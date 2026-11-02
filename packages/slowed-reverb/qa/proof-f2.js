'use strict';

/*
 * qa/proof-f2.js - F2 pre-delay units proof (pure Node, real dattorro-worklet.js).
 * Stubs AudioWorkletProcessor/registerProcessor/sampleRate, posts preDelay=0.5 s,
 * feeds an impulse, and measures the onset of wet output. Seconds-everywhere
 * means silence for the first preDelay*sr samples. RED (*0.1 bug): onset ~= 0.05 s.
 * GREEN: onset ~= 0.5 s. Also asserts preBuf holds >= 0.6 s.
 * Exit 0 = assertions hold, 1 = failed, 2 = harness setup problem.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SR = 48000;
const PRE_DELAY = 0.5;
const N = 40000;

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

const proc = new Processor();
proc.port.onmessage({
  data: {
    type: 'setParams',
    params: {
      preDelay: PRE_DELAY,
      preFilter: 0.75,
      inputDiff1: 0.75,
      inputDiff2: 0.625,
      decayDiff1: 0.675,
      decay: 0.3,
      damping: 0.6,
      wetGain: 0.3,
    },
  },
});

console.log('preBuf.length=' + proc.preBuf.length + ' (0.6s @ ' + SR + 'Hz = ' + Math.ceil(SR * 0.6) + ')');

const BLOCK = 128;
let onset = -1;
let idx = 0;
for (let start = 0; start < N; start += BLOCK) {
  const ib = new Float32Array(BLOCK);
  if (start === 0) ib[0] = 1;
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  proc.process(
    [[ib, ib.slice()]],
    [[oL, oR]]
  );
  for (let i = 0; i < BLOCK; i++) {
    if (onset < 0 && (Math.abs(oL[i]) > 1e-9 || Math.abs(oR[i]) > 1e-9)) onset = idx;
    idx++;
  }
}

const expectedMin = Math.floor(PRE_DELAY * SR);
const expectedMax = Math.floor(PRE_DELAY * SR) + 6000;
console.log('first wet onset sample=' + onset + ' (expect in [' + expectedMin + ', ' + expectedMax + '])');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS F2: ' : 'FAIL F2: ') + name + (detail ? ' - ' + detail : ''));
  if (!ok) failures++;
}
check('preBuf sized to 0.6 s', proc.preBuf.length === Math.ceil(SR * 0.6), 'length=' + proc.preBuf.length);
check('impulse onset ~= preDelay*sr', onset >= expectedMin && onset <= expectedMax, 'onset=' + onset);
process.exit(failures === 0 ? 0 : 1);
