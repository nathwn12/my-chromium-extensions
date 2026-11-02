'use strict';
/*
 * worklet-silent-analysis.cjs
 * Local-only, PURE NODE silent verification harness (qa/ is gitignored).
 * Session scratch id: ses_f07d8d804ffePLpg7UON9NAcAF
 *
 * SAFETY: no browser, no Chromium, no Playwright, no chrome-devtools/MCP, no
 * audio device, no sound. Worklet sources are executed inside node:vm with a
 * stub AudioWorkletProcessor. This file must never launch a browser.
 *
 * Produces (in <parent>/loudness-<SESSION_ID>/):
 *   silent-analysis.json
 *   silent-analysis-transcript.txt
 *   silent-unit.txt        (node tests/shared.test.js)
 *   silent-typecheck.txt   (npm run typecheck)
 *
 * Variants:
 *   baseline = `git show HEAD:audio/normalizer-worklet.js` (written to temp, never hand-edited)
 *   opt      = current worklet with ONLY the B1 band anchor reverted (bandDb=shortDb -> programDb)
 *   patched  = current worklet
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const SESSION_ID = 'ses_f07d8d804ffePLpg7UON9NAcAF';
const sessionDir = process.env.TN_SILENT_DIR
  || path.join(path.dirname(repoRoot), `loudness-${SESSION_ID}`);
const variantsDir = path.join(os.tmpdir(), 'opencode', `loudness-${SESSION_ID}`, `worklet-variants-${SESSION_ID}`);
const jsonPath = path.join(sessionDir, 'silent-analysis.json');
const transcriptPath = path.join(sessionDir, 'silent-analysis-transcript.txt');
const unitPath = path.join(sessionDir, 'silent-unit.txt');
const typecheckPath = path.join(sessionDir, 'silent-typecheck.txt');

const SR = 48000;
const BLOCK = 128;
const CEILING_LINEAR = Math.pow(10, -1 / 20); // -1 dBFS soft-knee / limiter ceiling

// Worklet band boundaries, mirrored from audio/normalizer-worklet.js (read-only constants).
// lufsToInternalDb(lufs) = lufs - LOUDNESS_OFFSET (LOUDNESS_OFFSET = -0.691).
const LOUDNESS_OFFSET = -0.691;
const BAND_LIMITS = {
  quietFloorInternalDb: (-23.5 - LOUDNESS_OFFSET) - 1.3, // COMFORT_MIN_LUFS - BAND_DEADBAND_DB
  loudCeilingInternalDb: (-18 - LOUDNESS_OFFSET) + 1.3,  // COMFORT_MAX_LUFS + BAND_DEADBAND_DB
  comfortMinInternalDb: (-23.5 - LOUDNESS_OFFSET),
  comfortMaxInternalDb: (-18 - LOUDNESS_OFFSET),
};
// AM base amplitude: the prior 0.2 parked the short-window level at the loud ceiling
// (measured short mean ~ -16.02 dB vs ceiling -16.01 dB) so B1 never activated.
// 0.25 lifts the short-window level ~1.9 dB so the whole modulation range sits clearly
// above the loud ceiling; peak = 0.25*10^(5/20) = 0.4446 << 0.891 ceiling (limiter inactive).
const AM_BASE_AMP = 0.25;
const AM_DEPTH_DB = 5;
const AM_RATE_HZ = 1.5;
const AM_CARRIER_HZ = 200;
// Duration extended from 15 s to 60 s so the baseline's 13 s program window reaches
// steady state BEFORE the 8 s measurement window. At 15 s the baseline was still
// converging (its "ripple" was really a monotonic settling trend), which is not AM ripple.
const AM_DURATION_SECONDS = 60;
const AM_ANALYSIS_START = 52; // last 8 s
const AM_ANALYSIS_END = 60;

const THRESHOLDS = {
  equivalenceMaxUlp: 1,
  settleTimeSeconds: 3.5,
  settleOvershootDb: 0.3,
  releaseTimeSeconds: 3.5,
  amRippleDb: 0.25,
};

/* ------------------------------------------------------------------ */
/* Variants                                                            */
/* ------------------------------------------------------------------ */

function gitShowBaseline() {
  return execFileSync('git', ['show', 'HEAD:audio/normalizer-worklet.js'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  }).replace(/\r\n/g, '\n');
}

// opt = current worklet with ONLY the B1 band anchor reverted:
//   delete the `const bandDb = shortDb;` declaration, then rename the comfort-band
//   comparisons from bandDb to programDb. The rename uses a WORD-BOUNDARY match so the
//   unrelated `localDeadbandDb` identifier (which contains the substring "bandDb") is
//   never touched. Fails loudly if the transform is not exactly as advertised.
function revertB1(src) {
  const marker = '    const bandDb = shortDb;\n';
  if (!src.includes(marker)) throw new Error('B1 revert: `const bandDb = shortDb;` line not found');
  let out = src.replace(marker, '');
  const before = out;
  out = out.replace(/\bbandDb\b/g, 'programDb');

  // Self-check: only the comfort-band anchor tokens may have changed.
  if (/\bbandDb\b/.test(out)) throw new Error('B1 revert self-check failed: a bandDb token survived');
  if (out.includes('localDeadprogramDb')) throw new Error('B1 revert self-check failed: localDeadbandDb was corrupted');
  const deadbandBefore = (before.match(/localDeadbandDb/g) || []).length;
  const deadbandAfter = (out.match(/localDeadbandDb/g) || []).length;
  if (deadbandBefore === 0 || deadbandAfter !== deadbandBefore) {
    throw new Error(`B1 revert self-check failed: localDeadbandDb count changed ${deadbandBefore} -> ${deadbandAfter}`);
  }
  if (!out.includes('programDb < quietFloorDb')) throw new Error('B1 revert self-check failed: quietFloor comparison not rewritten');
  if (!out.includes('programDb > loudCeilingDb')) throw new Error('B1 revert self-check failed: loudCeiling comparison not rewritten');
  if (!out.includes('(quietFloorDb - programDb)') || !out.includes('(programDb - loudCeilingDb)')) {
    throw new Error('B1 revert self-check failed: comfort-band expressions not rewritten');
  }
  return out;
}

