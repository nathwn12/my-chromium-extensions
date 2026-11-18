'use strict';

/* global require, __dirname, setImmediate */

/*
 * test/section-latch.test.js - a section repeat is a latch, Node only.
 *
 * The owner report behind this file: "A saved section repeat does not bind. It
 * should be permanent and auto-latch. After one repeat it goes back to the
 * full song."
 *
 * The loop used to be enforced by one 100 ms interval that `syncTick()` tore
 * down whenever its `wanted` predicate was momentarily false (a song id that
 * blipped, a hidden tab), and nothing rebuilt it for the rest of the song.
 * These tests pin the latch: once a section is set it loops on every pass,
 * driven by the media's own events, and a transient loss never disarms it.
 *
 * No browser, no audio: the fake below is the whole surface the controller
 * touches, and the only clock is the fake interval/timeout table.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const actions = require(path.join(__dirname, '..', 'player-actions.js'));

const HOST_ATTR = 'data-slra-player-actions';
const SECTION = { videoId: 'song-a', startSeconds: 30, endSeconds: 60 };

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
    muted: true,
    // Player 50 on the YTM element scale.
    volume: 50 * actions.YTM_ELEMENT_PER_PLAYER,
    currentSrc: '',
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

  function makeMedia(videoId, overrides) {
    const media = createElement('video');
    media.currentSrc = 'https://music.youtube.com/stream/' + videoId;
    media.duration = 300;
    media.play = function play() {
      media.playCalls += 1;
      return Promise.resolve();
    };
    Object.assign(media, overrides || {});
    return media;
  }

  function walk(root) {
    const out = [];
    const visit = (node) => {
      out.push(node);
      for (const child of node.children) visit(child);
      if (node.shadowRoot) visit(node.shadowRoot);
    };
    visit(root);
    return out;
  }

  function panel(label) {
    const current = documentElement.children.find((child) => child.hasAttribute(HOST_ATTR));
    if (!current || !current.shadowRoot) return null;
    return walk(current.shadowRoot).find((node) => node.getAttribute('aria-label') === label) || null;
  }

  return {
    win: win,
    document: document,
    documentElement: documentElement,
    makeMedia: makeMedia,
    panel: panel,
  };
}

// ---------------------------------------------------------------------------
// Fake timers, storage, harness
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
    intervalDelays() {
      return [...intervals.values()].map((timer) => timer.ms);
    },
    tickIntervals() {
      for (const timer of [...intervals.values()]) timer.fn();
    },
    flushTimeouts() {
      const pending = [...timeouts.entries()];
      timeouts.clear();
      for (const [, timer] of pending) timer.fn();
    },
  };
}

function createStorage(sections) {
  const data = { playerActions: { sections: sections || [] } };
  return {
    async get(key) {
      return { [key]: data[key] };
    },
    async set(items) {
      Object.assign(data, items);
    },
    subscribe() {
      return () => {};
    },
  };
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function createHarness(options) {
  const settings = options || {};
  const dom = createDom();
  const timers = createTimers();
  const storage = settings.storage || createStorage();
  let media = settings.media || dom.makeMedia('song-a');
  const clock = 1000;

  const controller = actions.createPlayerActions({
    window: dom.win,
    document: dom.document,
    mediaProvider: () => media,
    pageHook: {
      setVolume: async (percent) => ({ volume: percent, applied: true, source: 'player' }),
      syncVolumeUi() {},
    },
    storage: storage,
    timers: timers,
    now: () => clock,
  });

  return {
    controller: controller,
    dom: dom,
    timers: timers,
    media: () => media,
    setMedia(next) {
      media = next;
    },
    setHref(href) {
      dom.win.location.href = href;
    },
    pushSong(id) {
      controller.setSongId(id);
    },
    backstop() {
      return timers.intervalDelays().includes(actions.TICK_MS);
    },
    panel(label) {
      return dom.panel(label);
    },
    fromValue() {
      const node = dom.panel('From');
      return node ? node.value : '';
    },
    status() {
      const node = dom.panel('Section status');
      return node ? node.textContent : '';
    },
    async start() {
      await controller.start();
      await settle();
    },
  };
}

/** A saved section for the current song, restored and armed. */
async function armed(options) {
  const settings = options || {};
  const harness = createHarness({
    storage: createStorage(settings.sections || [SECTION]),
    media: settings.media,
    startWithoutMedia: settings.startWithoutMedia,
  });
  await harness.start();
  return harness;
}

/** One pass through the section, driven by the backstop tick. */
function tickPass(harness) {
  const media = harness.media();
  media.currentTime = SECTION.endSeconds;
  harness.timers.tickIntervals();
  return media.currentTime;
}

/** One pass through the section, driven by the element's own timeupdate. */
function timeupdatePass(harness, at) {
  const media = harness.media();
  media.currentTime = at === undefined ? SECTION.endSeconds : at;
  media.dispatchEvent('timeupdate');
  return media.currentTime;
}

