'use strict';
// F1 proof: handleSetDocumentState({enabled:true}) must not clobber gain/blastGuard.
// Usage: node qa/proof-f1-toggle.cjs [path-to-content-script.js]
// Seeds stored gain 6 dB + blast guard on, delivers a gain-less SET_DOCUMENT_STATE
// (the shape of the old TOGGLE_CHANGED broadcast), then reads GET_DOCUMENT_STATUS.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const csPath = process.argv[2] || path.join(repoRoot, 'content-script.js');

async function flush(n = 60) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

async function main() {
  const sharedSrc = fs.readFileSync(path.join(repoRoot, 'shared.js'), 'utf8');
  const csSrc = fs.readFileSync(csPath, 'utf8');
  let runtimeListener = null;
  const sandbox = {
    console, Math, Date, JSON, Promise, URL,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    location: { href: 'https://www.example.com/page' },
    window: { addEventListener: () => {}, postMessage: () => {}, removeEventListener: () => {} },
    document: {
      addEventListener: () => {},
      documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({
            activeSites: {},
            siteSettings: { 'example.com': { enabled: true, gainDb: 6, blastGuard: true } },
          }),
          set: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        onMessage: { addListener: (fn) => { runtimeListener = fn; } },
        sendMessage: async () => ({ ok: true }),
        getURL: (p) => `chrome-extension://x/${p}`,
      },
      tabs: { sendMessage: async () => ({ ok: true }) },
      scripting: { executeScript: async () => {} },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(sharedSrc, ctx, { filename: 'shared.js' });
  vm.runInContext(csSrc, ctx, { filename: 'content-script.js' });
  await flush();
  if (!runtimeListener) throw new Error('runtime.onMessage listener not registered');

  async function getStatus() {
    let captured;
    runtimeListener({ type: 'GET_DOCUMENT_STATUS' }, {}, (r) => { captured = r; });
    await flush(20);
    return captured;
  }

  const before = await getStatus();
  // Gain-less message, shaped like the pre-fix TOGGLE_CHANGED broadcast.
  runtimeListener({ type: 'SET_DOCUMENT_STATE', enabled: true }, {}, () => {});
  await flush();
  const after = await getStatus();

  console.log(JSON.stringify({ file: csPath, before, after }, null, 2));
  if (before.gainDb !== 6 || before.blastGuard !== true) {
    console.log('SETUP-FAIL: stored state did not apply');
    process.exit(2);
  }
  if (after.gainDb !== 6 || after.blastGuard !== true) {
    console.log(`RED: gain-less message clobbered state (gainDb=${after.gainDb}, blastGuard=${after.blastGuard})`);
    process.exit(1);
  }
  console.log('GREEN: gain-less message preserved gainDb=6 blastGuard=true');
}

main().catch((e) => { console.error(e); process.exit(2); });
