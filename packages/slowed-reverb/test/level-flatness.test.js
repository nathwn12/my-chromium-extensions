'use strict';

/* global require, process, __dirname */

/*
 * test/level-flatness.test.js - neither effect slider may change loudness.
 *
 * Owner requirement: "zero EFFECT on volume with regards to the knob for the
 * reverb and slowed ... literally just a SLOWED (speed/pitch) + REVERB, plus a
 * volume controller via scrollwheel". Moving the reverb intensity slider or the
 * speed slider must not change how loud the output is; only the wheel volume
 * control may.
 *
 * Method: render a fixed music-like signal through the same graph the extension
 * builds - `source -> dryGain -> masterGain` and
 * `source -> Dattorro worklet -> reverbCompGain -> masterGain` - at a matrix of
 * settings, and compare the output RMS in dBFS. Static and numeric only: the
 * real dattorro-worklet.js runs against stub globals from plain Node and the
 * real content-script.js is read as text, so there is no AudioContext, no device
 * and no playback anywhere in this file.
 *
 * Speed is the element's `playbackRate` with `preservesPitch = false`, which is a
 * resample: the stream the tap captures carries the source at `t * rate`, with
 * the amplitude unchanged. It is modelled here by resampling the test signal,
 * which is exactly what reaches the graph downstream of the element.
 */

const fs = require('fs');
const path = require('path');

const SR = 48000;
const SECONDS = 4.5;
const WIN_FROM = 1.5;
const WIN_TO = 4.5;
const TOLERANCE_DB = 0.5;
const INTENSITIES = [0, 0.25, 0.5, 0.75, 1];
const SPEEDS = [0.7, 0.85, 1, 1.15, 1.3];
const OFF_GRID = [0.1, 0.35, 0.6, 0.85, 0.95];

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log('ok   ' + name);
    return;
  }
  const message = name + (detail ? ' (' + detail + ')' : '');
  failures.push(message);
  console.log('FAIL ' + message);
}

const WORKLET_PATH = path.join(__dirname, '..', 'dattorro-worklet.js');
const CONTENT_PATH = path.join(__dirname, '..', 'content-script.js');
const workletSrc = fs.readFileSync(WORKLET_PATH, 'utf8');
const contentSrc = fs.readFileSync(CONTENT_PATH, 'utf8');

function db(x) {
  return 20 * Math.log10(Math.max(1e-12, x));
}

// --- the shipped level code, read as text ------------------------------------

// Brace-matched slice of a top-level `function name(...) { ... }` declaration.
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

// Builds the one function every call site must use, straight from the shipped
// bytes, so this harness cannot drift from the extension.
function loadLevels() {
  const table = (contentSrc.match(/const WET_TRANSFER_BY_INTENSITY = \[[^\]]*\];/) || [])[0] || '';
  const headroom = (contentSrc.match(/const MIX_HEADROOM = ([0-9.]+);/) || [])[0] || '';
  const pieces = [
    table,
    headroom,
    extractFunction(contentSrc, 'computeDattorroParams'),
    extractFunction(contentSrc, 'computePostParams'),
    extractFunction(contentSrc, 'wetTransferForIntensity'),
    extractFunction(contentSrc, 'computeMixLevels'),
  ];
  if (pieces.some((piece) => !piece)) return null;
  const factory = new Function(
    'state',
    pieces.join('\n') + '\nreturn { computeMixLevels, wetTransferForIntensity, WET_TRANSFER_BY_INTENSITY, MIX_HEADROOM };'
  );
  const loaded = factory({ lastNonzeroIntensity: 0.5 });
  return {
    triple: (intensity) => loaded.computeMixLevels(intensity),
    transfer: loaded.wetTransferForIntensity,
    table: loaded.WET_TRANSFER_BY_INTENSITY,
    headroom: loaded.MIX_HEADROOM,
  };
}

// --- the worklet, with the stub globals it expects ---------------------------

function loadWorkletClass(sr) {
  const factory = new Function(
    'sampleRate',
    'AudioWorkletProcessor',
    'registerProcessor',
    workletSrc + '\nreturn DattorroReverbProcessor;'
  );
  const StubBase = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
  };
  let cls = null;
  factory(sr, StubBase, (name, c) => {
    void name;
    cls = c;
  });
  return cls;
}