function buildVariants() {
  fs.mkdirSync(variantsDir, { recursive: true });
  const baseline = gitShowBaseline();
  const patched = fs.readFileSync(path.join(repoRoot, 'audio', 'normalizer-worklet.js'), 'utf8').replace(/\r\n/g, '\n');
  const opt = revertB1(patched);

  // Sanity: baseline must be the pre-change worklet.
  if (!baseline.includes('const SOFT_KNEE_DB = 3;')) throw new Error('baseline sanity failed');
  if (baseline.includes('SOFT_KNEE_RATIO')) throw new Error('baseline sanity failed: HEAD already has B3');
  if (baseline.includes('const bandDb = shortDb;')) throw new Error('baseline sanity failed: HEAD already has B1');
  // opt must have B1 reverted but keep the micro-opts, and must NOT have disturbed the
  // unrelated local-dynamics deadband identifier.
  if (/\bbandDb\b/.test(opt)) throw new Error('opt sanity failed: a bandDb token still present');
  if (opt.includes('const bandDb')) throw new Error('opt sanity failed: bandDb declaration still present');
  if (opt.includes('localDeadprogramDb')) throw new Error('opt sanity failed: localDeadbandDb corrupted');
  if (!opt.includes('localDeadbandDb')) throw new Error('opt sanity failed: localDeadbandDb missing from opt');
  if ((opt.match(/localDeadbandDb/g) || []).length !== (patched.match(/localDeadbandDb/g) || []).length) {
    throw new Error('opt sanity failed: localDeadbandDb occurrence count changed');
  }
  if (!opt.includes('programDb < quietFloorDb')) throw new Error('opt sanity failed: quietFloor comparison not rewritten');
  if (!opt.includes('programDb > loudCeilingDb')) throw new Error('opt sanity failed: loudCeiling comparison not rewritten');
  if (!opt.includes('SOFT_KNEE_RATIO')) throw new Error('opt sanity failed: B3 missing (opt should keep micro-opts)');
  // patched must have B1.
  if (!patched.includes('const bandDb = shortDb;')) throw new Error('patched sanity failed: B1 anchor missing');

  fs.writeFileSync(path.join(variantsDir, 'baseline.js'), baseline);
  fs.writeFileSync(path.join(variantsDir, 'opt.js'), opt);
  fs.writeFileSync(path.join(variantsDir, 'patched.js'), patched);

  return {
    baseline,
    opt,
    patched,
    optDiffersFromBaselineOnlyBy:
      'B3 (SOFT_KNEE_RATIO precompute + hoisted ceilingLinear) + B4 (multiplicative exp gain ramp) + B5 (wrapped index increment/decrement, hoisted readIndex, scheduleLimiter rewrite) + dead-code removal (hop machinery, gainToDb)',
    paths: {
      baseline: path.join(variantsDir, 'baseline.js'),
      opt: path.join(variantsDir, 'opt.js'),
      patched: path.join(variantsDir, 'patched.js'),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Silent loader (node:vm) and driver                                  */
/* ------------------------------------------------------------------ */

function loadProcessor(source) {
  let Captured = null;
  const sandbox = {
    sampleRate: SR,
    console,
    registerProcessor: (_name, cls) => { Captured = cls; },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, postMessage() {} };
      }
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'normalizer-worklet.vm.js' });
  if (!Captured) throw new Error('registerProcessor was never called');
  return Captured;
}

function makeSine(amp, freq, seconds) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR);
  return x;
}

// Render a mono signal (duplicated to both channels) through a variant.
// Records currentGain (the loudness gain) once per 128-frame block.
function renderVariant(source, signal, opts = {}) {
  const Proc = loadProcessor(source);
  const proc = new Proc();
  proc.port.onmessage({ data: { type: 'set-gain-db', gainDb: opts.gainDb ?? 0 } });
  proc.port.onmessage({ data: { type: 'set-blast-guard', blastGuard: !!opts.blastGuard } });

  const n = signal.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const nBlocks = Math.ceil(n / BLOCK);
  const gains = new Float32Array(nBlocks);
  const shorts = new Float32Array(nBlocks); // short-window loudness level (internal dBFS), per block

  let b = 0;
  for (let pos = 0; pos < n; pos += BLOCK, b++) {
    const len = Math.min(BLOCK, n - pos);
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < len; i++) { const v = signal[pos + i]; inL[i] = v; inR[i] = v; }
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    proc.process([[inL], [inR]], [[oL], [oR]]);
    for (let i = 0; i < len; i++) { outL[pos + i] = oL[i]; outR[pos + i] = oR[i]; }
    gains[b] = 20 * Math.log10(Math.max(proc.currentGain, 1e-12));
    shorts[b] = 10 * Math.log10((proc.shortSq || 0) + 1e-12);
  }
  return { outL, outR, gains, shorts, blockDt: BLOCK / SR };
}

/* ------------------------------------------------------------------ */
/* Stimuli                                                             */
/* ------------------------------------------------------------------ */

function fillSineSeg(x, t0, t1, amp, freq) {
  const i0 = Math.max(0, Math.round(t0 * SR));
  const i1 = Math.min(x.length, Math.round(t1 * SR));
  for (let i = i0; i < i1; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR);
}

function buildEquivalence() {
  const x = new Float32Array(Math.round(SR * 3.0));
  fillSineSeg(x, 0.00, 0.50, 0.02, 220); // quiet
  fillSineSeg(x, 0.50, 1.20, 0.90, 300); // loud (engages limiter, true-peak > ceiling)
  fillSineSeg(x, 1.20, 1.50, 0.02, 220); // quiet
  fillSineSeg(x, 1.50, 2.10, 0.02, 220); // quiet bed under hits
  for (const t of [1.55, 1.75, 1.95]) fillSineSeg(x, t, t + 0.025, 0.70, 450); // transient hits
  fillSineSeg(x, 2.10, 2.60, 0.02, 220); // quiet
  fillSineSeg(x, 2.60, 3.00, 1.20, 180); // burst
  return x;
}

