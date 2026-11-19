'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const csPath = process.argv[2] || path.join(repoRoot, 'content-script.js');

async function main() {
  const sharedSrc = fs.readFileSync(path.join(repoRoot, 'shared.js'), 'utf8');
  const csSrc = fs.readFileSync(csPath, 'utf8');
  let runtimeListener = null;
  let sendCalls = 0;
  const timers = [];
  async function flush(n = 60) {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setImmediate(r));
      while (timers.length) timers.shift()();
      await new Promise((r) => setImmediate(r));
    }
  }
  const sandbox = {
    console, Math, Date, JSON, Promise, URL,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
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
            siteSettings: { 'example.com': { enabled: true, gainDb: 0, blastGuard: false } },
          }),
          set: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        onMessage: { addListener: (fn) => { runtimeListener = fn; } },
        sendMessage: async () => { sendCalls++; throw new Error('no receiver'); },
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
  const callsAfterInit = sendCalls;
  runtimeListener({ type: 'SET_DOCUMENT_STATE', enabled: true, gainDb: 0, blastGuard: false }, {}, () => {});
  await flush();
  let status;
  runtimeListener({ type: 'GET_DOCUMENT_STATUS' }, {}, (r) => { status = r; });
  await flush(10);
  const result = { file: csPath, callsAfterInit, sendCalls, lastError: status?.lastError };
  console.log(JSON.stringify(result, null, 2));
  if (sendCalls >= 2 && status?.lastError) {
    console.log('GREEN: rejection cleared injecting (retry fired) and recorded lastError');
  } else {
    console.log(`RED: rejection swallowed (sendCalls=${sendCalls}, lastError=${JSON.stringify(status?.lastError)})`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
