'use strict';

/* global require, __dirname */


const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const SR = 44100;
const BLOCK = 128;
const pkg = join(__dirname, '..');
const workletSrc = readFileSync(join(pkg, 'dattorro-worklet.js'), 'utf8');
const contentSrc = readFileSync(join(pkg, 'content-script.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

function loadMix() {
  const pieces = [
    (contentSrc.match(/const WET_TRANSFER_BY_INTENSITY = \[[^\]]*\];/) || [])[0] || '',
    (contentSrc.match(/const MIX_HEADROOM = [0-9.]+;/) || [])[0] || '',
    extractFunction(contentSrc, 'computeDattorroParams'),
    extractFunction(contentSrc, 'computePostParams'),
    extractFunction(contentSrc, 'wetTransferForIntensity'),
    extractFunction(contentSrc, 'computeMixLevels'),
  ];
  assert.ok(pieces.every(Boolean), 'shipped mix source is readable');
  const factory = new Function(
    'state',
    pieces.join('\n') + '\nreturn { computeMixLevels, wetTransferForIntensity, MIX_HEADROOM };'
  );
  return factory({ lastNonzeroIntensity: 0.5 });
}

const mix = loadMix();

function loadWorkletClass() {
  let Cls = null;
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
  factory(SR, StubBase, (_name, c) => {
    void _name;
    Cls = c;
  });
  assert.ok(Cls, 'worklet processor registered');
  return Cls;
}

const Cls = loadWorkletClass();

// Baseline control: the pre-cap mapping, fully wet at maximum.
function baselineParams(intensity) {
  const i = Math.max(0, Math.min(1, intensity));
  if (i <= 0) return { wetGain: 0, decay: 0, damping: 1, preDelay: 0 };
  return {
    preDelay: 0.44 + i * 0.1,
    preFilter: 0.7 + i * 0.1,
    inputDiff1: 0.75,
    inputDiff2: 0.625,
    decayDiff1: 0.65 + i * 0.05,
    decay: Math.pow(i, 0.75) * 0.58,
    damping: Math.min(0.5 + Math.pow(i, 0.6) * 0.4, 0.78),
    wetGain: Math.pow(i, 0.75),
  };
}

function baselineMix(intensity) {
  const params = baselineParams(intensity);
  return {
    params,
    dry: mix.MIX_HEADROOM * Math.sqrt(Math.max(0, 1 - params.wetGain * params.wetGain)),
    comp: mix.MIX_HEADROOM / mix.wetTransferForIntensity(intensity),
  };
}

function renderWet(params, input) {
  const p = new Cls();
  p.handleMessage({ type: 'setParams', params });
  const out = new Float32Array(input.length);
  for (let start = 0; start < input.length; start += BLOCK) {
    const n = Math.min(BLOCK, input.length - start);
    const slice = input.subarray(start, start + n);
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    p.process([[slice, slice]], [[oL, oR]]);
    out.set(oL, start);
  }
  return out;
}

function render(levels, input) {
  const wet = renderWet(levels.params, input);
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) out[n] = levels.dry * input[n] + levels.comp * wet[n];
  return { wet, out };
}

function rms(buf, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function peak(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) > m) m = Math.abs(buf[i]);
  return m;
}

function finite(buf) {
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) return false;
  return true;
}

function musicLike(seconds, peakLevel) {
  const total = Math.floor(SR * seconds);
  const src = new Float32Array(total);
  let seed = 0xa11ce;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let max = 0;
  for (let n = 0; n < total; n++) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const w = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    const v = b0 + b1 + b2 + w * 0.1848;
    src[n] = v;
    if (Math.abs(v) > max) max = Math.abs(v);
  }
  const scale = max > 0 ? peakLevel / max : 0;
  for (let n = 0; n < total; n++) src[n] *= scale;
  return src;
}

function impulse() {
  const buf = new Float32Array(SR * 3);
  buf[0] = 0.9;
  return buf;
}

const SECONDS = 3;
const input = musicLike(SECONDS, 0.5);
const winFrom = Math.floor(SR * 1);
const winTo = Math.floor(SR * SECONDS);

