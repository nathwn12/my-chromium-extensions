'use strict';
// F2 proof: a NaN block must not poison the loudness estimators permanently.
// Usage: node qa/proof-f2-nan.cjs [path-to-worklet.js]
// Settles estimators on a sine, injects one all-NaN block, then feeds clean
// blocks and checks the estimators + output recover (finite) within 5 blocks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const workletPath = process.argv[2] || path.join(repoRoot, 'audio', 'normalizer-worklet.js');
const SR = 48000;
const BLOCK = 128;
const CH = 2;

function loadProcessor(src) {
  let Captured = null;
  const sandbox = {
    console, Math, JSON,
    sampleRate: SR,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
    registerProcessor: (_name, cls) => { Captured = cls; },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'worklet.js' });
  if (!Captured) throw new Error('processor not registered');
  return new Captured();
}

function sineBlock(freq, amp, startFrame) {
  const chs = [];
  for (let c = 0; c < CH; c++) {
    const b = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) b[i] = amp * Math.sin(2 * Math.PI * freq * (startFrame + i) / SR);
    chs.push(b);
  }
  return chs;
}

function nanBlock() {
  return [new Float32Array(BLOCK).fill(NaN), new Float32Array(BLOCK).fill(NaN)];
}

function runBlock(proc, input) {
  const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  proc.process([input], [output]);
  return output;
}

function allFinite(arrays) {
  for (const a of arrays) for (const v of a) if (!Number.isFinite(v)) return false;
  return true;
}

function main() {
  const src = fs.readFileSync(workletPath, 'utf8');
  const proc = loadProcessor(src);
  let frame = 0;
  for (let b = 0; b < 40; b++) { runBlock(proc, sineBlock(440, 0.15, frame)); frame += BLOCK; }
  const preNaN = proc.momentarySq;
  const nanOut = runBlock(proc, nanBlock()); frame += BLOCK;
  const nanOutFinite = allFinite(nanOut);
  let recoveredAt = -1;
  let outputsFinite = nanOutFinite;
  for (let b = 1; b <= 20; b++) {
    const out = runBlock(proc, sineBlock(440, 0.15, frame)); frame += BLOCK;
    if (!allFinite(out)) outputsFinite = false;
    if (recoveredAt < 0 && Number.isFinite(proc.momentarySq) && Number.isFinite(proc.shortSq)) recoveredAt = b;
  }
  const result = {
    file: workletPath,
    preNaNFinite: Number.isFinite(preNaN),
    nanBlockOutputFinite: nanOutFinite,
    recoveredWithin5: recoveredAt >= 0 && recoveredAt <= 5,
    recoveredAtBlock: recoveredAt,
    finalMomentarySq: proc.momentarySq,
    finalShortSq: proc.shortSq,
    laterOutputsFinite: outputsFinite,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.preNaNFinite) { console.log('SETUP-FAIL'); process.exit(2); }
  if (result.recoveredWithin5 && result.nanBlockOutputFinite && result.laterOutputsFinite) {
    console.log('GREEN: estimators recovered, no NaN emitted');
  } else {
    console.log(`RED: never recovers: ${recoveredAt < 0}, nanOutFinite=${nanOutFinite}, laterFinite=${outputsFinite}`);
    process.exit(1);
  }
}

main();
