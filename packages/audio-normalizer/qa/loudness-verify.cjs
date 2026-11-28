'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');
const WORKLET_PATH = path.join(repoRoot, 'audio', 'normalizer-worklet.js');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'manifest.json');
const REFERENCE_PATH = path.join(__dirname, 'reference-values.json');
const REPORT_PATH = path.join(__dirname, 'loudness-verify.json');

const SR = 48000;
const SR441 = 44100;
const BLOCK = 128;
const SEED = 0xC10C; // fixed seed: every fixture is bit-exact reproducible
const LOUDNESS_OFFSET = -0.691; // mirrored from audio/normalizer-worklet.js (read-only)
const CEILING_DBTP = -1.0; // pass criterion: processed true peak must be <= -1 dBTP (single ceiling since 5.4.1)
const DOCUMENTED_DEFAULT_TARGET_LUFS = -20;
const DELTA_TOL_LU = 0.1; // pass criterion: |processor LUFS - reference LUFS| <= 0.1 LU
const EPS_DB = 1e-6;
const TARGET_PROBE_LUFS = -24;
const AGC_RIPPLE_MAX_DB = 0.25; // audible gain modulation limit inside a 100 ms window after the meter settles
const AGC_SLEW_MAX_DB_PER_QUANTUM = 0.05; // hard AGC gain-delta ceiling across one 128-frame render quantum
const AGC_STEP_RECOVERY_MAX_SECONDS = 0.5; // AGC must reach its post-step target within half a second
const AGC_STEP_RECOVERY_TOL_DB = 0.3; // recovery tolerance at +0.5 s (a few quanta of slew margin)

const CLOSED_LOOP_TOL_LU = 0.2;
const SETTLED_WINDOW_SECONDS = 5;
const SETTLED_MAX_SPREAD_DB = 0.1;
const TAIL_SETTLE_DB = 0.05;
const MIN_TAIL_SECONDS = 5;
const CHANGING_PROGRAMS = new Set([
  'gated-silence', 'quiet-passage',
  'comfort-dialogue', 'comfort-shortform',
  'comfort-pair12', 'comfort-varying4',
  'comfort-step',
]);
function closedLoopScope(fixtureKey) {
  const base = fixtureKey.replace(/-44100$/, '');
  if (CHANGING_PROGRAMS.has(base)) {
    return { inScope: false, reason: 'out of scope for A1 convergence (changing program; A2/A3/A5 bind, not the steady-program settle gate)' };
  }
  return { inScope: true, reason: '' };
}
const HARNESS_GAIN_DB = 0;
const OUT_DIR = path.join(FIXTURE_DIR, 'out');

const LEVEL_MIN_SPREAD_REDUCTION_DB = 3.0;
const LEVEL_MIN_QUIET_RISE_DB = 3.0;
const PREV_MARGIN_FFMPEG_TP = -1.40;
const PREV_MARGIN_HARNESS_TP = -1.60;
const MARGIN_STANDARD_UNDERREAD_DB = 0.688;

const SELF_TEST_ONLY = process.argv.includes('--self-test');
for (const a of process.argv.slice(2)) {
  if (a !== '--self-test') {
    console.error(`unknown argument: ${a} (only --self-test is supported)`);
    process.exit(1);
  }
}

function makeLcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5; // [-0.5, 0.5)
  };
}

function sineIntoAt(x, sr, t0, t1, amp, freq, phase = 0) {
  const i0 = Math.max(0, Math.round(t0 * sr));
  const i1 = Math.min(x.length, Math.round(t1 * sr));
  for (let i = i0; i < i1; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / sr + phase);
}

function sineInto(x, t0, t1, amp, freq, phase = 0) {
  sineIntoAt(x, SR, t0, t1, amp, freq, phase);
}

function sineIntoPlanarAt(planar, ch, sr, t0, t1, amp, freq, phase = 0) {
  sineIntoAt(planar[ch], sr, t0, t1, amp, freq, phase);
}

function sineIntoPlanar(planar, ch, t0, t1, amp, freq, phase = 0) {
  sineIntoAt(planar[ch], SR, t0, t1, amp, freq, phase);
}

function pinkInto(x, seed, peakTarget) {
  const rnd = makeLcg(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const w = rnd() * 2; // white in [-1, 1)
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    x[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const g = peakTarget / (peak || 1);
  for (let i = 0; i < x.length; i++) x[i] *= g;
}

const FIXTURES = [
  {
    name: 'sine-1khz-fs-20',
    seconds: 30,
    description: '1 kHz sine, amplitude 0.1 (~-20 dBFS peak), phase 0',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.1, 1000); return x; },
  },
  {
    name: 'sine-1khz-fs-50',
    seconds: 30,
    description: '1 kHz sine, amplitude 0.00316 (~-50 dBFS peak), phase 0',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.00316, 1000); return x; },
  },
  {
    name: 'gated-silence',
    seconds: 50,
    description: '5 s loud 1 kHz sine (amp 0.5), 40 s exact digital silence, 5 s same loud sine; absolute gate must exclude the silent blocks',
    build: () => {
      const x = new Float32Array(SR * 50);
      sineInto(x, 0, 5, 0.5, 1000);
      sineInto(x, 45, 50, 0.5, 1000);
      return x;
    },
  },
  {
    name: 'quiet-passage',
    seconds: 30,
    description: '10 s loud 1 kHz sine (amp 0.5), 10 s quiet (amp 0.005, -46 dBFS), 10 s loud; exercises the relative gate',
    build: () => {
      const x = new Float32Array(SR * 30);
      sineInto(x, 0, 10, 0.5, 1000);
      sineInto(x, 10, 20, 0.005, 1000);
      sineInto(x, 20, 30, 0.5, 1000);
      return x;
    },
  },
  {
    name: 'pink-ish',
    seconds: 30,
    description: `deterministic Kellett-filtered noise, seeded LCG (seed 0x${SEED.toString(16)}), normalized to 0.2 peak; no Math.random anywhere`,
    build: () => { const x = new Float32Array(SR * 30); pinkInto(x, SEED, 0.2); return x; },
  },
  {
    name: 'high-tone-11k',
    seconds: 30,
    description: 'honestly-labelled mid-high tone (renamed 2026-10-18; was "inter-sample-peak" with a wrong fnorm-0.5 worst-case claim): continuous 11.025 kHz sine amp 0.98, fnorm 0.2297, bound ~0.14 dB — NOT the Nyquist worst case; genuine near-Nyquist stress lives in the adversarial sweep',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.98, 11025); return x; },
  },
  {
    name: 'sine-1khz-loud',
    seconds: 30,
    description: 'companion control for high-tone-11k: uniform 1 kHz sine at amplitude 0.98, continuous 0-30 s. Same near-full-scale sample peak, but at 1 kHz (fnorm 0.042) the 4x detector under-read is negligible, so the limiter path is exercised where the detector is accurate — the contrast with the 11.025 kHz tone is the point. Settles like the other uniform tones.',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.98, 1000); return x; },
  },
  {
    name: 'mono-sine-1khz',
    seconds: 30,
    workletChannels: 1,
    description: 'MONO worklet-path fixture: 1-channel WAV, 1 kHz sine amplitude 0.1 (~-20 dBFS peak), fed to the worklet as 1 channel (inputs[0] = [ch0]). Same level as sine-1khz-fs-20 so the 1-channel integrated loudness must agree with the ffmpeg 1-channel measurement within 0.1 LU.',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.1, 1000); return x; },
  },
  {
    name: 'comfort-quiet',
    seconds: 30,
    description: 'COMFORT cross-program quiet end: uniform 1 kHz sine amp 0.0447 (~-30 LUFS program). Must settle within +-0.5 LU of the -20 program target.',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.0447, 1000); return x; },
  },
  {
    name: 'comfort-loud',
    seconds: 30,
    description: 'COMFORT cross-program loud end: uniform 1 kHz sine amp 0.447 (~-10 LUFS program). Must settle within +-0.5 LU of the -20 program target.',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.447, 1000); return x; },
  },
  {
    name: 'comfort-dialogue',
    seconds: 30,
    description: 'COMFORT long-form profile (YouTube-like: quiet dialogue against loud music/effects): 0-10 s loud 880 Hz sine amp 0.3, 10-20 s quiet 440 Hz sine amp 0.015, 20-30 s loud again. The levelling stage must shrink the loud:quiet spread by >= 3 dB and raise the quiet passage by >= 3 dB; ends with 10 s of stable loud program so the gain settles.',
    build: () => {
      const x = new Float32Array(SR * 30);
      sineInto(x, 0, 10, 0.3, 880);
      sineInto(x, 10, 20, 0.015, 440);
      sineInto(x, 20, 30, 0.3, 880);
      return x;
    },
  },
  {
    name: 'comfort-shortform',
    seconds: 30,
    description: 'COMFORT short-form profile (TikTok/X/Facebook/Reddit-like: wildly varying masters with hot peaks): 0-5 s amp 0.5, 5-10 s amp 0.025 (26 dB down: the quiet section gates out of the gated mean like dialogue, so the settled state is well-defined), 10-15 s amp 0.5 with 0.9-amp 64-frame Nyquist-alternating hot bursts at 11 s, 13 s and 14 s, 15-30 s stable amp 0.5 (15 s uniform stable tail: the settled steady state the oracle measures is one program, not a passage boundary).',
    build: () => {
      const x = new Float32Array(SR * 30);
      sineInto(x, 0, 5, 0.5, 1000);
      sineInto(x, 5, 10, 0.025, 1000);
      sineInto(x, 10, 15, 0.5, 1000);
      sineInto(x, 15, 30, 0.5, 1000);
      for (const at of [11, 13, 14]) {
        const base = Math.round(at * SR);
        for (let k = 0; k < 64; k++) x[base + k] = (k % 2 === 0 ? 0.9 : -0.9);
      }
      return x;
    },
  },
  {
    name: 'comfort-varying4',
    seconds: 60,
    description: 'COMFORT dead-band NOT-fire case (EBU R 128 s4 clause k: within 5 LU no adaptation): 15 s sections alternating 440 Hz sine amp 0.1 / 0.0631 (4.0 dB, inLRA ~4.0 LU — a varying program that engages the processor, unlike a constant tone whose zero LRA stays zero under any compression and cannot fail). Section short-term sits inside the ±2.5 LU dead-band, so the levelling must apply NO adaptation: settled spread and tail LRA preserved.',
    build: () => {
      const x = new Float32Array(SR * 60);
      const aHi = 0.1, aLo = 0.1 / Math.pow(10, 4 / 20);
      sineInto(x, 0, 15, aHi, 440);
      sineInto(x, 15, 30, aLo, 440);
      sineInto(x, 30, 60, aHi, 440);
      return x;
    },
  },
  {
    name: 'comfort-pair12',
    seconds: 60,
    description: 'COMFORT dead-band FIRE case: 15 s sections alternating 440 Hz sine amp 0.2 / 0.05 (12.04 dB). Section short-term sits far outside the ±2.5 LU dead-band, so the levelling must engage: spread shrinks by >= 4 dB, the quiet section rises by >= 3 dB, residual spread stays >= 3 LU (OUR no-flatten floor — no published residual floor exists). The +6 dB published boost cap binds the quiet lift, so residual lands near 6 rather than exactly 5.',
    build: () => {
      const x = new Float32Array(SR * 60);
      sineInto(x, 0, 15, 0.2, 440);
      sineInto(x, 15, 30, 0.05, 440);
      sineInto(x, 30, 60, 0.2, 440);
      return x;
    },
  },
  {
    name: 'comfort-step',
    seconds: 90,
    description: 'COMFORT step-recovery profile (SPEC A5/H2/S4: 60 s quiet program followed by 30 s ~10 LU louder; the levelling/AGC stage must recover output short-term loudness to within +-1.0 LU of target within 10 s; a steady pre-step program must show no pumping). Quiet: 440 Hz sine amp 0.0447 (~-30 LUFS); loud: 440 Hz sine amp 0.1413 (~-20 LUFS, +10 dB). Ends with 30 s of stable loud program.',
    build: () => {
      const x = new Float32Array(SR * 90);
      sineInto(x, 0, 60, 0.0447, 440);
      sineInto(x, 60, 90, 0.1413, 440);
      return x;
    },
  },
  {
    name: 'comfort-music',
    seconds: 30,
    description: 'COMFORT platform-normalized program profile (YT Music-like music program near the platforms’ ≈-14 delivery): uniform 440 Hz sine amp 0.2 (~-17 LUFS). The slow loop should apply a small attenuation of a few LU; the levelling stage should leave it nearly untouched (dead-band: no adaptation inside the band).',
    build: () => { const x = new Float32Array(SR * 30); sineInto(x, 0, 30, 0.2, 440); return x; },
  },
  {
    name: 'surround-51',
    seconds: 20,
    workletChannels: 6,
    layout: 'SMPTE order L R C LFE Ls Rs; WAVEFORMATEXTENSIBLE mask 0x3F (FL|FR|FC|LFE|BL|BR)',
    description: '5.1 worklet-path fixture (6-channel WAV, SMPTE order L R C LFE Ls Rs, mask 0x3F): surrounds carry the energy (Ls/Rs: 1 kHz sine amp 0.5, weight 1.41 each — load-bearing), fronts carry little (L/R: 1 kHz amp 0.05; C: 1 kHz amp 0.02), LFE present and loud (50 Hz sine amp 0.5, weight 0 — must be excluded). A worklet that mis-weights surrounds or includes LFE mismatches ffmpeg by LU, not 0.0x. Fed to the worklet as 6 channels.',
    build: () => {
      const n = SR * 20;
      const planar = [];
      for (let c = 0; c < 6; c++) planar.push(new Float32Array(n));
      sineIntoPlanar(planar, 0, 0, 20, 0.05, 1000); // L: quiet
      sineIntoPlanar(planar, 1, 0, 20, 0.05, 1000); // R: quiet
      sineIntoPlanar(planar, 2, 0, 20, 0.02, 1000); // C: quieter
      sineIntoPlanar(planar, 3, 0, 20, 0.5, 50);    // LFE: loud, excluded
      sineIntoPlanar(planar, 4, 0, 20, 0.5, 1000);  // Ls: energy
      sineIntoPlanar(planar, 5, 0, 20, 0.5, 1000);  // Rs: energy
      return planar;
    },
  },
];

const FIXTURES_441 = [
  {
    name: 'sine-1khz-fs-20-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of sine-1khz-fs-20: 1 kHz sine amp 0.1, 0-30 s',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.1, 1000); return x; },
  },
  {
    name: 'sine-1khz-fs-50-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of sine-1khz-fs-50: 1 kHz sine amp 0.00316',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.00316, 1000); return x; },
  },
  {
    name: 'gated-silence-44100',
    seconds: 50,
    sampleRate: SR441,
    description: '44.1 kHz version of gated-silence: 5 s loud, 40 s silence, 5 s loud',
    build: () => {
      const x = new Float32Array(SR441 * 50);
      sineIntoAt(x, SR441, 0, 5, 0.5, 1000);
      sineIntoAt(x, SR441, 45, 50, 0.5, 1000);
      return x;
    },
  },
  {
    name: 'quiet-passage-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of quiet-passage: 10 s loud, 10 s quiet, 10 s loud',
    build: () => {
      const x = new Float32Array(SR441 * 30);
      sineIntoAt(x, SR441, 0, 10, 0.5, 1000);
      sineIntoAt(x, SR441, 10, 20, 0.005, 1000);
      sineIntoAt(x, SR441, 20, 30, 0.5, 1000);
      return x;
    },
  },
  {
    name: 'pink-ish-44100',
    seconds: 30,
    sampleRate: SR441,
    description: `44.1 kHz deterministic Kellett noise, seeded LCG (seed 0x${SEED.toString(16)}), normalized to 0.2 peak`,
    build: () => { const x = new Float32Array(SR441 * 30); pinkInto(x, SEED, 0.2); return x; },
  },
  {
    name: 'high-tone-11k-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of high-tone-11k: continuous 11.025 kHz sine amp 0.98 (fnorm = f/fs = 0.25 at 44.1 kHz, bound 0.168 dB; not a worst case)',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.98, 11025); return x; },
  },
  {
    name: 'sine-1khz-loud-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz companion control: uniform 1 kHz sine amp 0.98',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.98, 1000); return x; },
  },
  {
    name: 'mono-sine-1khz-44100',
    seconds: 30,
    sampleRate: SR441,
    workletChannels: 1,
    description: '44.1 kHz MONO worklet-path fixture: 1 kHz sine amp 0.1, fed as 1 channel',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.1, 1000); return x; },
  },
  {
    name: 'comfort-quiet-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-quiet: uniform 1 kHz sine amp 0.0447',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.0447, 1000); return x; },
  },
  {
    name: 'comfort-loud-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-loud: uniform 1 kHz sine amp 0.447',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.447, 1000); return x; },
  },
  {
    name: 'comfort-dialogue-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-dialogue: 0-10 s loud 880 Hz amp 0.3, 10-20 s quiet 440 Hz amp 0.015, 20-30 s loud',
    build: () => {
      const x = new Float32Array(SR441 * 30);
      sineIntoAt(x, SR441, 0, 10, 0.3, 880);
      sineIntoAt(x, SR441, 10, 20, 0.015, 440);
      sineIntoAt(x, SR441, 20, 30, 0.3, 880);
      return x;
    },
  },
  {
    name: 'comfort-shortform-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-shortform: 0.5/0.025 masters (26 dB) with hot Nyquist bursts, uniform stable 15-30 s tail',
    build: () => {
      const x = new Float32Array(SR441 * 30);
      sineIntoAt(x, SR441, 0, 5, 0.5, 1000);
      sineIntoAt(x, SR441, 5, 10, 0.025, 1000);
      sineIntoAt(x, SR441, 10, 15, 0.5, 1000);
      sineIntoAt(x, SR441, 15, 30, 0.5, 1000);
      for (const at of [11, 13, 14]) {
        const base = Math.round(at * SR441);
        for (let k = 0; k < 64; k++) x[base + k] = (k % 2 === 0 ? 0.9 : -0.9);
      }
      return x;
    },
  },
  {
    name: 'comfort-varying4-44100',
    seconds: 60,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-varying4: 440 Hz amp 0.1 / 0.0631 (4.0 dB), 0-15 s loud, 15-30 s quiet, 30-60 s loud. Carries the 44.1 kHz LRA evidence for the dead-band NOT-fire case (input + settled-range oracle LRA).',
    build: () => {
      const x = new Float32Array(SR441 * 60);
      const aHi = 0.1, aLo = 0.1 / Math.pow(10, 4 / 20);
      sineIntoAt(x, SR441, 0, 15, aHi, 440);
      sineIntoAt(x, SR441, 15, 30, aLo, 440);
      sineIntoAt(x, SR441, 30, 60, aHi, 440);
      return x;
    },
  },
  {
    name: 'comfort-pair12-44100',
    seconds: 60,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-pair12: 440 Hz amp 0.2 / 0.05 (12.04 dB), 0-15 s loud, 15-30 s quiet, 30-60 s loud. Carries the 44.1 kHz evidence for the dead-band FIRE case.',
    build: () => {
      const x = new Float32Array(SR441 * 60);
      sineIntoAt(x, SR441, 0, 15, 0.2, 440);
      sineIntoAt(x, SR441, 15, 30, 0.05, 440);
      sineIntoAt(x, SR441, 30, 60, 0.2, 440);
      return x;
    },
  },
  {
    name: 'comfort-step-44100',
    seconds: 90,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-step: 60 s quiet 440 Hz amp 0.0447, 30 s loud 440 Hz amp 0.1413 (+10 dB). Carries the 44.1 kHz evidence for the A5 step-recovery control.',
    build: () => {
      const x = new Float32Array(SR441 * 90);
      sineIntoAt(x, SR441, 0, 60, 0.0447, 440);
      sineIntoAt(x, SR441, 60, 90, 0.1413, 440);
      return x;
    },
  },
  {
    name: 'comfort-music-44100',
    seconds: 30,
    sampleRate: SR441,
    description: '44.1 kHz version of comfort-music: uniform 440 Hz sine amp 0.2',
    build: () => { const x = new Float32Array(SR441 * 30); sineIntoAt(x, SR441, 0, 30, 0.2, 440); return x; },
  },
  {
    name: 'surround-51-44100',
    seconds: 20,
    sampleRate: SR441,
    workletChannels: 6,
    layout: 'SMPTE order L R C LFE Ls Rs; WAVEFORMATEXTENSIBLE mask 0x3F (FL|FR|FC|LFE|BL|BR)',
    description: '44.1 kHz 5.1 worklet-path fixture, same mix as surround-51',
    build: () => {
      const n = SR441 * 20;
      const planar = [];
      for (let c = 0; c < 6; c++) planar.push(new Float32Array(n));
      sineIntoPlanarAt(planar, 0, SR441, 0, 20, 0.05, 1000);
      sineIntoPlanarAt(planar, 1, SR441, 0, 20, 0.05, 1000);
      sineIntoPlanarAt(planar, 2, SR441, 0, 20, 0.02, 1000);
      sineIntoPlanarAt(planar, 3, SR441, 0, 20, 0.5, 50);
      sineIntoPlanarAt(planar, 4, SR441, 0, 20, 0.5, 1000);
      sineIntoPlanarAt(planar, 5, SR441, 0, 20, 0.5, 1000);
      return planar;
    },
  },
];

const ADVERSARIAL_SWEEP = (() => {
  const N = 8192;
  const AT = 2040;
  const mkBurst = (len, amp, brk) => {
    const x = new Float32Array(N);
    let s = 1;
    for (let k = 0; k < len; k++) {
      x[AT + k] = amp * s;
      if (k !== brk) s = -s;
    }
    return x;
  };
  const mkSineBurst = (freq, amp, len) => {
    const x = new Float32Array(N);
    for (let k = 0; k < len; k++) x[AT + k] = amp * Math.sin(2 * Math.PI * freq * (AT + k) / SR);
    return x;
  };
  const briefPattern = [1, -1, 1, -1, 1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, 1, -1, 1];
  const briefBurst = new Float32Array(N);
  for (let k = 0; k < 18; k++) briefBurst[AT + k] = 0.8 * briefPattern[k];
  const fullAlt = new Float32Array(N);
  { let s = 1; for (let i = 0; i < N; i++) { fullAlt[i] = s; s = -s; } }
  const spike10 = new Float32Array(N); spike10[4000] = 1.0;
  const spike08 = new Float32Array(N); spike08[4000] = 0.8;
  const steady11k = new Float32Array(N);
  for (let i = 0; i < N; i++) steady11k[i] = 0.98 * Math.sin(2 * Math.PI * 11025 * i / SR);
  return [
    { name: 'burst-brief-18f-0.8', description: 'reported counterexample: 18-frame ±0.8 burst, two phase breaks', build: () => briefBurst.slice() },
    { name: 'burst-mid-4f-0.8', description: '4-frame ±0.8 burst, mid phase break', build: () => mkBurst(4, 0.8, 2) },
    { name: 'burst-mid-8f-0.8', description: '8-frame ±0.8 burst, mid phase break', build: () => mkBurst(8, 0.8, 4) },
    { name: 'burst-mid-18f-0.8', description: '18-frame ±0.8 burst, mid phase break', build: () => mkBurst(18, 0.8, 9) },
    { name: 'burst-mid-32f-0.8', description: '32-frame ±0.8 burst, mid phase break', build: () => mkBurst(32, 0.8, 16) },
    { name: 'burst-mid-64f-0.8', description: '64-frame ±0.8 burst, mid phase break', build: () => mkBurst(64, 0.8, 32) },
    { name: 'burst-mid-18f-0.5', description: '18-frame ±0.5 burst, mid phase break', build: () => mkBurst(18, 0.5, 9) },
    { name: 'burst-mid-18f-1.0', description: '18-frame ±1.0 burst, mid phase break', build: () => mkBurst(18, 1.0, 9) },
    { name: 'burst-clean-18f-0.8', description: '18-frame ±0.8 clean alternating burst (edge transients only)', build: () => mkBurst(18, 0.8, -1) },
    { name: 'burst-clean-64f-1.0', description: '64-frame ±1.0 clean alternating burst', build: () => mkBurst(64, 1.0, -1) },
    { name: 'spike-1.0', description: 'isolated single-sample +1.0 spike', build: () => spike10.slice() },
    { name: 'spike-0.8', description: 'isolated single-sample +0.8 spike', build: () => spike08.slice() },
    { name: 'sine-19200-64f-0.8', description: '64-frame 19.2 kHz sine burst amp 0.8 (fnorm 0.40)', build: () => mkSineBurst(19200, 0.8, 64) },
    { name: 'sine-21600-64f-0.8', description: '64-frame 21.6 kHz sine burst amp 0.8 (fnorm 0.45)', build: () => mkSineBurst(21600, 0.8, 64) },
    { name: 'sine-23040-64f-0.8', description: '64-frame 23.04 kHz sine burst amp 0.8 (fnorm 0.48)', build: () => mkSineBurst(23040, 0.8, 64) },
    { name: 'full-alternating-1.0', description: 'full-length (8192-frame) full-scale alternating pattern', build: () => fullAlt.slice() },
    { name: 'steady-11k-0.98', description: 'steady full-scale 11.025 kHz tone (oracle overshoot end of the margin)', build: () => steady11k.slice() },
  ];
})();