test('offline 0 / 50 / 100 percent intensity: split, level and bounds', () => {
  const rows = [];
  for (const intensity of [0, 0.5, 1]) {
    const levels = mix.computeMixLevels(intensity);
    const result = render(levels, input);
    rows.push({
      intensity,
      wetGain: levels.params.wetGain,
      dry: levels.dry,
      wetRms: rms(result.wet, winFrom, winTo),
      outRms: rms(result.out, winFrom, winTo),
      peak: peak(result.out),
    });
    assert.ok(finite(result.out), 'output is finite at intensity ' + intensity);
    assert.ok(peak(result.out) <= 1, 'no clipping at intensity ' + intensity);
  }
  const [off, half, full] = rows;
  console.log('     i   wetGain   dry    wetRMS   outRMS   peak');
  for (const r of rows) {
    console.log('     ' + r.intensity.toFixed(2) + '  ' + r.wetGain.toFixed(4) + '   ' +
      r.dry.toFixed(3) + '  ' + r.wetRms.toFixed(5) + '  ' + r.outRms.toFixed(5) + '  ' + r.peak.toFixed(3));
  }
  assert.equal(off.wetGain, 0, '0% has no wet send');
  assert.equal(off.wetRms, 0, '0% has no tank output');
  assert.ok(off.dry > 0.85 && half.dry > 0 && full.dry > 0, 'the direct bus is live at every setting');
  assert.ok(half.wetRms > 0 && half.wetRms < full.wetRms, '50% is between the endpoints');
  assert.ok(Math.abs(20 * Math.log10(full.outRms / off.outRms)) <= 0.5, '100% holds the 0% level');
});

test('wet send rises at every quarter step and keeps the endpoints', () => {
  const at = (intensity) => mix.computeMixLevels(intensity);
  const points = [0, 0.25, 0.5, 0.75, 1].map((intensity) => ({
    intensity,
    wet: at(intensity).params.wetGain,
    dry: at(intensity).dry,
  }));
  console.log('     wet send by slider quarter: ' + points.map((p) =>
    p.intensity.toFixed(2) + '=' + p.wet.toFixed(4)).join('  '));
  assert.equal(points[0].wet, 0, '0% is fully dry');
  assert.equal(points[0].dry, 0.9, '0% keeps the full direct bus');
  assert.ok(Math.abs(points[4].wet - 0.6) < 1e-12, '100% keeps the capped wet send');
  assert.ok(Math.abs(points[4].dry - 0.72) < 1e-12, '100% keeps the strong direct bus');
  for (let k = 1; k < points.length; k++) {
    assert.ok(points[k].wet > points[k - 1].wet, 'wet send is strictly increasing at ' + points[k].intensity);
    assert.ok(points[k].dry < points[k - 1].dry, 'dry complement falls at ' + points[k].intensity);
  }
  const upperHalf = points[4].wet - points[2].wet;
  const upperQuarter = points[4].wet - points[3].wet;
  assert.ok(upperHalf > 0.2, 'the upper half of the slider still adjusts wet send: ' + upperHalf.toFixed(4));
  assert.ok(upperQuarter > 0.08, 'the last quarter still adjusts wet send: ' + upperQuarter.toFixed(4));
});

test('maximum intensity preserves the direct signal and bounds wet, tail and peak vs baseline', () => {
  const shipped = mix.computeMixLevels(1);
  const base = baselineMix(1);
  const now = render(shipped, input);
  const before = render(base, input);
  const directRms = rms(input, winFrom, winTo) * shipped.dry;
  const tailNow = renderWet(shipped.params, impulse());
  const tailBase = renderWet(base.params, impulse());
  const tailFrom = Math.floor(SR * 0.4);
  const tailTo = Math.floor(SR * 0.5);
  const tailRmsNow = rms(tailNow, tailFrom, tailTo);
  const tailRmsBase = rms(tailBase, tailFrom, tailTo);
  console.log('     shipped: wetGain=' + shipped.params.wetGain.toFixed(3) +
    ' dry=' + shipped.dry.toFixed(3) + ' directRMS=' + directRms.toFixed(5));
  console.log('     wet RMS now=' + rms(now.wet, winFrom, winTo).toFixed(5) +
    ' baseline=' + rms(before.wet, winFrom, winTo).toFixed(5));
  console.log('     tail RMS now=' + tailRmsNow.toExponential(2) +
    ' baseline=' + tailRmsBase.toExponential(2));
  console.log('     peak now=' + peak(now.out).toFixed(3) + ' baseline=' + peak(before.out).toFixed(3));
  assert.ok(shipped.params.wetGain <= 0.6 + 1e-12, 'wet send is capped at maximum');
  assert.ok(shipped.dry >= 0.65, 'the direct bus stays strong at maximum');
  assert.ok(directRms > 0, 'the direct path carries signal at maximum');
  assert.ok(rms(now.wet, winFrom, winTo) < rms(before.wet, winFrom, winTo), 'wet is bounded below baseline');
  assert.ok(tailRmsNow < tailRmsBase, 'tail is bounded below baseline');
  assert.ok(peak(now.out) <= peak(before.out) + 1e-6, 'peak is bounded by baseline');
});