function renderWet(params, input) {
  const Cls = loadWorkletClass(SR);
  const p = new Cls();
  p.handleMessage({ type: 'setParams', params });
  const out = new Float32Array(input.length);
  let done = 0;
  const block = 1024;
  while (done < input.length) {
    const n = Math.min(block, input.length - done);
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    p.process([[input.subarray(done, done + n), input.subarray(done, done + n)]], [[oL, oR]]);
    out.set(oL, done);
    done += n;
  }
  return out;
}

// --- the fixed test signal ---------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalise(src, peak) {
  let max = 0;
  for (let n = 0; n < src.length; n++) if (Math.abs(src[n]) > max) max = Math.abs(src[n]);
  const scale = max > 0 ? peak / max : 0;
  for (let n = 0; n < src.length; n++) src[n] *= scale;
  return src;
}

// Ordinary music, not a lab tone: broadband 1/f noise, which is the standard
// surrogate for a music spectrum. Deliberately no stationary sine: a steady tone
// whose frequency lands on a tank mode (126.5 Hz is one) makes the *reverb* 12 dB
// louder at that frequency, which is the plate's character, not the slider's
// level, and no single scalar gain can correct it. The dark material below keeps
// the tonal case covered.
function musicLike(seconds, peak) {
  const total = Math.floor(SR * seconds);
  const rand = mulberry32(0xa11ce);
  const src = new Float32Array(total);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let n = 0; n < total; n++) {
    const w = rand() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    src[n] = b0 + b1 + b2 + w * 0.1848;
  }
  return normalise(src, peak);
}

// Worst-case dark material: almost all of its energy sits within an octave of
// the tank's own DC blocker. Kept as a second material so a compensation curve
// cannot be tuned to one spectrum without the effect showing up here.
function darkMaterial(seconds, peak) {
  const total = Math.floor(SR * seconds);
  const rand = mulberry32(0x5eed);
  const src = new Float32Array(total);
  let y1 = 0;
  let y2 = 0;
  for (let n = 0; n < total; n++) {
    const w = rand() * 2 - 1;
    y1 += 0.05 * (w - y1);
    y2 += 0.05 * (y1 - y2);
    src[n] = y2 * 4 + 0.35 * Math.sin((2 * Math.PI * 110 * n) / SR);
  }
  return normalise(src, peak);
}

// playbackRate with preservesPitch=false: output sample n is source n * rate.
function resample(src, rate, total) {
  const out = new Float32Array(total);
  const last = src.length - 1;
  for (let n = 0; n < total; n++) {
    const pos = n * rate;
    if (pos >= last) {
      out[n] = 0;
      continue;
    }
    const i0 = Math.floor(pos);
    out[n] = src[i0] + (src[i0 + 1] - src[i0]) * (pos - i0);
  }
  return out;
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

function peakOf(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > m) m = Math.abs(buf[i]);
  return m;
}

function spreadOf(values) {
  return Math.max.apply(null, values) - Math.min.apply(null, values);
}

// --- the matrix --------------------------------------------------------------

const windowFrom = Math.floor(SR * WIN_FROM);
const windowTo = Math.floor(SR * WIN_TO);

function renderSetting(triple, input, intensity) {
  const mix = triple(intensity);
  const wet = renderWet(mix.params, input);
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) out[n] = mix.dry * input[n] + mix.comp * wet[n];
  return { mix, out, level: db(rms(out.subarray(windowFrom, windowTo))) };
}

function measure(triple, material, peakLevel, intensities, speeds) {
  const total = Math.floor(SR * SECONDS);
  const src = material(SECONDS * 1.4, peakLevel);
  const rows = [];
  let worstPeak = 0;
  for (const speed of speeds) {
    const input = speed === 1 ? src.subarray(0, total) : resample(src, speed, total);
    for (const intensity of intensities) {
      const rendered = renderSetting(triple, input, intensity);
      const peak = peakOf(rendered.out);
      worstPeak = Math.max(worstPeak, peak);
      rows.push({ speed, intensity, level: rendered.level, peak, dry: rendered.mix.dry, comp: rendered.mix.comp });
    }
  }
  return { rows, worstPeak };
}

function printTable(rows, intensities) {
  console.log('     speed  ' + intensities.map((i) => 'i=' + i.toFixed(2) + '   ').join(''));
  for (const speed of SPEEDS) {
    const cells = rows
      .filter((r) => r.speed === speed)
      .map((r) => r.level.toFixed(2) + '  ');
    if (cells.length) console.log('     ' + speed.toFixed(2) + '   ' + cells.join(''));
  }
}

