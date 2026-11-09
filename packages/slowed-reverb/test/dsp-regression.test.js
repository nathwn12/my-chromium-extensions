'use strict';

/* global require, process, __dirname */

/*
 * test/dsp-regression.test.js - offline DSP regression for the Dattorro repair.
 *
 * Plain Node only: the real dattorro-worklet.js is evaluated with stub
 * globals (same pattern as mute-enforce.test.js) at 44.1/48/96 kHz, and the
 * real content-script.js is read as text with its mix expressions eval'd.
 * No browser, no AudioContext, no playback. Each numbered item fails on the
 * pre-fix bytes and passes on the repaired bytes.
 */

const fs = require('fs');
const path = require('path');

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

function db(x) {
  return 20 * Math.log10(x);
}

const WORKLET_PATH = path.join(__dirname, '..', 'dattorro-worklet.js');
const CONTENT_PATH = path.join(__dirname, '..', 'content-script.js');

function loadWorkletClass(sr) {
  const src = fs.readFileSync(WORKLET_PATH, 'utf8');
  const factory = new Function(
    'sampleRate',
    'AudioWorkletProcessor',
    'registerProcessor',
    src + '\nreturn DattorroReverbProcessor;'
  );
  let registered = null;
  const StubBase = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
  };
  const cls = factory(sr, StubBase, (name, c) => {
    void name;
    registered = c;
  });
  return { cls: registered || cls, src };
}

// Run `seconds` of audio through a fresh processor; fill(L, R, start) writes
// the input blocks; returns { outL, outR } concatenated.
function runAudio(Cls, sr, params, seconds, fill) {
  const p = new Cls();
  if (params) p.handleMessage({ type: 'setParams', params });
  const total = Math.floor(sr * seconds);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  const B = 1024;
  let done = 0;
  while (done < total) {
    const n = Math.min(B, total - done);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    fill(L, R, done, sr);
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    p.process([[L, R]], [[oL, oR]]);
    outL.set(oL, done);
    outR.set(oR, done);
    done += n;
  }
  return { p, outL, outR };
}

