'use strict';
// F6 proof: the popup toggle must reflect the authoritative GET_SITE_STATE,
// not the siteToggles mirror.
// Usage: node qa/proof-f6-popup.cjs [path-to-popup.js]
// Scenario A (divergence): mirror ON, authority OFF -> toggle must be OFF.
// Scenario B (fallback): authority unreachable (undefined) -> mirror used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const popupPath = process.argv[2] || path.join(repoRoot, 'popup.js');

function el(overrides = {}) {
  return {
    checked: false, disabled: false, value: '', textContent: '', className: '',
    dataset: {}, addEventListener: () => {}, ...overrides,
  };
}

async function runScenario(popupSrc, sharedSrc, { mirrorOn, authority }) {
  const ids = {
    'reset-btn': el(), toggle: el(), 'blast-guard': el(),
    'gain-slider': el({ value: '0' }), 'gain-value': el(), hostname: el(),
    'status-dot': el(), 'status-text': el(),
  };
  const sandbox = {
    console, Math, Date, JSON, Promise, URL,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    window: { addEventListener: () => {} },
    document: {
      getElementById: (id) => ids[id],
      querySelectorAll: () => [],
    },
    chrome: {
      tabs: {
        query: async () => [{ id: 7, url: 'https://www.example.com/' }],
        sendMessage: async () => { throw new Error('unreachable'); },
      },
      runtime: {
        sendMessage: async (msg) => {
          if (msg?.type === 'GET_SITE_STATE') return authority;
          return {};
        },
      },
      storage: {
        local: {
          get: (keys, cb) => cb({ siteToggles: mirrorOn ? { 'example.com': true } : {} }),
          set: (items, cb) => cb && cb(),
        },
        onChanged: { addListener: () => {} },
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(sharedSrc, ctx, { filename: 'shared.js' });
  vm.runInContext(popupSrc, ctx, { filename: 'popup.js' });
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
  return { toggleChecked: ids.toggle.checked };
}

async function main() {
  const sharedSrc = fs.readFileSync(path.join(repoRoot, 'shared.js'), 'utf8');
  const popupSrc = fs.readFileSync(popupPath, 'utf8');
  const a = await runScenario(popupSrc, sharedSrc, {
    mirrorOn: true,
    authority: { enabled: false, gainDb: 3, blastGuard: true, siteKey: 'example.com' },
  });
  const b = await runScenario(popupSrc, sharedSrc, { mirrorOn: true, authority: undefined });
  const result = {
    file: popupPath,
    divergeToggleChecked: a.toggleChecked,
    fallbackToggleChecked: b.toggleChecked,
  };
  console.log(JSON.stringify(result, null, 2));
  if (b.toggleChecked !== true) { console.log('SETUP-FAIL: mirror fallback broken'); process.exit(2); }
  if (a.toggleChecked !== false) {
    console.log('RED: toggle follows the mirror (ON) instead of the authority (OFF)');
    process.exit(1);
  }
  console.log('GREEN: toggle follows authority, mirror kept as fallback');
}

main().catch((e) => { console.error(e); process.exit(2); });
