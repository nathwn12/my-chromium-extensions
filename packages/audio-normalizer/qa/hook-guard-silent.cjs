// qa/hook-guard-silent.cjs
// Pure-Node node:vm harness for the page-hook silence-until-routed guard.
// No browser, no Chromium, no audio playback — fully stubbed DOM/WebAudio.
// Loads the page-hook source, activates it via the START message, and asserts:
//   S1: patched play() mutes synchronously, stays muted while routing is
//       pending, restores the prior value after connect completes.
//   S2: worklet module load rejects -> muted restored, no permanent silence.
//   S3: addModule never resolves -> muted restored by the 1.5 s timeout.
//   S4: element already muted before attach -> restored to true (never false).
//   S5: STOP while guarding -> muted restored.
//   S6: __tnWebAudio element -> no mute applied (control).
// Usage: node qa/hook-guard-silent.cjs [--source <path-to-page-hook.js>]
// Exit code is non-zero on any failure.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SOURCE = path.join(REPO_ROOT, 'page-hook.js');
const CHANNEL = 'tab-normalizer-v5';
const GUARD_TIMEOUT_MS = 1500;

function parseArgs(argv) {
  let source = DEFAULT_SOURCE;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--source' && argv[i + 1]) {
      source = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return { source };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await tick(intervalMs);
  }
}

// addModuleBehavior: 'resolve' | 'reject' | 'never' | 'deferred'
function loadHook(sourceText, filename, addModuleBehavior) {
  const posted = [];
  const messageListeners = [];
  const stats = { addModule: 0, createMediaElementSource: 0 };
  let deferred = null;

  class ElementStub {}
  class HTMLMediaElementStub extends ElementStub {
    constructor() {
      super();
      this.muted = false;
      this.tagName = 'VIDEO';
      this.src = 'https://example.com/v.mp4';
    }
    play() {
      return Promise.resolve();
    }
  }
  class AudioNodeStub {
    connect() {
      return {};
    }
    disconnect() {}
  }
  class GainStub {
    connect() {}
    disconnect() {}
  }
  class SourceStub {
    connect() {}
    disconnect() {}
  }
  class AudioWorkletNodeStub {
    constructor() {
      this.port = { postMessage() {} };
    }
    connect() {}
    disconnect() {}
  }
  class AudioContextStub {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = {};
      this.audioWorklet = {
        addModule: () => {
          stats.addModule++;
          if (addModuleBehavior === 'resolve') return Promise.resolve();
          if (addModuleBehavior === 'reject') return Promise.reject(new Error('boom'));
          if (addModuleBehavior === 'never') return new Promise(() => {});
          return new Promise((resolve, reject) => {
            deferred = { resolve, reject };
          });
        },
      };
    }
    async resume() {}
    createGain() {
      return new GainStub();
    }
    createMediaElementSource() {
      stats.createMediaElementSource++;
      return new SourceStub();
    }
    addEventListener() {}
  }
  class MutationObserverStub {
    constructor() {}
    observe() {}
    disconnect() {}
  }
  class DOMExceptionStub extends Error {
    constructor(message, name) {
      super(message);
      this.name = name || 'Error';
    }
  }

  const documentStub = {
    documentElement: { getAttribute: () => null, removeAttribute: () => {} },
    currentScript: null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const windowStub = {
    addEventListener: (type, fn) => {
      if (type === 'message') messageListeners.push(fn);
    },
    postMessage: (msg) => {
      posted.push(msg);
    },
  };
  windowStub.AudioContext = AudioContextStub;

  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: { href: 'https://example.com/' },
    AudioNode: AudioNodeStub,
    HTMLMediaElement: HTMLMediaElementStub,
    AudioContext: AudioContextStub,
    AudioWorkletNode: AudioWorkletNodeStub,
    MutationObserver: MutationObserverStub,
    Element: ElementStub,
    DOMException: DOMExceptionStub,
    URL,
    console: { ...console, log: () => {} },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(sourceText, sandbox, { filename });

  return {
    posted,
    stats,
    getDeferred: () => deferred,
    fire: (data) => {
      for (const fn of messageListeners) fn({ source: windowStub, data });
    },
    start: () => {
      for (const fn of messageListeners) {
        fn({ source: windowStub, data: { channel: CHANNEL, type: 'START', gainDb: 0 } });
      }
    },
    stop: () => {
      for (const fn of messageListeners) {
        fn({ source: windowStub, data: { channel: CHANNEL, type: 'STOP' } });
      }
    },
    makeElement: () => new HTMLMediaElementStub(),
  };
}

function check(cond, message, failures) {
  if (!cond) failures.push(message);
}