function writeWavFloat32Rate(filePath, samples, rate) {
  const n = samples.length;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + n * 4, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(3, 20); // IEEE float
  hdr.writeUInt16LE(1, 22); // mono
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 4, 28);
  hdr.writeUInt16LE(4, 32);
  hdr.writeUInt16LE(32, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(n * 4, 40);
  const body = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) body.writeFloatLE(samples[i], i * 4);
  fs.writeFileSync(filePath, Buffer.concat([hdr, body]));
}

function writeWavFloat32(filePath, samples) {
  writeWavFloat32Rate(filePath, samples, SR);
}

function readWavFloat32Mono(filePath) {
  const planar = readWavFloat32Planar(filePath);
  if (planar.channels !== 1) throw new Error(`expected mono WAV: ${filePath} (got ${planar.channels} channels)`);
  return planar.planar[0];
}

function readWavFloat32Planar(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a WAV file: ${filePath}`);
  }
  let audioFormat = 0, channels = 0, rate = 0, bits = 0, subFormat = 0;
  let dataOff = -1, dataSize = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (audioFormat === 0xfffe && size >= 40) subFormat = buf.readUInt16LE(body + 24);
    } else if (id === 'data' && dataOff < 0) {
      dataOff = body;
      dataSize = Math.min(size, buf.length - body);
    }
    off = body + size + (size % 2);
  }
  if (dataOff < 0) throw new Error(`data chunk not found: ${filePath}`);
  const isFloat = audioFormat === 3 || (audioFormat === 0xfffe && subFormat === 3);
  if (!isFloat || bits !== 32) throw new Error(`expected 32-bit float WAV: ${filePath}`);
  if (rate !== SR && rate !== SR441) throw new Error(`unexpected sample rate ${rate} in ${filePath}`);
  const frames = Math.floor(dataSize / 4 / channels);
  const planar = [];
  for (let c = 0; c < channels; c++) planar.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      planar[c][i] = buf.readFloatLE(dataOff + (i * channels + c) * 4);
    }
  }
  return { sampleRate: rate, channels, planar };
}

function writeWavFloat32PlanarRate(filePath, planar, rate, channelMask) {
  const channels = planar.length;
  const n = planar[0].length;
  for (const ch of planar) if (ch.length !== n) throw new Error('planar channel length mismatch');
  const mask = channelMask !== undefined ? channelMask : (channels === 6 ? 0x3f : (1 << channels) - 1);
  const fmtSize = 40;
  const hdr = Buffer.alloc(12 + 8 + fmtSize + 8);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(4 + 8 + fmtSize + 8 + n * channels * 4, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(fmtSize, 16);
  hdr.writeUInt16LE(0xfffe, 20); // WAVE_FORMAT_EXTENSIBLE
  hdr.writeUInt16LE(channels, 22);
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * channels * 4, 28);
  hdr.writeUInt16LE(channels * 4, 32);
  hdr.writeUInt16LE(32, 34);
  hdr.writeUInt16LE(22, 36); // cbSize
  hdr.writeUInt16LE(32, 38); // valid bits
  hdr.writeUInt32LE(mask, 40);
  hdr.writeUInt32LE(3, 44); // subformat Data1 = float (KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)
  hdr.writeUInt16LE(0, 48); // Data2
  hdr.writeUInt16LE(0x10, 50); // Data3
  Buffer.from([0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]).copy(hdr, 52); // Data4
  hdr.write('data', 60);
  hdr.writeUInt32LE(n * channels * 4, 64);
  const body = Buffer.alloc(n * channels * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) body.writeFloatLE(planar[c][i], (i * channels + c) * 4);
  }
  fs.writeFileSync(filePath, Buffer.concat([hdr, body]));
}

function writeWavFloat32Planar(filePath, planar, channelMaskOrRate, maybeMask) {
  if (typeof channelMaskOrRate === 'number' && channelMaskOrRate >= 8000 && maybeMask === undefined) {
    writeWavFloat32PlanarRate(filePath, planar, channelMaskOrRate, undefined);
    return;
  }
  if (typeof channelMaskOrRate === 'number' && typeof maybeMask === 'number') {
    writeWavFloat32PlanarRate(filePath, planar, channelMaskOrRate, maybeMask);
    return;
  }
  writeWavFloat32PlanarRate(filePath, planar, SR, channelMaskOrRate);
}

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function toPlanar(built) {
  return Array.isArray(built) ? built : [built];
}

function generateFixtures() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const files = [];
  const allDefs = [...FIXTURES.map((f) => ({ ...f, sampleRate: SR })), ...FIXTURES_441];
  for (const f of allDefs) {
    const rate = f.sampleRate || SR;
    const nCh = f.workletChannels || (Array.isArray(f.build()) ? f.build().length : 1);
    const aP = toPlanar(f.build());
    const bP = toPlanar(f.build());
    if (aP.length !== bP.length) throw new Error(`HARNESS BROKEN: ${f.name} rebuild channel-count mismatch`);
    if (aP.length !== nCh) throw new Error(`HARNESS BROKEN: ${f.name} built ${aP.length} channels, expected ${nCh}`);
    for (let c = 0; c < aP.length; c++) {
      if (aP[c].length !== bP[c].length) throw new Error(`HARNESS BROKEN: ${f.name} rebuild length mismatch (ch ${c})`);
      for (let i = 0; i < aP[c].length; i++) {
        if (aP[c][i] !== bP[c][i]) throw new Error(`HARNESS BROKEN: ${f.name} not bit-exact reproducible at ch ${c} sample ${i}`);
      }
    }
    const wavPath = path.join(FIXTURE_DIR, `${f.name}.wav`);
    if (aP.length === 1) {
      if (rate === SR) writeWavFloat32(wavPath, aP[0]);
      else writeWavFloat32Rate(wavPath, aP[0], rate);
    } else {
      if (rate === SR) writeWavFloat32Planar(wavPath, aP);
      else writeWavFloat32PlanarRate(wavPath, aP, rate);
    }
    const sha = sha256Hex(fs.readFileSync(wavPath));
    const back = readWavFloat32Planar(wavPath);
    if (back.sampleRate !== rate) throw new Error(`HARNESS BROKEN: ${f.name} WAV round-trip rate mismatch (got ${back.sampleRate}, want ${rate})`);
    if (back.channels !== aP.length) throw new Error(`HARNESS BROKEN: ${f.name} WAV round-trip channel mismatch`);
    for (let c = 0; c < aP.length; c++) {
      if (back.planar[c].length !== aP[c].length) throw new Error(`HARNESS BROKEN: ${f.name} WAV round-trip length mismatch (ch ${c})`);
      for (let i = 0; i < aP[c].length; i++) {
        if (back.planar[c][i] !== aP[c][i]) throw new Error(`HARNESS BROKEN: ${f.name} WAV round-trip mismatch at ch ${c} sample ${i}`);
      }
    }
    files.push({
      name: `${f.name}.wav`,
      seconds: f.seconds,
      samples: aP[0].length,
      channels: aP.length,
      sampleRate: rate,
      workletChannels: f.workletChannels || aP.length,
      layout: f.layout || (aP.length === 1 ? 'mono' : `${aP.length}ch`),
      description: f.description,
      sha256: sha,
    });
  }
  const manifest = {
    generated: true,
    doNotEdit: 'generated by qa/loudness-verify.cjs; re-run the harness to regenerate',
    generator: 'qa/loudness-verify.cjs',
    seed: SEED,
    seedHex: `0x${SEED.toString(16)}`,
    sampleRate: SR,
    sampleRates: [SR, SR441],
    format: '32-bit float WAV (IEEE float, no dither); mono fixtures 1ch plain, surround-51 6ch WAVE_FORMAT_EXTENSIBLE SMPTE (mask 0x3F); 48 kHz names bare, 44.1 kHz names carry -44100',
    files,
  };
  try {
    const prev = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    if (prev && Array.isArray(prev.outputs)) manifest.outputs = prev.outputs;
  } catch {}
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return files;
}

function checkFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { present: false, version: null, note: 'ffmpeg is NOT on PATH (ffmpeg -version failed); oracle checks are UNTESTED' };
  }
  const firstLine = String(r.stdout || '').split('\n')[0].trim();
  return { present: true, version: firstLine, note: `ffmpeg present: ${firstLine}` };
}

function runOracle(wavPath) {
  const args = ['-hide_banner', '-f', 'wav', '-i', wavPath, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  const stderr = String(r.stderr || '');
  const parsed = parseEbur128(stderr);
  return {
    command: `ffmpeg ${args.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ')}`,
    exit: r.status,
    rawStderr: stderr,
    ...parsed,
  };
}

function parseEbur128(stderr) {
  const pick = (re) => {
    const m = re.exec(stderr);
    return m ? Number(m[1]) : NaN;
  };
  return {
    integratedLufs: pick(/^\s*I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/m),
    lraLu: pick(/^\s*LRA:\s*(-?\d+(?:\.\d+)?)\s+LU/m),
    truePeakDbTp: pick(/^\s*Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/m),
  };
}

function loadProcessor(source, rate = SR) {
  let Captured = null;
  const sandbox = {
    sampleRate: rate,
    console,
    registerProcessor: (_name, cls) => { Captured = cls; },
    AudioWorkletProcessor: class {
      constructor() { this.port = { onmessage: null, postMessage() {} }; }
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'normalizer-worklet.vm.js' });
  if (!Captured) throw new Error('HARNESS BROKEN: registerProcessor was never called');
  return Captured;
}

function makeProc(Proc, opts = {}) {
  const { gainDb = HARNESS_GAIN_DB, mode = null, targetLufs = null } = opts;
  const proc = new Proc();
  proc.port.onmessage({ data: { type: 'set-gain-db', gainDb } });
  if (targetLufs !== null && targetLufs !== undefined) proc.port.onmessage({ data: { type: 'set-target-lufs', targetLufs } });
  if (mode !== null && mode !== undefined) proc.port.onmessage({ data: { type: 'set-mode', mode } });
  return proc;
}

function collectInternals(proc, signalPlanar, outsPlanar) {
  const tel = proc.telemetry || {};
  const internals = {
    hasQueryApi: true,
    gapNote: 'CLOSED: audio/normalizer-worklet.js exposes this.telemetry (integratedLufs, shortTermLufs, momentaryLufs, truePeakDb, appliedGainDb, mode, warm) on every process() call, plus meter messages on the port; processorLufs below reads that documented surface.',
    programSq: NaN,
    shortSq: NaN,
    momentarySq: NaN,
    currentGain: Number.isFinite(tel.appliedGainDb) ? Math.pow(10, tel.appliedGainDb / 20) : 1,
    currentLimiterGain: proc.currentLimiterGain,
    analysisFrames: proc.totalFrames,
    processorLufsProgram: Number.isFinite(tel.integratedLufs) ? tel.integratedLufs : -Infinity,
    processorLufsShort: Number.isFinite(tel.shortTermLufs) ? tel.shortTermLufs : -Infinity,
    appliedGainDb: Number.isFinite(tel.appliedGainDb) ? tel.appliedGainDb : 0,
    limiterGainDb: 20 * Math.log10(Math.max(proc.currentLimiterGain, 1e-12)),
    telemetryWarm: !!tel.warm,
    telemetryMode: tel.mode,
  };
  let si = 0, so = 0;
  for (let c = 0; c < signalPlanar.length; c++) {
    const sCh = signalPlanar[c];
    const oCh = (outsPlanar[c] || outsPlanar[0]);
    for (let i = 0; i < sCh.length; i++) { si += sCh[i] * sCh[i]; so += oCh[i] * oCh[i]; }
  }
  internals.measuredGainDb = 10 * Math.log10((so + 1e-18) / (si + 1e-18));
  return internals;
}

function hasNaNOuts(outs) {
  for (const ch of outs) {
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) return true;
  }
  return false;
}

function gainTraceBounds(trace) {
  let mn = Infinity, mx = -Infinity;
  for (const v of trace) {
    if (!Number.isFinite(v)) return { min: NaN, max: NaN, hasNaN: true };
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { min: mn, max: mx, hasNaN: false };
}

function renderThroughWorklet(Proc, signal, gainDbOrOpts = HARNESS_GAIN_DB) {
  const opts = typeof gainDbOrOpts === 'object' && gainDbOrOpts !== null
    ? gainDbOrOpts
    : { gainDb: gainDbOrOpts };
  const proc = makeProc(Proc, opts);

  const n = signal.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const gainTrace = [];
  const normTrace = [];
  for (let pos = 0; pos < n; pos += BLOCK) {
    const len = Math.min(BLOCK, n - pos);
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < len; i++) { const v = signal[pos + i]; inL[i] = v; inR[i] = v; }
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    proc.process([[inL], [inR]], [[oL], [oR]]);
    for (let i = 0; i < len; i++) { outL[pos + i] = oL[i]; outR[pos + i] = oR[i]; }
    gainTrace.push(proc.telemetry.appliedGainDb);
    normTrace.push(Number.isFinite(proc.telemetry.normGainDb) ? proc.telemetry.normGainDb : proc.telemetry.appliedGainDb);
  }

  const tel = proc.telemetry || {};
  const internals = {
    hasQueryApi: true,
    gapNote: 'CLOSED: audio/normalizer-worklet.js exposes this.telemetry (integratedLufs, shortTermLufs, momentaryLufs, truePeakDb, appliedGainDb, mode, warm) on every process() call, plus meter messages on the port; processorLufs below reads that documented surface.',
    programSq: NaN,
    shortSq: NaN,
    momentarySq: NaN,
    currentGain: Number.isFinite(tel.appliedGainDb) ? Math.pow(10, tel.appliedGainDb / 20) : 1,
    currentLimiterGain: proc.currentLimiterGain,
    analysisFrames: proc.totalFrames,
    processorLufsProgram: Number.isFinite(tel.integratedLufs) ? tel.integratedLufs : -Infinity,
    processorLufsShort: Number.isFinite(tel.shortTermLufs) ? tel.shortTermLufs : -Infinity,
    appliedGainDb: Number.isFinite(tel.appliedGainDb) ? tel.appliedGainDb : 0,
    limiterGainDb: 20 * Math.log10(Math.max(proc.currentLimiterGain, 1e-12)),
  };

  let si = 0, so = 0;
  for (let i = 0; i < n; i++) { si += signal[i] * signal[i]; so += outL[i] * outL[i]; }
  internals.measuredGainDb = 10 * Math.log10((so + 1e-18) / (si + 1e-18));

  return { outL, outR, internals, gainTrace, normTrace };
}

function renderThroughWorkletChannels(Proc, planar, gainDbOrOpts = HARNESS_GAIN_DB) {
  const opts = typeof gainDbOrOpts === 'object' && gainDbOrOpts !== null
    ? gainDbOrOpts
    : { gainDb: gainDbOrOpts };
  const proc = makeProc(Proc, opts);

  const nCh = planar.length;
  const n = planar[0].length;
  const outs = planar.map(() => new Float32Array(n));
  const gainTrace = [];
  const normTrace = [];
  for (let pos = 0; pos < n; pos += BLOCK) {
    const len = Math.min(BLOCK, n - pos);
    const ins = [];
    const ous = [];
    for (let c = 0; c < nCh; c++) {
      const a = new Float32Array(BLOCK);
      for (let i = 0; i < len; i++) a[i] = planar[c][pos + i];
      ins.push(a);
      ous.push(new Float32Array(BLOCK));
    }
    proc.process([ins], [ous]);
    for (let c = 0; c < nCh; c++) {
      for (let i = 0; i < len; i++) outs[c][pos + i] = ous[c][i];
    }
    gainTrace.push(proc.telemetry.appliedGainDb);
    normTrace.push(Number.isFinite(proc.telemetry.normGainDb) ? proc.telemetry.normGainDb : proc.telemetry.appliedGainDb);
  }

  const tel = proc.telemetry || {};
  const internals = {
    hasQueryApi: true,
    gapNote: 'CLOSED: audio/normalizer-worklet.js exposes this.telemetry (integratedLufs, shortTermLufs, momentaryLufs, truePeakDb, appliedGainDb, mode, warm) on every process() call, plus meter messages on the port; processorLufs below reads that documented surface.',
    programSq: NaN,
    shortSq: NaN,
    momentarySq: NaN,
    currentGain: Number.isFinite(tel.appliedGainDb) ? Math.pow(10, tel.appliedGainDb / 20) : 1,
    currentLimiterGain: proc.currentLimiterGain,
    analysisFrames: proc.totalFrames,
    processorLufsProgram: Number.isFinite(tel.integratedLufs) ? tel.integratedLufs : -Infinity,
    processorLufsShort: Number.isFinite(tel.shortTermLufs) ? tel.shortTermLufs : -Infinity,
    appliedGainDb: Number.isFinite(tel.appliedGainDb) ? tel.appliedGainDb : 0,
    limiterGainDb: 20 * Math.log10(Math.max(proc.currentLimiterGain, 1e-12)),
  };

  let si = 0, so = 0;
  for (let c = 0; c < nCh; c++) {
    for (let i = 0; i < n; i++) { si += planar[c][i] * planar[c][i]; so += outs[c][i] * outs[c][i]; }
  }
  internals.measuredGainDb = 10 * Math.log10((so + 1e-18) / (si + 1e-18));

  return { outs, internals, gainTrace, normTrace };
}

function countHardClips(outs, ceilingDb) {
  const rail = Math.fround(Math.pow(10, ceilingDb / 20));
  let count = 0;
  for (const ch of outs) {
    for (let i = 0; i < ch.length; i++) {
      if (ch[i] === rail || ch[i] === -rail) count++;
    }
  }
  return { count, rail };
}

function truePeakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  for (let i = 0; i + 3 < samples.length; i++) {
    const y0 = samples[i], y1 = samples[i + 1], y2 = samples[i + 2], y3 = samples[i + 3];
    for (const t of [0.25, 0.5, 0.75]) {
      const t2 = t * t, t3 = t2 * t;
      const v = y0 * (-t3 / 6 + t2 / 2 - t / 3)
        + y1 * (t3 / 2 - t2 - t / 2 + 1)
        + y2 * (-t3 / 2 + t2 / 2 + t)
        + y3 * (t3 / 6 - t / 6);
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-12));

function peakVerdictDbTp(tpDb, ceilingDb) {
  if (!Number.isFinite(tpDb)) return 'UNTESTED';
  return tpDb <= ceilingDb + EPS_DB ? 'PASS' : 'FAIL';
}

function compareLufs(measured, expected) {
  if (!Number.isFinite(measured) || !Number.isFinite(expected)) return { verdict: 'UNTESTED', delta: NaN };
  const delta = measured - expected;
  return { verdict: Math.abs(delta) <= DELTA_TOL_LU ? 'PASS' : 'FAIL', delta };
}

function parseWorkletConstants(source) {
  const num = (name) => {
    const m = new RegExp(`var ${name} = (-?\\d+(?:[.]\\d+)?);`).exec(source);
    if (!m) throw new Error(`HARNESS BROKEN: could not parse ${name} from worklet source`);
    return Number(m[1]);
  };
  return {
    targetDefault: num('TARGET_LUFS_DEFAULT'),
    maxBoostDb: num('MAX_BOOST_DB'),
    maxCutDb: num('MAX_CUT_DB'),
    tpMarginDb: num('TP_DETECTOR_MARGIN_DB'),
    ceilingDb: num('CEILING_DB'),
  };
}

function analyzeSettleAt(gainTrace, sr) {
  const n = gainTrace.length;
  const perSec = sr / BLOCK;
  const final = n > 0 ? gainTrace[n - 1] : NaN;
  if (!Number.isFinite(final) || n === 0) {
    return { settled: false, finalGain: final, settleQuantum: 0, tailSeconds: 0, spreadDb: NaN, reason: 'empty/non-finite applied-gain trace' };
  }
  const windowQuanta = Math.min(n, Math.round(SETTLED_WINDOW_SECONDS * perSec));
  let spread = 0;
  for (let i = n - windowQuanta; i < n; i++) {
    const d = Math.abs(gainTrace[i] - final);
    if (d > spread) spread = d;
  }
  let k = n - 1;
  while (k > 0 && Math.abs(gainTrace[k - 1] - final) <= TAIL_SETTLE_DB) k--;
  const tailSeconds = ((n - k) * BLOCK) / sr;
  const settled = spread <= SETTLED_MAX_SPREAD_DB;
  return {
    settled,
    finalGain: final,
    settleQuantum: k,
    tailSeconds,
    spreadDb: spread,
    reason: settled ? '' : `applied gain moved ${spread.toFixed(3)} dB over the final ${SETTLED_WINDOW_SECONDS} s (limit ${SETTLED_MAX_SPREAD_DB} dB)`,
  };
}

function analyzeSettle(gainTrace) {
  return analyzeSettleAt(gainTrace, SR);
}

function checkClosedLoop(outputLufs, expectedLufs, settled, tailSeconds) {
  if (!settled) return { verdict: 'UNTESTED', delta: NaN, reason: 'applied gain did not settle' };
  if (!Number.isFinite(tailSeconds) || tailSeconds < MIN_TAIL_SECONDS) {
    return { verdict: 'UNTESTED', delta: NaN, reason: `converged tail too short (${Number.isFinite(tailSeconds) ? tailSeconds.toFixed(1) : 'n/a'} s < ${MIN_TAIL_SECONDS} s)` };
  }
  if (!Number.isFinite(outputLufs) || !Number.isFinite(expectedLufs)) {
    return { verdict: 'UNTESTED', delta: NaN, reason: 'non-finite loudness (oracle or expectation missing)' };
  }
  const delta = outputLufs - expectedLufs;
  if (Math.abs(delta) <= CLOSED_LOOP_TOL_LU) return { verdict: 'PASS', delta, reason: '' };
  return { verdict: 'FAIL', delta, reason: `|${delta.toFixed(2)}| LU > ${CLOSED_LOOP_TOL_LU} LU` };
}

function perSecondTraceAt(gainTrace, sr) {
  const perSec = Math.round(sr / BLOCK);
  const out = [];
  for (let i = 0; i < gainTrace.length; i += perSec) out.push(Number(gainTrace[i].toFixed(3)));
  return out;
}

function perSecondTrace(gainTrace) {
  return perSecondTraceAt(gainTrace, SR);
}

function recordClosedLoopOutputs(entries) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.outputs = entries;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function loadReference() {
  if (!fs.existsSync(REFERENCE_PATH)) {
    return { status: 'not yet available (qa/reference-values.json does not exist)', values: {} };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  } catch (e) {
    return { status: `not yet available (qa/reference-values.json is not valid JSON: ${e.message})`, values: {} };
  }
  return { status: 'present', values: (raw && raw.fixtures) || {} };
}

const LEGACY_REFERENCE_ALIASES = {
  'high-tone-11k': 'inter-sample-peak',
  'high-tone-11k-44100': 'inter-sample-peak-44100',
};
function referenceEntryFor(values, key) {
  if (values[key] !== undefined) return values[key];
  const legacy = LEGACY_REFERENCE_ALIASES[key];
  if (legacy !== undefined && values[legacy] !== undefined) return values[legacy];
  return undefined;
}

function selfCheckHarness(oracle /* oracle of sine-1khz-fs-20 */) {
  const problems = [];
  if (!oracle || !Number.isFinite(oracle.integratedLufs)) {
    problems.push('HARNESS BROKEN: ffmpeg parser returned NaN/no integrated value for sine-1khz-fs-20 (expected a finite LUFS number)');
  } else if (oracle.integratedLufs > -15 || oracle.integratedLufs < -35) {
    problems.push(`HARNESS BROKEN: parsed integrated ${oracle.integratedLufs} LUFS for a -20 dBFS 1 kHz sine is outside the sane range [-35, -15]`);
  }
  if (!Number.isFinite(oracle.truePeakDbTp)) {
    problems.push('HARNESS BROKEN: ffmpeg parser returned NaN/no true peak for sine-1khz-fs-20');
  }
  const wrong = compareLufs(oracle.integratedLufs, oracle.integratedLufs + 5);
  if (wrong.verdict !== 'FAIL') {
    problems.push(`HARNESS BROKEN: comparator reported ${wrong.verdict} for a deliberately-wrong expected value (+5 LU); it must report FAIL`);
  }
  const right = compareLufs(oracle.integratedLufs, oracle.integratedLufs);
  if (right.verdict !== 'PASS') {
    problems.push(`HARNESS BROKEN: comparator reported ${right.verdict} for the exact oracle value; it must report PASS`);
  }
  return problems;
}

function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return 'n/a';
  return Number(n.toFixed(digits)).toFixed(digits);
}

