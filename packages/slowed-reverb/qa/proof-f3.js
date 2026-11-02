'use strict';

/*
 * qa/proof-f3.js - F3 mono-mix proof (pure Node, real dattorro-worklet.js).
 * Runs the same input through a stereo instance and a 1-channel instance and
 * asserts the mono output equals the intended mix: the mean of the two stereo
 * channels. RED (alias bug): mono buffer holds only the right-channel result.
 * Exit 0 = holds, 1 = failed, 2 = harness setup problem.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SR = 44100;
const N = 19968; // multiple of BLOCK
const BLOCK = 128;

globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};
let Processor = null;
globalThis.registerProcessor = (name, cls) => {
  if (name === 'dattorro-reverb') Processor = cls;
};

const workletPath = path.join(__dirname, '..', 'dattorro-worklet.js');
vm.runInThisContext(fs.readFileSync(workletPath, 'utf8'), { filename: workletPath });
if (!Processor) {
  console.error('FATAL: processor not registered');
  process.exit(2);
}

const PARAMS = {
  preDelay: 0.1,
  preFilter: 0.75,
  inputDiff1: 0.75,
  inputDiff2: 0.625,
  decayDiff1: 0.675,
  decay: 0.35,
  damping: 0.6,
  wetGain: 0.3,
};

function driveStereo() {
  const p = new Processor();
  p.port.onmessage({ data: { type: 'setParams', params: { ...PARAMS } } });
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  for (let start = 0; start < N; start += BLOCK) {
    const ib = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const n = start + i;
      ib[i] = n === 0 ? 1 : 0.4 * Math.sin((2 * Math.PI * 440 * n) / SR);
    }
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    p.process(
      [[ib, ib.slice()]],
      [[oL, oR]]
    );
    outL.set(oL, start);
    outR.set(oR, start);
  }
  return { outL, outR };
}

function driveMono() {
  const p = new Processor();
  p.port.onmessage({ data: { type: 'setParams', params: { ...PARAMS } } });
  const out = new Float32Array(N);
  for (let start = 0; start < N; start += BLOCK) {
    const ib = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const n = start + i;
      ib[i] = n === 0 ? 1 : 0.4 * Math.sin((2 * Math.PI * 440 * n) / SR);
    }
    const o = new Float32Array(BLOCK);
    p.process([[ib]], [[o]]);
    out.set(o, start);
  }
  return out;
}

const { outL, outR } = driveStereo();
const mono = driveMono();

let maxDiff = 0;
for (let n = 5000; n < N; n++) {
  const intended = 0.5 * (outL[n] + outR[n]);
  const d = Math.abs(mono[n] - intended);
  if (d > maxDiff) maxDiff = d;
}
console.log('max |mono - mean(stereoL, stereoR)| over samples 5000..' + N + ' = ' + maxDiff);
const ok = maxDiff < 1e-6;
console.log(ok ? 'PASS F3: mono output equals the intended mix' : 'FAIL F3: mono output is NOT the intended mix');
process.exit(ok ? 0 : 1);