function maxAbsDelta(buf, skip) {
  let m = 0;
  for (let i = skip + 1; i < buf.length; i++) {
    const d = Math.abs(buf[i] - buf[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

function rmsWindow(buf, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function countNonFinite(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) n++;
  return n;
}

function countClipped(l, r) {
  let n = 0;
  for (let i = 0; i < l.length; i++) {
    if (Math.abs(l[i]) >= 1 || Math.abs(r[i]) >= 1) n++;
  }
  return n;
}

function peakOf(l, r) {
  let m = 0;
  for (let i = 0; i < l.length; i++) {
    if (Math.abs(l[i]) > m) m = Math.abs(l[i]);
    if (Math.abs(r[i]) > m) m = Math.abs(r[i]);
  }
  return m;
}

// 128-frame blocks. `input` may be null to model a disconnected source; the
// output arrays are reused when `holder` is passed, exactly like a live render
// quantum, so a worklet that writes nothing replays stale samples.
function pumpBlocks(p, sr, seconds, input, holder) {
  const total = Math.floor(sr * seconds);
  const out = new Float32Array(total);
  let done = 0;
  while (done < total) {
    const n = Math.min(128, total - done);
    let block = [];
    if (input) {
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      input(L, R, done, sr);
      block = [L, R];
    }
    const oL = holder ? holder[0] : new Float32Array(n);
    const oR = holder ? holder[1] : new Float32Array(n);
    p.process([block], [[oL, oR]]);
    out.set(oL.subarray(0, n), done);
    done += n;
  }
  return out;
}

function paramsFor(intensity) {
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

function makeTone(freq, amp) {
  return (L, R, start, sr) => {
    for (let n = 0; n < L.length; n++) {
      const v = amp * Math.sin((2 * Math.PI * freq * (start + n)) / sr);
      L[n] = v;
      R[n] = v;
    }
  };
}

function makeDc(amp) {
  return (L, R) => {
    L.fill(amp);
    R.fill(amp);
  };
}

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

// Music-like: low-passed noise plus a 110 Hz tone, normalised to `peak`.
function makeMusic(sr, seconds, peak) {
  const total = Math.floor(sr * seconds);
  const src = new Float32Array(total);
  const rand = mulberry32(0x5eed);
  let y1 = 0;
  let y2 = 0;
  let max = 0;
  for (let n = 0; n < total; n++) {
    const w = rand() * 2 - 1;
    y1 += 0.05 * (w - y1);
    y2 += 0.05 * (y1 - y2);
    const v = y2 * 4 + 0.35 * Math.sin((2 * Math.PI * 110 * n) / sr);
    src[n] = v;
    if (Math.abs(v) > max) max = Math.abs(v);
  }
  const scale = max > 0 ? peak / max : 0;
  for (let n = 0; n < total; n++) src[n] *= scale;
  return (L, R, start) => {
    L.set(src.subarray(start, start + L.length));
    R.set(src.subarray(start, start + R.length));
  };
}

function main() {
  const wsrc = fs.readFileSync(WORKLET_PATH, 'utf8');
  const csrc = fs.readFileSync(CONTENT_PATH, 'utf8');

  // --- 1. WORST: hard clamp, linear below 1.0 ---
  check('1. soft-clip expression is gone', wsrc.indexOf('1 + Math.abs') === -1);
  check('1. hard clamp to [-1,1] present', wsrc.indexOf('Math.max(-1, Math.min(1,') !== -1);
  const outExpr = (wsrc.match(/outL\[i\]\s*=\s*([^;]*wetGain[^;]*);/) || [])[1] || '';
  const outFn = new Function(
    'W',
    'V',
    'return (' + outExpr.replace(/this\.wetGain/g, 'W').replace(/this\.wetLpf\[0\]/g, 'V') + ');'
  );
  const amps = [0.1, 0.3, 0.5, 0.9];
  const gains = amps.map((a) => outFn(1, a) / a);
  const trans = gains.map((g) => db(g));
  console.log('     wet-bus transfer dB @0.1/0.3/0.5/0.9: ' + trans.map((t) => t.toFixed(3)).join(' / '));
  const gainSpread = Math.max.apply(null, gains) - Math.min.apply(null, gains);
  check(
    '1. wet bus is linear below the clamp (single headroom gain)',
    gainSpread < 1e-9 && gains[0] > 0 && gains[0] <= 1,
    'spread ' + gainSpread.toExponential(2) + ' gain ' + gains[0].toFixed(3)
  );
  check(
    '1. the wet bus keeps headroom instead of clipping ordinary material',
    outFn(1, 1.9) <= 1 && outFn(1, 1.9) >= 0.5,
    'out(1.9)=' + outFn(1, 1.9).toFixed(3)
  );

  // --- 2. MIX: fully wet at i=1, equal-power, dip < 1 dB ---
  check('2. capped *0.42 wet mapping is gone', csrc.indexOf('* 0.42') === -1);
  const wetSrc = (csrc.match(/wetGain:\s*(Math\.pow\(i, 0\.75\)[^,\n]*),/) || [])[1] || '';
  const wetFn = new Function('I', 'return (' + wetSrc.replace(/\bi\b/g, 'I') + ');');
  const drySrcs = [
    (csrc.match(/rampGain\(dryGain\.gain,\s*([^;]+)\);/) || [])[1] || '',
    (csrc.match(/rampGain\(controller\.dryGain\.gain,\s*([^;]+)\);/) || [])[1] || '',
  ];
  check('2. both dry sites use the equal-power complement', drySrcs.every((s) => s.indexOf('Math.sqrt') !== -1), drySrcs.join(' | '));
  const dryFns = drySrcs.map(
    (s) => new Function('W', 'return (' + s.replace(/initialParams\.wetGain/g, 'W').replace(/params\.wetGain/g, 'W') + ');')
  );
  let worstDip = 0;
  for (let k = 0; k <= 100; k++) {
    const i = k / 100;
    const w = wetFn(i);
    const d = dryFns[1](w);
    const dip = db(Math.sqrt(w * w + d * d));
    if (dip < worstDip) worstDip = dip;
  }
  console.log(
    '     wet(0)=' + wetFn(0).toFixed(3) + ' wet(1)=' + wetFn(1).toFixed(3) +
    ' dry(0)=' + dryFns[1](wetFn(0)).toFixed(3) + ' dry(1)=' + dryFns[1](wetFn(1)).toFixed(3) +
    ' worst dip=' + worstDip.toFixed(3) + ' dB'
  );
  check('2. i=0 fully dry (wet 0, dry 1)', wetFn(0) === 0 && dryFns[1](0) === 1);
  check('2. i=1 fully wet (wet 1, dry 0)', wetFn(1) === 1 && dryFns[1](1) === 0);
  check('2. level dip < 1 dB across 0..1', worstDip > -1, 'worst dip ' + worstDip.toFixed(2) + ' dB');

  // --- 3. DENORMALS: 40 s of silence leaves nothing below 1e-20 ---
  check('3. sub-1e-20 flush present', wsrc.indexOf('1e-20') !== -1);
  const sr3 = 44100;
  const { cls: Cls3 } = loadWorkletClass(sr3);
  const sine = (L, R, start, sr) => {
    for (let n = 0; n < L.length; n++) {
      const v = 0.5 * Math.sin((2 * Math.PI * 440 * (start + n)) / sr);
      L[n] = v;
      R[n] = v;
    }
  };
  const p3 = new Cls3();
  p3.handleMessage({ type: 'setParams', params: { wetGain: 1 } });
  const B3 = 1024;
  const pump = (seconds, fill) => {
    const total = Math.floor(sr3 * seconds);
    let done = 0;
    while (done < total) {
      const n = Math.min(B3, total - done);
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      fill(L, R, done, sr3);
      p3.process([[L, R]], [[new Float32Array(n), new Float32Array(n)]]);
      done += n;
    }
  };
  pump(1, sine);
  pump(40, (L, R) => {
    L.fill(0);
    R.fill(0);
  });
  const sub = (v) => v !== 0 && Math.abs(v) < 1.1754944e-38;
  let tiny = 0;
  const scan = (buf) => {
    for (let k = 0; k < buf.length; k++) if (sub(buf[k])) tiny++;
  };
  scan(p3.preBuf);
  for (const d of p3.inDiff) scan(d.buf);
  scan(p3.modDelay1.buf);
  scan(p3.modDelay2.buf);
  for (const dl of p3.preDampDL) scan(dl.buf);
  for (const dl of p3.decayDiff2) scan(dl.buf);
  for (const dl of p3.postDampDL) scan(dl.buf);
  for (const v of [p3.preFilter, p3.hpf, p3.damping[0], p3.damping[1], p3.wetLpf[0], p3.wetLpf[1]]) {
    if (sub(v)) tiny++;
  }
  console.log('     subnormal words after 40 s silence: ' + tiny);
  check('3. zero subnormal words after 40 s of silence', tiny === 0, tiny + ' words remain');
  const { outL: tail } = runAudio(Cls3, sr3, { wetGain: 1 }, 1, (L, R, start) => {
    L.fill(0);
    R.fill(0);
    if (start === 0) {
      L[0] = 0.9;
      R[0] = 0.9;
    }
  });
  const tailRms = rmsWindow(tail, Math.floor(sr3 * 0.4), Math.floor(sr3 * 0.5));
  console.log('     impulse tail RMS @0.4-0.5 s: ' + tailRms.toExponential(2) + ' (' + db(Math.max(1e-12, tailRms)).toFixed(1) + ' dBFS)');
  check('3. audible tail survives above -100 dBFS', tailRms > 1e-5, tailRms.toExponential(2));

  // --- 4. SMOOTHING: no integer preDelay steps, continuous LFO ---
  check('4. 2048-sample LFO tick is gone', wsrc.indexOf('& 0x7ff') === -1);
  check('4. no Math.floor on the live predelay', wsrc.indexOf('Math.floor(this.predelay') === -1);
  check('4. fractional reads present', wsrc.indexOf('readFrac') !== -1);
  const sr4 = 44100;
  const { cls: Cls4 } = loadWorkletClass(sr4);
  const in440 = (L, R, start, sr) => {
    for (let n = 0; n < L.length; n++) {
      const v = 0.5 * Math.sin((2 * Math.PI * 440 * (start + n)) / sr);
      L[n] = v;
      R[n] = v;
    }
  };
  const off4 = new Cls4();
  off4.handleMessage({ type: 'setParams', params: { wetGain: 1 } });
  off4.modDepth = 0;
  off4.lfoInc = 0;
  const skip4 = Math.floor(sr4 * 0.5);
  const refRun = (() => {
    const total = Math.floor(sr4 * 2.5);
    const out = new Float32Array(total);
    const B = 1024;
    let done = 0;
    while (done < total) {
      const n = Math.min(B, total - done);
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      in440(L, R, done, sr4);
      const oL = new Float32Array(n);
      const oR = new Float32Array(n);
      off4.process([[L, R]], [[oL, oR]]);
      out.set(oL, done);
      done += n;
    }
    return out;
  })();
  const on4 = runAudio(Cls4, sr4, { wetGain: 1 }, 2.5, in440);
  const dBase = maxAbsDelta(refRun, skip4);
  const dOn = maxAbsDelta(on4.outL, skip4);
  const ratio4 = dOn / Math.max(1e-12, dBase);
  console.log('     max sample delta baseline=' + dBase.toFixed(4) + ' lfo-on=' + dOn.toFixed(4) + ' ratio=' + ratio4.toFixed(2) + 'x');
  check('4. LFO max delta within 1.2x of baseline', ratio4 < 1.2, 'ratio ' + ratio4.toFixed(2) + 'x');

  // --- 5. SAMPLE RATE: identical corners at 44.1/48/96 kHz ---
  check('5. fixed lpfCoeff 0.5 is gone', wsrc.indexOf('lpfCoeff = 0.5') === -1);
  check('5. fixed hpfCoeff 0.025 is gone', wsrc.indexOf('hpfCoeff = 0.025') === -1);
  const rates = [44100, 48000, 96000];
  const fcs = rates.map((r) => {
    const { cls } = loadWorkletClass(r);
    const p = new cls();
    const fc = (c) => (-Math.log(1 - c) * r) / (2 * Math.PI);
    return { r, hpf: fc(p.hpfCoeff), lpf: fc(p.lpfCoeff), lfoHz: ((p.lfoInc * r) / 32) };
  });
  for (const f of fcs) {
    console.log('     sr=' + f.r + ' hpf=' + f.hpf.toFixed(1) + 'Hz lpf=' + f.lpf.toFixed(0) + 'Hz lfo=' + f.lfoHz.toFixed(4) + 'Hz');
  }
  const spread = (xs) => (Math.max.apply(null, xs) - Math.min.apply(null, xs)) / Math.min.apply(null, xs);
  check('5. DC-blocker corner identical at all rates', spread(fcs.map((f) => f.hpf)) < 1e-3);
  check('5. wet-beam corner identical at all rates', spread(fcs.map((f) => f.lpf)) < 1e-3);
  check('5. LFO rate identical at all rates', spread(fcs.map((f) => f.lfoHz)) < 1e-3);
  // Empirical -3 dB of the live lowpass coefficient at 48 kHz.
  const live48 = loadWorkletClass(48000).cls;
  const c48 = new live48().lpfCoeff;
  const fcTheory = (-Math.log(1 - c48) * 48000) / (2 * Math.PI);
  const probe = [0.5, 0.7, 1.0, 1.4, 2.0];
  let measured = 0;
  let best = 1e9;
  for (const mult of probe) {
    const f = fcTheory * mult;
    const total = 48000;
    let y = 0;
    let peak = 0;
    for (let n = 0; n < total; n++) {
      const x = Math.sin((2 * Math.PI * f * n) / 48000);
      y += c48 * (x - y);
      if (n > 24000 && Math.abs(y) > peak) peak = Math.abs(y);
    }
    const err = Math.abs(db(peak) + 3);
    if (err < best) {
      best = err;
      measured = f;
    }
  }
  console.log('     lpf -3dB theory=' + fcTheory.toFixed(0) + 'Hz measured~' + measured.toFixed(0) + 'Hz');
  check('5. measured -3 dB matches theory within 30%', Math.abs(measured - fcTheory) / fcTheory < 0.3);

  // --- 6. TAPS: 353/3627 live on the 4217 line ---
  const taps = (wsrc.match(/const PRE_DAMP_TAPS_MS = \[\s*\[([^\]]+)\][^\[]*\[([^\]]+)\]/) || []).slice(1, 3);
  const rows = taps.map((s) => s.split(',').map((x) => parseFloat(x)));
  console.log('     preDamp taps row0=[' + rows[0].join(', ') + '] row1=[' + rows[1].join(', ') + ']');
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check(
    '6. 266/2974 on the 4453 line, 353/3627 on the 4217 line',
    rows.length === 2 &&
      near(rows[0][0], 8.937872) && near(rows[0][1], 99.929438) &&
      near(rows[1][0], 11.861161) && near(rows[1][1], 121.870905),
    JSON.stringify(rows)
  );

  // --- 7. no stale replay when the source goes away (tank keeps decaying) ---
  const srProbe = 48000;
  const { cls: ClsProbe } = loadWorkletClass(srProbe);
  const p7 = new ClsProbe();
  p7.handleMessage({ type: 'setParams', params: paramsFor(0.8) });
  const loud7 = pumpBlocks(p7, srProbe, 1, makeTone(440, 0.5), null);
  const loudRms = rmsWindow(loud7, Math.floor(srProbe * 0.8), srProbe);
  const holder7 = [new Float32Array(128), new Float32Array(128)];
  pumpBlocks(p7, srProbe, 2, null, holder7);
  const burst7 = pumpBlocks(p7, srProbe, 0.05, makeTone(440, 0.5), null);
  const ratio7 = rmsWindow(burst7, 0, burst7.length) / Math.max(1e-12, loudRms);
  console.log('     empty-input replay ratio: ' + ratio7.toFixed(3));
  check('7. tank decays while the input is empty (no stale replay)', ratio7 < 0.01, 'ratio ' + ratio7.toFixed(3));

  // --- 8. one out-of-range/NaN param must never latch non-finite output -----
  const p8 = new ClsProbe();
  p8.handleMessage({ type: 'setParams', params: { wetGain: 1, preDelay: 5 } });
  const o8 = pumpBlocks(p8, srProbe, 0.5, makeDc(0.1), null);
  check('8. out-of-range preDelay stays finite', countNonFinite(o8) === 0, countNonFinite(o8) + ' non-finite');
  p8.handleMessage({ type: 'setParams', params: paramsFor(1) });
  const o8b = pumpBlocks(p8, srProbe, 0.8, makeDc(0.1), null);
  check('8. NaN cannot latch after valid params are restored', countNonFinite(o8b) === 0, countNonFinite(o8b) + ' non-finite');
  const p8c = new ClsProbe();
  p8c.handleMessage({
    type: 'setParams',
    params: { wetGain: NaN, preDelay: NaN, decay: NaN, damping: NaN, preFilter: NaN },
  });
  p8c.handleMessage({ type: 'setParams', params: paramsFor(1) });
  const o8c = pumpBlocks(p8c, srProbe, 0.5, makeDc(0.2), null);
  check('8. NaN setParams are rejected at the worklet boundary', countNonFinite(o8c) === 0, countNonFinite(o8c) + ' non-finite');
  check(
    '8. every setParams field is finite-gated (static)',
    /Number\.isFinite\(p\.preDelay\)/.test(wsrc) &&
      /Number\.isFinite\(p\.decay\)/.test(wsrc) &&
      /Number\.isFinite\(p\.damping\)/.test(wsrc) &&
      /Number\.isFinite\(p\.wetGain\)/.test(wsrc),
    'a setParams field is written without a finite gate'
  );

  // --- 9. unbounded decay is clamped -------------------------------
  const p9 = new ClsProbe();
  p9.handleMessage({ type: 'setParams', params: { wetGain: 1, decay: 2 } });
  const impulse9 = (L, R, start) => {
    L.fill(0);
    R.fill(0);
    if (start === 0) {
      L[0] = 1;
      R[0] = 1;
    }
  };
  const o9 = pumpBlocks(p9, srProbe, 8, impulse9, null);
  check(
    '9. decay is clamped in the worklet (finite, no runaway)',
    countNonFinite(o9) === 0 && peakOf(o9, o9) < 1 && countClipped(o9, o9) === 0,
    'peak=' + peakOf(o9, o9).toFixed(3) + ' nonfinite=' + countNonFinite(o9)
  );
  check('9. decay is clamped below unity (static)', /Math\.min\(0\.95/.test(wsrc), 'no decay clamp');

  // --- 10. DelayLine has no zero-delay degenerate --------------------------
  const symFactory = new Function(
    'sampleRate',
    'AudioWorkletProcessor',
    'registerProcessor',
    wsrc + '\nreturn { DelayLine };'
  );
  const syms = symFactory(srProbe, class { constructor() { this.port = { postMessage() {} }; } }, () => {});
  const dl = new syms.DelayLine(64);
  dl.write(0, 5);
  check(
    '10. DelayLine(64) keeps 64 samples of history',
    dl.read(0) === 0 && dl.read(64) === 5,
    'read(0)=' + dl.read(0) + ' read(64)=' + dl.read(64)
  );

  // --- 11. wet bus headroom on music-like material -------------------------
  const p11 = new ClsProbe();
  p11.handleMessage({ type: 'setParams', params: paramsFor(1) });
  const music11 = makeMusic(srProbe, 4, 0.7);
  const o11 = pumpBlocks(p11, srProbe, 4, music11, null);
  const clipped11 = countClipped(o11, o11);
  console.log('     clipped samples at input peak 0.7: ' + clipped11);
  check('11. no hard clipping at input peak 0.7', clipped11 === 0, clipped11 + ' clipped');

  // --- 12. dry fast path does not pay the denormal sweep every block ------
  const p12 = new ClsProbe();
  p12.handleMessage({ type: 'setParams', params: paramsFor(0) });
  let flushes12 = 0;
  const originalFlush = p12.flushDenormals.bind(p12);
  p12.flushDenormals = () => {
    flushes12 += 1;
    originalFlush();
  };
  pumpBlocks(p12, srProbe, 5, makeTone(440, 0.5), null);
  const blocks12 = Math.floor(srProbe * 5 / 128);
  console.log('     flush calls during 5 s dry: ' + flushes12 + ' / ' + blocks12 + ' blocks');
  check(
    '12. denormal flush is throttled off the dry fast path',
    flushes12 > 0 && flushes12 <= Math.ceil(blocks12 / 8),
    flushes12 + ' flushes in ' + blocks12 + ' blocks'
  );

  // --- 13. the content-side intensity map never emits non-finite values ---
  const mapSrc = (csrc.match(/function computeDattorroParams\(intensity\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  const mapFn = new Function(mapSrc + '\nreturn computeDattorroParams;');
  const map = mapFn();
  const finiteMap = [0, 0.25, 0.5, 1, NaN, Infinity, -1, 4].every((i) => {
    const params = map(i);
    return Object.keys(params).every((k) => Number.isFinite(params[k]));
  });
  check('13. computeDattorroParams is finite for NaN/out-of-range intensity', finiteMap, 'non-finite param latched');

  if (failures.length > 0) {
    console.error('FAILURES: ' + failures.length);
    process.exitCode = 1;
  } else {
    console.log('all dsp-regression checks passed');
  }
}

main();