// ---------------------------------------------------------------------------
// The latch
// ---------------------------------------------------------------------------

test('latch: a saved section returns to its start on the first, second and third pass', async () => {
  const harness = await armed();
  const media = harness.media();
  assert.equal(media.currentTime, SECTION.startSeconds, 'restored and armed at the section start');

  // The first pass is the restore-era backstop.
  assert.equal(tickPass(harness), SECTION.startSeconds);

  // Every later pass is the page's own clock: an armed section cannot depend
  // on one interval surviving the whole song.
  assert.equal(timeupdatePass(harness), SECTION.startSeconds);
  assert.equal(timeupdatePass(harness), SECTION.startSeconds);
  assert.equal(tickPass(harness), SECTION.startSeconds, 'the backstop still loops too');
});

test('latch: a pause and a seeking/seeked cycle between passes do not disarm the loop', async () => {
  const harness = await armed();
  const media = harness.media();
  assert.equal(tickPass(harness), SECTION.startSeconds);

  media.paused = true;
  media.dispatchEvent('pause');
  media.paused = false;
  media.dispatchEvent('playing');

  media.seeking = true;
  media.dispatchEvent('seeking');
  media.seeking = false;
  media.dispatchEvent('seeked');

  assert.equal(timeupdatePass(harness), SECTION.startSeconds, 'second pass after a pause and a seek cycle');
  assert.equal(timeupdatePass(harness), SECTION.startSeconds, 'third pass');
});

test('latch: a manual seek past the section end snaps back to the section start', async () => {
  const harness = await armed();
  const media = harness.media();
  media.currentTime = SECTION.endSeconds + 15;
  media.dispatchEvent('seeked');
  assert.equal(media.currentTime, SECTION.startSeconds);
});

test('latch: a transient loss of song identity keeps the points, the backstop and the loop', async () => {
  const harness = await armed();
  const media = harness.media();
  assert.equal(tickPass(harness), SECTION.startSeconds);

  // The page can push a null id for a moment while the player re-inits.
  harness.pushSong(null);
  assert.equal(harness.fromValue(), '0:30', 'the points survive the blip');
  assert.equal(harness.backstop(), true, 'the backstop is not torn down by one transient signal');

  // Still no seek while identity is unknown, from either driver.
  media.currentTime = SECTION.endSeconds;
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds);
  assert.equal(timeupdatePass(harness), SECTION.endSeconds);

  // The same song comes back: the loop resumes on the next media event.
  harness.pushSong('song-a');
  assert.equal(timeupdatePass(harness), SECTION.startSeconds);
});

test('latch: a replaced media element re-binds the saved section on the same song', async () => {
  const harness = await armed();
  assert.equal(tickPass(harness), SECTION.startSeconds);

  const replacement = harness.dom.makeMedia('song-a');
  harness.setMedia(replacement);
  harness.controller.sync();

  assert.equal(harness.fromValue(), '0:30', 'the saved section is adopted again');
  assert.equal(replacement.currentTime, SECTION.startSeconds);
  assert.equal(harness.backstop(), true);
  replacement.currentTime = SECTION.endSeconds;
  replacement.dispatchEvent('timeupdate');
  assert.equal(replacement.currentTime, SECTION.startSeconds);
});

// ---------------------------------------------------------------------------
// Guards: the latch never overrides the existing invariants
// ---------------------------------------------------------------------------

test('guard: Repeat off ends the loop', async () => {
  const harness = await armed();
  harness.panel('Repeat').checked = false;
  harness.panel('Repeat').dispatchEvent('change');

  assert.equal(harness.backstop(), false);
  assert.equal(timeupdatePass(harness), SECTION.endSeconds);
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, SECTION.endSeconds);
});

test('guard: clearing the section ends the loop', async () => {
  const harness = await armed();
  harness.panel('Clear section').dispatchEvent('click');
  await settle();

  assert.equal(harness.fromValue(), '');
  assert.equal(harness.backstop(), false);
  assert.equal(timeupdatePass(harness), SECTION.endSeconds);
});

test('guard: a paused player and a seek inside the section are not loop points', async () => {
  const harness = await armed();
  const media = harness.media();

  media.paused = true;
  assert.equal(timeupdatePass(harness), SECTION.endSeconds, 'a paused player never seeks');
  media.paused = false;

  assert.equal(timeupdatePass(harness, SECTION.endSeconds - 5), SECTION.endSeconds - 5);
  media.currentTime = SECTION.startSeconds + 5;
  media.dispatchEvent('seeked');
  assert.equal(media.currentTime, SECTION.startSeconds + 5);
});

test('guard: no identity, no seek, even on a timeupdate', async () => {
  const harness = await armed();
  harness.pushSong(null);
  assert.equal(timeupdatePass(harness), SECTION.endSeconds);
  assert.equal(harness.media().currentTime, SECTION.endSeconds);
});
