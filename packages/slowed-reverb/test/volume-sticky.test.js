'use strict';

/* global require, __dirname, setImmediate */

/*
 * test/volume-sticky.test.js - a wheel-set volume is sticky, Node only.
 *
 * Owner report: "The volume also isn't sticky. I set it to 20%, I refresh, it
 * goes back to the louder volume. Scroll volume is not sticky."
 *
 * The wheel wrote the page player and the element but never stored anything,
 * so every page load started again from whatever YouTube Music restored. These
 * tests pin the two halves of the fix: a coalesced write of the wheel value into
 * the site settings, and one restore per page load through the same page-hook
 * path the wheel uses. No browser, no audio: fake DOM, fake timers, fake hooks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const actions = require(path.join(ROOT, 'player-actions.js'));

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'shared.js'), 'utf8'), { filename: 'shared.js' });
const Shared = globalThis.SlowedReverbShared;

const HOST_ATTR = 'data-slra-player-actions';
const SAVE_DEBOUNCE_MS = 300;
const RESTORE_RETRY_MS = 600;

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

function createElement(tagName) {
  const listeners = new Map();
  const element = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentElement: null,
    attributes: new Map(),
    style: {},
    dataset: {},
    shadowRoot: null,
    isConnected: true,
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    type: '',
    isContentEditable: false,
    scrollHeight: 0,
    clientHeight: 0,
    computedOverflow: 'visible',
    computedVisibility: 'visible',
    computedDisplay: 'block',
    currentTime: 0,
    duration: 300,
    paused: false,
    seeking: false,
    muted: false,
    volume: 50 * actions.YTM_ELEMENT_PER_PLAYER,
    currentSrc: 'https://music.youtube.com/stream/song-a',
    playCalls: 0,
    classList: {
      names: new Set(),
      add() {},
      remove() {},
      contains() {
        return false;
      },
      toggle() {
        return false;
      },
    },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    },
    remove() {},
    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(type, props) {
      const event = {
        type: type,
        target: this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...(props || {}),
      };
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
      return event;
    },
    attachShadow() {
      this.shadowRoot = createElement('#shadow-root');
      return this.shadowRoot;
    },
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
    contains(node) {
      return node === this;
    },
  };
  return element;
}

function createDom() {
  const documentElement = createElement('html');
  const body = createElement('body');
  documentElement.appendChild(body);
  const bar = createElement('ytmusic-player-bar');
  documentElement.appendChild(bar);
  const mainPanel = createElement('div');
  mainPanel.setAttribute('id', 'main-panel');
  documentElement.appendChild(mainPanel);

  const docListeners = new Map();
  const winListeners = new Map();

  const document = {
    documentElement: documentElement,
    body: body,
    defaultView: null,
    visibilityState: 'visible',
    createElement: (tagName) => createElement(tagName),
    querySelector: () => null,
    addEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, props) {
      const event = {
        type: type,
        target: documentElement,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...(props || {}),
      };
      for (const fn of [...(docListeners.get(type) || [])]) fn(event);
      return event;
    },
  };

  const win = {
    document: document,
    location: { href: 'https://music.youtube.com/watch?v=song-a' },
    innerHeight: 800,
    getComputedStyle: (node) => ({
      overflowY: (node && node.computedOverflow) || 'visible',
      visibility: (node && node.computedVisibility) || 'visible',
      display: (node && node.computedDisplay) || 'block',
    }),
    addEventListener(type, fn) {
      const list = winListeners.get(type) || [];
      list.push(fn);
      winListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, props) {
      const event = {
        type: type,
        target: documentElement,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        deltaMode: 0,
        deltaY: 0,
        ...(props || {}),
      };
      for (const fn of [...(winListeners.get(type) || [])]) fn(event);
      return event;
    },
  };

  document.defaultView = win;

  return {
    win: win,
    document: document,
    documentElement: documentElement,
    bar: bar,
    makeMedia: () => createElement('video'),
  };
}

// ---------------------------------------------------------------------------
// Fake timers, page hook, storage, harness
// ---------------------------------------------------------------------------

function createTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn: fn, ms: ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn: fn, ms: ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    delays() {
      return [...timeouts.values()].map((timer) => timer.ms);
    },
    flushTimeouts() {
      const pending = [...timeouts.entries()];
      timeouts.clear();
      for (const [, timer] of pending) timer.fn();
    },
    tickIntervals() {
      for (const timer of [...intervals.values()]) timer.fn();
    },
  };
}

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function createHarness(options) {
  const settings = options || {};
  const dom = createDom();
  const timers = createTimers();
  const media = dom.makeMedia();
  const pageHookCalls = [];
  const savedVolumes = [];
  const clock = 1000;

  const pageHook = {
    // YTM writes the element volume alongside the player value.
    setVolume(percent) {
      pageHookCalls.push({ percent: percent });
      media.volume = percent * actions.YTM_ELEMENT_PER_PLAYER;
      return Promise.resolve({ volume: percent, applied: true, source: 'player' });
    },
    syncVolumeUi() {},
  };

  const storage = {
    async get(key) {
      return { [key]: { sections: [] } };
    },
    async set() {},
    subscribe() {
      return () => {};
    },
  };
  if (settings.saveVolume !== false) {
    storage.saveVolume = async (percent) => {
      savedVolumes.push(percent);
      return { ok: true };
    };
  }

  const controller = actions.createPlayerActions({
    window: dom.win,
    document: dom.document,
    mediaProvider: () => media,
    pageHook: pageHook,
    storage: storage,
    timers: timers,
    now: () => clock,
  });

  return {
    controller: controller,
    dom: dom,
    timers: timers,
    media: media,
    pageHookCalls: pageHookCalls,
    savedVolumes: savedVolumes,
    wheel(deltaY) {
      return dom.win.dispatch('wheel', { deltaY: deltaY, target: dom.bar });
    },
    hasHost() {
      return dom.documentElement.children.some((child) => child.hasAttribute(HOST_ATTR));
    },
    async start() {
      await controller.start();
      await settle();
    },
  };
}

// ---------------------------------------------------------------------------
// Persist: one coalesced write per burst
// ---------------------------------------------------------------------------

test('volume: one wheel step saves the value once, only after the coalescing window', async () => {
  const harness = createHarness();
  await harness.start();
  harness.wheel(100);
  await settle();

  assert.deepEqual(harness.pageHookCalls, [{ percent: 45 }], 'the wheel wrote the page');
  assert.deepEqual(harness.savedVolumes, [], 'nothing is written on the wheel itself');

  harness.timers.flushTimeouts();
  await settle();
  assert.deepEqual(harness.savedVolumes, [45]);
});

test('volume: a burst of wheel steps saves only the last value, once', async () => {
  const harness = createHarness();
  await harness.start();
  harness.wheel(100);
  harness.wheel(100);
  harness.wheel(100);
  await settle();

  assert.equal(harness.pageHookCalls.length, 3, 'every step applied to the page');
  assert.deepEqual(harness.savedVolumes, []);

  harness.timers.flushTimeouts();
  await settle();
  assert.deepEqual(harness.savedVolumes, [35], 'one write, last value wins');
});

test('volume: pagehide flushes a pending save without waiting for the window', async () => {
  const harness = createHarness();
  await harness.start();
  harness.wheel(100);
  await settle();

  harness.dom.win.dispatch('pagehide');
  await settle();
  assert.deepEqual(harness.savedVolumes, [45]);
});

test('volume: hiding the tab flushes a pending save too', async () => {
  const harness = createHarness();
  await harness.start();
  harness.wheel(100);
  await settle();

  harness.dom.document.visibilityState = 'hidden';
  harness.dom.document.dispatch('visibilitychange');
  await settle();
  assert.deepEqual(harness.savedVolumes, [45]);
});

test('guard: no saveVolume writer is not a failed wheel', async () => {
  const harness = createHarness({ saveVolume: false });
  await harness.start();
  harness.wheel(100);
  await settle();
  harness.timers.flushTimeouts();
  await settle();

  assert.deepEqual(harness.pageHookCalls, [{ percent: 45 }]);
});

// ---------------------------------------------------------------------------
// Restore: once per page load, through the same page-hook path
// ---------------------------------------------------------------------------

test('volume: a stored volume is applied once on load, then the page owns it', async () => {
  const harness = createHarness();
  await harness.start();
  assert.deepEqual(harness.pageHookCalls, [], 'nothing is applied before a stored value arrives');

  harness.controller.restoreVolume(20);
  await settle();
  assert.deepEqual(harness.pageHookCalls, [{ percent: 20 }]);

  // Later playback signals must not re-pin the page.
  harness.media.dispatchEvent('playing');
  harness.media.dispatchEvent('play');
  harness.timers.flushTimeouts();
  await settle();
  assert.deepEqual(harness.pageHookCalls, [{ percent: 20 }]);
});

test('volume: a restore waits for playback and then applies once', async () => {
  const harness = createHarness();
  await harness.start();
  harness.media.paused = true;

  harness.controller.restoreVolume(20);
  await settle();
  assert.deepEqual(harness.pageHookCalls, [], 'a paused player is not written');

  harness.media.paused = false;
  harness.media.dispatchEvent('playing');
  await settle();
  assert.deepEqual(harness.pageHookCalls, [{ percent: 20 }]);
});

test('volume: one bounded retry when the page restores its own volume over ours', async () => {
  const harness = createHarness();
  await harness.start();
  harness.controller.restoreVolume(20);
  await settle();
  assert.deepEqual(harness.pageHookCalls, [{ percent: 20 }]);

  // YTM applies its own startup value after ours.
  harness.media.volume = 100 * actions.YTM_ELEMENT_PER_PLAYER;
  harness.timers.flushTimeouts();
  await settle();

  assert.deepEqual(harness.pageHookCalls, [{ percent: 20 }, { percent: 20 }], 'exactly one retry');
  harness.timers.flushTimeouts();
  await settle();
  assert.equal(harness.pageHookCalls.length, 2, 'and no second retry');
});

test('volume: a restore that stuck is not rewritten', async () => {
  const harness = createHarness();
  await harness.start();
  harness.controller.restoreVolume(20);
  await settle();

  harness.timers.flushTimeouts();
  await settle();
  assert.deepEqual(harness.pageHookCalls, [{ percent: 20 }]);
});

test('guard: a wheel step before playback cancels the pending restore', async () => {
  const harness = createHarness();
  await harness.start();
  harness.media.paused = true;
  harness.controller.restoreVolume(20);
  assert.deepEqual(harness.pageHookCalls, [], 'the paused page is not written');

  harness.wheel(100);
  await settle();
  assert.deepEqual(harness.pageHookCalls, [{ percent: 45 }], 'the wheel owns the value');

  harness.media.paused = false;
  harness.media.dispatchEvent('playing');
  harness.timers.flushTimeouts();
  await settle();
  assert.deepEqual(harness.pageHookCalls, [{ percent: 45 }], 'the stale restore never fires');
});

test('guard: junk restore values are ignored', async () => {
  const harness = createHarness();
  await harness.start();
  harness.controller.restoreVolume('loud');
  harness.controller.restoreVolume(null);
  await settle();
  assert.deepEqual(harness.pageHookCalls, []);
});

// ---------------------------------------------------------------------------
// Settings shape
// ---------------------------------------------------------------------------

test('settings: an object without volume stays valid and means never set', () => {
  const normalized = Shared.normalizeSettings({ slow: 0.9, reverbIntensity: 0.4 });
  assert.equal(normalized.slow, 0.9);
  assert.equal(normalized.reverbIntensity, 0.4);
  assert.equal(normalized.volume, null);
  assert.equal(Shared.normalizeSettings(null).volume, null);
});

test('settings: volume is clamped to an integer 0-100 and non-finite input is unset', () => {
  assert.equal(Shared.normalizeSettings({ volume: 20 }).volume, 20);
  assert.equal(Shared.normalizeSettings({ volume: '20' }).volume, 20);
  assert.equal(Shared.normalizeSettings({ volume: 20.6 }).volume, 21);
  assert.equal(Shared.normalizeSettings({ volume: 120 }).volume, 100);
  assert.equal(Shared.normalizeSettings({ volume: -5 }).volume, 0);
  assert.equal(Shared.normalizeSettings({ volume: 'abc' }).volume, null);
  assert.equal(Shared.normalizeSettings({ volume: NaN }).volume, null);
  assert.equal(Shared.normalizeSettings({ volume: Infinity }).volume, null);
});

test('settings: the default shape carries an unset volume', () => {
  assert.equal(Shared.getDefaultSettings().volume, null);
});

// ---------------------------------------------------------------------------
// Wiring, static: the facade and the background merge are what make it reach
// storage. No browser is launched for these.
// ---------------------------------------------------------------------------

test('wiring: the content script saves the wheel volume through SET_SITE_SETTINGS', () => {
  const source = fs.readFileSync(path.join(ROOT, 'content-script.js'), 'utf8');
  assert.match(source, /saveVolume:\s*\(percent\)\s*=>/, 'the facade exposes saveVolume');
  assert.match(source, /type:\s*'SET_SITE_SETTINGS'/, 'it sends the existing message');
  assert.match(source, /volume:\s*/, 'with a volume field');
  assert.match(source, /restoreVolume\(/, 'and it restores the stored volume');
});

test('wiring: the background merges the stored settings before normalizing a patch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.ok(
    source.includes('...(current || {})'),
    'SET_SITE_SETTINGS must merge a volume-only patch over the stored settings',
  );
  assert.ok(
    source.includes('const settings = normalizeSettings({'),
    'and normalize the merged object',
  );
});