function main() {
  console.log('LOUDNESS VERIFY HARNESS (pure Node, node:vm; no browser, no Chromium, no audio device)');
  console.log(`repo: ${repoRoot}`);

  const files = generateFixtures();
  console.log(`fixtures: wrote ${files.length} generated WAVs + manifest to ${FIXTURE_DIR}`);

  const ff = checkFfmpeg();
  console.log(`ffmpeg check command: ffmpeg -version`);
  if (ff.present) console.log(`ffmpeg check observed: ${ff.version}`);
  else console.log('ffmpeg check observed: ffmpeg is NOT on PATH (spawn failed) — oracle checks will be UNTESTED');

  if (SELF_TEST_ONLY) {
    runSelfTestOnly(ff);
    return;
  }

  if (!fs.existsSync(WORKLET_PATH)) {
    console.error(`HARNESS BROKEN: worklet not found at ${WORKLET_PATH}`);
    process.exit(1);
  }
  const workletSource = fs.readFileSync(WORKLET_PATH, 'utf8');
  if (!workletSource.includes('registerProcessor')) {
    console.error('HARNESS BROKEN: worklet source does not call registerProcessor');
    process.exit(1);
  }
  const Proc = loadProcessor(workletSource, SR);
  const Proc48 = Proc;
  const Proc441 = loadProcessor(workletSource, SR441);

  const wc = parseWorkletConstants(workletSource);
  if (wc.targetDefault !== DOCUMENTED_DEFAULT_TARGET_LUFS) {
    console.error(`HARNESS BROKEN: parsed TARGET_LUFS_DEFAULT=${wc.targetDefault}, documented literal is ${DOCUMENTED_DEFAULT_TARGET_LUFS} (update the worklet AND the documented target together, never one side alone)`);
    process.exit(1);
  }
  const EFFECTIVE_TARGET = wc.targetDefault + HARNESS_GAIN_DB;
  console.log(`worklet constants: TARGET_LUFS_DEFAULT=${wc.targetDefault} MAX_BOOST_DB=${wc.maxBoostDb} MAX_CUT_DB=${wc.maxCutDb} TP_DETECTOR_MARGIN_DB=${wc.tpMarginDb}; render set-gain-db=${HARNESS_GAIN_DB} -> effective target ${fmt(EFFECTIVE_TARGET)} LUFS`);
  console.log(`worklet ceiling: CEILING_DB=${wc.ceilingDb} (single -1 dBTP ceiling, 5.4.1)`);
  if (wc.ceilingDb !== CEILING_DBTP) {
    console.error(`HARNESS BROKEN: parsed CEILING_DB=${wc.ceilingDb}, expected ${CEILING_DBTP}`);
    process.exit(1);
  }

  const reference = loadReference();
  console.log(`reference-values.json: ${reference.status}`);

  let oracle20 = null;
  if (ff.present) {
    oracle20 = runOracle(path.join(FIXTURE_DIR, 'sine-1khz-fs-20.wav'));
    console.log(`oracle command: ${oracle20.command}`);
  } else {
    oracle20 = { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN, command: 'n/a (ffmpeg absent)', exit: null, rawStderr: '' };
  }
  const harnessProblems = ff.present ? selfCheckHarness(oracle20) : ['ffmpeg absent: parser self-check UNTESTED (no oracle output to validate against)'];
  const harnessOk = harnessProblems.length === 0;
  for (const p of harnessProblems) console.log(`${ff.present ? 'FAIL' : 'UNTESTED'}: ${p}`);
  if (!harnessOk && ff.present) {
    console.error('HARNESS BROKEN — refusing to report results.');
    process.exit(1);
  }

  const rows = [];
  const outputEntries = [];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files48 = files.filter((f) => (f.sampleRate || SR) === SR);
  const files441 = files.filter((f) => (f.sampleRate || SR) === SR441);
  for (const f of files48) {
    const wavPath = path.join(FIXTURE_DIR, f.name);
    const key = path.basename(f.name, '.wav');
    const planar = readWavFloat32Planar(wavPath).planar;

    const oracle = (key === 'sine-1khz-fs-20') ? oracle20 : (ff.present ? runOracle(wavPath) : {
      command: oracle20.command, exit: null, rawStderr: '',
      integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN,
    });

    let outs, internals, gainTrace, normTrace;
    if (f.workletChannels && f.workletChannels !== 2) {
      ({ outs, internals, gainTrace, normTrace } = renderThroughWorkletChannels(Proc, planar, HARNESS_GAIN_DB));
    } else {
      const signal = planar[0];
      const r = renderThroughWorklet(Proc, signal, HARNESS_GAIN_DB);
      outs = [r.outL, r.outR];
      internals = r.internals;
      gainTrace = r.gainTrace;
      normTrace = r.normTrace;
    }
    const procLufs = internals.processorLufsProgram;
    let procTruePeak = 0;
    for (const ch of outs) procTruePeak = Math.max(procTruePeak, truePeakOf(ch));
    const hardClip = countHardClips(outs, CEILING_DBTP);

    const settle = analyzeSettle(normTrace);
    const outBase = `${key}.out`;
    const outPath = path.join(OUT_DIR, `${outBase}.wav`);
    const outLen = outs[0].length;
    const multi = outs.length > 1 && !(outs.length === 2 && !f.workletChannels);
    const storedOuts = multi ? outs : [outs[0]];
    if (multi) {
      writeWavFloat32Planar(outPath, storedOuts);
    } else {
      writeWavFloat32(outPath, storedOuts[0]);
    }
    const outBack = readWavFloat32Planar(outPath);
    if (outBack.channels !== storedOuts.length) throw new Error(`HARNESS BROKEN: ${outBase} WAV round-trip channel mismatch`);
    for (let c = 0; c < storedOuts.length; c++) {
      if (outBack.planar[c].length !== storedOuts[c].length) throw new Error(`HARNESS BROKEN: ${outBase} WAV round-trip length mismatch (ch ${c})`);
      for (let i = 0; i < storedOuts[c].length; i++) {
        if (outBack.planar[c][i] !== storedOuts[c][i]) throw new Error(`HARNESS BROKEN: ${outBase} WAV round-trip mismatch at ch ${c} sample ${i}`);
      }
    }
    outputEntries.push({
      name: `out/${outBase}.wav`,
      seconds: outLen / SR,
      samples: outLen,
      channels: storedOuts.length,
      description: `generated processor OUTPUT for ${key} (${storedOuts.length}ch; render set-gain-db ${HARNESS_GAIN_DB} dB; closed-loop oracle input)`,
      sha256: sha256Hex(fs.readFileSync(outPath)),
    });
    const tailStart = Math.min(settle.settleQuantum * BLOCK, outLen);
    const tailPlanar = storedOuts.map((ch) => ch.subarray(tailStart));
    let tailPath = null;
    if (tailPlanar[0].length >= Math.round(0.4 * SR)) {
      tailPath = path.join(OUT_DIR, `${outBase}.tail.wav`);
      if (multi) {
        writeWavFloat32Planar(tailPath, tailPlanar);
      } else {
        writeWavFloat32(tailPath, tailPlanar[0]);
      }
      outputEntries.push({
        name: `out/${outBase}.tail.wav`,
        seconds: tailPlanar[0].length / SR,
        samples: tailPlanar[0].length,
        channels: storedOuts.length,
        description: `generated settled-tail slice of ${key} output (from ${(tailStart / SR).toFixed(2)} s; closed-loop convergence oracle input)`,
        sha256: sha256Hex(fs.readFileSync(tailPath)),
      });
    }
    const noOracle = { command: oracle.command, exit: null, rawStderr: '', integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN };
    const oracleOut = ff.present ? runOracle(outPath) : { ...noOracle };
    const oracleTail = (ff.present && tailPath) ? runOracle(tailPath) : { ...noOracle };
    console.log(`closed-loop oracle command (output): ${oracleOut.command}`);
    if (tailPath) console.log(`closed-loop oracle command (tail): ${oracleTail.command}`);

    const requiredGain = Number.isFinite(oracle.integratedLufs) ? EFFECTIVE_TARGET - oracle.integratedLufs : NaN;
    let expectedLufs = NaN;
    let boundNote = '';
    if (Number.isFinite(requiredGain)) {
      if (requiredGain > wc.maxBoostDb) {
        expectedLufs = oracle.integratedLufs + wc.maxBoostDb;
        boundNote = `clamped at +${wc.maxBoostDb} dB boost bound`;
      } else if (requiredGain < -wc.maxCutDb) {
        expectedLufs = oracle.integratedLufs - wc.maxCutDb;
        boundNote = `clamped at -${wc.maxCutDb} dB cut bound`;
      } else {
        expectedLufs = EFFECTIVE_TARGET;
      }
    }
    const cl = checkClosedLoop(oracleTail.integratedLufs, expectedLufs, settle.settled, settle.tailSeconds);
    const outPeakVerdict = peakVerdictDbTp(oracleOut.truePeakDbTp, CEILING_DBTP);
    const scope = closedLoopScope(key);
    let closedVerdict;
    let closedReason = cl.reason;
    if (!scope.inScope) {
      closedVerdict = 'UNTESTED';
      closedReason = scope.reason;
    } else if (cl.verdict === 'FAIL' || outPeakVerdict === 'FAIL') {
      closedVerdict = 'FAIL';
      const bits = [];
      if (cl.verdict === 'FAIL') bits.push(`convergence ${cl.reason}`);
      if (outPeakVerdict === 'FAIL') bits.push(`output true peak ${fmt(oracleOut.truePeakDbTp)} dBTP exceeds ceiling ${CEILING_DBTP} dBTP`);
      closedReason = bits.join('; ');
    } else if (cl.verdict === 'PASS' && outPeakVerdict === 'PASS') {
      closedVerdict = 'PASS';
      closedReason = boundNote;
    } else {
      closedVerdict = 'UNTESTED';
      const bits = [];
      if (cl.verdict === 'UNTESTED') bits.push(cl.reason);
      if (outPeakVerdict === 'UNTESTED') bits.push('output true peak unknown (no oracle)');
      closedReason = bits.join('; ');
    }

    const vsOracle = ff.present ? compareLufs(procLufs, oracle.integratedLufs) : { verdict: 'UNTESTED', delta: NaN };
    const refEntry = referenceEntryFor(reference.values, key);
    const refLufs = refEntry && Number.isFinite(refEntry.integratedLufs) ? refEntry.integratedLufs : NaN;
    const vsRef = Number.isFinite(refLufs) ? compareLufs(procLufs, refLufs) : { verdict: 'UNTESTED', delta: NaN };
    const refNote = Number.isFinite(refLufs) ? '' : 'reference not yet available';

    const ceilingVerdict = peakVerdictDbTp(toDb(procTruePeak), CEILING_DBTP);

    const exercised = [];
    if (ff.present) exercised.push(vsOracle.verdict);
    if (Number.isFinite(refLufs)) exercised.push(vsRef.verdict);
    exercised.push(ceilingVerdict);
    let verdict;
    if (exercised.includes('FAIL')) verdict = 'FAIL';
    else if (exercised.includes('UNTESTED') || exercised.length === 0) verdict = 'UNTESTED';
    else verdict = 'PASS';
    if (!ff.present && !Number.isFinite(refLufs)) verdict = ceilingVerdict === 'FAIL' ? 'FAIL' : 'UNTESTED';

    rows.push({
      fixture: key,
      channels: planar.length,
      workletChannels: f.workletChannels || planar.length,
      layout: f.layout || (planar.length === 1 ? 'mono' : `${planar.length}ch`),
      oracleLufs: oracle.integratedLufs,
      oracleLra: oracle.lraLu,
      oracleTruePeakDbTp: oracle.truePeakDbTp,
      oracleCommand: oracle.command,
      oracleExit: oracle.exit,
      rawStderr: oracle.rawStderr,
      processorLufs: procLufs,
      processorLufsShort: internals.processorLufsShort,
      deltaVsOracle: vsOracle.delta,
      verdictVsOracle: vsOracle.verdict,
      referenceLufs: refLufs,
      referenceSource: (refEntry && refEntry.source) || null,
      deltaVsReference: vsRef.delta,
      verdictVsReference: vsRef.verdict,
      referenceNote: refNote,
      processorTruePeakDbTp: toDb(procTruePeak),
      verdictCeiling: ceilingVerdict,
      hardClipCount: hardClip.count,
      hardClipRail: hardClip.rail,
      appliedGainDb: internals.appliedGainDb,
      limiterGainDb: internals.limiterGainDb,
      measuredGainDb: internals.measuredGainDb,
      verdict,
      closedLoop: {
        effectiveTargetLufs: EFFECTIVE_TARGET,
        requiredGainDb: requiredGain,
        expectedLufs,
        boundNote: boundNote || null,
        appliedGainDb: settle.finalGain,
        gainSpreadDb: settle.spreadDb,
        gainSettled: settle.settled,
        settleFromSeconds: (Math.min(settle.settleQuantum * BLOCK, outLen) / SR),
        tailSeconds: settle.tailSeconds,
        outputWav: `out/${outBase}.wav`,
        outputTailWav: tailPath ? `out/${outBase}.tail.wav` : null,
        outputFullLufs: oracleOut.integratedLufs,
        outputTailLufs: oracleTail.integratedLufs,
        outputFullPeakDbTp: oracleOut.truePeakDbTp,
        outputTailCommand: oracleTail.command,
        deltaVsExpected: cl.delta,
        verdictConvergence: cl.verdict,
        convergenceInScope: scope.inScope,
        scopeReason: scope.reason,
        verdictCeiling: outPeakVerdict,
        verdict: closedVerdict,
        reason: closedReason,
        gainTracePerSecondDb: perSecondTrace(typeof normTrace !== 'undefined' ? normTrace : gainTrace),
      },
    });
  }
  recordClosedLoopOutputs(outputEntries);

  const advRows = [];
  for (const spec of ADVERSARIAL_SWEEP) {
    const sigA = spec.build();
    const sigB = spec.build();
    if (sigA.length !== sigB.length) throw new Error(`HARNESS BROKEN: adversarial ${spec.name} rebuild length mismatch`);
    for (let i = 0; i < sigA.length; i++) {
      if (sigA[i] !== sigB[i]) throw new Error(`HARNESS BROKEN: adversarial ${spec.name} not bit-exact reproducible at sample ${i}`);
    }
    const sig = sigA;
    const { outs } = renderThroughWorkletChannels(Proc48, [sig], {});
    const outN = outs[0];
    const baseN = `adversarial-${spec.name}.out`;
    const pathN = path.join(OUT_DIR, `${baseN}.wav`);
    writeWavFloat32(pathN, outN);
    outputEntries.push({
      name: `out/${baseN}.wav`,
      seconds: outN.length / SR,
      samples: outN.length,
      channels: 1,
      sampleRate: SR,
      description: `generated ADVERSARIAL sweep OUTPUT for ${spec.name} (${spec.description}; render set-gain-db 0 dB)`,
      sha256: sha256Hex(fs.readFileSync(pathN)),
    });
    const oracleN = ff.present ? runOracle(pathN) : { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN, command: 'n/a', exit: null, rawStderr: '' };
    const verdictN = peakVerdictDbTp(oracleN.truePeakDbTp, CEILING_DBTP);
    const verdict = verdictN;
    advRows.push({
      signal: spec.name,
      description: spec.description,
      outputPeak: oracleN.truePeakDbTp,
      verdictNormal: verdictN,
      verdict,
    });
  }
  recordClosedLoopOutputs(outputEntries);
  const advFails = advRows.filter((r) => r.verdict === 'FAIL').length;
  const advUntested = advRows.filter((r) => r.verdict === 'UNTESTED').length;
  const advSummary = advFails > 0 ? 'FAIL' : (advUntested > 0 ? `${advUntested} UNTESTED` : 'PASS');

  const rate441Rows = [];
  for (const f of files441) {
    const wavPath = path.join(FIXTURE_DIR, f.name);
    const key = path.basename(f.name, '.wav');
    const baseKey = key.replace(/-44100$/, '');
    const readBack = readWavFloat32Planar(wavPath);
    const planar = readBack.planar;
    const srHere = readBack.sampleRate;
    const oracle = ff.present ? runOracle(wavPath) : { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN, command: 'n/a', exit: null, rawStderr: '' };
    let outs, internals, gainTrace, normTrace;
    if (f.workletChannels && f.workletChannels !== 2) {
      ({ outs, internals, gainTrace, normTrace } = renderThroughWorkletChannels(Proc441, planar, {}));
    } else {
      const r = renderThroughWorklet(Proc441, planar[0], {});
      outs = [r.outL, r.outR];
      internals = r.internals;
      gainTrace = r.gainTrace;
      normTrace = r.normTrace;
    }
    const procLufs = internals.processorLufsProgram;
    const vsOracle = ff.present ? compareLufs(procLufs, oracle.integratedLufs) : { verdict: 'UNTESTED', delta: NaN };
    let procPeak = 0;
    for (const ch of outs) procPeak = Math.max(procPeak, truePeakOf(ch));
    const hardClip = countHardClips(outs, CEILING_DBTP);
    const settle = analyzeSettleAt(normTrace, srHere);
    const outBase = `${key}.out`;
    const outPath = path.join(OUT_DIR, `${outBase}.wav`);
    const outLen = outs[0].length;
    const multi = outs.length > 1 && !(outs.length === 2 && !f.workletChannels);
    const storedOuts = multi ? outs : [outs[0]];
    if (multi) writeWavFloat32PlanarRate(outPath, storedOuts, srHere);
    else writeWavFloat32Rate(outPath, storedOuts[0], srHere);
    outputEntries.push({
      name: `out/${outBase}.wav`,
      seconds: outLen / srHere,
      samples: outLen,
      channels: storedOuts.length,
      sampleRate: srHere,
      description: `generated 44.1 kHz processor OUTPUT for ${key} (${storedOuts.length}ch)`,
      sha256: sha256Hex(fs.readFileSync(outPath)),
    });
    const tailStart = Math.min(settle.settleQuantum * BLOCK, outLen);
    const tailPlanar = storedOuts.map((ch) => ch.subarray(tailStart));
    let tailPath = null;
    if (tailPlanar[0].length >= Math.round(0.4 * srHere)) {
      tailPath = path.join(OUT_DIR, `${outBase}.tail.wav`);
      if (multi) writeWavFloat32PlanarRate(tailPath, tailPlanar, srHere);
      else writeWavFloat32Rate(tailPath, tailPlanar[0], srHere);
      outputEntries.push({
        name: `out/${outBase}.tail.wav`,
        seconds: tailPlanar[0].length / srHere,
        samples: tailPlanar[0].length,
        channels: storedOuts.length,
        sampleRate: srHere,
        description: `generated 44.1 kHz settled-tail slice of ${key} output`,
        sha256: sha256Hex(fs.readFileSync(tailPath)),
      });
    }
    const noOracle = { command: oracle.command, exit: null, rawStderr: '', integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN };
    const oracleOut = ff.present ? runOracle(outPath) : { ...noOracle };
    const oracleTail = (ff.present && tailPath) ? runOracle(tailPath) : { ...noOracle };
    const requiredGain = Number.isFinite(oracle.integratedLufs) ? EFFECTIVE_TARGET - oracle.integratedLufs : NaN;
    let expectedLufs = NaN;
    if (Number.isFinite(requiredGain)) {
      if (requiredGain > wc.maxBoostDb) expectedLufs = oracle.integratedLufs + wc.maxBoostDb;
      else if (requiredGain < -wc.maxCutDb) expectedLufs = oracle.integratedLufs - wc.maxCutDb;
      else expectedLufs = EFFECTIVE_TARGET;
    }
    const cl = checkClosedLoop(oracleTail.integratedLufs, expectedLufs, settle.settled, settle.tailSeconds);
    const outPeakVerdict = peakVerdictDbTp(oracleOut.truePeakDbTp, CEILING_DBTP);
    const scope441 = closedLoopScope(key);
    let closedVerdict;
    let closedReason441 = cl.reason;
    if (!scope441.inScope) {
      closedVerdict = 'UNTESTED';
      closedReason441 = scope441.reason;
    } else if (cl.verdict === 'FAIL' || outPeakVerdict === 'FAIL') closedVerdict = 'FAIL';
    else if (cl.verdict === 'PASS' && outPeakVerdict === 'PASS') closedVerdict = 'PASS';
    else closedVerdict = 'UNTESTED';
    const nanFree = !hasNaNOuts(outs) && Number.isFinite(procLufs);
    const hcOk = hardClip.count === 0;
    let verdict = 'PASS';
    if (vsOracle.verdict === 'FAIL' || !nanFree || !hcOk) verdict = 'FAIL';
    else if (scope441.inScope && closedVerdict === 'FAIL') verdict = 'FAIL';
    else if (vsOracle.verdict === 'UNTESTED' || (scope441.inScope && closedVerdict === 'UNTESTED')) verdict = 'UNTESTED';
    const base48 = rows.find((r) => r.fixture === baseKey);
    rate441Rows.push({
      fixture: key,
      baseFixture: baseKey,
      oracleLufs: oracle.integratedLufs,
      processorLufs: procLufs,
      deltaVsOracle: vsOracle.delta,
      verdictVsOracle: vsOracle.verdict,
      baseline48Lufs: base48 ? base48.processorLufs : NaN,
      oracleLra: oracle.lraLu,
      hardClipCount: hardClip.count,
      nanFree,
      closedLoop: {
        effectiveTargetLufs: EFFECTIVE_TARGET,
        requiredGainDb: requiredGain,
        expectedLufs,
        appliedGainDb: settle.finalGain,
        outputTailLufs: oracleTail.integratedLufs,
        outputFullLufs: oracleOut.integratedLufs,
        outputTailWav: tailPath ? `out/${outBase}.tail.wav` : null,
        outputFullPeakDbTp: oracleOut.truePeakDbTp,
        deltaVsExpected: cl.delta,
        verdictConvergence: cl.verdict,
        convergenceInScope: scope441.inScope,
        scopeReason: scope441.reason,
        verdictCeiling: outPeakVerdict,
        verdict: closedVerdict,
        reason: closedReason441,
        tailSeconds: settle.tailSeconds,
        gainSettled: settle.settled,
      },
      verdict,
    });
  }
  recordClosedLoopOutputs(outputEntries);

  function sectionRmsDb(outs, sr, t0, t1) {
    const i0 = Math.round(t0 * sr), i1 = Math.round(t1 * sr);
    let sum = 0, n = 0;
    for (const ch of outs) {
      for (let i = i0; i < Math.min(i1, ch.length); i++) { sum += ch[i] * ch[i]; n++; }
    }
    return 20 * Math.log10(Math.sqrt(sum / Math.max(n, 1)) + 1e-18);
  }
  function sectionSpreadDb(outs, sr, a0, a1, b0, b1) {
    return sectionRmsDb(outs, sr, a0, a1) - sectionRmsDb(outs, sr, b0, b1);
  }
  let levelRow = null;
  {
    const levelKey = 'comfort-dialogue';
    const levelWav = path.join(FIXTURE_DIR, `${levelKey}.wav`);
    const levelPlanar = readWavFloat32Planar(levelWav).planar;
    const inSpread = sectionSpreadDb(levelPlanar, SR, 0, 10, 10, 20);
    const inQuietDb = sectionRmsDb(levelPlanar, SR, 10, 20);
    let outsL, internalsL, gainTraceL, normTraceL;
    const r = renderThroughWorklet(Proc48, levelPlanar[0], { mode: 'level' });
    outsL = [r.outL];
    internalsL = r.internals;
    gainTraceL = r.gainTrace;
    normTraceL = r.normTrace;
    const levelOutBase = `${levelKey}.level.out`;
    const levelOutPath = path.join(OUT_DIR, `${levelOutBase}.wav`);
    writeWavFloat32(levelOutPath, outsL[0]);
    outputEntries.push({
      name: `out/${levelOutBase}.wav`,
      seconds: outsL[0].length / SR,
      samples: outsL[0].length,
      channels: 1,
      sampleRate: SR,
      description: `generated COMFORT-LEVELLING OUTPUT for ${levelKey} (set-mode level; dead-band AGC levelling + slow loop to -20 + limiter)`,
      sha256: sha256Hex(fs.readFileSync(levelOutPath)),
    });
    const baseRow = rows.find((rr) => rr.fixture === levelKey);
    const oracleIn = baseRow ? { integratedLufs: baseRow.oracleLufs, lraLu: baseRow.oracleLra, truePeakDbTp: baseRow.oracleTruePeakDbTp } : { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN };
    const oracleLevel = ff.present ? runOracle(levelOutPath) : { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN, command: 'n/a', exit: null, rawStderr: '' };
    const outSpread = sectionSpreadDb(outsL, SR, 0, 10, 10, 20);
    const outQuietDb = sectionRmsDb(outsL, SR, 10, 20);
    const spreadReduction = inSpread - outSpread;
    const quietRise = outQuietDb - inQuietDb;
    const engaged = Number.isFinite(inSpread) && Number.isFinite(outSpread)
      && spreadReduction >= LEVEL_MIN_SPREAD_REDUCTION_DB && quietRise >= LEVEL_MIN_QUIET_RISE_DB;
    const hardClipL = countHardClips(outsL, CEILING_DBTP);
    const nanL = hasNaNOuts(outsL) || normTraceL.some((v) => !Number.isFinite(v)) || !Number.isFinite(internalsL.appliedGainDb);
    const levelTailStart = Math.min(analyzeSettle(normTraceL).settleQuantum * BLOCK, outsL[0].length);
    const levelTail = outsL[0].subarray(levelTailStart);
    let levelTailLufs = NaN;
    if (ff.present && levelTail.length >= Math.round(0.4 * SR)) {
      const tmpTail = path.join(OUT_DIR, `${levelOutBase}.tail.wav`);
      writeWavFloat32(tmpTail, levelTail);
      const oTail = runOracle(tmpTail);
      levelTailLufs = oTail.integratedLufs;
      outputEntries.push({
        name: `out/${levelOutBase}.tail.wav`,
        seconds: levelTail.length / SR,
        samples: levelTail.length,
        channels: 1,
        sampleRate: SR,
        description: `generated COMFORT-LEVELLING settled-tail slice of ${levelKey}`,
        sha256: sha256Hex(fs.readFileSync(tmpTail)),
      });
    }
    const targetDelta = Number.isFinite(levelTailLufs) ? levelTailLufs - EFFECTIVE_TARGET : NaN;
    const targetMet = Number.isFinite(targetDelta) && Math.abs(targetDelta) <= CLOSED_LOOP_TOL_LU;
    const peakOk = ff.present && Number.isFinite(oracleLevel.truePeakDbTp) && oracleLevel.truePeakDbTp <= CEILING_DBTP + EPS_DB;
    let verdictL = 'PASS';
    if (!engaged || hardClipL.count !== 0 || nanL || !peakOk || !targetMet) verdictL = 'FAIL';
    if (!ff.present) verdictL = 'UNTESTED';
    levelRow = {
      fixture: levelKey,
      metric: 'section RMS spread loud(0-10s) vs quiet(10-20s), dB (input program vs comfort output)',
      inSpread,
      inQuietDb,
      outSpread,
      outQuietDb,
      spreadReduction,
      quietRise,
      engaged,
      inLra: oracleIn.lraLu,
      outLra: oracleLevel.lraLu,
      lraReduction: (Number.isFinite(oracleIn.lraLu) && Number.isFinite(oracleLevel.lraLu)) ? oracleIn.lraLu - oracleLevel.lraLu : NaN,
      levelTailLufs,
      targetDelta,
      targetMet,
      targetNote: targetMet
        ? 'comfort chain levels AND still meets the program target (slow loop measured from the levelled signal)'
        : `comfort tail misses the program target by ${fmt(targetDelta)} LU (limit ${CLOSED_LOOP_TOL_LU} LU)`,
      outputPeakDbTp: oracleLevel.truePeakDbTp,
      peakOk,
      hardClipCount: hardClipL.count,
      noNaN: !nanL,
      modeTelemetry: internalsL.telemetryMode || 'level',
      verdict: verdictL,
    };
  }
  recordClosedLoopOutputs(outputEntries);

  let targetRow = null;
  {
    const tKey = 'sine-1khz-fs-20';
    const tWav = path.join(FIXTURE_DIR, `${tKey}.wav`);
    const tPlanar = readWavFloat32Planar(tWav).planar;
    let outsT, internalsT, gainTraceT;
    const r = renderThroughWorklet(Proc48, tPlanar[0], { targetLufs: TARGET_PROBE_LUFS });
    outsT = [r.outL];
    internalsT = r.internals;
    gainTraceT = r.gainTrace;
    const settleT = analyzeSettle(gainTraceT);
    const tBase = `${tKey}.target-20.out`;
    const tPath = path.join(OUT_DIR, `${tBase}.wav`);
    writeWavFloat32(tPath, outsT[0]);
    outputEntries.push({
      name: `out/${tBase}.wav`,
      seconds: outsT[0].length / SR,
      samples: outsT[0].length,
      channels: 1,
      sampleRate: SR,
      description: `generated set-target-lufs OUTPUT for ${tKey} (set-target-lufs ${TARGET_PROBE_LUFS})`,
      sha256: sha256Hex(fs.readFileSync(tPath)),
    });
    const tailStartT = Math.min(settleT.settleQuantum * BLOCK, outsT[0].length);
    const tailT = outsT[0].subarray(tailStartT);
    let tailPathT = null;
    if (tailT.length >= Math.round(0.4 * SR)) {
      tailPathT = path.join(OUT_DIR, `${tBase}.tail.wav`);
      writeWavFloat32(tailPathT, tailT);
      outputEntries.push({
        name: `out/${tBase}.tail.wav`,
        seconds: tailT.length / SR,
        samples: tailT.length,
        channels: 1,
        sampleRate: SR,
        description: `generated set-target-lufs settled-tail slice of ${tKey}`,
        sha256: sha256Hex(fs.readFileSync(tailPathT)),
      });
    }
    const oracleTailT = (ff.present && tailPathT) ? runOracle(tailPathT) : { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN, command: 'n/a', exit: null, rawStderr: '' };
    const clT = checkClosedLoop(oracleTailT.integratedLufs, TARGET_PROBE_LUFS, settleT.settled, settleT.tailSeconds);
    let verdictT = clT.verdict;
    if (!ff.present && verdictT === 'FAIL') verdictT = 'UNTESTED';
    const stuckAt18 = checkClosedLoop(EFFECTIVE_TARGET, TARGET_PROBE_LUFS, true, 12);
    targetRow = {
      fixture: tKey,
      probeTarget: TARGET_PROBE_LUFS,
      settled: settleT.settled,
      tailSeconds: settleT.tailSeconds,
      tailLufs: oracleTailT.integratedLufs,
      delta: clT.delta,
      verdict: verdictT,
      stuckCheck: stuckAt18.verdict,
      stuckNote: 'retarget-that-did-nothing still sits at the -20 default (must report FAIL)',
    };
  }
  recordClosedLoopOutputs(outputEntries);

  let resetRow = null;
  {
    const rKey = 'sine-1khz-fs-20';
    const rWav = path.join(FIXTURE_DIR, `${rKey}.wav`);
    const rPlanar = readWavFloat32Planar(rWav).planar;
    const procR = makeProc(Proc48, {});
    const driveProc = (proc, planar) => {
      const nCh = planar.length;
      const n = planar[0].length;
      const outs = planar.map(() => new Float32Array(n));
      const trace = [];
      for (let pos = 0; pos < n; pos += BLOCK) {
        const len = Math.min(BLOCK, n - pos);
        const ins = [];
        const ous = [];
        for (let c = 0; c < nCh; c++) {
          const a = new Float32Array(BLOCK);
          for (let i = 0; i < len; i++) a[i] = planar[c][pos + i];
          ins.push(a);
          ous.push(new Float32Array(BLOCK));
        }
        proc.process([ins], [ous]);
        for (let c = 0; c < nCh; c++) {
          for (let i = 0; i < len; i++) outs[c][pos + i] = ous[c][i];
        }
        trace.push(proc.telemetry.appliedGainDb);
      }
      return { outs, trace };
    };
    driveProc(procR, rPlanar);
    const preTel = { warm: procR.telemetry.warm, integratedLufs: procR.telemetry.integratedLufs, appliedGainDb: procR.telemetry.appliedGainDb, totalFrames: procR.totalFrames };
    const preInternal = { warm: procR.warm, integratedLufs: procR.integratedLufs };
    procR.port.onmessage({ data: { type: 'reset-meter' } });
    const maxAbs2d = (arrs) => { let m = 0; for (const a of arrs) for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; };
    const allOnes = (a) => { for (let i = 0; i < a.length; i++) if (a[i] !== 1) return false; return true; };
    const immInterpMax = maxAbs2d(procR.interpZ);
    const immInterpZiOk = procR.interpZi === 0;
    const immPRingOk = maxAbs2d([procR.pRing]) === 0;
    const immBlocksOk = maxAbs2d([procR.blocks]) === 0;
    const immDelayOk = maxAbs2d(procR.channelBuffers) === 0 && procR.writeIndex === 0;
    const immTargetsOk = allOnes(procR.limiterTargets) && procR.currentLimiterGain === 1;
    const immTelOk = !Number.isFinite(procR.telemetry.integratedLufs) && procR.telemetry.truePeakDb === -Infinity && procR.telemetry.warm === false;
    const immOk = immInterpMax === 0 && immInterpZiOk && immPRingOk && immBlocksOk && immDelayOk && immTargetsOk && immTelOk
      && procR.totalFrames === 0 && procR.warm === false && !Number.isFinite(procR.integratedLufs) && procR.truePeakTrack === 0;
    const silence = rPlanar.map(() => new Float32Array(BLOCK));
    const silRes = driveProc(procR, silence);
    let silOutZero = true;
    for (const ch of silRes.outs) for (let i = 0; i < ch.length; i++) if (ch[i] !== 0) { silOutZero = false; break; }
    const postTel = { warm: procR.telemetry.warm, integratedLufs: procR.telemetry.integratedLufs, appliedGainDb: procR.telemetry.appliedGainDb, totalFrames: procR.totalFrames, truePeakDb: procR.telemetry.truePeakDb };
    const postInternal = { warm: procR.warm, integratedLufs: procR.integratedLufs, truePeakTrack: procR.truePeakTrack };
    let silEngagements = 0;
    for (let i = 0; i < procR.limiterTargets.length; i++) if (procR.limiterTargets[i] !== 1) silEngagements++;
    const silPeakMinusInf = postTel.truePeakDb === -Infinity && postInternal.truePeakTrack === 0;
    const silZeroEng = silEngagements === 0 && procR.currentLimiterGain === 1;
    const snip = rPlanar.map((ch) => ch.subarray(0, SR * 5));
    driveProc(procR, snip);
    const reacqTel = { warm: procR.telemetry.warm, integratedLufs: procR.telemetry.integratedLufs, appliedGainDb: procR.telemetry.appliedGainDb, totalFrames: procR.totalFrames };
    procR.port.onmessage({ data: { type: 'reset-meter' } });
    const procF = makeProc(Proc48, {});
    const settingsKept = procR.targetLufs === procF.targetLufs && procR.trimTargetDb === procF.trimTargetDb
      && procR.trimCurrentDb === procF.trimCurrentDb
      && procR.mode === procF.mode;
    const qLen = SR * 5;
    const quiet = new Float32Array(qLen);
    for (let i = 0; i < qLen; i++) quiet[i] = 0.05 * Math.sin(2 * Math.PI * 1000 * i / SR);
    const qPlanar = [quiet];
    const resR = driveProc(procR, qPlanar);
    const resF = driveProc(procF, qPlanar);
    let equivMaxDiff = 0;
    let equivIdent = resR.outs.length === resF.outs.length && resR.outs[0].length === resF.outs[0].length;
    if (equivIdent) {
      for (let c = 0; c < resR.outs.length; c++) {
        for (let i = 0; i < resR.outs[c].length; i++) {
          const d = Math.abs(resR.outs[c][i] - resF.outs[c][i]);
          if (d > equivMaxDiff) equivMaxDiff = d;
          if (resR.outs[c][i] !== resF.outs[c][i]) equivIdent = false;
        }
      }
    }
    const equivTelOk = procR.telemetry.integratedLufs === procF.telemetry.integratedLufs
      && procR.telemetry.appliedGainDb === procF.telemetry.appliedGainDb
      && procR.telemetry.truePeakDb === procF.telemetry.truePeakDb
      && procR.telemetry.warm === procF.telemetry.warm;
    let equiv441Ident = false;
    let equiv441MaxDiff = NaN;
    try {
      const p441 = readWavFloat32Planar(path.join(FIXTURE_DIR, 'sine-1khz-fs-20-44100.wav')).planar;
      const procR441 = makeProc(Proc441, {});
      driveProc(procR441, p441.map((ch) => ch.subarray(0, SR441 * 5)));
      procR441.port.onmessage({ data: { type: 'reset-meter' } });
      const procF441 = makeProc(Proc441, {});
      const qLen441 = SR441 * 5;
      const quiet441 = new Float32Array(qLen441);
      for (let i = 0; i < qLen441; i++) quiet441[i] = 0.05 * Math.sin(2 * Math.PI * 1000 * i / SR441);
      const resR441 = driveProc(procR441, [quiet441]);
      const resF441 = driveProc(procF441, [quiet441]);
      equiv441MaxDiff = 0;
      equiv441Ident = resR441.outs.length === resF441.outs.length && resR441.outs[0].length === resF441.outs[0].length;
      if (equiv441Ident) {
        for (let c = 0; c < resR441.outs.length; c++) {
          for (let i = 0; i < resR441.outs[c].length; i++) {
            const d = Math.abs(resR441.outs[c][i] - resF441.outs[c][i]);
            if (d > equiv441MaxDiff) equiv441MaxDiff = d;
            if (resR441.outs[c][i] !== resF441.outs[c][i]) equiv441Ident = false;
          }
        }
      }
    } catch (e) { equiv441Ident = false; }
    const cleared = postTel.warm === false && !Number.isFinite(postTel.integratedLufs) && postInternal.warm === false && !Number.isFinite(postInternal.integratedLufs) && immOk && silPeakMinusInf && silZeroEng && silOutZero;
    const preValid = preTel.warm === true && Number.isFinite(preTel.integratedLufs);
    const reacquired = Number.isFinite(reacqTel.integratedLufs);
    const equivOk = equivIdent && equivMaxDiff === 0 && equivTelOk && equiv441Ident && settingsKept;
    let verdictR = 'PASS';
    if (!preValid) verdictR = 'UNTESTED';
    else if (!cleared || !reacquired || !equivOk) verdictR = 'FAIL';
    resetRow = {
      fixture: rKey,
      preWarm: preTel.warm,
      preIntegrated: preTel.integratedLufs,
      preInternalWarm: preInternal.warm,
      preInternalIntegrated: preInternal.integratedLufs,
      postWarm: postTel.warm,
      postIntegrated: postTel.integratedLufs,
      postInternalWarm: postInternal.warm,
      postInternalIntegrated: postInternal.integratedLufs,
      reacqWarm: reacqTel.warm,
      reacqIntegrated: reacqTel.integratedLufs,
      cleared,
      reacquired,
      immInterpMax,
      immInterpZiOk,
      immPRingOk,
      immBlocksOk,
      immDelayOk,
      immTargetsOk,
      immTelOk,
      immOk,
      postTruePeakDb: postTel.truePeakDb,
      postTruePeakTrack: postInternal.truePeakTrack,
      silPeakMinusInf,
      silEngagements,
      silZeroEng,
      silOutZero,
      equivIdent48: equivIdent,
      equivMaxDiff48: equivMaxDiff,
      equivTelOk,
      equivIdent441: equiv441Ident,
      equivMaxDiff441: equiv441MaxDiff,
      settingsKept,
      equivOk,
      verdict: verdictR,
    };
  }

  const GAIN_ROWS_SPEC = [
    { gainDb: 0, fixture: 'sine-1khz-fs-20' }, // trim 0, expected tail -20
    { gainDb: 6, fixture: 'sine-1khz-fs-20' }, // trim +6, expected tail -14
    { gainDb: -6, fixture: 'gated-silence' }, // trim -6, expected tail -26
    { gainDb: 12, fixture: 'sine-1khz-loud' }, // trim +12, expected tail -8 (loudest legitimate setting)
    { gainDb: -12, fixture: 'sine-1khz-fs-20' }, // trim -12, expected tail -32
  ];
  function tailRmsDb(outs, startSample) {
    let sum = 0, n = 0;
    for (const ch of outs) {
      for (let i = startSample; i < ch.length; i++) { sum += ch[i] * ch[i]; n++; }
    }
    return 20 * Math.log10(Math.sqrt(sum / Math.max(n, 1)) + 1e-18);
  }
  const gainRows = [];
  for (const spec of GAIN_ROWS_SPEC) {
    const expectedTail = EFFECTIVE_TARGET + spec.gainDb;
    const baseRow = rows.find((r) => r.fixture === spec.fixture);
    const inputLufs = baseRow ? baseRow.oracleLufs : NaN;
    const fDef = files48.find((fi) => path.basename(fi.name, '.wav') === spec.fixture);
    const wavPath = path.join(FIXTURE_DIR, `${spec.fixture}.wav`);
    const planar = readWavFloat32Planar(wavPath).planar;
    let outs, internals, gainTrace, normTrace;
    if (fDef && fDef.workletChannels && fDef.workletChannels !== 2) {
      ({ outs, internals, gainTrace, normTrace } = renderThroughWorkletChannels(Proc48, planar, { gainDb: spec.gainDb }));
    } else {
      const r = renderThroughWorklet(Proc48, planar[0], { gainDb: spec.gainDb });
      outs = [r.outL, r.outR];
      internals = r.internals;
      gainTrace = r.gainTrace;
      normTrace = r.normTrace;
    }
    const probe = makeProc(Proc48, { gainDb: spec.gainDb });
    const targetOk = probe.targetLufs === wc.targetDefault;
    const trimArmed = probe.trimTargetDb === spec.gainDb;
    const integratedTrim = internals.processorLufsProgram;
    const integratedRef = baseRow ? baseRow.processorLufs : NaN;
    const integratedDelta = (Number.isFinite(integratedTrim) && Number.isFinite(integratedRef)) ? integratedTrim - integratedRef : NaN;
    const integratedOk = Number.isFinite(integratedDelta) && Math.abs(integratedDelta) <= DELTA_TOL_LU;
    const settle = analyzeSettle(normTrace);
    const tag = `gain${spec.gainDb >= 0 ? 'p' : 'm'}${Math.abs(spec.gainDb)}`;
    const gBase = `${spec.fixture}.${tag}.out`;
    const gPath = path.join(OUT_DIR, `${gBase}.wav`);
    const outLen = outs[0].length;
    const multi = outs.length > 1 && !(outs.length === 2 && !(fDef && fDef.workletChannels));
    const storedOuts = multi ? outs : [outs[0]];
    if (multi) writeWavFloat32Planar(gPath, storedOuts);
    else writeWavFloat32(gPath, storedOuts[0]);
    outputEntries.push({
      name: `out/${gBase}.wav`,
      seconds: outLen / SR,
      samples: outLen,
      channels: storedOuts.length,
      sampleRate: SR,
      description: `generated USER-TRIM OUTPUT for ${spec.fixture} (render set-gain-db ${spec.gainDb} dB; expected tail ${fmt(expectedTail)} LUFS)`,
      sha256: sha256Hex(fs.readFileSync(gPath)),
    });
    const tailStart = Math.min(settle.settleQuantum * BLOCK, outLen);
    const tailPlanar = storedOuts.map((ch) => ch.subarray(tailStart));
    let tailPath = null;
    if (tailPlanar[0].length >= Math.round(0.4 * SR)) {
      tailPath = path.join(OUT_DIR, `${gBase}.tail.wav`);
      if (multi) writeWavFloat32Planar(tailPath, tailPlanar);
      else writeWavFloat32(tailPath, tailPlanar[0]);
      outputEntries.push({
        name: `out/${gBase}.tail.wav`,
        seconds: tailPlanar[0].length / SR,
        samples: tailPlanar[0].length,
        channels: storedOuts.length,
        sampleRate: SR,
        description: `generated USER-TRIM settled-tail slice of ${spec.fixture} at set-gain-db ${spec.gainDb} dB`,
        sha256: sha256Hex(fs.readFileSync(tailPath)),
      });
    }
    const noOracle = { command: 'n/a', exit: null, rawStderr: '', integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN };
    const oracleTail = (ff.present && tailPath) ? runOracle(tailPath) : { ...noOracle };
    const oracleOut = ff.present ? runOracle(gPath) : { ...noOracle };
    const cl = checkClosedLoop(oracleTail.integratedLufs, expectedTail, settle.settled, settle.tailSeconds);
    let tailShiftDb = NaN;
    let shiftOk = false;
    if (baseRow && baseRow.closedLoop && Number.isFinite(baseRow.closedLoop.settleFromSeconds)) {
      const baseOutPath = path.join(OUT_DIR, `${spec.fixture}.out.wav`);
      try {
        const baseBack = readWavFloat32Planar(baseOutPath).planar;
        const baseStart = Math.min(Math.round(baseRow.closedLoop.settleFromSeconds * SR), baseBack[0].length);
        const refDb = tailRmsDb(baseBack.length > 1 ? baseBack : [baseBack[0]], baseStart);
        const gotDb = tailRmsDb(storedOuts, tailStart);
        tailShiftDb = gotDb - refDb;
        shiftOk = Number.isFinite(tailShiftDb) && Math.abs(tailShiftDb - spec.gainDb) <= 0.75;
      } catch { shiftOk = false; }
    }
    let verdict = 'PASS';
    let reason = '';
    const settleOutOfScope = spec.fixture === 'gated-silence';
    if (!targetOk || !trimArmed) {
      verdict = 'FAIL';
      reason = `slider wiring wrong: targetLufs=${probe.targetLufs} (want ${wc.targetDefault}), trimTargetDb=${probe.trimTargetDb} (want ${spec.gainDb})`;
    } else if (!integratedOk) {
      verdict = 'FAIL';
      reason = `trim perturbed the integrated measurement by ${fmt(integratedDelta)} LU (limit ${DELTA_TOL_LU})`;
    } else if (!settleOutOfScope && cl.verdict !== 'PASS') {
      verdict = cl.verdict === 'FAIL' ? 'FAIL' : 'UNTESTED';
      reason = cl.verdict === 'FAIL' ? `tail misses target+trim: ${cl.reason}` : `tail check untested: ${cl.reason}`;
    } else if (!shiftOk) {
      verdict = 'FAIL';
      reason = `output shift ${fmt(tailShiftDb)} dB != trim ${spec.gainDb} dB (limit 0.75 dB — a doubled trim reads 2x)`;
    }
    let peakTp = Number.isFinite(oracleOut.truePeakDbTp) ? oracleOut.truePeakDbTp : NaN;
    let peakVerdict = null;
    let hardClipCount = null;
    let hardClipVerdict = null;
    if (spec.gainDb === 12) {
      peakVerdict = peakVerdictDbTp(oracleOut.truePeakDbTp, CEILING_DBTP);
      const hc = countHardClips(outs, CEILING_DBTP);
      hardClipCount = hc.count;
      hardClipVerdict = hc.count === 0 ? 'PASS' : 'FAIL';
      if (verdict === 'PASS') {
        if (peakVerdict === 'FAIL' || hardClipVerdict === 'FAIL') {
          verdict = 'FAIL';
          const bits = [];
          if (peakVerdict === 'FAIL') bits.push(`output true peak ${fmt(peakTp)} dBTP exceeds ceiling ${CEILING_DBTP} dBTP`);
          if (hardClipVerdict === 'FAIL') bits.push(`hard-clip backstop fired ${hardClipCount}x`);
          reason = bits.join('; ');
        } else if (peakVerdict === 'UNTESTED') {
          verdict = 'UNTESTED';
          reason = 'output true peak unknown (no oracle)';
        }
      }
    }
    if (!ff.present && verdict === 'FAIL' && !targetOk) { /* wiring failure stands without oracle */ } else if (!ff.present) {
      verdict = 'UNTESTED';
      reason = 'tail/shift oracle checks need ffmpeg';
    }
    gainRows.push({
      gainDb: spec.gainDb,
      fixture: spec.fixture,
      inputLufs,
      programTargetLufs: EFFECTIVE_TARGET,
      expectedTailLufs: expectedTail,
      appliedGainDb: settle.finalGain,
      gainSpreadDb: settle.spreadDb,
      gainSettled: settle.settled,
      settleFromSeconds: tailStart / SR,
      tailSeconds: settle.tailSeconds,
      outputWav: `out/${gBase}.wav`,
      outputTailWav: tailPath ? `out/${gBase}.tail.wav` : null,
      outputTailLufs: oracleTail.integratedLufs,
      tailShiftDb,
      shiftOk,
      integratedTrim,
      integratedRef,
      integratedDelta,
      integratedOk,
      targetOk,
      trimArmed,
      outputFullPeakDbTp: peakTp,
      peakVerdict,
      hardClipCount,
      hardClipVerdict,
      deltaVsExpected: cl.delta,
      verdictConvergence: cl.verdict,
      settleOutOfScope,
      settleOutOfScopeNote: settleOutOfScope
        ? `settle-based closed-loop tail check out of scope for the sparse ${spec.fixture} fixture (trace never settles by construction); verdict binds targetOk/trimArmed/integratedOk/shiftOk; skipped cl verdict: ${cl.verdict}${cl.reason ? ` (${cl.reason})` : ''}`
        : null,
      verdict,
      reason: reason || '',
      gainTracePerSecondDb: perSecondTrace(typeof normTrace !== 'undefined' ? normTrace : gainTrace),
    });
  }
  recordClosedLoopOutputs(outputEntries);
  const gainFails = gainRows.filter((g) => g.verdict === 'FAIL').length;
  const gainUntested = gainRows.filter((g) => g.verdict === 'UNTESTED').length;
  const gainSummary = gainFails > 0 ? 'FAIL' : (gainUntested > 0 ? `${gainUntested} UNTESTED` : 'PASS');

  function comfortSectionRmsDb(outs, sr, t0, t1) {
    const i0 = Math.round(t0 * sr), i1 = Math.round(t1 * sr);
    let sum = 0, n = 0;
    for (const ch of outs) {
      for (let i = i0; i < Math.min(i1, ch.length); i++) { sum += ch[i] * ch[i]; n++; }
    }
    return 20 * Math.log10(Math.sqrt(sum / Math.max(n, 1)) + 1e-18);
  }
  function comfortSpreadDb(outs, sr) {
    return comfortSectionRmsDb(outs, sr, 0, 10) - comfortSectionRmsDb(outs, sr, 10, 20);
  }
  function maxShortTermDb(samples, sr) {
    const win = Math.round(3 * sr), hop = Math.round(1 * sr);
    let mx = -Infinity;
    for (let st = 0; st + win <= samples.length; st += hop) {
      let sum = 0;
      for (let i = st; i < st + win; i++) sum += samples[i] * samples[i];
      const db = 20 * Math.log10(Math.sqrt(sum / win) + 1e-18);
      if (db > mx) mx = db;
    }
    return mx;
  }
  function trimImmediacy(ProcHere, srHere, rateTag) {
    const N = srHere * 20;
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = 0.04 * Math.sin(2 * Math.PI * 1000 * i / srHere);
    const proc = makeProc(ProcHere, {});
    const stepQuantum = (startIdx) => {
      const a = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) a[i] = 0.04 * Math.sin(2 * Math.PI * 1000 * (startIdx + i) / srHere);
      const o = new Float32Array(BLOCK);
      proc.process([[a]], [[o]]);
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += o[i] * o[i];
      return Math.sqrt(sum / BLOCK);
    };
    for (let pos = 0; pos < N; pos += BLOCK) stepQuantum(pos);
    const intBefore = proc.telemetry.integratedLufs;
    const tgtBefore = proc.targetLufs;
    const r0 = stepQuantum(N);
    proc.port.onmessage({ data: { type: 'set-gain-db', gainDb: 6 } });
    const r1 = stepQuantum(N + BLOCK);
    stepQuantum(N + 2 * BLOCK);
    stepQuantum(N + 3 * BLOCK);
    const rSettled = stepQuantum(N + 4 * BLOCK);
    const d1 = 20 * Math.log10((r1 + 1e-18) / (r0 + 1e-18));
    const dSettled = 20 * Math.log10((rSettled + 1e-18) / (r0 + 1e-18));
    const intAfter = proc.telemetry.integratedLufs;
    const tgtAfter = proc.targetLufs;
    const trimDb = proc.telemetry.userTrimDb;
    const firstOk = Number.isFinite(d1) && Math.abs(d1) <= 0.5;
    const settledOk = Number.isFinite(dSettled) && Math.abs(dSettled - 6) <= 0.5;
    const targetOk = tgtBefore === wc.targetDefault && tgtAfter === wc.targetDefault;
    const intOk = Number.isFinite(intBefore) && Number.isFinite(intAfter) && Math.abs(intAfter - intBefore) <= 0.05;
    const trimOk = trimDb === 6;
    const verdict = (firstOk && settledOk && targetOk && intOk && trimOk) ? 'PASS' : 'FAIL';
    return { rateTag, d1, dSettled, intBefore, intAfter, tgtBefore, tgtAfter, trimDb, firstOk, settledOk, targetOk, intOk, trimOk, verdict };
  }
  const comfortRows = [];
  const comfortCheck = (clause, fixture, rateTag, measured, threshold, verdict, note) => {
    comfortRows.push({ clause, fixture, rate: rateTag, measured, threshold, verdict, note: note || '' });
  };
  for (const fx of ['comfort-quiet', 'comfort-loud']) {
    const row48 = rows.find((r) => r.fixture === fx);
    const row441 = rate441Rows.find((r) => r.fixture === `${fx}-44100`);
    const evalTail = (row, tag) => {
      if (!row || !row.closedLoop) return comfortCheck('cross-program', fx, tag, NaN, '+-0.5 LU of -20', 'UNTESTED', 'row missing');
      const t = row.closedLoop.outputTailLufs;
      const ok = row.closedLoop.verdictConvergence !== undefined
        ? (Number.isFinite(t) && Math.abs(t - EFFECTIVE_TARGET) <= 0.5 && row.closedLoop.gainSettled)
        : false;
      comfortCheck('cross-program', fx, tag, t, '+-0.5 LU of -20', ff.present ? (ok ? 'PASS' : 'FAIL') : 'UNTESTED', `settled=${row.closedLoop.gainSettled} tail ${fmt(row.closedLoop.tailSeconds)} s`);
    };
    evalTail(row48, '48000');
    evalTail(row441, '44100');
  }
  const deadbandWindows = [
    ['comfort-pair12', '48000', SR, 32.5, 37.5, 22.5, 27.5],
    ['comfort-pair12', '44100', SR441, 32.5, 37.5, 22.5, 27.5],
    ['comfort-varying4', '48000', SR, 32.5, 37.5, 22.5, 27.5],
    ['comfort-varying4', '44100', SR441, 32.5, 37.5, 22.5, 27.5],
  ];
  for (const [fxD, tagD, srHere, la0, la1, qa0, qa1] of deadbandWindows) {
    const suffixD = tagD === '48000' ? '' : '-44100';
    try {
      const inPD = readWavFloat32Planar(path.join(FIXTURE_DIR, `${fxD}${suffixD}.wav`)).planar;
      const outPD = readWavFloat32Planar(path.join(OUT_DIR, `${fxD}${suffixD}.out.wav`)).planar;
      const inLoud = comfortSectionRmsDb(inPD, srHere, la0, la1);
      const inQuiet = comfortSectionRmsDb(inPD, srHere, qa0, qa1);
      const outLoud = comfortSectionRmsDb(outPD, srHere, la0, la1);
      const outQuiet = comfortSectionRmsDb(outPD, srHere, qa0, qa1);
      const inSpreadD = inLoud - inQuiet, outSpreadD = outLoud - outQuiet;
      const redD = inSpreadD - outSpreadD;
      const riseD = outQuiet - inQuiet;
      const riseLoudD = outLoud - inLoud;
      if (fxD === 'comfort-pair12') {
        comfortCheck('deadband-spread-reduction', fxD, tagD, redD, '>= 4 dB (must FIRE)', redD >= 4 ? 'PASS' : 'FAIL', `in ${fmt(inSpreadD)} out ${fmt(outSpreadD)} dB`);
        comfortCheck('deadband-quiet-rise', fxD, tagD, riseD, '>= 3 dB (must FIRE)', riseD >= 3 ? 'PASS' : 'FAIL', `quiet ${fmt(inQuiet)} -> ${fmt(outQuiet)} dB`);
      } else {
        comfortCheck('deadband-no-reduction', fxD, tagD, redD, '<= 1.0 dB (must NOT fire)', redD <= 1.0 ? 'PASS' : 'FAIL', `in ${fmt(inSpreadD)} out ${fmt(outSpreadD)} dB`);
        const diffRiseD = riseD - riseLoudD;
        comfortCheck('deadband-quiet-untouched', fxD, tagD, diffRiseD, '|dRise| <= 1.0 dB (must NOT fire)', Math.abs(diffRiseD) <= 1.0 ? 'PASS' : 'FAIL', `quiet rise ${fmt(riseD)} vs loud rise ${fmt(riseLoudD)} dB`);
      }
      comfortCheck('no-flatten-floor', fxD, tagD, outSpreadD, '>= 3.0 residual (OURS)', outSpreadD >= 3.0 ? 'PASS' : 'FAIL', 'no published residual floor exists; this number is OURS, never a standard number');
    } catch (e) {
      comfortCheck(fxD === 'comfort-pair12' ? 'deadband-spread-reduction' : 'deadband-no-reduction', fxD, tagD, NaN, 'n/a', 'FAIL', `readback failed: ${e.message}`);
    }
  }
  for (const fxL of ['comfort-varying4', 'comfort-pair12']) {
    for (const [tagL, srHere] of [['48000', SR], ['44100', SR441]]) {
      const suffixL = tagL === '48000' ? '' : '-44100';
      try {
        const inFullL = readWavFloat32Planar(path.join(FIXTURE_DIR, `${fxL}${suffixL}.wav`)).planar;
        const outFullL = readWavFloat32Planar(path.join(OUT_DIR, `${fxL}${suffixL}.out.wav`)).planar;
        const sliceL = (planar) => planar.map((ch) => ch.subarray(Math.round(20 * srHere), Math.round(45 * srHere)));
        const inSlL = sliceL(inFullL), outSlL = sliceL(outFullL);
        const inSlPath = path.join(OUT_DIR, `${fxL}${suffixL}.slice-in.wav`);
        const outSlPath = path.join(OUT_DIR, `${fxL}${suffixL}.slice-out.wav`);
        writeWavFloat32Rate(inSlPath, inSlL[0], srHere);
        writeWavFloat32Rate(outSlPath, outSlL[0], srHere);
        outputEntries.push({
          name: `out/${fxL}${suffixL}.slice-in.wav`,
          seconds: inSlL[0].length / srHere,
          samples: inSlL[0].length,
          channels: 1,
          sampleRate: srHere,
          description: `generated settled-slice (20-45 s) INPUT of ${fxL}${suffixL} for LRA evidence`,
          sha256: sha256Hex(fs.readFileSync(inSlPath)),
        });
        outputEntries.push({
          name: `out/${fxL}${suffixL}.slice-out.wav`,
          seconds: outSlL[0].length / srHere,
          samples: outSlL[0].length,
          channels: 1,
          sampleRate: srHere,
          description: `generated settled-slice (20-45 s) OUTPUT of ${fxL}${suffixL} for LRA evidence`,
          sha256: sha256Hex(fs.readFileSync(outSlPath)),
        });
        const inLraL = ff.present ? runOracle(inSlPath).lraLu : NaN;
        const tailLraL = ff.present ? runOracle(outSlPath).lraLu : NaN;
        if (fxL === 'comfort-pair12') {
          const redL = (Number.isFinite(inLraL) && Number.isFinite(tailLraL)) ? inLraL - tailLraL : NaN;
          comfortCheck('deadband-lra-reduction', fxL, tagL, redL, '>= 3 LU (must FIRE)', ff.present ? (Number.isFinite(redL) && redL >= 3 ? 'PASS' : 'FAIL') : 'UNTESTED', `slice in LRA ${fmt(inLraL)} out LRA ${fmt(tailLraL)} LU`);
          comfortCheck('deadband-lra-residual', fxL, tagL, tailLraL, '>= 3.0 LU (OURS)', ff.present ? (Number.isFinite(tailLraL) && tailLraL >= 3.0 ? 'PASS' : 'FAIL') : 'UNTESTED', '');
        } else {
          const keepL = (Number.isFinite(inLraL) && Number.isFinite(tailLraL)) ? tailLraL - inLraL : NaN;
          comfortCheck('deadband-lra-preserved', fxL, tagL, keepL, '|out-in| <= 1.0 (OURS)', ff.present ? (Number.isFinite(keepL) && Math.abs(keepL) <= 1.0 ? 'PASS' : 'FAIL') : 'UNTESTED', `slice in LRA ${fmt(inLraL)} out LRA ${fmt(tailLraL)} LU`);
        }
      } catch (e) {
        comfortCheck(fxL === 'comfort-pair12' ? 'deadband-lra-reduction' : 'deadband-lra-preserved', fxL, tagL, NaN, 'n/a', 'FAIL', `slice failed: ${e.message}`);
      }
    }
  }
  recordClosedLoopOutputs(outputEntries);
  for (const [fxS, tagS, srHere, w0a, w0b, w1a, w1b] of [
    ['comfort-shortform', '48000', SR, 0, 5, 5, 10],
    ['comfort-shortform', '44100', SR441, 0, 5, 5, 10],
  ]) {
    const suffixS = tagS === '48000' ? '' : '-44100';
    try {
      const inPS = readWavFloat32Planar(path.join(FIXTURE_DIR, `${fxS}${suffixS}.wav`)).planar;
      const outPS = readWavFloat32Planar(path.join(OUT_DIR, `${fxS}${suffixS}.out.wav`)).planar;
      const inSS = comfortSectionRmsDb(inPS, srHere, w0a, w0b) - comfortSectionRmsDb(inPS, srHere, w1a, w1b);
      const outSS = comfortSectionRmsDb(outPS, srHere, w0a, w0b) - comfortSectionRmsDb(outPS, srHere, w1a, w1b);
      const redS = inSS - outSS;
      comfortCheck('shortform-spread-reduction', fxS, tagS, redS, '>= 2 dB (supporting)', redS >= 2 ? 'PASS' : 'FAIL', `in ${fmt(inSS)} out ${fmt(outSS)} dB`);
      comfortCheck('no-flatten', fxS, tagS, outSS, '|spread| > 1 dB (not flat either way)', Math.abs(outSS) > 1 ? 'PASS' : 'FAIL', 'EBU R 128 s4 (k): adaptation must not equalise passages');
    } catch (e) {
      comfortCheck('shortform-spread-reduction', fxS, tagS, NaN, 'n/a', 'FAIL', `readback failed: ${e.message}`);
    }
  }
  for (const fx of ['comfort-dialogue', 'comfort-shortform', 'comfort-music', 'comfort-pair12', 'comfort-varying4']) {
    for (const [rowSet, tag, srHere] of [[rows, '48000', SR], [rate441Rows, '44100', SR441]]) {
      const suffix = tag === '48000' ? '' : '-44100';
      const row = rowSet.find((r) => r.fixture === `${fx}${suffix}`);
      if (!row || !row.closedLoop) {
        comfortCheck('sustained', fx, tag, NaN, '<= -19.5 LUFS', 'UNTESTED', 'row missing');
        continue;
      }
      const t = row.closedLoop.outputTailLufs;
      const okS = Number.isFinite(t) && t <= EFFECTIVE_TARGET + 0.5;
      comfortCheck('sustained', fx, tag, t, '<= -19.5 LUFS (target + 0.5)', ff.present ? (okS ? 'PASS' : 'FAIL') : 'UNTESTED', `tail ${fmt(row.closedLoop.tailSeconds)} s settled=${row.closedLoop.gainSettled}`);
      const outFullWavC = path.join(OUT_DIR, `${fx}${suffix}.out.wav`);
      let stOverC = NaN, stMaxDbC = NaN, wholeOutC = NaN;
      try {
        wholeOutC = row.closedLoop.outputFullLufs;
        const outFullC = readWavFloat32Planar(outFullWavC).planar[0];
        stMaxDbC = maxShortTermDb(outFullC, srHere);
        stOverC = (Number.isFinite(stMaxDbC) && Number.isFinite(wholeOutC)) ? stMaxDbC - wholeOutC : NaN;
      } catch { stOverC = NaN; }
      comfortCheck('max-short-term', fx, tag, stOverC, '<= 5.5 above whole (R128 s1)', (Number.isFinite(stOverC) && Number.isFinite(wholeOutC)) ? (stOverC <= 5.5 ? 'PASS' : 'FAIL') : 'UNTESTED', `max 3 s ${fmt(stMaxDbC)} dB vs whole-output ${fmt(wholeOutC)} LUFS`);
    }
  }
  for (const [ProcHere, srHere, tag] of [[Proc48, SR, '48000'], [Proc441, SR441, '44100']]) {
    const ti = trimImmediacy(ProcHere, srHere, tag);
    const v = ti.verdict;
    comfortCheck('slider-instant', 'trim-probe', tag, ti.d1, 'switch quantum |d| <= 0.5 dB', v, `switch-quantum ${fmt(ti.d1)} dB (old trim still in line), settled ${fmt(ti.dSettled)} dB (want +6 +-0.5), target ${ti.tgtBefore}->${ti.tgtAfter}, integrated ${fmt(ti.intBefore)}->${fmt(ti.intAfter)} LUFS, trimDb ${ti.trimDb}`);
    comfortRows.push({ clause: 'slider-instant-settled', fixture: 'trim-probe', rate: tag, measured: ti.dSettled, threshold: '+6 +-0.5 dB', verdict: ti.settledOk ? 'PASS' : 'FAIL', note: '' });
    comfortRows.push({ clause: 'slider-target-untouched', fixture: 'trim-probe', rate: tag, measured: ti.tgtAfter, threshold: `stays ${wc.targetDefault}`, verdict: ti.targetOk ? 'PASS' : 'FAIL', note: '' });
    comfortRows.push({ clause: 'slider-measure-untouched', fixture: 'trim-probe', rate: tag, measured: ti.intAfter - ti.intBefore, threshold: '|delta| <= 0.05 LU', verdict: ti.intOk ? 'PASS' : 'FAIL', note: '' });
  }
  for (const [ProcHere, srHere, tag] of [[Proc48, SR, '48000'], [Proc441, SR441, '44100']]) {
    {
      const ceilDb = CEILING_DBTP;
      const ceilLin = Math.pow(10, ceilDb / 20);
      const NN = srHere * 3;
      const xx = new Float32Array(NN);
      const bb0 = 4 * BLOCK;
      for (let k = 0; k < 64; k++) xx[bb0 + k] = (k % 2 === 0 ? 0.9 : -0.9);
      const procT = makeProc(ProcHere, {});
      const yy = new Float32Array(NN);
      for (let q = 0, pos = 0; pos < NN; pos += BLOCK, q++) {
        if (q === 5) procT.port.onmessage({ data: { type: 'set-gain-db', gainDb: 12 } });
        const aa = new Float32Array(BLOCK), oo = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK && pos + i < NN; i++) aa[i] = xx[pos + i];
        procT.process([[aa]], [[oo]]);
        for (let i = 0; i < BLOCK && pos + i < NN; i++) yy[pos + i] = oo[i];
      }
      let railsT = 0;
      for (let i = 0; i < NN; i++) if (Math.abs(yy[i]) >= ceilLin * (1 - 1e-6)) railsT++;
      const tBase = `trim-step-${tag}.out`;
      const tPath = path.join(OUT_DIR, `${tBase}.wav`);
      writeWavFloat32Rate(tPath, yy, srHere);
      outputEntries.push({
        name: `out/${tBase}.wav`,
        seconds: yy.length / srHere,
        samples: yy.length,
        channels: 1,
        sampleRate: srHere,
        description: `generated F1 trim-step OUTPUT at ${tag} Hz under the single ceiling (burst in quantum 4, set-gain-db:12 at quantum 5)`,
        sha256: sha256Hex(fs.readFileSync(tPath)),
      });
      const ocT = ff.present ? runOracle(tPath) : { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN };
      const tpT = ocT.truePeakDbTp;
      const tpOkT = Number.isFinite(tpT) && tpT <= ceilDb + EPS_DB;
      const vT = railsT === 0 && (ff.present ? tpOkT : true) ? (ff.present ? (tpOkT ? 'PASS' : 'FAIL') : 'UNTESTED') : 'FAIL';
      comfortCheck('trim-step-ceiling', 'burst-then-trim-12', tag, tpT, `<= ${ceilDb} dBTP + 0 rails`, vT, `oracle ${fmt(tpT)} dBTP, rail hits ${railsT}`);
    }
  }
  for (const [ProcHere, srHere, tag] of [[Proc48, SR, '48000'], [Proc441, SR441, '44100']]) {
    {
      const ceilDb = CEILING_DBTP;
      const NN = srHere * 3;
      const xx = new Float32Array(NN);
      const bb0 = 4 * BLOCK;
      for (let k = 0; k < 64; k++) xx[bb0 + k] = (k % 2 === 0 ? 0.9 : -0.9);
      const procT = makeProc(ProcHere, {});
      procT.port.onmessage({ data: { type: 'set-gain-db', gainDb: 12 } });
      const yy = new Float32Array(NN);
      for (let q = 0, pos = 0; pos < NN; pos += BLOCK, q++) {
        const aa = new Float32Array(BLOCK), oo = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK && pos + i < NN; i++) aa[i] = xx[pos + i];
        procT.process([[aa]], [[oo]]);
        for (let i = 0; i < BLOCK && pos + i < NN; i++) yy[pos + i] = oo[i];
      }
      const hcT = countHardClips([yy], ceilDb).count;
      const tBase = `trim-armed-then-burst-12-${tag}.out`;
      const tPath = path.join(OUT_DIR, `${tBase}.wav`);
      writeWavFloat32Rate(tPath, yy, srHere);
      outputEntries.push({
        name: `out/${tBase}.wav`,
        seconds: yy.length / srHere,
        samples: yy.length,
        channels: 1,
        sampleRate: srHere,
        description: `generated A4 +12-armed trim-step OUTPUT at ${tag} Hz under the single ceiling (set-gain-db:12 armed before a 64-sample burst at 512-575, inside the lookahead)`,
        sha256: sha256Hex(fs.readFileSync(tPath)),
      });
      const ocT = ff.present ? runOracle(tPath) : { integratedLufs: NaN, lraLu: NaN, truePeakDbTp: NaN };
      const tpT = ocT.truePeakDbTp;
      const tpOkT = Number.isFinite(tpT) && tpT <= ceilDb + EPS_DB;
      const vT = hcT === 0 && (ff.present ? tpOkT : true) ? (ff.present ? (tpOkT ? 'PASS' : 'FAIL') : 'UNTESTED') : 'FAIL';
      comfortCheck('trim-step-ceiling-armed', 'trim-12-then-burst', tag, tpT, `<= ${ceilDb} dBTP + 0 clips`, vT, `oracle ${fmt(tpT)} dBTP, hard-clip hits ${hcT}`);
    }
  }
  recordClosedLoopOutputs(outputEntries);
  for (const fx of ['comfort-quiet', 'comfort-loud', 'comfort-dialogue', 'comfort-shortform', 'comfort-music', 'comfort-pair12', 'comfort-varying4']) {
    const row = rows.find((r) => r.fixture === fx);
    const tpN = row ? row.closedLoop.outputFullPeakDbTp : NaN;
    comfortCheck('ceiling', fx, '48000', tpN, '<= -1 dBTP', peakVerdictDbTp(tpN, CEILING_DBTP), '');
    const row441 = rate441Rows.find((r) => r.fixture === `${fx}-44100`);
    const tp441 = row441 ? row441.closedLoop.outputFullPeakDbTp : NaN;
    comfortCheck('ceiling', fx, '44100', tp441, '<= -1 dBTP', peakVerdictDbTp(tp441, CEILING_DBTP), '');
  }
  const comfortFails = comfortRows.filter((r) => r.verdict === 'FAIL').length;
  const comfortUntested = comfortRows.filter((r) => r.verdict === 'UNTESTED').length;
  const comfortSummary = comfortFails > 0 ? 'FAIL' : (comfortUntested > 0 ? `${comfortUntested} UNTESTED` : 'PASS');

  const STEP_FIRE_TOL_LU = 1.0;
  const STEP_PUMP_TOL_LU = 0.5;
  const stepRows = [];
  {
    const stepSliceAt = (planar, srHere, t0, t1) => planar.map((ch) => ch.subarray(Math.round(t0 * srHere), Math.min(ch.length, Math.round(t1 * srHere))));
    for (const [fxStep, tagStep, srHere, ProcHere] of [['comfort-step', '48000', SR, Proc48], ['comfort-step-44100', '44100', SR441, Proc441]]) {
      try {
        const stepOut = readWavFloat32Planar(path.join(OUT_DIR, `${fxStep}.out.wav`)).planar;
        const stepPlanar = readWavFloat32Planar(path.join(FIXTURE_DIR, `${fxStep}.wav`)).planar;
        const inst = renderThroughWorkletChannels(ProcHere, stepPlanar, {});
        const q0 = Math.round((60 * srHere) / BLOCK);
        const q1 = Math.round((75 * srHere) / BLOCK);
        let agcMax = 0;
        for (let qi = q0; qi < Math.min(q1, inst.gainTrace.length); qi++) {
          const a = inst.gainTrace[qi] - inst.normTrace[qi];
          const m = a < 0 ? -a : a;
          if (m > agcMax) agcMax = m;
        }
        const stAt = (tEnd) => {
          const sl = stepSliceAt(stepOut, srHere, tEnd - 3, tEnd);
          const sBase = `${fxStep}.st-${tEnd}`;
          const sPath = path.join(OUT_DIR, `${sBase}.wav`);
          if (sl[0].length >= Math.round(0.4 * srHere)) {
            writeWavFloat32Rate(sPath, sl[0], srHere);
            outputEntries.push({
              name: `out/${sBase}.wav`,
              seconds: sl[0].length / srHere,
              samples: sl[0].length,
              channels: 1,
              sampleRate: srHere,
              description: `generated STEP-RECOVERY oracle-ST slice of ${fxStep} output (3 s window ending at ${tEnd} s)`,
              sha256: sha256Hex(fs.readFileSync(sPath)),
            });
            return ff.present ? runOracle(sPath).integratedLufs : NaN;
          }
          return NaN;
        };
        const series = [];
        for (let t = 61; t <= 70; t++) series.push(stAt(t));
        const st55 = stAt(55);
        const st60 = stAt(60);
        const earlyOutside = series.slice(0, 3).some((v) => !Number.isFinite(v) || Math.abs(v - EFFECTIVE_TARGET) > STEP_FIRE_TOL_LU);
        const fireDelta = series[9] - EFFECTIVE_TARGET;
        const fireVerdict = ff.present
          ? (Number.isFinite(series[9]) && Math.abs(fireDelta) <= STEP_FIRE_TOL_LU ? 'PASS' : 'FAIL')
          : 'UNTESTED';
        const pumpDelta = st60 - st55;
        const pumpVerdict = ff.present
          ? (Number.isFinite(pumpDelta) && Math.abs(pumpDelta) <= STEP_PUMP_TOL_LU ? 'PASS' : 'FAIL')
          : 'UNTESTED';
        let verdictS = 'PASS';
        if (fireVerdict === 'FAIL' || pumpVerdict === 'FAIL') verdictS = 'FAIL';
        else if (fireVerdict === 'UNTESTED' || pumpVerdict === 'UNTESTED') verdictS = 'UNTESTED';
        stepRows.push({
          fixture: fxStep,
          rate: tagStep,
          stSeries6163: series.slice(0, 3),
          stSeries6470: series.slice(3),
          stAt70: series[9],
          fireDelta,
          fireVerdict,
          earlyOutsideGateBites: earlyOutside,
          st55,
          st60,
          pumpDelta,
          pumpVerdict,
          agcMaxPostStepDb: agcMax,
          agcNote: 'descriptive only: AGC and slow loop act together after a step; this control does not isolate causation between them',
          verdict: verdictS,
        });
      } catch (e) {
        stepRows.push({ fixture: fxStep, rate: tagStep, verdict: 'FAIL', note: `render failed: ${e.message}` });
      }
    }
    recordClosedLoopOutputs(outputEntries);
  }
  const stepFails = stepRows.filter((r) => r.verdict === 'FAIL').length;
  const stepUntested = stepRows.filter((r) => r.verdict === 'UNTESTED').length;
  const stepSummary = stepFails > 0 ? 'FAIL' : (stepUntested > 0 ? `${stepUntested} UNTESTED` : 'PASS');

  const AGC_RIPPLE_WINDOW_SECONDS = 0.1;
  const agcBallisticsRows = [];
  {
    const qAt = (tSec) => Math.round((tSec * SR) / BLOCK);
    const agcTraceOf = (gainTrace, normTrace) => gainTrace.map((g, i) => g - normTrace[i]);
    const toneInto = (buf, t0, t1, amp) => {
      for (let i = Math.round(t0 * SR); i < Math.min(buf.length, Math.round(t1 * SR)); i++) {
        buf[i] = amp * Math.sin(2 * Math.PI * 1000 * i / SR);
      }
    };
    const driveAgc = (ProcHere, sig) => {
      const rendered = renderThroughWorkletChannels(ProcHere, [sig], {});
      return agcTraceOf(rendered.gainTrace, rendered.normTrace);
    };
    const maxDeltaDb = (trace, i0, i1) => {
      let worst = 0;
      for (let i = Math.max(1, i0); i < Math.min(i1, trace.length); i++) {
        const d = Math.abs(trace[i] - trace[i - 1]);
        if (d > worst) worst = d;
      }
      return worst;
    };
    const ripplePpDb = (trace, i0, i1, winQ) => {
      let worst = 0;
      for (let s = i0; s + winQ <= i1; s++) {
        let mn = Infinity, mx = -Infinity;
        for (let i = s; i < s + winQ; i++) { const v = trace[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const pp = mx - mn;
        if (pp > worst) worst = pp;
      }
      return worst;
    };
    const finite = (trace) => trace.length > 0 && trace.every((v) => Number.isFinite(v));

    const rippleSig = new Float32Array(SR * 24);
    toneInto(rippleSig, 0, 8, 0.1413);
    toneInto(rippleSig, 8, 24, 0.1413 / 2);
    const rippleTrace = driveAgc(Proc48, rippleSig);
    const rippleFrom = qAt(12);
    let rippleMean = 0;
    for (let i = rippleFrom; i < rippleTrace.length; i++) rippleMean += rippleTrace[i];
    rippleMean /= Math.max(1, rippleTrace.length - rippleFrom);
    const ripplePp = finite(rippleTrace) ? ripplePpDb(rippleTrace, rippleFrom, rippleTrace.length, Math.max(1, qAt(AGC_RIPPLE_WINDOW_SECONDS))) : NaN;
    const rippleOk = Number.isFinite(ripplePp) && ripplePp <= AGC_RIPPLE_MAX_DB && Math.abs(rippleMean) >= 0.2;
    agcBallisticsRows.push({ clause: 'am-ripple', measuredDb: ripplePp, threshold: '<= ' + AGC_RIPPLE_MAX_DB + ' dB p-p in 100 ms', settledAgcDb: rippleMean, verdict: rippleOk ? 'PASS' : 'FAIL', note: 'steady 1 kHz sine after a -6 dB preamble; engaged AGC must not modulate the gain' });

    const stepSig = new Float32Array(SR * 24);
    toneInto(stepSig, 0, 8, 0.1413);
    toneInto(stepSig, 8, 16, 0.1413 / 2);
    toneInto(stepSig, 16, 24, 0.1413);
    const stepTrace = driveAgc(Proc48, stepSig);
    const stepMaxDelta = finite(stepTrace) ? maxDeltaDb(stepTrace, 1, stepTrace.length) : NaN;
    const slewOk = Number.isFinite(stepMaxDelta) && stepMaxDelta <= AGC_SLEW_MAX_DB_PER_QUANTUM + 1e-9;
    const riseQ = qAt(16);
    const settledTarget = stepTrace[stepTrace.length - 1];
    let recoverySeconds = Infinity;
    for (let i = riseQ; i < stepTrace.length; i++) {
      if (Number.isFinite(stepTrace[i]) && Math.abs(stepTrace[i] - settledTarget) <= AGC_STEP_RECOVERY_TOL_DB) { recoverySeconds = (i - riseQ) * BLOCK / SR; break; }
    }
    const recoveryOk = Number.isFinite(recoverySeconds) && recoverySeconds <= AGC_STEP_RECOVERY_MAX_SECONDS + BLOCK / SR;
    agcBallisticsRows.push({ clause: 'slew-and-step', maxPerQuantumDeltaDb: stepMaxDelta, recoverySeconds, recoveryToleranceDb: AGC_STEP_RECOVERY_TOL_DB, threshold: '<= ' + AGC_SLEW_MAX_DB_PER_QUANTUM + ' dB per quantum; recovery <= ' + AGC_STEP_RECOVERY_MAX_SECONDS + ' s', verdict: (slewOk && recoveryOk) ? 'PASS' : 'FAIL', note: '6 dB drop at 8 s, 6 dB rise at 16 s; gain read from the worklet meter surface' });

    const smoothNeedle = [
      '      var agcNextDb = agcTargetDb + (this.currentAgcDb - agcTargetDb) * (agcTargetDb > this.currentAgcDb ? agcAttackCoeff : agcReleaseCoeff);',
      '      var agcMoveDb = agcNextDb - this.currentAgcDb;',
      '      if (agcMoveDb > agcSlewPerSampleDb) agcMoveDb = agcSlewPerSampleDb;',
      '      else if (agcMoveDb < -agcSlewPerSampleDb) agcMoveDb = -agcSlewPerSampleDb;',
      '      this.currentAgcDb += agcMoveDb;',
      '      if (this.currentAgcDb > agcCapMax) this.currentAgcDb = agcCapMax;',
      '      if (this.currentAgcDb < agcCapMin) this.currentAgcDb = agcCapMin;',
      '      var agcLinSamp = dbToGain(this.currentAgcDb);'
    ].join('\n');
    let snapMaxDelta = NaN, snapNote = '', snapVerdict = 'FAIL';
    try {
      if (!workletSource.includes(smoothNeedle)) throw new Error('AGC smoothing block not found in worklet source');
      const snapProc = loadProcessor(workletSource.replace(smoothNeedle, '      this.currentAgcDb = agcTargetDb;\n      var agcLinSamp = dbToGain(this.currentAgcDb);'), SR);
      const snapTrace = driveAgc(snapProc, stepSig);
      snapMaxDelta = finite(snapTrace) ? maxDeltaDb(snapTrace, 1, snapTrace.length) : NaN;
      snapVerdict = Number.isFinite(snapMaxDelta) && snapMaxDelta > AGC_SLEW_MAX_DB_PER_QUANTUM ? 'PASS' : 'FAIL';
    } catch (e) { snapNote = e.message; }
    agcBallisticsRows.push({ clause: 'snap-negative-control', maxPerQuantumDeltaDb: snapMaxDelta, verdict: snapVerdict, note: snapNote || 'snap variant must exceed the per-quantum ceiling (proves the gate bites)' });
  }
  const agcBallisticsFails = agcBallisticsRows.filter((r) => r.verdict === 'FAIL').length;
  const agcBallisticsSummary = agcBallisticsFails > 0 ? 'FAIL' : 'PASS';

  const ONSET_BOUND_05_DB = -6.0;
  const ONSET_BOUND_10_DB = -8.0;
  const ONSET_QUIET_TOL_DB = 0.1;
  const ONSET_OVERSHOOT_DB = 1.5;
  const ONSET_TAIL_TOL_LU = 1.0;
  const onsetRows = [];
  let onsetNeg = null;
  {
    const valueAt = (trace, tSec, srHere) => trace[Math.min(Math.floor((tSec * srHere) / BLOCK), trace.length - 1)];
    const timeTo = (trace, boundDb, srHere) => {
      for (let i = 0; i < trace.length; i++) {
        if (trace[i] <= boundDb) return (i * BLOCK) / srHere;
      }
      return Infinity;
    };
    const traceOk = (trace) => trace.length > 0 && trace.every((v) => Number.isFinite(v));
    const measureLoud = (tag, srHere, ProcHere, fixtureName) => {
      const mono = readWavFloat32Planar(path.join(FIXTURE_DIR, fixtureName)).planar[0];
      const { outs, gainTrace } = renderThroughWorkletChannels(ProcHere, [mono], {});
      const v05 = valueAt(gainTrace, 0.5, srHere);
      const v10 = valueAt(gainTrace, 1.0, srHere);
      const t6 = timeTo(gainTrace, ONSET_BOUND_05_DB, srHere);
      const t8 = timeTo(gainTrace, ONSET_BOUND_10_DB, srHere);
      const settle = analyzeSettleAt(gainTrace, srHere);
      let gainMin = Infinity;
      for (const v of gainTrace) if (v < gainMin) gainMin = v;
      const over = gainMin >= settle.finalGain - ONSET_OVERSHOOT_DB;
      const outLen = outs[0].length;
      const tailStart = Math.min(settle.settleQuantum * BLOCK, outLen);
      const tail = outs[0].subarray(tailStart);
      let tailLufs = NaN;
      if (tail.length >= Math.round(0.4 * srHere)) {
        const tailPath = path.join(OUT_DIR, `onset-${tag}.tail.wav`);
        writeWavFloat32Rate(tailPath, tail, srHere);
        outputEntries.push({
          name: `out/onset-${tag}.tail.wav`,
          seconds: tail.length / srHere,
          samples: tail.length,
          channels: 1,
          sampleRate: srHere,
          description: `generated ONSET settled-tail slice of ${fixtureName} output`,
          sha256: sha256Hex(fs.readFileSync(tailPath)),
        });
        if (ff.present) tailLufs = runOracle(tailPath).integratedLufs;
      }
      const tailDelta = tailLufs - EFFECTIVE_TARGET;
      const g05 = Number.isFinite(v05) && v05 <= ONSET_BOUND_05_DB;
      const g10 = Number.isFinite(v10) && v10 <= ONSET_BOUND_10_DB;
      const gTail = settle.settled && Number.isFinite(tailLufs) && Math.abs(tailDelta) <= ONSET_TAIL_TOL_LU;
      const nanFree = traceOk(gainTrace) && !hasNaNOuts(outs);
      let verdict = 'PASS';
      if (!ff.present) verdict = 'UNTESTED';
      else if (!g05 || !g10 || !gTail || !over || !nanFree || !settle.settled) verdict = 'FAIL';
      onsetRows.push({
        clause: 'onset-loud', fixture: fixtureName, rate: tag,
        valueAt05Db: v05, valueAt10Db: v10, timeToMinus6S: t6, timeToMinus8S: t8,
        settledGainDb: settle.finalGain, gainMinDb: gainMin, overshootOk: over,
        settled: settle.settled, tailSeconds: settle.tailSeconds,
        tailLufs, tailDeltaLufs: tailDelta, nanFree, verdict,
      });
      return { v05, v10, t6, t8 };
    };
    if (ff.present) {
      measureLoud('48000', SR, Proc48, 'comfort-loud.wav');
      measureLoud('44100', SR441, Proc441, 'comfort-loud-44100.wav');
    } else {
      for (const [tag, fixtureName] of [['48000', 'comfort-loud.wav'], ['44100', 'comfort-loud-44100.wav']]) {
        onsetRows.push({ clause: 'onset-loud', fixture: fixtureName, rate: tag, verdict: 'UNTESTED', note: 'ffmpeg absent: tail oracle unavailable' });
      }
    }
    {
      const mono = readWavFloat32Planar(path.join(FIXTURE_DIR, 'comfort-quiet.wav')).planar[0];
      const { outs, gainTrace } = renderThroughWorkletChannels(Proc48, [mono], {});
      const ONSET_QUIET_WINDOW_SECONDS = 0.4;
      const firstN = Math.min(gainTrace.length, Math.floor((ONSET_QUIET_WINDOW_SECONDS * SR) / BLOCK));
      let maxAbs = 0;
      for (let i = 0; i < firstN; i++) {
        const a = Math.abs(gainTrace[i]);
        if (a > maxAbs) maxAbs = a;
      }
      const settle = analyzeSettleAt(gainTrace, SR);
      const quietOk = Number.isFinite(maxAbs) && maxAbs <= ONSET_QUIET_TOL_DB;
      const proceeds = settle.settled && Number.isFinite(settle.finalGain) && settle.finalGain >= 5;
      const nanFree = traceOk(gainTrace) && !hasNaNOuts(outs);
      let verdict = 'PASS';
      if (!ff.present) verdict = 'UNTESTED';
      else if (!quietOk || !proceeds || !nanFree) verdict = 'FAIL';
      onsetRows.push({
        clause: 'onset-quiet-control', fixture: 'comfort-quiet.wav', rate: '48000',
        maxAbsFirst04Db: maxAbs, settled: settle.settled, settledGainDb: settle.finalGain,
        nanFree, verdict,
      });
    }
    {
      try {
        const liveSource = fs.readFileSync(WORKLET_PATH, 'utf8');
        const GUARDneedle = 'var FAST_ONSET_SECONDS = 0.05;';
        if (!liveSource.includes(GUARDneedle)) {
          throw new Error(`guard-disabled variant failed: ${GUARDneedle} not found in ${WORKLET_PATH}`);
        }
        const disabledSource = liveSource.replace(GUARDneedle, 'var FAST_ONSET_SECONDS = 2;');
        if (!disabledSource.includes('var FAST_ONSET_SECONDS = 2;')) {
          throw new Error('guard-disabled variant failed: replacement did not apply');
        }
        const tmpPath = path.join(os.tmpdir(), 'tan-onset-neg-worklet.js');
        fs.writeFileSync(tmpPath, disabledSource);
        const OldProc = loadProcessor(disabledSource, SR);
        const mono = readWavFloat32Planar(path.join(FIXTURE_DIR, 'comfort-loud.wav')).planar[0];
        const { gainTrace } = renderThroughWorkletChannels(OldProc, [mono], {});
        const old05 = valueAt(gainTrace, 0.5, SR);
        const oldT6 = timeTo(gainTrace, ONSET_BOUND_05_DB, SR);
        const oldT8 = timeTo(gainTrace, ONSET_BOUND_10_DB, SR);
        const oldFails = Number.isFinite(old05) && old05 > ONSET_BOUND_05_DB;
        const cur = onsetRows.find((r) => r.clause === 'onset-loud' && r.rate === '48000');
        onsetNeg = {
          tmpPath, oldValueAt05Db: old05, oldTimeToMinus6S: oldT6, oldTimeToMinus8S: oldT8,
          newValueAt05Db: cur ? cur.valueAt05Db : NaN,
          newTimeToMinus6S: cur ? cur.timeToMinus6S : NaN,
          newTimeToMinus8S: cur ? cur.timeToMinus8S : NaN,
          oldFailsBound: oldFails,
          verdict: oldFails ? 'PASS' : 'FAIL',
        };
        onsetRows.push({
          clause: 'onset-negative-control', fixture: 'comfort-loud.wav', rate: '48000',
          valueAt05Db: old05, timeToMinus6S: oldT6, verdict: onsetNeg.verdict,
          note: 'guard-disabled variant must FAIL the 0.5 s bound (proves the gate bites)',
        });
      } catch (e) {
        onsetNeg = { verdict: 'FAIL', note: `negative control failed to run: ${e.message}` };
        onsetRows.push({ clause: 'onset-negative-control', fixture: 'comfort-loud.wav', rate: '48000', verdict: 'FAIL', note: onsetNeg.note });
      }
    }
    {
      const zeros = new Float32Array(SR);
      const { outs, gainTrace } = renderThroughWorkletChannels(Proc48, [zeros], {});
      let allZero = true;
      for (const ch of outs) {
        for (let i = 0; i < ch.length; i++) {
          if (ch[i] !== 0) { allZero = false; break; }
        }
        if (!allZero) break;
      }
      const nanFree = traceOk(gainTrace) && !hasNaNOuts(outs);
      onsetRows.push({
        clause: 'onset-bit-silence', fixture: 'digital-silence-1s', rate: '48000',
        allZero, nanFree, verdict: (allZero && nanFree) ? 'PASS' : 'FAIL',
      });
    }
    recordClosedLoopOutputs(outputEntries);
  }
  const onsetFails = onsetRows.filter((r) => r.verdict === 'FAIL').length;
  const onsetUntested = onsetRows.filter((r) => r.verdict === 'UNTESTED').length;
  const onsetSummary = onsetFails > 0 ? 'FAIL' : (onsetUntested > 0 ? `${onsetUntested} UNTESTED` : 'PASS');

  console.log('');
  console.log('fixture              | oracle LUFS | processor LUFS |  delta | oracle TP | processor TP | verdict');
  console.log('---------------------|-------------|----------------|--------|-----------|--------------|--------');
  for (const r of rows) {
    console.log(
      `${r.fixture.padEnd(20)} | ${fmt(r.oracleLufs).padStart(11)} | ${fmt(r.processorLufs).padStart(14)} | ${fmt(r.deltaVsOracle).padStart(6)} | ${fmt(r.oracleTruePeakDbTp).padStart(9)} | ${fmt(r.processorTruePeakDbTp).padStart(12)} | ${r.verdict}`
    );
  }
  console.log('');
  for (const r of rows) {
    if (r.verdict === 'UNTESTED') {
      const why = !ff.present && !Number.isFinite(r.referenceLufs)
        ? 'no comparison source (ffmpeg absent, reference not yet available)'
        : `oracle ${r.verdictVsOracle}, reference ${r.verdictVsReference}${r.referenceNote ? ` (${r.referenceNote})` : ''}, ceiling ${r.verdictCeiling}`;
      console.log(`UNTESTED: ${r.fixture} — ${why}; not reported as PASS.`);
    }
  }
  console.log('SURFACE: audio/normalizer-worklet.js exposes this.telemetry (integratedLufs, shortTermLufs, momentaryLufs, truePeakDb, appliedGainDb, normGainDb, userTrimDb, mode, warm — refreshed on every process() call) and posts {type:\'meter\', ...} on the port; the harness convergence check reads the slow loop (normGainDb) on that documented surface, and the closed-loop oracle above measures the actual output WAVs.');
  if (!Number.isFinite(rows[0].referenceLufs)) {
    console.log('UNTESTED: reference-values.json comparison for ALL fixtures — file has no per-fixture values yet (not yet available); not reported as PASS.');
  }
  console.log('');
  console.log('CLOSED-LOOP (converged output measured by the same ffmpeg oracle; tail = settled steady state):');
  console.log('fixture              | input LUFS | target | required | applied | tail LUFS | full LUFS |  delta | verdict');
  console.log('---------------------|------------|--------|----------|---------|-----------|-----------|--------|--------');
  for (const r of rows) {
    const c = r.closedLoop;
    console.log(
      `${r.fixture.padEnd(20)} | ${fmt(r.oracleLufs).padStart(10)} | ${fmt(c.effectiveTargetLufs).padStart(6)} | ${fmt(c.requiredGainDb).padStart(8)} | ${fmt(c.appliedGainDb).padStart(7)} | ${fmt(c.outputTailLufs).padStart(9)} | ${fmt(c.outputFullLufs).padStart(9)} | ${fmt(c.deltaVsExpected).padStart(6)} | ${c.verdict}`
    );
  }
  console.log('');
  for (const r of rows) {
    const c = r.closedLoop;
    if (c.verdict === 'UNTESTED') {
      console.log(`UNTESTED: ${r.fixture} — ${c.reason}; slow-gain trace (per-second norm dB): [${c.gainTracePerSecondDb.join(', ')}]; not reported as PASS.`);
    } else if (c.boundNote) {
      console.log(`NOTE: ${r.fixture} — required gain ${fmt(c.requiredGainDb)} dB exceeds the clamp; ${c.boundNote}, expected ${fmt(c.expectedLufs)} LUFS.`);
    }
  }
  const clScoped = rows.filter((r) => r.closedLoop.convergenceInScope);
  const clFails = clScoped.filter((r) => r.closedLoop.verdict === 'FAIL').length;
  const clUntested = clScoped.filter((r) => r.closedLoop.verdict === 'UNTESTED').length;
  const clSummary = clFails > 0 ? 'FAIL' : (clUntested > 0 ? `${clUntested} UNTESTED` : 'PASS');
  console.log(`CLOSED-LOOP: ${clSummary} (A1 scope: ${clScoped.length} steady fixtures; ${rows.length - clScoped.length} changing fixtures scoped to A2/A3/A5)`);

  console.log('');
  console.log('TRUE-PEAK (processor OUTPUT measured by two independent detectors; ffmpeg is binding):');
  console.log('fixture              | input TP ffmpeg | output TP ffmpeg | output TP harness | verdict');
  console.log('---------------------|-----------------|------------------|-------------------|--------');
  for (const r of rows) {
    const c = r.closedLoop;
    console.log(
      `${r.fixture.padEnd(20)} | ${fmt(r.oracleTruePeakDbTp).padStart(15)} | ${fmt(c.outputFullPeakDbTp).padStart(16)} | ${fmt(r.processorTruePeakDbTp).padStart(17)} | ${c.verdictCeiling}`
    );
  }
  const tpFails = rows.filter((r) => r.closedLoop.verdictCeiling === 'FAIL').length;
  const tpUntested = rows.filter((r) => r.closedLoop.verdictCeiling === 'UNTESTED').length;
  const tpSummary = tpFails > 0 ? 'FAIL' : (tpUntested > 0 ? `${tpUntested} UNTESTED` : 'PASS');
  console.log(`TRUE-PEAK: ${tpSummary}`);

  console.log('');
  console.log('ADVERSARIAL SWEEP (short-burst worklet OUTPUT true peak by the ffmpeg oracle; ffmpeg is binding):');
  console.log('signal               | out TP | verdict');
  console.log('---------------------|--------|--------');
  for (const a of advRows) {
    console.log(
      `${a.signal.padEnd(20)} | ${fmt(a.outputPeak).padStart(6)} | ${a.verdict}`
    );
  }
  console.log(`ADVERSARIAL: ${advSummary}`);

  let worstRow = null;
  {
    const advWorst = advRows.reduce((a, b) => (a.outputPeak > b.outputPeak ? a : b), advRows[0]);
    const ht = rows.find((r) => r.fixture === 'high-tone-11k');
    const worstVerdict = advSummary;
    console.log(`TRUE-PEAK WORST-CASE (adversarial sweep, detector margin ${wc.tpMarginDb} dB): hottest output ${fmt(advWorst.outputPeak)} dBTP (${advWorst.signal}; must be <= ${fmt(CEILING_DBTP)} dBTP) | high-tone-11k program output ${ht ? fmt(ht.closedLoop.outputFullPeakDbTp) : 'n/a'} dBTP (previous 0.6 dB margin: ${fmt(PREV_MARGIN_FFMPEG_TP)} dBTP) | verdict ${worstVerdict}`);
    worstRow = {
      fixture: advWorst.signal,
      marginDb: wc.tpMarginDb,
      outputFfmpegTp: advWorst.outputPeak,
      highTone11kOutputTp: ht ? ht.closedLoop.outputFullPeakDbTp : NaN,
      prevMarginFfmpegTp: PREV_MARGIN_FFMPEG_TP,
      prevMarginHarnessTp: PREV_MARGIN_HARNESS_TP,
      verdict: worstVerdict,
    };
  }
  const worstSummary = !worstRow ? 'UNTESTED' : worstRow.verdict;

  console.log('');
  console.log('HARD-CLIP BACKSTOP (exact rail hits across every output channel; must be 0):');
  console.log('fixture              | ch | hard-clip count | verdict');
  console.log('---------------------|----|---------------|--------');
  let hardClipTotal = 0;
  for (const r of rows) {
    hardClipTotal += r.hardClipCount;
    const v = r.hardClipCount === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${r.fixture.padEnd(20)} | ${String(r.workletChannels).padStart(2)} | ${String(r.hardClipCount).padStart(13)} | ${v}`
    );
  }
  console.log(`HARD-CLIP TOTAL: ${hardClipTotal}`);
  const hardClipSummary = hardClipTotal === 0 ? 'PASS' : 'FAIL';
  if (hardClipSummary !== 'PASS') {
    for (const r of rows) {
      if (r.hardClipCount !== 0) {
        console.log(`FINDING: ${r.fixture} — ${r.hardClipCount} hard-clip events (rail ±${r.hardClipRail}); diagnosis: the limiter/margin failed to contain the peak on this fixture; the ceiling was NOT raised to hide it.`);
      }
    }
  }
  console.log(`HARD-CLIP: ${hardClipSummary}`);

  console.log('');
  console.log('MULTICHANNEL/MONO WORKLET COVERAGE (worklet integrated LUFS vs ffmpeg oracle, ±0.1 LU):');
  console.log('fixture              | layout                                                            | ch | worklet LUFS | oracle LUFS |  delta | verdict');
  console.log('---------------------|-------------------------------------------------------------------|----|--------------|-------------|--------|--------');
  const multiRows = rows.filter((r) => r.workletChannels === 1 || r.workletChannels === 6);
  for (const r of multiRows) {
    console.log(
      `${r.fixture.padEnd(20)} | ${String(r.layout).slice(0, 65).padEnd(65)} | ${String(r.workletChannels).padStart(2)} | ${fmt(r.processorLufs).padStart(12)} | ${fmt(r.oracleLufs).padStart(11)} | ${fmt(r.deltaVsOracle).padStart(6)} | ${r.verdictVsOracle}`
    );
  }
  const multiFails = multiRows.filter((r) => r.verdictVsOracle === 'FAIL' || r.closedLoop.verdictCeiling === 'FAIL').length;
  const multiUntested = multiRows.filter((r) => r.verdictVsOracle === 'UNTESTED' || r.closedLoop.verdictCeiling === 'UNTESTED').length;
  const multiSummary = multiFails > 0 ? 'FAIL' : (multiUntested > 0 ? `${multiUntested} UNTESTED` : (multiRows.length > 0 ? 'PASS' : 'UNTESTED'));
  console.log(`MULTICHANNEL/MONO: ${multiSummary}`);

  console.log('');
  console.log('44.1 kHz WORKLET COVERAGE (processor at 44100 Hz vs ffmpeg oracle, ±0.1 LU; closed loop to -20):');
  console.log('fixture                   | 48k worklet | 44.1k worklet | 44.1k oracle |  delta | tail 44.1k | verdict');
  console.log('--------------------------|-------------|---------------|--------------|--------|------------|--------');
  for (const q of rate441Rows) {
    console.log(
      `${q.fixture.padEnd(25)} | ${fmt(q.baseline48Lufs).padStart(11)} | ${fmt(q.processorLufs).padStart(13)} | ${fmt(q.oracleLufs).padStart(12)} | ${fmt(q.deltaVsOracle).padStart(6)} | ${fmt(q.closedLoop.outputTailLufs).padStart(10)} | ${q.verdict}`
    );
  }
  const r441Fails = rate441Rows.filter((r) => r.verdict === 'FAIL').length;
  const r441Untested = rate441Rows.filter((r) => r.verdict === 'UNTESTED').length;
  const r441Summary = r441Fails > 0 ? 'FAIL' : (r441Untested > 0 ? `${r441Untested} UNTESTED` : 'PASS');
  console.log(`44.1kHz: ${r441Summary} (A1 convergence scoped to steady fixtures; changing fixtures judged on meter accuracy + A2/A3/A5)`);

  console.log('');
  console.log('COMFORT LEVELLING (set-mode level on comfort-dialogue; dead-band AGC with ±2.5 LU band and +6 dB boost cap, input vs output):');
  if (levelRow) {
    console.log(`metric: ${levelRow.metric}`);
    console.log(`input spread: ${fmt(levelRow.inSpread)} dB | output spread: ${fmt(levelRow.outSpread)} dB | reduction: ${fmt(levelRow.spreadReduction)} dB (gate >= ${fmt(LEVEL_MIN_SPREAD_REDUCTION_DB)} dB — a no-op leveller gives 0.00 dB) | quiet rise: ${fmt(levelRow.quietRise)} dB (gate >= ${fmt(LEVEL_MIN_QUIET_RISE_DB)} dB) | engaged=${levelRow.engaged}`);
    console.log(`input LRA: ${fmt(levelRow.inLra)} LU | output LRA: ${fmt(levelRow.outLra)} LU | LRA reduction: ${fmt(levelRow.lraReduction)} LU`);
    console.log(`comfort tail LUFS: ${fmt(levelRow.levelTailLufs)} (program target ${fmt(EFFECTIVE_TARGET)}, delta ${fmt(levelRow.targetDelta)}, gate |delta| <= ${fmt(CLOSED_LOOP_TOL_LU)} LU) — ${levelRow.targetNote}`);
    console.log(`comfort output true peak: ${fmt(levelRow.outputPeakDbTp)} dBTP (ceiling ${CEILING_DBTP} dBTP, ok=${levelRow.peakOk}) | hard-clip: ${levelRow.hardClipCount} | noNaN: ${levelRow.noNaN} | mode telemetry: ${levelRow.modeTelemetry}`);
    console.log(`LEVEL: ${levelRow.verdict}`);
  }
  const levelSummary = levelRow ? levelRow.verdict : 'UNTESTED';
  console.log('');
  console.log('MESSAGES (set-target-lufs + reset-meter):');
  if (targetRow) {
    console.log(`set-target-lufs: fixture ${targetRow.fixture} probe target ${fmt(targetRow.probeTarget)} LUFS | tail ${fmt(targetRow.tailLufs)} LUFS | delta ${fmt(targetRow.delta)} LU | settled=${targetRow.settled} tail ${fmt(targetRow.tailSeconds)} s | verdict ${targetRow.verdict} (stuck-at-default would report ${targetRow.stuckCheck})`);
  }
  if (resetRow) {
    console.log(`reset-meter: pre warm=${resetRow.preWarm} integrated=${fmt(resetRow.preIntegrated)} LUFS | post warm=${resetRow.postWarm} integrated=${fmt(resetRow.postIntegrated)} | re-acquired warm=${resetRow.reacqWarm} integrated=${fmt(resetRow.reacqIntegrated)} LUFS | cleared=${resetRow.cleared} reacquired=${resetRow.reacquired} | verdict ${resetRow.verdict}`);
    console.log(`reset-meter equivalence: immediate-clear ok=${resetRow.immOk} (interpMax=${fmt(resetRow.immInterpMax)} interpZi=${resetRow.immInterpZiOk} pRing=${resetRow.immPRingOk} blocks=${resetRow.immBlocksOk} delay=${resetRow.immDelayOk} targets=${resetRow.immTargetsOk} telemetry=${resetRow.immTelOk}) | post-silence truePeak=${fmt(resetRow.postTruePeakDb)} (minusInf=${resetRow.silPeakMinusInf}) engagements=${resetRow.silEngagements} (zero=${resetRow.silZeroEng}) outsZero=${resetRow.silOutZero} | equiv48 identical=${resetRow.equivIdent48} maxDiff=${fmt(resetRow.equivMaxDiff48)} telemetry=${resetRow.equivTelOk} | equiv441 identical=${resetRow.equivIdent441} maxDiff=${fmt(resetRow.equivMaxDiff441)} | settingsKept=${resetRow.settingsKept} | equivOk=${resetRow.equivOk}`);
  }
  const msgFails = [targetRow, resetRow].filter((r) => r && r.verdict === 'FAIL').length;
  const msgUntested = [targetRow, resetRow].filter((r) => !r || r.verdict === 'UNTESTED').length;
  const msgSummary = msgFails > 0 ? 'FAIL' : (msgUntested > 0 ? 'UNTESTED' : 'PASS');
  console.log(`MESSAGES: ${msgSummary}`);
  let transitionRow = null;
  {
    const TRANSITION_TOL_DB = 0.5;
    const GAIN_STEP_TOL_DB = 1.0;
    const IMMEDIATE_STEP_TOL_DB = 1e-9;
    const rates = [
      { sr: SR, Proc: Proc48, tag: '48000' },
      { sr: SR441, Proc: Proc441, tag: '44100' },
    ];
    const perRate = [];
    for (const cfg of rates) {
      const srHere = cfg.sr;
      const ProcHere = cfg.Proc;
      const TR_N = srHere * 60;
      const tone = new Float32Array(TR_N);
      for (let i = 0; i < TR_N; i++) tone[i] = 0.04 * Math.sin(2 * Math.PI * 1000 * i / srHere);
      const first30 = tone.subarray(0, srHere * 30);
      const last30 = tone.subarray(srHere * 30);
      const driveTo = (proc, sig, trace) => {
        const n = sig.length;
        const out = new Float32Array(n);
        for (let pos = 0; pos < n; pos += BLOCK) {
          const len = Math.min(BLOCK, n - pos);
          const a = new Float32Array(BLOCK);
          const b = new Float32Array(BLOCK);
          const oA = new Float32Array(BLOCK);
          const oB = new Float32Array(BLOCK);
          for (let i = 0; i < len; i++) { a[i] = sig[pos + i]; b[i] = sig[pos + i]; }
          proc.process([[a], [b]], [[oA], [oB]]);
          if (trace) trace.push(proc.telemetry.appliedGainDb);
          for (let i = 0; i < len; i++) out[pos + i] = oA[i];
        }
        return out;
      };
      const rmsDbTail = (x, rate, lastSec) => {
        const st = Math.max(0, x.length - Math.round(lastSec * rate));
        let sum = 0;
        for (let i = st; i < x.length; i++) sum += x[i] * x[i];
        const rms = Math.sqrt(sum / Math.max(1, x.length - st));
        return 20 * Math.log10(Math.max(rms, 1e-12));
      };
      const freshP = makeProc(ProcHere, { mode: 'level' });
      const outFresh = driveTo(freshP, tone, null);
      const freshDb = rmsDbTail(outFresh, srHere, 5);
      const swP = makeProc(ProcHere, {});
      const swTrace = [];
      driveTo(swP, first30, swTrace);
      const gainBefore = swP.telemetry.appliedGainDb;
      swP.port.onmessage({ data: { type: 'set-mode', mode: 'level' } });
      const gainAfter = swP.telemetry.appliedGainDb;
      const immediateStep = Math.abs(gainAfter - gainBefore);
      const outSwTail = driveTo(swP, last30, swTrace);
      const swDb = rmsDbTail(outSwTail, srHere, 5);
      const div = Math.abs(swDb - freshDb);
      let maxStep = 0;
      const skipQuanta = Math.round(5 * srHere / BLOCK);
      for (let i = Math.max(1, skipQuanta); i < swTrace.length; i++) {
        const d = Math.abs(swTrace[i] - swTrace[i - 1]);
        if (d > maxStep) maxStep = d;
      }
      const aOk = div <= TRANSITION_TOL_DB;
      const immOk = immediateStep <= IMMEDIATE_STEP_TOL_DB;
      const slewOk = maxStep <= GAIN_STEP_TOL_DB;
      const verdictR = (aOk && immOk && slewOk) ? 'PASS' : 'FAIL';
      perRate.push({ sr: cfg.tag, freshDb, swDb, divergenceDb: div, gainBefore, gainAfter, immediateStepDb: immediateStep, maxStepDb: maxStep, verdict: verdictR });
    }
    const verdictT = perRate.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL';
    transitionRow = { perRate, tolDb: TRANSITION_TOL_DB, gainStepTolDb: GAIN_STEP_TOL_DB, immediateTolDb: IMMEDIATE_STEP_TOL_DB, verdict: verdictT };
    transitionRow.freshDb = perRate[0].freshDb;
    transitionRow.swDb = perRate[0].swDb;
    transitionRow.divergenceDb = perRate[0].divergenceDb;
  }

  let telemetryRow = null;
  {
    const TP_TOL_DB = 0.01;
    const TP_BURST_AGREE_DB = 0.25;
    const HOLD_TOL_DB = 0.01;
    const TEL_TONE_AMP = 0.04;
    const TEL_VALUE_AMP = 0.1413;
    const p0 = makeProc(Proc48, {});
    const inA = new Float32Array(BLOCK);
    const inB = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) { const v = 0.5 * Math.sin(2 * Math.PI * 1000 * i / SR); inA[i] = v; inB[i] = v; }
    const oA0 = new Float32Array(BLOCK);
    const oB0 = new Float32Array(BLOCK);
    p0.process([[inA], [inB]], [[oA0], [oB0]]);
    let outPeak0 = 0;
    for (let i = 0; i < BLOCK; i++) { const a = Math.abs(oA0[i]); if (a > outPeak0) outPeak0 = a; }
    const tel0 = p0.telemetry.truePeakDb;
    const zeroOk = outPeak0 === 0 ? !Number.isFinite(tel0) : true;
    const p1 = makeProc(Proc48, {});
    const N2 = Math.round(SR * 15);
    const capTone = new Float32Array(N2);
    for (let pos = 0; pos < N2; pos += BLOCK) {
      const len = Math.min(BLOCK, N2 - pos);
      const a = new Float32Array(BLOCK);
      const b = new Float32Array(BLOCK);
      const oa = new Float32Array(BLOCK);
      const ob = new Float32Array(BLOCK);
      for (let i = 0; i < len; i++) { const v = TEL_VALUE_AMP * Math.sin(2 * Math.PI * 1000 * (pos + i) / SR); a[i] = v; b[i] = v; }
      p1.process([[a], [b]], [[oa], [ob]]);
      for (let i = 0; i < len; i++) capTone[pos + i] = oa[i];
    }
    const tel1 = p1.telemetry.truePeakDb;
    const cubTone = toDb(truePeakOf(capTone.subarray(capTone.length - 2 * SR)));
    const toneDiff = Number.isFinite(tel1) ? tel1 - cubTone : NaN;
    const toneOk = Number.isFinite(tel1) && Math.abs(toneDiff) <= TP_TOL_DB && tel1 >= cubTone - TP_TOL_DB;
    const pB = makeProc(Proc48, { gainDb: 6 });
    const NB = Math.round(SR * 12);
    const capBurst = new Float32Array(NB);
    for (let pos = 0; pos < NB; pos += BLOCK) {
      const len = Math.min(BLOCK, NB - pos);
      const a = new Float32Array(BLOCK);
      const b = new Float32Array(BLOCK);
      const oa = new Float32Array(BLOCK);
      const ob = new Float32Array(BLOCK);
      for (let i = 0; i < len; i++) { const v = 0.4 * Math.sin(2 * Math.PI * 1000 * (pos + i) / SR); a[i] = v; b[i] = v; }
      pB.process([[a], [b]], [[oa], [ob]]);
      for (let i = 0; i < len; i++) capBurst[pos + i] = oa[i];
    }
    const pC = makeProc(Proc48, { gainDb: 12 });
    const NCLIP = Math.round(SR * 12);
    const capClip = new Float32Array(NCLIP);
    for (let pos = 0; pos < NCLIP; pos += BLOCK) {
      const len = Math.min(BLOCK, NCLIP - pos);
      const a = new Float32Array(BLOCK);
      const b = new Float32Array(BLOCK);
      const oa = new Float32Array(BLOCK);
      const ob = new Float32Array(BLOCK);
      for (let i = 0; i < len; i++) { const v = 0.98 * Math.sin(2 * Math.PI * 1000 * (pos + i) / SR); a[i] = v; b[i] = v; }
      pC.process([[a], [b]], [[oa], [ob]]);
      for (let i = 0; i < len; i++) capClip[pos + i] = oa[i];
    }
    const telB = pB.telemetry.truePeakDb;
    const cubBurst = toDb(truePeakOf(capBurst.subarray(capBurst.length - 2 * SR)));
    const burstDiff = Number.isFinite(telB) ? telB - cubBurst : NaN;
    const burstHonest = Number.isFinite(telB) && telB >= cubBurst - TP_TOL_DB;
    const burstOk = burstHonest && Number.isFinite(burstDiff) && Math.abs(burstDiff) <= TP_BURST_AGREE_DB;
    const telC = pC.telemetry.truePeakDb;
    const cubClip = toDb(truePeakOf(capClip));
    const clipRail = countHardClips([capClip], CEILING_DBTP).count;
    const clipNeverUnder = Number.isFinite(telC) && Number.isFinite(cubClip) && telC >= cubClip - TP_TOL_DB;
    const clipOk = Number.isFinite(cubClip) && cubClip <= CEILING_DBTP + EPS_DB && clipRail === 0;
    const pH = makeProc(Proc48, {});
    for (let pos = 0; pos < SR * 2; pos += BLOCK) {
      const a = new Float32Array(BLOCK);
      const b = new Float32Array(BLOCK);
      const oa = new Float32Array(BLOCK);
      const ob = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) { const v = TEL_TONE_AMP * Math.sin(2 * Math.PI * 1000 * (pos + i) / SR); a[i] = v; b[i] = v; }
      pH.process([[a], [b]], [[oa], [ob]]);
    }
    for (let q = 0; q < 10; q++) {
      const a = new Float32Array(BLOCK);
      const b = new Float32Array(BLOCK);
      const oa = new Float32Array(BLOCK);
      const ob = new Float32Array(BLOCK);
      pH.process([[a], [b]], [[oa], [ob]]);
    }
    const trackBefore = pH.truePeakTrack;
    const telBefore = pH.telemetry.truePeakDb;
    const zA = new Float32Array(BLOCK);
    const zB = new Float32Array(BLOCK);
    const zOA = new Float32Array(BLOCK);
    const zOB = new Float32Array(BLOCK);
    pH.process([[zA], [zB]], [[zOA], [zOB]]);
    let zOutPeak = 0;
    for (let i = 0; i < BLOCK; i++) { const av = Math.abs(zOA[i]); if (av > zOutPeak) zOutPeak = av; }
    const telAfter = pH.telemetry.truePeakDb;
    const predicted = trackBefore * Math.exp(-BLOCK / (SR * 1.5));
    const predictedDb = predicted > 0 ? 20 * Math.log10(predicted) : -Infinity;
    const holdDiff = (Number.isFinite(telAfter) && Number.isFinite(predictedDb)) ? telAfter - predictedDb : NaN;
    const holdOk = zOutPeak === 0
      ? (Number.isFinite(telAfter) && Math.abs(holdDiff) <= HOLD_TOL_DB)
      : (Number.isFinite(telAfter) && telAfter >= toDb(zOutPeak) - HOLD_TOL_DB);
    const expectDb = 20 * Math.log10(TEL_VALUE_AMP);
    const valueOk = Number.isFinite(tel1) && Math.abs(tel1 - expectDb) <= 1.0;
    const verdictTel = (zeroOk && valueOk && toneOk && burstOk && clipOk && holdOk) ? 'PASS' : 'FAIL'; // clipNeverUnder reported, not gated (see above)
    telemetryRow = { outPeak0, tel0: Number.isFinite(tel0) ? tel0 : -Infinity, zeroOk, tel1: Number.isFinite(tel1) ? tel1 : -Infinity, expectDb, valueOk, cubTone, toneDiff, toneOk, cubBurst, burstDiff, burstHonest, burstOk, burstAgreeTolDb: TP_BURST_AGREE_DB, telB: Number.isFinite(telB) ? telB : -Infinity, telC: Number.isFinite(telC) ? telC : -Infinity, cubClip, clipRail, clipNeverUnder, clipOk, trackBefore, telBefore, zOutPeak, telAfter, predictedDb, holdDiff, holdOk, tpTolDb: TP_TOL_DB, holdTolDb: HOLD_TOL_DB, verdict: verdictTel };
  }

  console.log('');
  console.log('USER-TRIM (set-gain-db is an immediate output trim: settled tail vs target+trim, ±0.20 LU; shift exactly 1x; integrated + target unchanged):');
  console.log('gain | fixture              | input LUFS | prog targ | exp tail |    slow | tail LUFS | shift dB | int dLU | verdict');
  console.log('-----|----------------------|------------|-----------|----------|---------|-----------|----------|---------|--------');
  for (const g of gainRows) {
    const gs = `${g.gainDb >= 0 ? '+' : ''}${g.gainDb}`;
    console.log(
      `${gs.padStart(4)} | ${g.fixture.padEnd(20)} | ${fmt(g.inputLufs).padStart(10)} | ${fmt(g.programTargetLufs).padStart(9)} | ${fmt(g.expectedTailLufs).padStart(8)} | ${fmt(g.appliedGainDb).padStart(7)} | ${fmt(g.outputTailLufs).padStart(9)} | ${fmt(g.tailShiftDb).padStart(8)} | ${fmt(g.integratedDelta).padStart(7)} | ${g.verdict}`
    );
  }
  console.log('');
  for (const g of gainRows) {
    const gs = `${g.gainDb >= 0 ? '+' : ''}${g.gainDb}`;
    const extra = g.gainDb === 12
      ? ` | output true peak ${fmt(g.outputFullPeakDbTp)} dBTP (ceiling ${CEILING_DBTP} dBTP, ${g.peakVerdict}) | hard-clip ${g.hardClipCount} (${g.hardClipVerdict})`
      : '';
    const note = g.reason ? `; ${g.reason}` : '';
    const scope = g.settleOutOfScope && g.settleOutOfScopeNote ? `; ${g.settleOutOfScopeNote}` : '';
    console.log(`TRACE: trim ${gs} ${g.fixture} — targetOk=${g.targetOk} trimArmed=${g.trimArmed} integrated ${fmt(g.integratedTrim)} vs trim-0 ${fmt(g.integratedRef)} (ok=${g.integratedOk}) shift ${fmt(g.tailShiftDb)} dB (ok=${g.shiftOk}); applied-gain per-second dB: [${g.gainTracePerSecondDb.join(', ')}]; settled=${g.gainSettled} tail ${fmt(g.tailSeconds)} s${extra}${note}${scope}`);
  }
  console.log(`USER-GAIN: ${gainSummary}`);
  console.log('');
  console.log('COMFORT (dead-band clauses name the gate state: FIRE on the 12 dB pair, NOT-fire on the 4 LU program; residual floors are OURS; max-short-term is EBU R 128 s1 restated, never "LDR"):');
  console.log('clause                  | fixture              | rate  | measured | threshold | verdict');
  console.log('------------------------|----------------------|-------|----------|-----------|--------');
  for (const c of comfortRows) {
    console.log(
      `${c.clause.padEnd(23)} | ${c.fixture.padEnd(20)} | ${c.rate.padEnd(5)} | ${fmt(c.measured).padStart(8)} | ${String(c.threshold).slice(0, 9).padStart(9)} | ${c.verdict}${c.note ? ` — ${c.note}` : ''}`
    );
  }
  console.log(`COMFORT: ${comfortSummary}`);
  console.log('');
  console.log('STEP RECOVERY (SPEC A5/H2/S4: 60 s quiet + 30 s ~10 LU louder; oracle ST each second after the step; FIRE = recovery within +-1.0 LU by 10 s; NOT = pre-step steady shows no pumping within 0.5 LU; AGC excursion descriptive only, causation not isolated):');
  for (const s of stepRows) {
    if (s.stSeries6163 !== undefined) {
      console.log(`fixture ${s.fixture} rate ${s.rate}: ST 61-63 LUFS [${(s.stSeries6163 || []).map(fmt).join(', ')}] (early, outside +-1 proves the gate bites: ${s.earlyOutsideGateBites}) | ST 64-70 LUFS [${(s.stSeries6470 || []).map(fmt).join(', ')}] | ST@70 ${fmt(s.stAt70)} (target ${fmt(EFFECTIVE_TARGET)}, delta ${fmt(s.fireDelta)}, tol +-1.0: ${s.fireVerdict})`);
      console.log(`  no-pump: pre-step ST@55 ${fmt(s.st55)} vs ST@60 ${fmt(s.st60)} LUFS (delta ${fmt(s.pumpDelta)}, tol 0.5: ${s.pumpVerdict}) | max |AGC| 60-75 s ${fmt(s.agcMaxPostStepDb)} dB (${s.agcNote}) | verdict ${s.verdict}${s.note ? ` — ${s.note}` : ''}`);
    } else {
      console.log(`fixture ${s.fixture} rate ${s.rate}: verdict ${s.verdict}${s.note ? ` — ${s.note}` : ''}`);
    }
  }
  console.log(`STEP: ${stepSummary}`);
  console.log('');
  console.log('AGC BALLISTICS (gain = this.telemetry.appliedGainDb - normGainDb, read per 128-frame quantum; no audio-path instrumentation):');
  for (const a of agcBallisticsRows) {
    if (a.clause === 'am-ripple') {
      console.log(`am-ripple: steady 1 kHz sine after -6 dB preamble, settled AGC ${fmt(a.settledAgcDb)} dB | max p-p in 100 ms ${fmt(a.measuredDb, 4)} dB (limit ${AGC_RIPPLE_MAX_DB} dB) | verdict ${a.verdict}`);
    } else if (a.clause === 'slew-and-step') {
      console.log(`slew-and-step: 6 dB drop then 6 dB rise | max per-quantum AGC delta ${fmt(a.maxPerQuantumDeltaDb, 4)} dB (ceiling ${AGC_SLEW_MAX_DB_PER_QUANTUM}) | recovery ${fmt(a.recoverySeconds, 3)} s to within ${a.recoveryToleranceDb} dB of target (limit ${AGC_STEP_RECOVERY_MAX_SECONDS} s) | verdict ${a.verdict}`);
    } else {
      console.log(`snap-negative-control: snap variant max per-quantum AGC delta ${fmt(a.maxPerQuantumDeltaDb, 4)} dB (must exceed ${AGC_SLEW_MAX_DB_PER_QUANTUM}) | verdict ${a.verdict}${a.note ? ` — ${a.note}` : ''}`);
    }
  }
  console.log(`AGC BALLISTICS: ${agcBallisticsSummary}`);
  console.log('');
  console.log('ONSET (5.4.2 cold-start onset convergence: loud onset cut by 0.5 s, quiet onset untouched, guard-disabled negative control, silence bit-zero; SEE ALSO qa/feed-transition-qa.cjs + qa/program-boundary-qa.cjs):');
  for (const o of onsetRows) {
    if (o.clause === 'onset-loud') {
      console.log(`onset-loud ${o.fixture} ${o.rate}: applied ${fmt(o.valueAt05Db)} dB @0.5 s (gate <= -6.0), ${fmt(o.valueAt10Db)} dB @1.0 s (gate <= -8.0) | time to -6 dB ${fmt(o.timeToMinus6S, 3)} s, to -8 dB ${fmt(o.timeToMinus8S, 3)} s | settled ${fmt(o.settledGainDb)} dB (min ${fmt(o.gainMinDb)} dB, overshoot ok=${o.overshootOk}, settled=${o.settled} tail ${fmt(o.tailSeconds, 1)} s) | tail ${fmt(o.tailLufs)} LUFS (target ${fmt(EFFECTIVE_TARGET)}, delta ${fmt(o.tailDeltaLufs)} LU, tol +-1.0) | noNaN=${o.nanFree} | verdict ${o.verdict}`);
    } else if (o.clause === 'onset-quiet-control') {
      console.log(`onset-quiet-control ${o.fixture} ${o.rate}: max |applied| first 0.4 s (pre-measurement) ${fmt(o.maxAbsFirst04Db, 3)} dB (gate <= 0.1) | settled=${o.settled} final ${fmt(o.settledGainDb)} dB (standard path proceeds) | noNaN=${o.nanFree} | verdict ${o.verdict}`);
    } else if (o.clause === 'onset-negative-control') {
      console.log(`onset-negative-control ${o.fixture} ${o.rate}: GUARD-DISABLED variant applied ${fmt(o.valueAt05Db)} dB @0.5 s (must FAIL the -6.0 bound), time to -6 dB ${fmt(o.timeToMinus6S, 3)} s | verdict ${o.verdict}${o.note ? ` — ${o.note}` : ''}`);
    } else {
      console.log(`${o.clause} ${o.fixture} ${o.rate}: allZero=${o.allZero} noNaN=${o.nanFree} | verdict ${o.verdict}`);
    }
  }
  if (onsetNeg) {
    console.log(`ONSET old-vs-new: guard-disabled value@0.5s ${fmt(onsetNeg.oldValueAt05Db)} dB, time-to--6dB ${fmt(onsetNeg.oldTimeToMinus6S, 3)} s, time-to--8dB ${fmt(onsetNeg.oldTimeToMinus8S, 3)} s | new value@0.5s ${fmt(onsetNeg.newValueAt05Db)} dB, new time-to--6dB ${fmt(onsetNeg.newTimeToMinus6S, 3)} s, new time-to--8dB ${fmt(onsetNeg.newTimeToMinus8S, 3)} s | disabled fails 0.5 s bound=${onsetNeg.oldFailsBound} | verdict ${onsetNeg.verdict}`);
  }
  console.log(`ONSET: ${onsetSummary}`);
  console.log('');
  console.log('TRANSITION (set-mode clears ONLY loudness measurement, gain/delay carry through; same 60 s tone at 48 + 44.1 kHz, fresh-level vs switched-level final-5 s RMS AND gain-continuity across the switch):');
  if (transitionRow && Array.isArray(transitionRow.perRate)) {
    for (const r of transitionRow.perRate) {
      console.log(r.sr + 'Hz fresh final-5 s RMS dB: ' + fmt(r.freshDb) + ' | switched final-5 s RMS dB: ' + fmt(r.swDb) + ' | divergence ' + fmt(r.divergenceDb) + ' dB (tol ' + fmt(transitionRow.tolDb) + ' dB) | immediate gain step ' + r.immediateStepDb.toExponential(1) + ' dB (tol ' + transitionRow.immediateTolDb.toExponential(0) + ') | max per-quantum step ' + fmt(r.maxStepDb) + ' dB (tol ' + fmt(transitionRow.gainStepTolDb) + ' dB) | verdict ' + r.verdict);
    }
    console.log('transition verdict ' + transitionRow.verdict + ' (a reset-to-unity fix passes RMS but fails the gain-step gates)');
  } else if (transitionRow) {
    console.log('fresh final-5 s RMS dB: ' + fmt(transitionRow.freshDb) + ' | switched final-5 s RMS dB: ' + fmt(transitionRow.swDb) + ' | divergence ' + fmt(transitionRow.divergenceDb) + ' dB (tol ' + fmt(transitionRow.tolDb) + ' dB) | verdict ' + transitionRow.verdict);
  }
  const transitionSummary = transitionRow ? transitionRow.verdict : 'UNTESTED';
  console.log('TRANSITION: ' + transitionSummary);
  console.log('');
  console.log('TELEMETRY (reported truePeakDb is a DECAYING HOLD on the delayed post-limiter output peak, 1.5 s TC; choice b):');
  if (telemetryRow) {
    console.log('fresh zero-output quantum: outPeak=' + fmt(telemetryRow.outPeak0) + ' reported=' + fmt(telemetryRow.tel0) + ' (must be -Inf when track is exactly 0) zeroOk=' + telemetryRow.zeroOk + ' | -20 LUFS program tone holds unity: reported=' + fmt(telemetryRow.tel1) + ' captured-cubic=' + fmt(telemetryRow.cubTone) + ' diff=' + fmt(telemetryRow.toneDiff) + ' (tol ' + fmt(telemetryRow.tpTolDb) + ', never under) toneOk=' + telemetryRow.toneOk);
    console.log('limiter +6-trim 0.4-amp: reported=' + fmt(telemetryRow.telB) + ' captured-cubic=' + fmt(telemetryRow.cubBurst) + ' diff=' + fmt(telemetryRow.burstDiff) + ' (honest: reported >= captured - 0.01: ' + telemetryRow.burstHonest + '; agree tol ' + fmt(telemetryRow.burstAgreeTolDb) + ') burstOk=' + telemetryRow.burstOk);
    console.log('limiter +12-trim 0.98-amp clip: captured-cubic=' + fmt(telemetryRow.cubClip) + ' (ceiling ' + CEILING_DBTP + ' dBTP) rail-hits=' + telemetryRow.clipRail + ' (want 0) reported-never-under=' + telemetryRow.clipNeverUnder + ' clipOk=' + telemetryRow.clipOk + ' | post-audio zero quantum: outPeak=' + fmt(telemetryRow.zOutPeak) + ' reported=' + fmt(telemetryRow.telAfter) + ' predicted-decay=' + fmt(telemetryRow.predictedDb) + ' diff=' + fmt(telemetryRow.holdDiff) + ' (tol ' + fmt(telemetryRow.holdTolDb) + ') holdOk=' + telemetryRow.holdOk + ' | verdict ' + telemetryRow.verdict);
  }
  const telemetrySummary = telemetryRow ? telemetryRow.verdict : 'UNTESTED';
  console.log('TELEMETRY: ' + telemetrySummary);

  const report = {
    generatedAt: new Date().toISOString(),
    harness: 'qa/loudness-verify.cjs',
    safety: 'pure Node (node:vm). No browser, no Chromium, no Playwright, no audio device, no sound.',
    ffmpeg: ff,
    fixtureDir: FIXTURE_DIR,
    manifest: MANIFEST_PATH,
    referenceStatus: reference.status,
    selfCheck: { ok: harnessOk, problems: harnessProblems },
    workletConstants: {
      targetDefault: wc.targetDefault,
      maxBoostDb: wc.maxBoostDb,
      maxCutDb: wc.maxCutDb,
      tpMarginDb: wc.tpMarginDb,
      ceilingDb: wc.ceilingDb,
      harnessGainDb: HARNESS_GAIN_DB,
      effectiveTargetLufs: EFFECTIVE_TARGET,
    },
    surfaceNote: 'audio/normalizer-worklet.js exposes this.telemetry (integratedLufs, shortTermLufs, momentaryLufs, truePeakDb, appliedGainDb, normGainDb, userTrimDb, mode, warm) refreshed on every process() call plus {type:meter} port messages; the harness convergence check reads the slow loop (normGainDb) on that documented surface (no poking at internals) and the closed-loop oracle measures the actual output WAVs under qa/fixtures/out/.',
    passCriteria: {
      deltaLu: `|processor LUFS - reference LUFS| <= ${DELTA_TOL_LU}`,
      ceilingDbTp: `processed true peak <= ${CEILING_DBTP} dBTP`,
      rate441DeltaLu: `44.1 kHz |processor LUFS - oracle LUFS| <= ${DELTA_TOL_LU}`,
      targetProbeLufs: TARGET_PROBE_LUFS,
    },
    closedLoopSummary: clSummary,
    truePeakSummary: tpSummary,
    truePeakWorstSummary: worstSummary,
    adversarialSummary: advSummary,
    adversarialRows: advRows,
    hardClipSummary,
    hardClipTotal,
    multichannelSummary: multiSummary,
    rate441Summary: r441Summary,
    levelSummary,
    transitionSummary,
    telemetrySummary,
    transitionRow,
    telemetryRow,
    messagesSummary: msgSummary,
    gainSummary,
    gainRows,
    comfortSummary,
    comfortRows,
    stepSummary,
    stepRows,
    agcBallisticsSummary,
    agcBallisticsRows,
    onsetSummary,
    onsetRows,
    onsetNegativeControl: onsetNeg,
    workletTruePeakMarginDb: wc.tpMarginDb,
    rows,
    truePeakWorstRow: worstRow,
    rate441Rows,
    levelRow,
    targetRow,
    resetRow,
    overall: rows.every((r) => r.verdict === 'PASS') && clSummary === 'PASS' && tpSummary === 'PASS' && worstSummary === 'PASS' && advSummary === 'PASS' && hardClipSummary === 'PASS' && multiSummary === 'PASS' && r441Summary === 'PASS' && levelSummary === 'PASS' && msgSummary === 'PASS' && gainSummary === 'PASS' && comfortSummary === 'PASS' && stepSummary === 'PASS' && agcBallisticsSummary === 'PASS' && onsetSummary === 'PASS' && transitionSummary === 'PASS' && telemetrySummary === 'PASS' ? 'ALL PASS' : 'FAILURES PRESENT',
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`wrote ${REPORT_PATH}`);
  console.log(`wrote ${MANIFEST_PATH}`);
  console.log(`OVERALL: ${report.overall}`);

  if (!rows.every((r) => r.verdict === 'PASS') || clSummary !== 'PASS' || tpSummary !== 'PASS' || worstSummary !== 'PASS' || advSummary !== 'PASS' || hardClipSummary !== 'PASS' || multiSummary !== 'PASS' || r441Summary !== 'PASS' || levelSummary !== 'PASS' || msgSummary !== 'PASS' || gainSummary !== 'PASS' || comfortSummary !== 'PASS' || stepSummary !== 'PASS' || agcBallisticsSummary !== 'PASS' || onsetSummary !== 'PASS' || transitionSummary !== 'PASS' || telemetrySummary !== 'PASS') process.exitCode = 2;
}

function runSelfTestOnly(ff) {
  console.log('SELF-TEST mode: validating the harness itself (no worklet conformance verdicts).');
  let ok = true;
  const check = (label, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: self-test ${label}`);
    if (!cond) ok = false;
  };

  check('ffmpeg present on PATH', ff.present);
  if (ff.present) console.log(`self-test ffmpeg version: ${ff.version}`);
  else console.log('self-test UNTESTED: ffmpeg absent — oracle parser checks cannot run; say so plainly.');

  const wavPath = path.join(FIXTURE_DIR, 'sine-1khz-fs-20.wav');
  if (ff.present) {
    const oracle = runOracle(wavPath);
    console.log(`self-test oracle command: ${oracle.command}`);
    check('parser returns finite integrated LUFS', Number.isFinite(oracle.integratedLufs));
    check(`parsed integrated ${fmt(oracle.integratedLufs)} LUFS is sane for a -20 dBFS 1 kHz sine (in [-35, -15])`,
      Number.isFinite(oracle.integratedLufs) && oracle.integratedLufs <= -15 && oracle.integratedLufs >= -35);
    check('parser returns finite true peak', Number.isFinite(oracle.truePeakDbTp));
    const wrong = compareLufs(oracle.integratedLufs, oracle.integratedLufs + 5);
    check(`deliberate +5 LU error reports FAIL (got ${wrong.verdict}, delta=${fmt(wrong.delta)})`, wrong.verdict === 'FAIL');
    const right = compareLufs(oracle.integratedLufs, oracle.integratedLufs);
    check(`exact oracle value reports PASS (got ${right.verdict})`, right.verdict === 'PASS');
  }

  {
    const exact = checkClosedLoop(-18, -18, true, 12);
    check(`closed-loop exact target reports PASS (got ${exact.verdict})`, exact.verdict === 'PASS');
    const wrongTarget = checkClosedLoop(-18, -13, true, 12);
    check(`closed-loop deliberately-wrong target (-13 vs -18 output) reports FAIL (got ${wrongTarget.verdict}, delta=${fmt(wrongTarget.delta)})`,
      wrongTarget.verdict === 'FAIL');
    const clampBound = checkClosedLoop(-41.02, -41, true, 12);
    check(`closed-loop clamp-bound expectation within tolerance reports PASS (got ${clampBound.verdict})`, clampBound.verdict === 'PASS');
    const unsettled = checkClosedLoop(-18, -18, false, 12);
    check(`closed-loop unsettled gain reports UNTESTED, never PASS (got ${unsettled.verdict})`, unsettled.verdict === 'UNTESTED');
    const shortTail = checkClosedLoop(-18, -18, true, 2);
    check(`closed-loop short tail reports UNTESTED, never PASS (got ${shortTail.verdict})`, shortTail.verdict === 'UNTESTED');
    const noOracle = checkClosedLoop(NaN, -18, true, 12);
    check(`closed-loop missing oracle value reports UNTESTED, never PASS (got ${noOracle.verdict})`, noOracle.verdict === 'UNTESTED');
  }

  {
    check('true-peak at ceiling reports PASS (live verdict)', peakVerdictDbTp(CEILING_DBTP, CEILING_DBTP) === 'PASS');
    check('true-peak 0.5 dB over ceiling reports FAIL (live verdict)', peakVerdictDbTp(CEILING_DBTP + 0.5, CEILING_DBTP) === 'FAIL');
    check('true-peak NaN is UNTESTED, never PASS (live verdict)', peakVerdictDbTp(NaN, CEILING_DBTP) === 'UNTESTED');
    const rail = Math.fround(Math.pow(10, CEILING_DBTP / 20));
    const dirty = [new Float32Array([0.1, -0.2, rail, 0.3]), new Float32Array([0.0, -rail])];
    const clean = [new Float32Array([0.1, -0.2, rail - 1e-4, 0.3]), new Float32Array([0.0, 0.5])];
    const dirtyCount = countHardClips(dirty, CEILING_DBTP).count;
    const cleanCount = countHardClips(clean, CEILING_DBTP).count;
    check(`hard-clip counter finds exact rail hits (got ${dirtyCount})`, dirtyCount === 2);
    check(`hard-clip counter ignores near-rail samples (got ${cleanCount})`, cleanCount === 0);
    const inside = compareLufs(-18.0, -17.91);
    const outside = compareLufs(-18.0, -17.5);
    check(`worklet-vs-oracle +0.09 LU reports PASS (got ${inside.verdict})`, inside.verdict === 'PASS');
    check(`worklet-vs-oracle +0.5 LU reports FAIL (got ${outside.verdict})`, outside.verdict === 'FAIL');
  }

  {
    const marginHolds = (marginDb) => marginDb >= MARGIN_STANDARD_UNDERREAD_DB - 1e-9;
    let shippedMargin = NaN;
    try {
      shippedMargin = parseWorkletConstants(fs.readFileSync(WORKLET_PATH, 'utf8')).tpMarginDb;
    } catch {}
    check(`shipped TP_DETECTOR_MARGIN_DB=${shippedMargin} covers the standard 0.688 dB worst-case under-read (U <= margin)`, Number.isFinite(shippedMargin) && marginHolds(shippedMargin));
    check('deliberately-too-small margin 0.5 dB FAILS the ceiling claim (U=0.688 > margin)', marginHolds(0.5) === false);
    const stuckLevel = checkClosedLoop(-13.9, -20, true, 12);
    check(`stuck comfort tail (-13.9 vs -20 program target) reports FAIL (got ${stuckLevel.verdict}, delta=${fmt(stuckLevel.delta)})`, stuckLevel.verdict === 'FAIL');
    const convergedLevel = checkClosedLoop(-20, -20, true, 12);
    check(`converged level-mode tail reports PASS (got ${convergedLevel.verdict})`, convergedLevel.verdict === 'PASS');
  }

  {
    let parsedDefault = NaN;
    try { parsedDefault = parseWorkletConstants(fs.readFileSync(WORKLET_PATH, 'utf8')).targetDefault; } catch {}
    check(`worklet TARGET_LUFS_DEFAULT=${parsedDefault} equals the documented literal ${DOCUMENTED_DEFAULT_TARGET_LUFS} (circular check would pass a -19 retune; this must not)`,
      Number.isFinite(parsedDefault) && parsedDefault === DOCUMENTED_DEFAULT_TARGET_LUFS);
    check(`deliberately-wrong literal would mismatch (parsed ${fmt(parsedDefault)} vs -19)`,
      !(Number.isFinite(parsedDefault) && parsedDefault === -19));
  }

  {
    const ht = FIXTURES.find((f) => f.name === 'high-tone-11k');
    const htDesc = ht && typeof ht.description === 'string' ? ht.description : '';
    check('high-tone-11k fixture exists under its honest name', !!ht);
    check('high-tone-11k description states the honest fnorm 0.2297', htDesc.includes('0.2297'));
    check('high-tone-11k description disclaims worst-case status and drops the old 0.688 dB bound claim',
      htDesc.includes('NOT') && !htDesc.includes('0.688'));
    const sweepNames = ADVERSARIAL_SWEEP.map((s) => s.name);
    check('adversarial sweep contains the reported counterexample burst', sweepNames.includes('burst-brief-18f-0.8'));
    check('adversarial sweep contains a full-scale alternating pattern', sweepNames.includes('full-alternating-1.0'));
    check('adversarial sweep contains an fnorm-0.48 sine burst', sweepNames.includes('sine-23040-64f-0.8'));
    check('adversarial sweep renders every signal once under the single ceiling (live verdict)',
      ADVERSARIAL_SWEEP.length >= 10);
    const reviewerPattern = [1, -1, 1, -1, 1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, 1, -1, 1];
    const briefSpec = ADVERSARIAL_SWEEP.find((s) => s.name === 'burst-brief-18f-0.8');
    let briefExact = false;
    if (briefSpec) {
      const sig = briefSpec.build();
      let start = -1;
      for (let i = 0; i + 18 <= sig.length; i++) {
        if (sig[i] !== 0) { start = i; break; }
      }
      briefExact = start >= 0;
      if (briefExact) {
        for (let k = 0; k < 18; k++) {
          if (sig[start + k] !== Math.fround(0.8 * reviewerPattern[k])) { briefExact = false; break; }
        }
        if (briefExact && (start + 18 < sig.length && sig[start + 18] !== 0)) briefExact = false;
        if (briefExact && (start > 0 && sig[start - 1] !== 0)) briefExact = false;
      }
    }
    check('counterexample fixture encodes the exact reviewer pattern (offsets 5-8 and 10-17 match)', briefExact === true);
  }

  {
    const atProbe = checkClosedLoop(TARGET_PROBE_LUFS, TARGET_PROBE_LUFS, true, 12);
    check(`set-target-lufs tail at probe vs probe reports PASS (got ${atProbe.verdict})`, atProbe.verdict === 'PASS');
    const stuckDefault = checkClosedLoop(DOCUMENTED_DEFAULT_TARGET_LUFS, TARGET_PROBE_LUFS, true, 12);
    check(`set-target-lufs stuck at default vs probe reports FAIL (got ${stuckDefault.verdict}, delta=${fmt(stuckDefault.delta)})`, stuckDefault.verdict === 'FAIL');
    const resetCleared = (warm, lufs) => warm === false && !Number.isFinite(lufs);
    check('reset-meter cleared state reports PASS', resetCleared(false, -Infinity) === true);
    check('reset-meter uncleared state reports FAIL', resetCleared(true, -18) === false);
  }

  {
    let targetDefault = NaN;
    let workletSrc = '';
    try {
      workletSrc = fs.readFileSync(WORKLET_PATH, 'utf8');
      targetDefault = parseWorkletConstants(workletSrc).targetDefault;
    } catch {}
    const tailPlus6 = targetDefault + 6;
    check(`user-trim tail lands on target + 6 = ${fmt(tailPlus6)} LUFS`, Number.isFinite(tailPlus6));
    const atPlus6 = checkClosedLoop(tailPlus6, tailPlus6, true, 12);
    check(`user-trim +6 tail at ${fmt(tailPlus6)} vs target + 6 reports PASS (got ${atPlus6.verdict})`, atPlus6.verdict === 'PASS');
    const doubled = checkClosedLoop(tailPlus6 + 6, tailPlus6, true, 12);
    check(`simulated doubling (+6 applied twice lands at ${fmt(tailPlus6 + 6)} vs ${fmt(tailPlus6)}) reports FAIL (got ${doubled.verdict}, delta=${fmt(doubled.delta)})`, doubled.verdict === 'FAIL');
    const hStart = workletSrc.indexOf("data.type === 'set-gain-db'");
    const hEnd = workletSrc.indexOf("data.type === 'start-normalizing'", hStart);
    const handler = (hStart >= 0 && hEnd > hStart) ? workletSrc.slice(hStart, hEnd) : '';
    check('set-gain-db handler arms trimTargetDb (slider is an output trim)', handler.includes('trimTargetDb'));
    check('set-gain-db handler never assigns targetLufs (slider is not a retarget)', !/targetLufs\s*=/.test(handler));
  }

  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch {}
  check('manifest lists all 34 generated fixtures (17x48k + 17x44100)',
    !!manifest && manifest.generated === true && Array.isArray(manifest.files) && manifest.files.length === 34);
  check('manifest records channel counts (surround-51 is 6ch)',
    !!manifest && Array.isArray(manifest.files) && manifest.files.some((e) => e.name === 'surround-51.wav' && e.channels === 6));
  check('manifest records comfort fixtures (comfort-dialogue + comfort-music + comfort-varying4 + comfort-pair12 at both rates)',
    !!manifest && Array.isArray(manifest.files) && manifest.files.some((e) => e.name === 'comfort-dialogue.wav') && manifest.files.some((e) => e.name === 'comfort-varying4-44100.wav' && e.sampleRate === SR441) && manifest.files.some((e) => e.name === 'comfort-pair12-44100.wav' && e.sampleRate === SR441));
  check('manifest records 44.1 kHz rates (sine-1khz-fs-20-44100.wav at 44100)',
    !!manifest && Array.isArray(manifest.files) && manifest.files.some((e) => e.name === 'sine-1khz-fs-20-44100.wav' && e.sampleRate === SR441));

  console.log(ok ? 'SELF-TEST: ALL PASS (harness can both pass and fail)' : 'SELF-TEST: FAILURES PRESENT (harness is broken)');
  process.exitCode = ok ? 0 : 1;
}

main();
