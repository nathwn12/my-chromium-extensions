'use strict';
// F3 proof: the lookahead limiter must account for user gain.
// Usage: node qa/proof-f3-limiter.cjs [path-to-worklet.js]
// Hot sine (peak 0.5) with set-gain-db +12 (x4 -> peak ~2.0 pre-limiter).
// Counts samples where the pre-knee signal exceeds the limiter ceiling,
// i.e. samples the last-resort soft knee had to rescue (sustained hard
// clipping) instead of the clean lookahead limiter. Patched into the loaded
// source string only; the repo file is untouched. Float32 output quantizes
// exact-ceiling flat-tops, so a black-box output comparison cannot see them.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const workletPath = process.argv[2] || path.join(repoRoot, 'audio', 'normalizer-worklet.js');
const SR = 48000;
const BLOCK = 128;
const CH = 2;

const COUNT_PATCH_FROM = 'const processed = applySoftKnee(delayed * totalGain, ceilingLinear, SOFT_KNEE_RATIO);';
const COUNT_PATCH_TO = `const preKnee = delayed * totalGain;
        if (globalThis.__countKnee && Math.abs(preKnee) > ceilingLinear) globalThis.__kneeSaves++;
        const processed = applySoftKnee(preKnee, ceilingLinear, SOFT_KNEE_RATIO);`;

function loadProcessor(src) {
  if (!src.includes(COUNT_PATCH_FROM)) throw new Error('knee patch anchor not found');
  const patched = src.split(COUNT_PATCH_FROM).join(COUNT_PATCH_TO);
  let Captured = null;
  const sandbox = {
    console, Math, JSON,
    sampleRate: SR,
    __countKnee: false,
    __kneeSaves: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
    registerProcessor: (_name, cls) => { Captured = cls; },
  };
  vm.createContext(sandbox);
  vm.runInContext(patched, sandbox, { filename: 'worklet.js' });
  return { proc: new Captured(), sandbox };
}

function main() {
  const src = fs.readFileSync(workletPath, 'utf8');
  const { proc, sandbox } = loadProcessor(src);
  proc.port.onmessage({ data: { type: 'set-gain-db', gainDb: 12 } });
  let frame = 0;
  const totalBlocks = 260;
  const skipBlocks = 60;
  for (let b = 0; b < totalBlocks; b++) {
    const input = [];
    for (let c = 0; c < CH; c++) {
      const blk = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) blk[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (frame + i) / SR);
      input.push(blk);
    }
    if (b === skipBlocks) { sandbox.__kneeSaves = 0; sandbox.__countKnee = true; }
    const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([input], [output]);
    frame += BLOCK;
  }
  const measured = (totalBlocks - skipBlocks) * BLOCK * CH;
  const result = { file: workletPath, userGainDb: 12, measured, kneeSaves: sandbox.__kneeSaves };
  console.log(JSON.stringify(result, null, 2));
  if (sandbox.__kneeSaves === 0) console.log('GREEN: no soft-knee rescues with +12 dB user gain');
  else { console.log(`RED: ${sandbox.__kneeSaves}/${measured} samples rescued by soft knee (hard clipping)`); process.exit(1); }
}

main();
