'use strict';

/*
 * qa/proof-f9.js - F9 unreachable-verdict proof (pure Node, real background.js).
 * Stubs chrome.* (tabs.sendMessage always rejects: no content script), loads the
 * REAL background.js, and calls pushTabState on an eligible tab. The MAIN-world
 * hook has no runtime-message listener, so gating the verdict on a post-inject
 * retry can never succeed: GREEN sends once, keeps the hook inject as
 * best-effort, and returns unreachable. RED sends twice with the same outcome.
 * Exit 0 = holds, 1 = failed, 2 = harness setup problem.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const stats = { sendMessageCalls: 0, executeScriptCalls: 0 };

globalThis.self = globalThis;
globalThis.importScripts = () => {};
globalThis.chrome = {
  tabs: {
    get: async () => ({ id: 7, url: 'https://www.youtube.com/watch?v=stub' }),
    query: (...args) => {
      const cb = args.find((a) => typeof a === 'function');
      const p = Promise.resolve([]);
      if (cb) p.then(cb);
      return p;
    },
    sendMessage: async () => {
      stats.sendMessageCalls++;
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    onReplaced: { addListener() {} },
  },
  scripting: {
    executeScript: async () => {
      stats.executeScriptCalls++;
      return [];
    },
  },
  runtime: {
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} },
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
    onChanged: { addListener() {} },
  },
};

const root = path.join(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), { filename: 'shared.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), { filename: 'background.js' });

const pushTabState = vm.runInThisContext('pushTabState', { filename: 'fetch-pushTabState' });
if (typeof pushTabState !== 'function') {
  console.error('FATAL: pushTabState not reachable after load');
  process.exit(2);
}

(async () => {
  await new Promise((r) => setTimeout(r, 50)); // let the import-time rehydrate settle
  stats.sendMessageCalls = 0;
  stats.executeScriptCalls = 0;
  const result = await pushTabState(7);
  console.log('pushTabState result: ' + JSON.stringify(result));
  console.log('sendMessage calls: ' + stats.sendMessageCalls + ', hook injects: ' + stats.executeScriptCalls);
  let failures = 0;
  function check(name, ok) {
    console.log((ok ? 'PASS F9: ' : 'FAIL F9: ') + name);
    if (!ok) failures++;
  }
  check('verdict is unreachable', result && result.ok === false && result.error === 'unreachable');
  check('no second sendMessage retry after the MAIN-world hook', stats.sendMessageCalls === 1);
  check('hook inject kept as best-effort', stats.executeScriptCalls === 1);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