async function scenarioS1(sourceText, filename) {
  const failures = [];
  const hook = loadHook(sourceText, filename, 'deferred');
  hook.start();
  const el = hook.makeElement();
  el.muted = false;
  void el.play();
  check(el.muted === true, `sync after play(): muted should be true, got ${el.muted}`, failures);
  await tick(60);
  check(el.muted === true, `while routing pending: muted should stay true, got ${el.muted}`, failures);
  hook.getDeferred().resolve();
  const attached = await waitFor(() => el.__tnAttached === true);
  check(attached, 'element should attach after module resolves', failures);
  check(el.muted === false, `after connect: muted should restore to false, got ${el.muted}`, failures);
  check(!el.__tnGuarding, 'guard flag should be cleared after connect', failures);
  return failures;
}

async function scenarioS2(sourceText, filename) {
  const failures = [];
  const hook = loadHook(sourceText, filename, 'reject');
  hook.start();
  const el = hook.makeElement();
  el.muted = false;
  void el.play();
  check(el.muted === true, `sync after play(): muted should be true, got ${el.muted}`, failures);
  const settled = await waitFor(() => !el.__tnGuarding, { timeoutMs: 3000 });
  check(settled, 'guard should clear after module rejection', failures);
  check(el.muted === false, `after error: muted should restore to false, got ${el.muted}`, failures);
  return failures;
}

async function scenarioS3(sourceText, filename) {
  const failures = [];
  const hook = loadHook(sourceText, filename, 'never');
  hook.start();
  const el = hook.makeElement();
  el.muted = false;
  void el.play();
  await tick(100);
  check(el.muted === true, `while pending (~100ms): muted should be true, got ${el.muted}`, failures);
  await tick(GUARD_TIMEOUT_MS + 500);
  check(el.muted === false, `after 1.5s timeout: muted should restore to false, got ${el.muted}`, failures);
  check(!el.__tnGuarding, 'guard flag should be cleared by the timeout', failures);
  return failures;
}

async function scenarioS4(sourceText, filename) {
  const failures = [];
  const hook = loadHook(sourceText, filename, 'deferred');
  hook.start();
  const el = hook.makeElement();
  el.muted = true;
  void el.play();
  check(el.muted === true && el.__tnGuarding === true, 'guard should engage on pre-muted element', failures);
  const hasDeferred = await waitFor(() => hook.getDeferred() !== null);
  check(hasDeferred, 'worklet load should start', failures);
  hook.getDeferred().resolve();
  const attached = await waitFor(() => el.__tnAttached === true);
  check(attached, 'element should attach after module resolves', failures);
  check(el.muted === true, `after connect: pre-muted element must restore to true, got ${el.muted}`, failures);
  check(!el.__tnGuarding, 'guard flag should be cleared after connect', failures);
  return failures;
}

async function scenarioS5(sourceText, filename) {
  const failures = [];
  const hook = loadHook(sourceText, filename, 'deferred');
  hook.start();
  const el = hook.makeElement();
  el.muted = false;
  void el.play();
  check(el.muted === true, `sync after play(): muted should be true, got ${el.muted}`, failures);
  hook.stop();
  check(el.muted === false, `after STOP: muted should restore to false, got ${el.muted}`, failures);
  check(!el.__tnGuarding, 'guard flag should be cleared by STOP', failures);
  const hasDeferred = await waitFor(() => hook.getDeferred() !== null);
  check(hasDeferred, 'worklet load should start', failures);
  hook.getDeferred().resolve();
  await tick(100);
  check(el.muted === false, `late attach after STOP must not re-mute, got ${el.muted}`, failures);
  return failures;
}

async function scenarioS6(sourceText, filename) {
  const failures = [];
  const hook = loadHook(sourceText, filename, 'resolve');
  hook.start();
  const el = hook.makeElement();
  el.__tnWebAudio = true;
  el.muted = false;
  void el.play();
  await tick(100);
  check(el.muted === false, `control: muted must stay false, got ${el.muted}`, failures);
  check(!el.__tnGuarding, 'control: guard must not engage on __tnWebAudio element', failures);
  return failures;
}

async function main() {
  const { source } = parseArgs(process.argv);
  const sourceText = fs.readFileSync(source, 'utf8');
  console.log(`hook-guard-silent: source=${source}`);

  const scenarios = [
    ['S1 sync-mute-hold-restore', scenarioS1],
    ['S2 module-reject-restores', scenarioS2],
    ['S3 timeout-restores', scenarioS3],
    ['S4 pre-muted-restores-true', scenarioS4],
    ['S5 stop-while-guarding', scenarioS5],
    ['S6 webaudio-control', scenarioS6],
  ];

  let failed = 0;
  for (const [name, fn] of scenarios) {
    let failures;
    try {
      failures = await fn(sourceText, source);
    } catch (e) {
      failures = [`harness threw: ${e && e.stack ? e.stack : e}`];
    }
    if (failures.length === 0) {
      console.log(`${name}: PASS`);
    } else {
      failed++;
      console.log(`${name}: FAIL`);
      for (const f of failures) console.log(`  - ${f}`);
    }
  }

  console.log(failed === 0 ? 'ALL PASS' : `${failed} SCENARIO(S) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