// Transition levels, chosen to isolate B1 (see rationale in JSON/transcript):
//   A_Q internal ~ -16.2 dBFS : inside the comfort deadband -> band correction ~0
//   A_L internal ~ -13.3 dBFS : above loud ceiling -> band correction active (~1.5 dB)
//   step = ~2.9 dB < LOCAL_DEADBAND_DB (3.5) -> shared local-dynamics term dormant.
//   peak 0.306 << 0.891 ceiling -> limiter inactive.
const TRANSITION_QUIET_AMP = 0.219;
const TRANSITION_LOUD_AMP = 0.306;

function buildTransition() {
  const n = Math.round(SR * 16.0);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const amp = t < 2 || t >= 10 ? TRANSITION_QUIET_AMP : TRANSITION_LOUD_AMP;
    x[i] = amp * Math.sin(2 * Math.PI * 300 * t);
  }
  return x;
}

function buildAm() {
  const n = Math.round(SR * AM_DURATION_SECONDS);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const db = AM_DEPTH_DB * Math.sin(2 * Math.PI * AM_RATE_HZ * t); // +/-5 dB AM at 1.5 Hz
    const amp = AM_BASE_AMP * Math.pow(10, db / 20);
    x[i] = amp * Math.sin(2 * Math.PI * AM_CARRIER_HZ * t);
  }
  return x;
}

// Analyze the AM render: gain ripple (peak-to-peak) over the last 8 s plus the
// short-window loudness range and its margins to the band boundaries.
function computeAm(V, sigAm) {
  const amBase = renderVariant(V.baseline, sigAm, {});
  const amPatched = renderVariant(V.patched, sigAm, {});
  const ripple = (r) => Number((segmentStats(r.gains, AM_ANALYSIS_START, AM_ANALYSIS_END).max - segmentStats(r.gains, AM_ANALYSIS_START, AM_ANALYSIS_END).min).toFixed(4));
  const shortStats = segmentStats(amPatched.shorts, AM_ANALYSIS_START, AM_ANALYSIS_END);
  const baseShortStats = segmentStats(amBase.shorts, AM_ANALYSIS_START, AM_ANALYSIS_END);
  const amPeak = (() => { let m = 0; for (let i = 0; i < sigAm.length; i++) { const a = Math.abs(sigAm[i]); if (a > m) m = a; } return m; })();
  const windowLabel = `[${AM_ANALYSIS_START},${AM_ANALYSIS_END}]s`;
  const shortRange = {
    baselineMinDb: Number(baseShortStats.min.toFixed(4)),
    baselineMaxDb: Number(baseShortStats.max.toFixed(4)),
    baselineP2pDb: Number((baseShortStats.max - baseShortStats.min).toFixed(4)),
    patchedMinDb: Number(shortStats.min.toFixed(4)),
    patchedMaxDb: Number(shortStats.max.toFixed(4)),
    patchedP2pDb: Number((shortStats.max - shortStats.min).toFixed(4)),
  };
  const ceilings = {
    quietFloorInternalDb: Number(BAND_LIMITS.quietFloorInternalDb.toFixed(4)),
    loudCeilingInternalDb: Number(BAND_LIMITS.loudCeilingInternalDb.toFixed(4)),
    comfortMinInternalDb: Number(BAND_LIMITS.comfortMinInternalDb.toFixed(4)),
    comfortMaxInternalDb: Number(BAND_LIMITS.comfortMaxInternalDb.toFixed(4)),
  };
  const minMarginAboveCeilingDb = Number((shortStats.min - BAND_LIMITS.loudCeilingInternalDb).toFixed(4));
  const allAboveCeiling = shortStats.min > BAND_LIMITS.loudCeilingInternalDb;
  const bandActive = allAboveCeiling;
  const am = {
    description:
      `${AM_DURATION_SECONDS} s: ${AM_CARRIER_HZ} Hz sine, instantaneous amplitude ${AM_BASE_AMP}*10^(${AM_DEPTH_DB}*sin(2*pi*${AM_RATE_HZ}*t)/20), i.e. +/-${AM_DEPTH_DB} dB AM at ${AM_RATE_HZ} Hz; mono duplicated`,
    analysis: `peak-to-peak of currentGain (loudness gain, dB) over ${windowLabel} (the last 8 s, after the 13 s program window has settled); short-window level = shortSq in internal dBFS`,
    baseAmp: AM_BASE_AMP,
    depthDb: AM_DEPTH_DB,
    rateHz: AM_RATE_HZ,
    carrierHz: AM_CARRIER_HZ,
    durationSeconds: AM_DURATION_SECONDS,
    analysisWindowSeconds: windowLabel,
    baseline: { rippleDb: ripple(amBase) },
    patched: { rippleDb: ripple(amPatched) },
    shortRange,
    bandBoundaries: ceilings,
    minMarginAboveCeilingDb,
    allAboveCeiling,
    bandActive,
    amPeak: Number(amPeak.toFixed(4)),
    ceilingLinear: Number(CEILING_LINEAR.toFixed(4)),
    limiterInactive: amPeak < CEILING_LINEAR,
    discriminating: bandActive && (ripple(amPatched) > 0.01),
  };
  am.rationale = {
    previousAmp: 0.2,
    previousProblem: 'amp 0.2 put the short-window level at the loud ceiling (measured short mean ~ -16.02 dB vs ceiling -16.01 dB); the B1 band anchor stayed inactive and both variants read ripple 0.',
    previousDurationProblem: 'at the original 15 s duration the baseline 13 s program window was still converging; its measured "ripple" over [7,15] was a monotonic settling trend (~0.62 dB), not AM ripple. Duration extended to 60 s so the measured window is steady state.',
    chosenAmp: AM_BASE_AMP,
    reason: `amp ${AM_BASE_AMP} lifts the short-window level ~1.9 dB so the entire modulation range is clearly above the loud ceiling (margin ${minMarginAboveCeilingDb} dB at the short-window minimum); +-${AM_DEPTH_DB} dB depth and ${AM_RATE_HZ} Hz rate unchanged.`,
    limiter: `AM peak ${amPeak.toFixed(4)} << ceiling ${CEILING_LINEAR.toFixed(4)} -> limiter stays inactive.`,
  };
  am.note = am.discriminating
    ? `DISCRIMINATING: short-window level is above loudCeiling by ${minMarginAboveCeilingDb} dB (min) across the cycle, so the B1 cut branch is exercised. patched ripple=${am.patched.rippleDb} dB vs baseline ripple=${am.baseline.rippleDb} dB.`
    : `NON-DISCRIMINATING: short-window min ${shortRange.patchedMinDb} dB vs loudCeiling ${ceilings.loudCeilingInternalDb} dB (margin ${minMarginAboveCeilingDb} dB); band anchor not clearly exercised.`;
  return am;
}

