'use strict';

/*
 * qa/worklet-offline.js - pure-Node offline harness for the REAL dattorro-worklet.js.
 *
 * SAFETY: runs in plain Node. No browser is launched, no AudioContext is created, no
 * audio device is opened. The real worklet source is evaluated with the AudioWorklet
 * globals stubbed (AudioWorkletProcessor, registerProcessor, sampleRate) and driven
 * block-by-block with Float32Array buffers, so every measured sample is produced by the
 * shipped DSP code itself. Nothing is ever connected to a destination.
 *
 * Question: does keeping the reverb tank primed at intensity 0 remove the wind-up when
 * reverb is enabled? Two scenarios, identical in every respect except tank state at the
 * moment wet output is enabled (step at t = 1.0 s):
 *
 *   PRIMED  the tank is driven from t=0 with the intensity-0.5 params and wetGain = 0
 *           (exactly what the real controller posts at intensity 0, see
 *           content-script.js computePostParams). At the step only wetGain is posted.
 *   COLD    the tank has no history at the step: the processor is reset at the step and
 *           the enabled params + wetGain are posted together - the counterfactual of an
 *           un-primed tank / a freshly attached graph. Because the reset sets wetGain=0
 *           and the enabled wetGain is posted immediately after, the ~5 ms wetGain
 *           one-pole ramp is identical to PRIMED; the only difference is tank fill time.
 *
 * Exit code 0 = all assertions pass, 1 = an assertion failed, 2 = harness setup problem.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SR = 44100;
const BLOCK = 128;
const RUN_SECONDS = 6;
const STEP_SECONDS = 1;
const INTENSITY = 0.5;
const STEP_DELTA_FACTOR = 2; // step deltas must stay within 2x the steady-state max delta

// ---------- AudioWorklet global stubs (the only environment the worklet sees) ----------
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};

let registeredName = null;
let RegisteredProcessor = null;
globalThis.registerProcessor = (name, cls) => {
  registeredName = name;
  RegisteredProcessor = cls;
};

function fatal(message) {
  console.error('FATAL: ' + message);
  process.exit(2);
}

// ---------- load and instantiate the REAL worklet ----------
const workletPath = path.join(__dirname, '..', 'dattorro-worklet.js');
vm.runInThisContext(fs.readFileSync(workletPath, 'utf8'), { filename: workletPath });
if (registeredName !== 'dattorro-reverb') fatal('registerProcessor name was ' + JSON.stringify(registeredName));
if (typeof RegisteredProcessor !== 'function') fatal('no processor class captured');

// ---------- params (mirrors content-script.js computeDattorroParams, content-script.js:599) ----------
function computeDattorroParams(intensity) {
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
    wetGain: Math.pow(i, 0.75) * 0.42,
  };
}

const enabled = computeDattorroParams(INTENSITY);

// Brief-specified expected enabled values, symbolically.
const expected = {
  preDelay: 0.49,
  preFilter: 0.75,
  inputDiff1: 0.75,
  inputDiff2: 0.625,
  decayDiff1: 0.675,
  decay: Math.pow(0.5, 0.75) * 0.58,
  damping: Math.min(0.5 + Math.pow(0.5, 0.6) * 0.4, 0.78),
  wetGain: Math.pow(0.5, 0.75) * 0.42,
};
for (const key of Object.keys(expected)) {
  if (Math.abs(enabled[key] - expected[key]) > 1e-12) {
    fatal('computeDattorroParams(' + INTENSITY + ').' + key + ' = ' + enabled[key] + ', expected ' + expected[key]);
  }
}

// ---------- deterministic input: impulse followed by a steady 440 Hz tone ----------
const totalSamples = Math.floor((RUN_SECONDS * SR) / BLOCK) * BLOCK;
const stepSample = Math.ceil((STEP_SECONDS * SR) / BLOCK) * BLOCK; // 44160 = 345 * 128
const toneStart = Math.round(0.01 * SR);

function buildInput() {
  const input = new Float32Array(totalSamples);
  input[0] = 0.5; // impulse
  for (let n = toneStart; n < totalSamples; n++) {
    input[n] = 0.25 * Math.sin((2 * Math.PI * 440 * n) / SR);
  }
  return input;
}

const input = buildInput();

// ---------- scenario driver (params delivered through the real port.onmessage path) ----------
function runScenario(kind) {
  const processor = new RegisteredProcessor();
  const post = (message) => processor.port.onmessage({ data: message });

  post({ type: 'setParams', params: { ...enabled, wetGain: 0 } });
  if (kind === 'cold') post({ type: 'reset' }); // explicit fresh start

  const outL = new Float32Array(totalSamples);
  const outR = new Float32Array(totalSamples);
  const inBuf = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  let stepped = false;

  for (let start = 0; start < totalSamples; start += BLOCK) {
    if (!stepped && start >= stepSample) {
      stepped = true;
      if (kind === 'cold') {
        // Empty the tank at the exact block where wet output is enabled. This produces
        // the same samples as a graph that only starts processing now: reset() zeroes
        // every delay line and the wetLpf, and sets t=0 / wetGain=0.
        post({ type: 'reset' });
        post({ type: 'setParams', params: { ...enabled } });
      } else {
        // Only the gain steps; the tank has been running with the enabled params.
        post({ type: 'setParams', params: { wetGain: enabled.wetGain } });
      }
    }
    inBuf.set(input.subarray(start, start + BLOCK));
    if (!processor.process([[inBuf]], [[oL, oR]])) fatal('process() returned false at sample ' + start);
    outL.set(oL, start);
    outR.set(oR, start);
  }
  if (!stepped) fatal('step sample never reached');
  return { outL, outR };
}

// ---------- measurement ----------
function windowRms(outL, outR, start, size) {
  let sum = 0;
  for (let i = start; i < start + size; i++) sum += outL[i] * outL[i] + outR[i] * outR[i];
  return Math.sqrt(sum / (2 * size));
}

function envelopeWindows(outL, outR, from, to, size) {
  const windows = [];
  for (let s = from; s + size <= to; s += size) {
    windows.push({ start: s, center: s + size / 2, rms: windowRms(outL, outR, s, size) });
  }
  return windows;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function firstCrossSeconds(env, steady, fraction) {
  const threshold = fraction * steady;
  for (const w of env) {
    if (w.rms >= threshold) return (w.center - stepSample) / SR;
  }
  return null;
}

function maxAbsDelta(outL, outR, from, to) {
  let m = 0;
  for (let i = from + 1; i < to; i++) {
    const dl = Math.abs(outL[i] - outL[i - 1]);
    const dr = Math.abs(outR[i] - outR[i - 1]);
    if (dl > m) m = dl;
    if (dr > m) m = dr;
  }
  return m;
}

function analyze(run) {
  const env = envelopeWindows(run.outL, run.outR, stepSample, totalSamples, BLOCK);
  const steadyFrom = stepSample + Math.round(3 * SR);
  const steadyTo = totalSamples - Math.round(0.05 * SR);
  const steady = mean(envelopeWindows(run.outL, run.outR, steadyFrom, steadyTo, BLOCK).map((w) => w.rms));

  const snapshot = (seconds) => {
    const target = stepSample + seconds * SR;
    let best = env[0];
    for (const w of env) {
      if (Math.abs(w.center - target) < Math.abs(best.center - target)) best = w;
    }
    return best.rms;
  };
  const snapshots = {};
  for (const s of [0.025, 0.05, 0.1, 0.2, 0.5, 1, 3]) snapshots[s] = snapshot(s);

  return {
    steady,
    steadyFrom,
    steadyTo,
    first: env.length ? env[0].rms : 0,
    t50: firstCrossSeconds(env, steady, 0.5),
    t90: firstCrossSeconds(env, steady, 0.9),
    stepDelta: maxAbsDelta(run.outL, run.outR, stepSample, stepSample + Math.round(0.1 * SR)),
    steadyDelta: maxAbsDelta(run.outL, run.outR, steadyFrom, steadyFrom + Math.round(0.5 * SR)),
    snapshots,
  };
}

function ms(seconds) {
  return seconds === null ? 'never' : (seconds * 1000).toFixed(2) + ' ms';
}

// ---------- run ----------
const scenarios = [
  { name: 'PRIMED', run: runScenario('primed') },
  { name: 'COLD', run: runScenario('cold') },
];
for (const s of scenarios) s.metrics = analyze(s.run);

console.log('=== dattorro-worklet offline analysis (pure Node; no browser, no audio device) ===');
console.log('source        : ' + workletPath);
console.log('sampleRate    : ' + SR + ' | block: ' + BLOCK + ' | run: ' + (totalSamples / SR).toFixed(3) + ' s');
console.log('step          : sample ' + stepSample + ' (t = ' + (stepSample / SR).toFixed(6) + ' s; nearest 128-sample block boundary to 1.0 s)');
console.log('input         : impulse 0.5 @ 0, then 440 Hz sine 0.25 from ' + (toneStart / SR).toFixed(3) + ' s');
console.log('enabled params: ' + Object.keys(enabled).map((k) => k + '=' + enabled[k].toFixed(10)).join('  '));
console.log('steady state  : mean window RMS over ' + (scenarios[0].metrics.steadyFrom / SR).toFixed(2) + '-' + (scenarios[0].metrics.steadyTo / SR).toFixed(2) + ' s');
console.log('');
console.log('scenario  steadyRMS   firstWin 25ms    50ms    100ms   200ms   500ms   1s      3s      t50        t90        stepMaxD  steadyMaxD ratio');
for (const s of scenarios) {
  const m = s.metrics;
  const pct = (v) => ((100 * v) / m.steady).toFixed(1) + '%';
  const row = [
    s.name.padEnd(8),
    m.steady.toFixed(6).padEnd(11),
    pct(m.first).padEnd(8),
    pct(m.snapshots[0.025]).padEnd(7),
    pct(m.snapshots[0.05]).padEnd(7),
    pct(m.snapshots[0.1]).padEnd(7),
    pct(m.snapshots[0.2]).padEnd(7),
    pct(m.snapshots[0.5]).padEnd(7),
    pct(m.snapshots[1]).padEnd(7),
    pct(m.snapshots[3]).padEnd(7),
    ms(m.t50).padEnd(10),
    ms(m.t90).padEnd(10),
    m.stepDelta.toExponential(2).padEnd(9),
    m.steadyDelta.toExponential(2).padEnd(11),
    (m.stepDelta / m.steadyDelta).toFixed(2),
  ];
  console.log(row.join(' '));
}
console.log('');
console.log('"firstWin" = window RMS of the first 128 samples after the step (0-2.9 ms); the other columns are snapshots near that offset; all are percentages of the steady-state mean.');
console.log('Steady-state snapshots wobble a few percent because the worklet modulation LFO slowly modulates the tail level; t90 uses the mean steady level as its threshold.');
console.log('');

// ---------- assertions ----------
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' - ' + detail : ''));
  if (!ok) failures++;
  return ok;
}

const primed = scenarios[0].metrics;
const cold = scenarios[1].metrics;

check(
  '(a) PRIMED t90 is short and well under 100 ms',
  primed.t90 !== null && primed.t90 < 0.1,
  'PRIMED t90 = ' + ms(primed.t90)
);

const bOk = primed.t90 !== null && cold.t90 !== null && primed.t90 * 2 < cold.t90;
check(
  '(b) PRIMED t90 is clearly shorter than COLD t90 (at least 2x margin)',
  bOk,
  'PRIMED t90 = ' + ms(primed.t90) + ', COLD t90 = ' + ms(cold.t90)
);
if (!bOk) {
  console.log('!!!! NEGATIVE RESULT: priming did not measurably remove the wind-up in this harness.');
  console.log('!!!! PRIMED t90 = ' + ms(primed.t90) + ' vs COLD t90 = ' + ms(cold.t90) + '. This contradicts the intended design; report it, do not hide it.');
}

for (const s of scenarios) {
  const ratio = s.metrics.steadyDelta > 0 ? s.metrics.stepDelta / s.metrics.steadyDelta : Infinity;
  check(
    '(c) ' + s.name + ' step max |sample delta| is bounded by the steady-state delta',
    s.metrics.steadyDelta > 0 && ratio <= STEP_DELTA_FACTOR,
    'stepMaxDelta=' + s.metrics.stepDelta.toExponential(3) + ', steadyMaxDelta=' + s.metrics.steadyDelta.toExponential(3) + ', ratio=' + ratio.toFixed(2)
  );
}

const steadyRel = Math.abs(cold.steady - primed.steady) / primed.steady;
check(
  '(sanity) COLD and PRIMED converge to the same steady-state level (within 10%)',
  steadyRel < 0.1,
  'relative difference = ' + (steadyRel * 100).toFixed(2) + '%'
);

console.log('');
console.log(failures === 0 ? 'RESULT: all assertions passed.' : 'RESULT: ' + failures + ' assertion(s) FAILED.');
process.exitCode = failures === 0 ? 0 : 1;
