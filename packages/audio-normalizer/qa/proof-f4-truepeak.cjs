'use strict';
// F4 proof: the true-peak 4x-interpolation decimator must be per-channel.
// Usage: node qa/proof-f4-truepeak.cjs [path-to-worklet.js]
// Calls pushTruePeak alternately for two channels over 8 stereo frames and
// counts interpolations per channel by observing Math.abs call volume
// (interp path: 4 calls; fast path: 2 calls).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const workletPath = process.argv[2] || path.join(repoRoot, 'audio', 'normalizer-worklet.js');

function loadTruePeak(src) {
  let absCalls = 0;
  const mathProxy = new Proxy(Math, {
    get: (t, k) => (k === 'abs' ? (...a) => { absCalls++; return Math.abs(...a); } : t[k]),
  });
  const sandbox = {
    console, JSON, Math: mathProxy,
    sampleRate: 48000,
    __take: (n) => { const c = absCalls; absCalls = 0; return c; },
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
    registerProcessor: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.__tp = pushTruePeak;\n', sandbox, { filename: 'worklet.js' });
  return sandbox;
}

function main() {
  const src = fs.readFileSync(workletPath, 'utf8');
  const sb = loadTruePeak(src);
  // Fresh per-channel histories, shaped like ensurePeaks (pad to 5 for fixed).
  const h0 = [0.1, 0.2, 0.3, 0.4, 0];
  const h1 = [0.4, 0.3, 0.2, 0.1, 0];
  const counts = { ch0: 0, ch1: 0 };
  for (let f = 0; f < 8; f++) {
    sb.__tp(h0, 0.5); if (sb.__take() >= 4) counts.ch0++;
    sb.__tp(h1, -0.5); if (sb.__take() >= 4) counts.ch1++;
  }
  const result = { file: workletPath, counts };
  console.log(JSON.stringify(result, null, 2));
  if (counts.ch0 === counts.ch1 && counts.ch0 > 0) {
    console.log(`GREEN: interpolation parity per channel (${counts.ch0}/${counts.ch1})`);
  } else {
    console.log(`RED: starved channel (ch0=${counts.ch0}, ch1=${counts.ch1})`);
    process.exit(1);
  }
}

main();