/* ------------------------------------------------------------------ */
/* f32 ULP comparison                                                  */
/* ------------------------------------------------------------------ */

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function f32Key(x) {
  _f32[0] = x;
  const b = _u32[0];
  return (b & 0x80000000) ? ((b ^ 0xffffffff) >>> 0) : (b + 0x80000000);
}
function compareF32(a, b) {
  let maxAbs = 0, maxUlp = 0, over1 = 0, differing = 0, firstDiffIdx = -1;
  const total = Math.min(a.length, b.length);
  for (let i = 0; i < total; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    differing++;
    if (firstDiffIdx < 0) firstDiffIdx = i;
    const d = Math.abs(x - y);
    if (d > maxAbs) maxAbs = d;
    const kd = Math.abs(f32Key(x) - f32Key(y));
    if (kd > maxUlp) maxUlp = kd;
    if (kd > 1) over1++;
  }
  return {
    total,
    differing,
    maxAbs,
    maxUlp,
    over1,
    exactMatch: maxAbs === 0,
    firstDiffIdx,
    firstDiffTimeSec: firstDiffIdx < 0 ? null : firstDiffIdx / SR,
  };
}
function comparePair(A, B) {
  const l = compareF32(A.outL, B.outL);
  const r = compareF32(A.outR, B.outR);
  return {
    total: l.total + r.total,
    differing: l.differing + r.differing,
    maxAbs: Math.max(l.maxAbs, r.maxAbs),
    maxUlp: Math.max(l.maxUlp, r.maxUlp),
    over1: l.over1 + r.over1,
    exactMatch: l.exactMatch && r.exactMatch,
    firstDiffIdx: l.firstDiffIdx >= 0 ? l.firstDiffIdx : r.firstDiffIdx,
    firstDiffTimeSec: l.firstDiffIdx >= 0 ? l.firstDiffTimeSec : r.firstDiffTimeSec,
  };
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function gainAt(gains, t) {
  const b = Math.round(t * SR / BLOCK) - 1;
  const i = Math.max(0, Math.min(gains.length - 1, b));
  return gains[i];
}
function lastViolationTime(gains, t0, t1, refDb, tol) {
  let last = null;
  for (let b = 0; b < gains.length; b++) {
    const t = (b + 1) * BLOCK / SR;
    if (t <= t0 || t > t1) continue;
    if (Math.abs(gains[b] - refDb) > tol) last = t;
  }
  return last;
}
function segmentStats(gains, t0, t1) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let b = 0; b < gains.length; b++) {
    const t = (b + 1) * BLOCK / SR;
    if (t <= t0 || t > t1) continue;
    const g = gains[b];
    if (g < min) min = g;
    if (g > max) max = g;
    sum += g; n++;
  }
  return { min, max, mean: n ? sum / n : NaN, count: n };
}
function trajectory(gains, times) {
  return times.map((t) => ({ t: Number(t.toFixed(3)), gainDb: Number(gainAt(gains, t).toFixed(4)) }));
}

// Long constant-level probe -> asymptotic steady-state loudness gain.
function probeGain(source, amp, seconds = 60) {
  const r = renderVariant(source, makeSine(amp, 300, seconds), {});
  const nBlocks = r.gains.length;
  const tail = r.gains.subarray(Math.max(0, nBlocks - Math.round(SR / BLOCK)));
  return { gainDb: median(tail) };
}

function cpuMedianMs(source, totalSamples, repeats = 5) {
  const Proc0 = loadProcessor(source);
  const warm = new Proc0();
  warm.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
  const mkBlock = () => { const a = new Float32Array(BLOCK); for (let i = 0; i < BLOCK; i++) a[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR); return a; };
  const blocks = Math.round(totalSamples / BLOCK);

  function runOnce(Proc) {
    const proc = new Proc();
    proc.port.onmessage({ data: { type: 'set-gain-db', gainDb: 0 } });
    const inA = mkBlock(), inB = new Float32Array(inA);
    const oA = new Float32Array(BLOCK), oB = new Float32Array(BLOCK);
    const t0 = process.hrtime.bigint();
    for (let b = 0; b < blocks; b++) proc.process([[inA], [inB]], [[oA], [oB]]);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  }

  // warm-up (JIT), untimed
  runOnce(Proc0);

  const samples = [];
  for (let r = 0; r < repeats; r++) samples.push(runOnce(loadProcessor(source)));
  return { samplesMs: samples.map((v) => Number(v.toFixed(4))), medianMs: median(samples) };
}

/* ------------------------------------------------------------------ */
/* Test subprocesses                                                   */
/* ------------------------------------------------------------------ */

