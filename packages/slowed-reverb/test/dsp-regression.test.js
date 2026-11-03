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
  const trans = amps.map((a) => db(outFn(1, a) / a));
  console.log('     transfer dB @0.1/0.3/0.5/0.9: ' + trans.map((t) => t.toFixed(3)).join(' / '));
  check(
    '1. transfer is 0.0 dB below 1.0',
    trans.every((t) => Math.abs(t) < 1e-9),
    'got ' + trans.map((t) => t.toFixed(2)).join(',') + ' dB'
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

  if (failures.length > 0) {
    console.error('FAILURES: ' + failures.length);
    process.exitCode = 1;
  } else {
    console.log('all dsp-regression checks passed');
  }
}

main();