// Diagnostic, not a gate: the wet path's measured transfer, i.e. what the tank
// returns per unit of worklet wetGain. A level-neutral mix needs 1/k.
function reportTransfer(triple, material) {
  const total = Math.floor(SR * SECONDS);
  const input = material(SECONDS * 1.4, 0.5).subarray(0, total);
  const inLevel = rms(input.subarray(windowFrom, windowTo));
  const cells = INTENSITIES.filter((i) => i > 0).map((intensity) => {
    const mix = triple(intensity);
    const wet = renderWet(mix.params, input);
    const k = rms(wet.subarray(windowFrom, windowTo)) / (mix.params.wetGain * inLevel);
    return 'i=' + intensity.toFixed(2) + ' k=' + k.toFixed(4) + ' comp=' + mix.comp.toFixed(3);
  });
  console.log('     wet transfer at speed 1.00: ' + cells.join(' | '));
}

function main() {
  const shipped = loadLevels();
  check('0a. the shipped mix code is readable', Boolean(shipped), 'computeMixLevels / transfer table not found');
  if (!shipped) {
    console.error('FAILURES: ' + failures.length);
    process.exitCode = 1;
    return;
  }

  // --- single owner, one writer per gain ------------------------------------
  const dryRamps = contentSrc.match(/rampGain\(controller\.dryGain\.gain,\s*[^;]+\);/g) || [];
  const compRamps = contentSrc.match(/rampGain\(controller\.reverbCompGain\.gain,\s*[^;]+\);/g) || [];
  const applyBlock = extractFunction(contentSrc, 'applyMixLevels');
  check(
    '0b. one writer ramps both mix gains through the owner',
    dryRamps.length === 1 &&
      compRamps.length === 1 &&
      dryRamps[0].indexOf('levels.dry') !== -1 &&
      compRamps[0].indexOf('levels.comp') !== -1 &&
      applyBlock.indexOf('levels.dry') !== -1 &&
      applyBlock.indexOf('levels.comp') !== -1,
    'dry=' + JSON.stringify(dryRamps) + ' comp=' + JSON.stringify(compRamps)
  );
  check(
    '0c. the equal-power dry formula exists once, inside the owner',
    (contentSrc.match(/Math\.sqrt\(Math\.max\(0, 1 - wet \* wet\)\)/g) || []).length === 1 &&
      extractFunction(contentSrc, 'computeMixLevels').indexOf('Math.sqrt(Math.max(0, 1 - wet * wet))') !== -1,
    'the dry complement is written out at more than one site'
  );
  check(
    '0d. every call site goes through the owner',
    extractFunction(contentSrc, 'updateWetChain').indexOf('computeMixLevels') !== -1 &&
      extractFunction(contentSrc, 'updateWetChain').indexOf('applyMixLevels') !== -1 &&
      extractFunction(contentSrc, 'alignBeforeAudible').indexOf('computeMixLevels') !== -1 &&
      extractFunction(contentSrc, 'alignBeforeAudible').indexOf('applyMixLevels') !== -1,
    'a call site computes its own levels'
  );
  check(
    '0e. the compensation stage sits between the tank and master',
    contentSrc.indexOf('dattorroNode.connect(reverbCompGain);') !== -1 &&
      contentSrc.indexOf('reverbCompGain.connect(masterGain);') !== -1 &&
      contentSrc.indexOf('dattorroNode.connect(masterGain);') === -1,
    'the wet path is not wired through reverbCompGain'
  );
  check(
    '0f. masterGain still carries media.volume only',
    (contentSrc.match(/rampGain\(controller\.masterGain\.gain,\s*[^;]+\);/g) || []).every(
      (site) => site.indexOf('media.volume') !== -1 || site.indexOf('controller.media.volume') !== -1
    ) && contentSrc.indexOf('masterGain.gain.value = 0;') !== -1,
    'a mix value reaches masterGain'
  );

  const mixBody = extractFunction(contentSrc, 'computeMixLevels');
  check(
    '0g. the mix headroom is one constant, applied to both halves of the mix',
    Number.isFinite(shipped.headroom) &&
      shipped.headroom > 0 &&
      shipped.headroom <= 1 &&
      (contentSrc.match(/const MIX_HEADROOM = /g) || []).length === 1 &&
      mixBody.indexOf('MIX_HEADROOM * Math.sqrt') !== -1 &&
      mixBody.indexOf('MIX_HEADROOM / wetTransferForIntensity') !== -1,
    'headroom=' + shipped.headroom
  );

  const triple = shipped.triple;
  const headroom = shipped.headroom;
  console.log(
    '     mix headroom ' + headroom.toFixed(3) + ' (' + db(headroom).toFixed(2) + ' dB) | transfer table k=[' +
      shipped.table.map((k) => k.toFixed(4)).join(' ') + ']'
  );
  console.log(
    '     wet=[' + INTENSITIES.map((i) => triple(i).params.wetGain.toFixed(3)).join(' ') +
      '] dry=[' + INTENSITIES.map((i) => triple(i).dry.toFixed(3)).join(' ') +
      '] comp=[' + INTENSITIES.map((i) => triple(i).comp.toFixed(3)).join(' ') + ']'
  );

  // --- primary material: the tolerance the requirement states ---------------
  const primary = measure(triple, musicLike, 0.5, INTENSITIES, SPEEDS);
  reportTransfer(triple, musicLike);
  console.log('\nprimary material, output RMS in dBFS (input peak 0.5):');
  printTable(primary.rows, INTENSITIES);
  const total = spreadOf(primary.rows.map((r) => r.level));
  console.log('     whole-matrix spread: ' + total.toFixed(2) + ' dB, peak ' + primary.worstPeak.toFixed(3));
  check(
    '1. no slider setting changes the output level by more than ' + TOLERANCE_DB + ' dB',
    total <= TOLERANCE_DB,
    'spread ' + total.toFixed(2) + ' dB'
  );

  for (const speed of SPEEDS) {
    const sp = spreadOf(primary.rows.filter((r) => r.speed === speed).map((r) => r.level));
    check(
      '2. reverb intensity is level-neutral at speed ' + speed.toFixed(2),
      sp <= TOLERANCE_DB,
      'spread ' + sp.toFixed(2) + ' dB'
    );
  }
  for (const intensity of INTENSITIES) {
    const sp = spreadOf(primary.rows.filter((r) => r.intensity === intensity).map((r) => r.level));
    check(
      '3. speed is level-neutral at intensity ' + intensity.toFixed(2),
      sp <= TOLERANCE_DB,
      'spread ' + sp.toFixed(2) + ' dB'
    );
  }

  // --- anchors: the endpoints must still be the levels they promise ---------
  const atZero = primary.rows.filter((r) => r.intensity === 0 && r.speed === 1)[0];
  const atOne = primary.rows.filter((r) => r.intensity === 1 && r.speed === 1)[0];
  const inputLevel = (() => {
    const total2 = Math.floor(SR * SECONDS);
    const src = musicLike(SECONDS * 1.4, 0.5).subarray(0, total2);
    return db(rms(src.subarray(windowFrom, windowTo)));
  })();
  console.log(
    '     input RMS ' + inputLevel.toFixed(2) + ' dBFS  i=0 ' + atZero.level.toFixed(2) +
      '  i=1 ' + atOne.level.toFixed(2)
  );
  const trimmedInput = inputLevel + db(headroom);
  check(
    '4. intensity 0 is the input level after the constant mix trim, and nothing else',
    Math.abs(atZero.level - trimmedInput) <= 0.05,
    'delta ' + (atZero.level - trimmedInput).toFixed(3) + ' dB'
  );
  check(
    '5. intensity 1 holds the same level as intensity 0',
    Math.abs(atOne.level - atZero.level) <= TOLERANCE_DB,
    'delta ' + (atOne.level - atZero.level).toFixed(2) + ' dB'
  );
  check('6. the wet path is compensated, never attenuated', triple(1).comp >= 1, 'comp ' + triple(1).comp.toFixed(3));
  check('7. nothing clips at input peak 0.5', primary.worstPeak <= 1, 'peak ' + primary.worstPeak.toFixed(3));
  // Full wet now carries the same RMS as dry, so on a near-full-scale master the
  // tank's own crest factor peaks above unity without the constant trim. The
  // peak is gated across the whole matrix, not only at full wet, because the
  // loudest cell is dry and wet summing at an intermediate intensity.
  const hot = measure(triple, musicLike, 0.9, INTENSITIES, SPEEDS);
  const hotCell = hot.rows.filter((r) => r.intensity === 1 && r.speed === 1)[0];
  const hotWorst = hot.rows.reduce((worst, row) => (row.peak > worst.peak ? row : worst), hot.rows[0]);
  console.log(
    '     peak at input 0.9: full wet ' + hotCell.peak.toFixed(3) + ' (speed 1.00), worst cell ' +
      hotWorst.peak.toFixed(3) + ' (speed ' + hotWorst.speed.toFixed(2) + ', i=' + hotWorst.intensity.toFixed(2) + ')'
  );
  check(
    '7b. a hot master at full wet stays below unity',
    hotCell.peak <= 0.99,
    'peak ' + hotCell.peak.toFixed(3)
  );
  check(
    '7c. no cell of the hot matrix reaches unity',
    hotWorst.peak <= 0.99,
    'peak ' + hotWorst.peak.toFixed(3) + ' at speed ' + hotWorst.speed + ', intensity ' + hotWorst.intensity
  );

  // --- the slider is continuous, so the curve must be flat between points ----
  const offGrid = measure(triple, musicLike, 0.5, [0, ...OFF_GRID], [1]);
  console.log(
    '     off-grid intensities: ' +
      offGrid.rows.map((r) => 'i=' + r.intensity.toFixed(2) + ' ' + r.level.toFixed(2)).join('  ')
  );
  const offGridSpread = spreadOf(offGrid.rows.map((r) => r.level));
  check(
    '8. the level is flat between the measured quarter points too',
    offGridSpread <= TOLERANCE_DB,
    'spread ' + offGridSpread.toFixed(2) + ' dB'
  );

  // --- negative control: without the compensation the harness must go red ---
  // A tolerance test that cannot fail proves nothing, so the same render runs
  // with comp forced to 1 (the pre-fix mix) and must breach the tolerance.
  const legacy = (intensity) => {
    const mix = triple(intensity);
    return { params: mix.params, dry: mix.dry, comp: 1 };
  };
  const control = measure(legacy, musicLike, 0.5, INTENSITIES, [1]);
  const controlSpread = spreadOf(control.rows.map((r) => r.level));
  console.log(
    '     control (comp=1) intensity spread: ' + controlSpread.toFixed(2) + ' dB | ' +
      control.rows.map((r) => r.level.toFixed(2)).join(' ')
  );
  check(
    '9. the harness is sensitive: uncompensated mix breaches the tolerance',
    controlSpread > TOLERANCE_DB,
    'control spread only ' + controlSpread.toFixed(2) + ' dB'
  );

  // --- second material: the same curve, on the worst case -------------------
  // Not gated at the primary tolerance. The wet bus is a filtered copy of the
  // input, so a track whose energy sits almost entirely below the tank's DC
  // blocker loses a little level at full wet; that is the plate's tone, and a
  // scalar gain cannot undo it. The intensity axis is therefore gated at the
  // reference speed, where the material's 110 Hz tone is not on a tank mode.
  // The speed axis on this material is deliberately reported, not gated: at
  // speed 1.15 that tone lands at 126.5 Hz, where the tank's own transfer is
  // -0.1 dB instead of -24.8 dB at 110 Hz, so the mode - not the slider -
  // sets the level there.
  const dark = measure(triple, darkMaterial, 0.5, INTENSITIES, SPEEDS);
  console.log('\ndark material, output RMS in dBFS (input peak 0.5):');
  printTable(dark.rows, INTENSITIES);
  const darkReference = dark.rows.filter((r) => r.speed === 1);
  const darkSpread = spreadOf(darkReference.map((r) => r.level));
  console.log(
    '     intensity spread at speed 1.00: ' + darkSpread.toFixed(2) +
      ' dB | whole matrix ' + spreadOf(dark.rows.map((r) => r.level)).toFixed(2) + ' dB (tonal mode at 1.15)'
  );
  check(
    '10. dark material is level-neutral across intensity at the reference speed',
    darkSpread <= 2.5,
    'spread ' + darkSpread.toFixed(2) + ' dB'
  );

  if (failures.length > 0) {
    console.error('FAILURES: ' + failures.length);
    process.exitCode = 1;
  } else {
    console.log('all level-flatness checks passed');
  }
}

main();