function runNode(args) {
  try {
    const out = execFileSync('node', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { exit: 0, output: out };
  } catch (e) {
    return { exit: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}`, error: String(e.message) };
  }
}
function runNpm(script) {
  const { execSync } = require('node:child_process');
  try {
    const out = execSync(`npm run ${script}`, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { exit: 0, output: out };
  } catch (e) {
    return { exit: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}`, error: String(e.message) };
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return String(n);
  return Number(n.toFixed(d)).toString();
}

function main() {
  fs.mkdirSync(sessionDir, { recursive: true });
  const V = buildVariants();

  const maxAbs = (arr) => { let m = 0; for (let i = 0; i < arr.length; i++) { const a = Math.abs(arr[i]); if (a > m) m = a; } return m; };

  /* ---- stimuli ---- */
  const sigEq = buildEquivalence();
  const sigTrans = buildTransition();
  const sigAm = buildAm();

  /* ---- (a) equivalence baseline vs opt, guard false/true ---- */
  const equivalence = {};
  for (const guard of [false, true]) {
    const key = guard ? 'guardTrue' : 'guardFalse';
    const b = renderVariant(V.baseline, sigEq, { blastGuard: guard });
    const o = renderVariant(V.opt, sigEq, { blastGuard: guard });
    const p = renderVariant(V.patched, sigEq, { blastGuard: guard });
    equivalence[key] = {
      blastGuard: guard,
      baselineVsOpt: comparePair(b, o),
      baselineVsPatchedInformational: comparePair(b, p),
      sanityPatchedGuardFalseVsTrue: null,
    };
    if (!guard) {
      equivalence._patchedFalse = p;
    } else {
      equivalence._patchedTrue = p;
    }
  }
  equivalence.guardFalse.sanityPatchedGuardFalseVsTrue = comparePair(equivalence._patchedFalse, equivalence._patchedTrue);
  delete equivalence._patchedFalse;
  delete equivalence._patchedTrue;

  /* ---- (b) transition: baseline vs patched ---- */
  const probe = {
    loud: { baseline: probeGain(V.baseline, TRANSITION_LOUD_AMP), patched: probeGain(V.patched, TRANSITION_LOUD_AMP) },
    quiet: { baseline: probeGain(V.baseline, TRANSITION_QUIET_AMP), patched: probeGain(V.patched, TRANSITION_QUIET_AMP) },
  };
  // Common asymptotic references (identical physical steady state for both variants).
  const refLoud = probe.loud.patched.gainDb;
  const refQuiet = probe.quiet.patched.gainDb;

  const tBase = renderVariant(V.baseline, sigTrans, { blastGuard: false });
  const tPatched = renderVariant(V.patched, sigTrans, { blastGuard: false });

  const BLOCK_DT = BLOCK / SR;
  function transitionMetrics(r) {
    const loud = segmentStats(r.gains, 2, 10);
    const lastV = lastViolationTime(r.gains, 2, 10, refLoud, 0.5);
    const lastVR = lastViolationTime(r.gains, 10, 16, refQuiet, 0.5);
    // "settled" = last 0.5 dB violation occurs before the segment boundary.
    const settledLoud = lastV === null || lastV < 10 - BLOCK_DT;
    const releasedQuiet = lastVR === null || lastVR < 16 - BLOCK_DT;
    return {
      refLoudDb: refLoud,
      refQuietDb: refQuiet,
      loudSegment: loud,
      quietToLoud: {
        settleTimeSeconds: lastV === null ? 0 : (settledLoud ? Number((lastV - 2).toFixed(4)) : null),
        settledWithinLoudWindow: settledLoud,
        lastViolationTimeSec: lastV === null ? null : Number(lastV.toFixed(4)),
        // overshoot = gain driven *past* the final target (deeper cut than steady state)
        overshootDownDb: Number(Math.max(0, refLoud - loud.min).toFixed(4)),
        // max gain above target (here it is the initial condition, not overshoot)
        maxAboveRefDb: Number(Math.max(0, loud.max - refLoud).toFixed(4)),
        endDeviationDb: Number(Math.abs(gainAt(r.gains, 10) - refLoud).toFixed(4)),
      },
      loudToQuiet: {
        releaseTimeSeconds: lastVR === null ? 0 : (releasedQuiet ? Number((lastVR - 10).toFixed(4)) : null),
        releasedWithinQuietWindow: releasedQuiet,
        lastViolationTimeSec: lastVR === null ? null : Number(lastVR.toFixed(4)),
      },
      trajectory: trajectory(r.gains, [0.25, 0.5, 1, 2, 2.25, 2.5, 3, 4, 5, 7, 10, 10.5, 11, 12, 14, 15.9]),
    };
  }
  const transition = {
    description: '16 s: quiet A=' + TRANSITION_QUIET_AMP + ' (0-2 s) -> loud A=' + TRANSITION_LOUD_AMP + ' (2-10 s) -> quiet A=' + TRANSITION_QUIET_AMP + ' (10-16 s); 300 Hz, phase-continuous; mono duplicated',
    probe,
    baseline: transitionMetrics(tBase),
    patched: transitionMetrics(tPatched),
    limiterActive: {
      transitionPeak: maxAbs(sigTrans),
      amPeak: maxAbs(sigAm),
      ceilingLinear: CEILING_LINEAR,
      transitionLimiterInactive: maxAbs(sigTrans) < CEILING_LINEAR,
      amLimiterInactive: maxAbs(sigAm) < CEILING_LINEAR,
    },
  };

  /* ---- (c) AM ripple ---- */
  const am = computeAm(V, sigAm);

  /* ---- CPU proxy ---- */
  const cpuBase = cpuMedianMs(V.baseline, 1000000, 5);
  const cpuPatch = cpuMedianMs(V.patched, 1000000, 5);
  const cpu = {
    label: 'OFFLINE CPU PROXY - not the browser AudioWorklet gauge; numeric wall-clock only, no audio device',
    totalSamples: 1000000,
    repeats: 5,
    baseline: cpuBase,
    patched: cpuPatch,
    ratio: Number((cpuPatch.medianMs / cpuBase.medianMs).toFixed(4)),
  };

  /* ---- tests ---- */
  const unit = runNode(['tests/shared.test.js']);
  fs.writeFileSync(unitPath, unit.output);
  const typecheck = runNpm('typecheck');
  fs.writeFileSync(typecheckPath, typecheck.output);

  /* ---- pass conditions ---- */
  const pass = {};
  for (const key of ['guardFalse', 'guardTrue']) {
    const c = equivalence[key].baselineVsOpt;
    pass[`A_equivalence_${key}`] = {
      expected: 'max ULP <= 1, zero samples > 1 ULP',
      pass: c.maxUlp <= THRESHOLDS.equivalenceMaxUlp && c.over1 === 0,
      maxAbsDelta: c.maxAbs,
      samplesDiffering: c.differing,
      totalSamples: c.total,
      worstUlp: c.maxUlp,
      ulpExceedanceCount: c.over1,
      exactMatch: c.exactMatch,
      firstDiffTimeSec: c.firstDiffTimeSec,
    };
  }
  const tp = transition.patched;
  pass.B_settle_quietToLoud = {
    expected: 'patched settle <= 3.5 s, overshoot <= 0.3 dB',
    pass: tp.quietToLoud.settledWithinLoudWindow
      && tp.quietToLoud.settleTimeSeconds !== null
      && tp.quietToLoud.settleTimeSeconds <= THRESHOLDS.settleTimeSeconds
      && tp.quietToLoud.overshootDownDb <= THRESHOLDS.settleOvershootDb,
    settleTimeSeconds: tp.quietToLoud.settleTimeSeconds,
    settledWithinLoudWindow: tp.quietToLoud.settledWithinLoudWindow,
    overshootDownDb: tp.quietToLoud.overshootDownDb,
    maxAboveRefDb: tp.quietToLoud.maxAboveRefDb,
    endDeviationDb: tp.quietToLoud.endDeviationDb,
    referenceLoudDb: refLoud,
  };
  pass.B_release_loudToQuiet = {
    expected: 'patched release <= 3.5 s (informational expectation)',
    pass: tp.loudToQuiet.releasedWithinQuietWindow
      && tp.loudToQuiet.releaseTimeSeconds !== null
      && tp.loudToQuiet.releaseTimeSeconds <= THRESHOLDS.releaseTimeSeconds,
    releaseTimeSeconds: tp.loudToQuiet.releaseTimeSeconds,
    releasedWithinQuietWindow: tp.loudToQuiet.releasedWithinQuietWindow,
    referenceQuietDb: refQuiet,
  };
  pass.B_am_ripple = {
    expected: 'patched ripple <= 0.25 dB and discriminating (band anchor exercised with margin)',
    pass: am.discriminating && am.patched.rippleDb <= THRESHOLDS.amRippleDb,
    patchedRippleDb: am.patched.rippleDb,
    baselineRippleDb: am.baseline.rippleDb,
    discriminating: am.discriminating,
    baseAmp: am.baseAmp,
    minMarginAboveCeilingDb: am.minMarginAboveCeilingDb,
    shortMinDb: am.shortRange.patchedMinDb,
    shortMaxDb: am.shortRange.patchedMaxDb,
    shortP2pDb: am.shortRange.patchedP2pDb,
    note: am.note,
  };
  pass.B_baseline_long_drift = {
    expected: 'baseline keeps drifting beyond 5 s (does not settle within the 8 s loud window; end deviation > 0.5 dB)',
    pass: !transition.baseline.quietToLoud.settledWithinLoudWindow
      || transition.baseline.quietToLoud.settleTimeSeconds === null
      || transition.baseline.quietToLoud.endDeviationDb > 0.5,
    baselineSettleTimeSeconds: transition.baseline.quietToLoud.settleTimeSeconds,
    baselineSettledWithinLoudWindow: transition.baseline.quietToLoud.settledWithinLoudWindow,
    baselineEndDeviationDb: transition.baseline.quietToLoud.endDeviationDb,
  };
  pass.C_cpu_proxy = {
    expected: 'informational ratio only (offline proxy, NOT the browser gauge)',
    pass: true,
    baselineMedianMs: cpuBase.medianMs,
    patchedMedianMs: cpuPatch.medianMs,
    ratio: cpu.ratio,
  };
  pass.D_unit = { expected: 'node tests/shared.test.js exit 0 (11/11)', pass: unit.exit === 0, exit: unit.exit };
  pass.D_typecheck = { expected: 'npm run typecheck exit 0', pass: typecheck.exit === 0, exit: typecheck.exit };

  const behaviorPassKeys = Object.keys(pass).filter((k) => k !== 'C_cpu_proxy');
  const allPass = Object.entries(pass).every(([k, v]) => (k === 'C_cpu_proxy' ? true : v.pass));

  const json = {
    sessionId: SESSION_ID,
    generatedAt: new Date().toISOString(),
    safety: 'PURE NODE (node:vm). No browser, no Chromium, no Playwright, no chrome-devtools/MCP, no audio device, no sound. Banned QA scripts (qa/responsive-normalizer-qa.cjs, qa/extension-qa.cjs) were not run.',
    harness: __filename,
    thresholds: THRESHOLDS,
    variants: {
      baseline: 'git show HEAD:audio/normalizer-worklet.js',
      opt: 'current worklet with ONLY the B1 band anchor reverted (delete `const bandDb = shortDb;`, replace bandDb -> programDb)',
      patched: 'current audio/normalizer-worklet.js',
      optDiffersFromBaselineOnlyBy: V.optDiffersFromBaselineOnlyBy,
      writtenPaths: V.paths,
      dir: variantsDir,
    },
    stimulus: {
      sampleRate: SR,
      blockFrames: BLOCK,
      equivalence: '3 s: quiet 0.02@220Hz (0-0.5s), loud 0.9@300Hz (0.5-1.2s), quiet (1.2-1.5s), quiet bed + 25ms 0.7@450Hz hits at 1.55/1.75/1.95s (1.5-2.1s), quiet (2.1-2.6s), burst 1.2@180Hz (2.6-3.0s); mono duplicated',
      transition: transition.description,
      transitionRationale: {
        quietAmp: TRANSITION_QUIET_AMP,
        quietInternalDbfsApprox: -16.2,
        quietBandState: 'inside the comfort deadband (loud ceiling internal ~ -16.01 dB) -> band correction ~ 0',
        loudAmp: TRANSITION_LOUD_AMP,
        loudInternalDbfsApprox: -13.3,
        loudBandState: 'above the loud ceiling -> band correction active (~1.5 dB)',
        stepDbApprox: 2.9,
        stepRationale: 'step < LOCAL_DEADBAND_DB (3.5 dB) keeps the local-dynamics term (shared by baseline and patched) dormant, isolating the B1 short-vs-program band anchor. Peak 0.306 << 0.891 ceiling so the limiter is inactive; measured gain is therefore the loudness gain.',
      },
      am: am.description,
      amRationale: am.rationale,
      cpu: '1,000,000 samples of a fixed 128-frame 440Hz@0.3 block',
    },
    results: { equivalence, transition, am, cpu, tests: { unit, typecheck } },
    pass,
    allPass,
    behaviorPassKeys,
  };

  writeOutputs(json);
  if (!json.allPass) process.exitCode = 2;
}

function buildTranscript(json) {
  const {
    variants: V, stimulus: S, results: R, pass,
  } = json;
  const am = R.am, transition = R.transition, equivalence = R.equivalence;
  const cpu = R.cpu, unit = R.tests.unit, typecheck = R.tests.typecheck;
  const tb = transition.baseline, tp = transition.patched;
  const probe = transition.probe;
  const tr = S.transitionRationale;
  const lim = transition.limiterActive;
  const L = [];
  const push = (s = '') => L.push(s);
  push('WORKLET SILENT ANALYSIS (PURE NODE / node:vm)');
  push(`session: ${json.sessionId}`);
  push(`date: ${json.generatedAt}`);
  if (json.amUpdatedAt) push(`amUpdatedAt: ${json.amUpdatedAt}`);
  if (json.rerun) push(`rerun: ${json.rerun}`);
  push(`harness: ${json.harness}`);
  push('safety: no browser / no Playwright / no chrome-devtools / no audio device / no sound');
  push('');
  push('VARIANTS');
  push('  baseline = git show HEAD:audio/normalizer-worklet.js (written to temp, not hand-edited)');
  push('  opt      = current worklet, B1 band anchor reverted ONLY (bandDb->programDb)');
  push('  patched  = current worklet (B1 + micro-opts + dead-code removal)');
  push(`  opt vs baseline differs only by: ${V.optDiffersFromBaselineOnlyBy}`);
  push(`  variant files: ${V.dir}`);
  push('');
  push('STIMULI (48 kHz, 128-frame blocks, mono duplicated)');
  push(`  equivalence: ${S.equivalence}`);
  push(`  transition : ${S.transition}`);
  push(`  rationale  : quiet A=${tr.quietAmp} (~${tr.quietInternalDbfsApprox} dBFS internal, inside comfort deadband, correction~0);`);
  push(`               loud  A=${tr.loudAmp} (~${tr.loudInternalDbfsApprox} dBFS internal, above loud ceiling, correction active);`);
  push(`               step ~${tr.stepDbApprox} dB < LOCAL_DEADBAND_DB 3.5 so the shared local-dynamics term stays dormant`);
  push(`               (isolates B1); peak ${fmt(lim.transitionPeak, 4)} << ceiling ${fmt(lim.ceilingLinear, 4)} -> limiter inactive.`);
  push(`  am         : ${S.am}`);
  push(`               base A=${am.baseAmp} (was ${am.rationale.previousAmp}); duration ${am.durationSeconds} s; measured over ${am.analysisWindowSeconds}`);
  push(`               ${am.rationale.reason}`);
  push(`               ${am.rationale.limiter}`);
  push(`               ${am.rationale.previousDurationProblem}`);
  push(`  cpu proxy  : ${cpu.totalSamples} samples, ${cpu.repeats} repeats (offline numeric only)`);
  push('');
  push('(A) EQUIVALENCE  baseline vs opt  (expect exact 0 for B3/B5, <= 1 f32 ULP for B4)');
  for (const key of ['guardFalse', 'guardTrue']) {
    const c = equivalence[key].baselineVsOpt;
    push(`  blastGuard=${key === 'guardTrue'}`);
    push(`    max|delta|=${c.maxAbs.toExponential(4)}  samplesDiffering=${c.differing}/${c.total}  worstUlp=${c.maxUlp}  samples>1ULP=${c.over1}  exactMatch=${c.exactMatch}`);
    const cl = equivalence[key].baselineVsPatchedInformational;
    push(`    baseline vs patched (informational; B1 audio change expected): max|delta|=${cl.maxAbs.toExponential(4)}  worstUlp=${cl.maxUlp}  samplesDiffering=${cl.differing}`);
  }
  push(`  sanity: patched guard=false vs true max|delta|=${equivalence.guardFalse.sanityPatchedGuardFalseVsTrue.maxAbs.toExponential(4)} (should be > 0)`);
  push('');
  push('(B) TRANSITION  quiet -> loud -> quiet  (gain = currentGain / loudness gain, dB)');
  push(`  asymptotic references (60 s constant-level probes):`);
  push(`    loud  ref: baseline=${fmt(probe.loud.baseline.gainDb, 4)} dB  patched=${fmt(probe.loud.patched.gainDb, 4)} dB  used=${fmt(tp.refLoudDb, 4)} dB`);
  push(`    quiet ref: baseline=${fmt(probe.quiet.baseline.gainDb, 4)} dB  patched=${fmt(probe.quiet.patched.gainDb, 4)} dB  used=${fmt(tp.refQuietDb, 4)} dB`);
  push(`  patched: settle(<=0.5dB)=${tp.quietToLoud.settleTimeSeconds === null ? 'not settled' : fmt(tp.quietToLoud.settleTimeSeconds, 4) + ' s'}  settledInWindow=${tp.quietToLoud.settledWithinLoudWindow}  overshoot(down)=${fmt(tp.quietToLoud.overshootDownDb, 4)} dB  endDev=${fmt(tp.quietToLoud.endDeviationDb, 4)} dB`);
  push(`           release(<=0.5dB)=${tp.loudToQuiet.releaseTimeSeconds === null ? 'not settled' : fmt(tp.loudToQuiet.releaseTimeSeconds, 4) + ' s'}  releasedInWindow=${tp.loudToQuiet.releasedWithinQuietWindow}`);
  push(`  baseline: settle(<=0.5dB)=${tb.quietToLoud.settleTimeSeconds === null ? 'not settled' : fmt(tb.quietToLoud.settleTimeSeconds, 4) + ' s'}  settledInWindow=${tb.quietToLoud.settledWithinLoudWindow}  endDev=${fmt(tb.quietToLoud.endDeviationDb, 4)} dB`);
  push(`           release(<=0.5dB)=${tb.loudToQuiet.releaseTimeSeconds === null ? 'not settled' : fmt(tb.loudToQuiet.releaseTimeSeconds, 4) + ' s'}  releasedInWindow=${tb.loudToQuiet.releasedWithinQuietWindow}`);
  push('  trajectory (absolute t s -> gain dB):');
  push('    t        baseline    patched');
  for (const row of tb.trajectory) {
    const p = tp.trajectory.find((q) => q.t === row.t);
    push(`    ${String(row.t).padEnd(8)} ${fmt(row.gainDb, 4).padStart(9)} ${fmt(p ? p.gainDb : NaN, 4).padStart(10)}`);
  }
  push('');
  push(`(C) AM RIPPLE  +/-${am.depthDb} dB @${am.rateHz} Hz carrier ${am.carrierHz} Hz; base A=${am.baseAmp}; ${am.durationSeconds} s render, measured over ${am.analysisWindowSeconds}`);
  push(`  patched  ripple = ${fmt(am.patched.rippleDb, 4)} dB  (expect <= ${json.thresholds.amRippleDb})`);
  push(`  baseline ripple = ${fmt(am.baseline.rippleDb, 4)} dB  (contrast; anchored on the 13 s program window)`);
  push(`  short-window level ${am.analysisWindowSeconds}: patched ${fmt(am.shortRange.patchedMinDb, 4)} .. ${fmt(am.shortRange.patchedMaxDb, 4)} dB (p2p ${fmt(am.shortRange.patchedP2pDb, 4)} dB)`);
  push(`                              baseline ${fmt(am.shortRange.baselineMinDb, 4)} .. ${fmt(am.shortRange.baselineMaxDb, 4)} dB (p2p ${fmt(am.shortRange.baselineP2pDb, 4)} dB)`);
  push(`  band boundaries (internal dBFS): quietFloor=${fmt(am.bandBoundaries.quietFloorInternalDb, 4)}  comfortMin=${fmt(am.bandBoundaries.comfortMinInternalDb, 4)}  comfortMax=${fmt(am.bandBoundaries.comfortMaxInternalDb, 4)}  loudCeiling=${fmt(am.bandBoundaries.loudCeilingInternalDb, 4)}`);
  push(`  margin: short-window min is ${fmt(am.minMarginAboveCeilingDb, 4)} dB above loudCeiling  (allAboveCeiling=${am.allAboveCeiling})`);
  push(`  AM peak = ${fmt(am.amPeak, 4)}  ceiling = ${fmt(am.ceilingLinear, 4)}  limiterInactive=${am.limiterInactive}`);
  push(`  discriminating = ${am.discriminating}`);
  push(`  ${am.note}`);
  push('');
  push('(D) CPU PROXY (clearly a proxy, NOT the browser gauge)');
  push(`  baseline median = ${fmt(cpu.baseline.medianMs, 4)} ms  samples=[${cpu.baseline.samplesMs.map((x) => fmt(x, 3)).join(', ')}]`);
  push(`  patched  median = ${fmt(cpu.patched.medianMs, 4)} ms  samples=[${cpu.patched.samplesMs.map((x) => fmt(x, 3)).join(', ')}]`);
  push(`  ratio patched/baseline = ${fmt(cpu.ratio, 4)}`);
  push('');
  push('(E) TESTS');
  push(`  node tests/shared.test.js  exit=${unit.exit}`);
  push('    ' + String(unit.output).trim().split('\n').join('\n    '));
  push(`  npm run typecheck          exit=${typecheck.exit}`);
  push('    ' + (String(typecheck.output).trim() || '(no output)').split('\n').slice(-6).join('\n    '));
  push('');
  push('PASS CONDITIONS');
  for (const [k, v] of Object.entries(pass)) {
    push(`  ${v.pass ? 'PASS' : 'FAIL'}  ${k}  ${JSON.stringify(v)}`);
  }
  push('');
  push(`OVERALL: ${json.allPass ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  return L.join('\n');
}

function writeOutputs(json, testsWritten = true) {
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  const transcript = buildTranscript(json);
  fs.writeFileSync(transcriptPath, transcript);
  console.log(transcript);
  console.log('');
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${transcriptPath}`);
  if (testsWritten) {
    console.log(`wrote ${unitPath}`);
    console.log(`wrote ${typecheckPath}`);
  }
}

// Re-run only the AM check against the persisted JSON, preserving the
// equivalence/transition/CPU/test results from the previous full run.
function amOnly() {
  fs.mkdirSync(sessionDir, { recursive: true });
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const V = buildVariants();
  const sigAm = buildAm();
  const am = computeAm(V, sigAm);

  json.results.am = am;
  json.stimulus.am = am.description;
  json.stimulus.amRationale = am.rationale;
  json.pass.B_am_ripple = {
    expected: 'patched ripple <= 0.25 dB and discriminating (band anchor exercised with margin)',
    pass: am.discriminating && am.patched.rippleDb <= THRESHOLDS.amRippleDb,
    patchedRippleDb: am.patched.rippleDb,
    baselineRippleDb: am.baseline.rippleDb,
    discriminating: am.discriminating,
    baseAmp: am.baseAmp,
    minMarginAboveCeilingDb: am.minMarginAboveCeilingDb,
    shortMinDb: am.shortRange.patchedMinDb,
    shortMaxDb: am.shortRange.patchedMaxDb,
    shortP2pDb: am.shortRange.patchedP2pDb,
    note: am.note,
  };
  json.allPass = Object.entries(json.pass).every(([k, v]) => (k === 'C_cpu_proxy' ? true : v.pass));
  json.amUpdatedAt = new Date().toISOString();
  json.rerun = `AM stimulus base amplitude changed ${am.rationale.previousAmp} -> ${am.baseAmp} (band anchor must be exercised). Equivalence/transition/CPU/test results preserved from the prior full run.`;
  writeOutputs(json, false);
  if (!json.allPass) process.exitCode = 2;
}

if (process.argv.includes('--am-only') || process.env.TN_AM_ONLY === '1') amOnly();
else main();
