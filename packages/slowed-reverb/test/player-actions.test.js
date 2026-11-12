'use strict';

/* global require, __dirname, setImmediate */

/*
 * test/player-actions.test.js - easy volume + section repeat, Node only.
 *
 * Ported from pear-slowed-reverb (precise-volume renderer + section-repeat
 * engine/saved at a418ecb8). Plain Node: no browser, no DOM library, no audio.
 * The wheel predicate and the controller take injected window/document/timers,
 * so the fake below is the whole browser surface they touch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const actions = require(path.join(ROOT, 'player-actions.js'));

const HOST_ATTR = 'data-slra-player-actions';

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

function createDom() {
  class ClassList {
    constructor() {
      this.names = new Set();
    }

    add(...names) {
      for (const name of names) this.names.add(name);
    }

    remove(...names) {
      for (const name of names) this.names.delete(name);
    }

    contains(name) {
      return this.names.has(name);
    }

    toggle(name, force) {
      const next = typeof force === 'boolean' ? force : !this.names.has(name);
      if (next) this.names.add(name);
      else this.names.delete(name);
      return next;
    }
  }

  class Element {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.style = {};
      this.dataset = {};
      this.classList = new ClassList();
      this.listeners = new Map();
      this.textContent = '';
      this.value = '';
      this.checked = false;
      this.hidden = false;
      this.type = '';
      this.isContentEditable = false;
      this.shadowRoot = null;
      this.isConnected = true;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      this.computedOverflow = 'visible';
      this.computedVisibility = 'visible';
      this.computedDisplay = 'block';
      this.currentTime = 0;
      this.duration = NaN;
      this.paused = false;
      this.seeking = false;
      this.muted = false;
      this.volume = 1;
      this.currentSrc = '';
      this.playCalls = 0;
    }

    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }

    get className() {
      return [...this.classList.names].join(' ');
    }

    set className(value) {
      this.classList.names = new Set(
        String(value)
          .split(/\s+/)
          .filter(Boolean),
      );
    }

    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    }

    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }

    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    }

    dispatchEvent(type, props) {
      const event = {
        type,
        target: this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...(props || {}),
      };
      for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
      return event;
    }

    listenerCount(type) {
      return (this.listeners.get(type) || []).length;
    }

    attachShadow() {
      this.shadowRoot = new Element('#shadow-root');
      return this.shadowRoot;
    }

    play() {
      this.playCalls += 1;
      return Promise.resolve();
    }

    contains(node) {
      if (node === this) return true;
      for (const child of this.children) {
        if (child.contains(node)) return true;
      }
      return false;
    }
  }

  const documentElement = new Element('html');
  documentElement.scrollHeight = 800;
  documentElement.clientHeight = 800;
  const body = new Element('body');
  documentElement.appendChild(body);
  // The two real player surfaces, always present on music.youtube.com.
  const bar = new Element('ytmusic-player-bar');
  documentElement.appendChild(bar);
  const mainPanel = new Element('div');
  mainPanel.setAttribute('id', 'main-panel');
  documentElement.appendChild(mainPanel);

  const docListeners = new Map();
  const winListeners = new Map();

  const document = {
    documentElement,
    body,
    defaultView: null,
    visibilityState: 'visible',
    createElement: (tagName) => new Element(tagName),
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
        type,
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
    listenerCount(type) {
      return (docListeners.get(type) || []).length;
    },
  };

  const win = {
    document,
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
        type,
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
    listenerCount(type) {
      return (winListeners.get(type) || []).length;
    },
  };

  document.defaultView = win;

  function makeMedia(videoId, overrides) {
    const media = new Element('video');
    media.currentSrc = 'https://music.youtube.com/stream/' + videoId;
    media.duration = 300;
    media.currentTime = 0;
    media.paused = false;
    media.seeking = false;
    media.muted = true;
    media.volume = 0.5;
    media.play = function play() {
      media.playCalls += 1;
      return Promise.resolve();
    };
    Object.assign(media, overrides || {});
    return media;
  }

  function nodes(root) {
    const out = [];
    const walk = (node) => {
      out.push(node);
      for (const child of node.children) walk(child);
      if (node.shadowRoot) walk(node.shadowRoot);
    };
    walk(root);
    return out;
  }

  function host() {
    return documentElement.children.find((child) => child.hasAttribute(HOST_ATTR)) || null;
  }

  function panel(label) {
    const current = host();
    if (!current || !current.shadowRoot) return null;
    return nodes(current.shadowRoot).find((node) => node.getAttribute('aria-label') === label) || null;
  }

  function hasHud() {
    const current = host();
    if (!current || !current.shadowRoot) return false;
    return nodes(current.shadowRoot).some((node) => node.classList.contains('slra-hud'));
  }

  return {
    win,
    document,
    documentElement,
    bar,
    mainPanel,
    makeMedia,
    host,
    panel,
    hasHud,
  };
}

// ---------------------------------------------------------------------------
// Fake timers, storage, page hook
// ---------------------------------------------------------------------------

function createTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    timeoutCount() {
      return timeouts.size;
    },
    intervalCount() {
      return intervals.size;
    },
    intervalDelays() {
      return [...intervals.values()].map((timer) => timer.ms);
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

function createStorage(initial, options) {
  const data = { playerActions: { sections: [] }, ...(initial || {}) };
  const writes = [];
  let gate = null;

  const subscribers = new Set();
  function emit() {
    const value = data.playerActions;
    const sections = value && Array.isArray(value.sections) ? value.sections : [];
    for (const callback of [...subscribers]) callback(sections);
  }

  return {
    data,
    writes,
    saveSection: options && options.saveSection ? options.saveSection : undefined,
    async get(key) {
      if (gate) await gate;
      return { [key]: data[key] };
    },
    async set(items) {
      writes.push(items);
      Object.assign(data, items);
      emit();
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    hold() {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    sections() {
      const value = data.playerActions;
      return value && Array.isArray(value.sections) ? value.sections : [];
    },
    setSections(sections) {
      data.playerActions = { sections };
      emit();
    },
  };
}

function createPageHook(volume, options) {
  const state = { volume, source: (options && options.source) || 'player' };
  const calls = [];

  return {
    calls,
    uiSyncs: [],
    volume() {
      return state.volume;
    },
    syncVolumeUi(percent) {
      this.uiSyncs.push(percent);
    },
    async setVolume(percent) {
      calls.push({ percent });
      if (state.source === 'none') {
        return { volume: null, applied: false, source: 'none' };
      }
      state.volume = percent;
      return { volume: percent, applied: true, source: state.source };
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
  const pageHook = settings.pageHook || createPageHook(50);
  let media = settings.media || dom.makeMedia('song-a', settings.mediaOptions);

  const controller = actions.createPlayerActions({
    window: dom.win,
    document: dom.document,
    mediaProvider: () => media,
    pageHook,
    storage,
    timers,
  });

  return {
    controller,
    dom,
    timers,
    storage,
    pageHook,
    media: () => media,
    setMedia(next) {
      media = next;
    },
    setHref(href) {
      dom.win.location.href = href;
    },
    hostCount() {
      return dom.documentElement.children.filter((child) => child.hasAttribute(HOST_ATTR)).length;
    },
    wheelListeners() {
      return dom.win.listenerCount('wheel');
    },
    wheel(deltaY, props) {
      return dom.win.dispatch('wheel', { deltaY, target: dom.bar, ...(props || {}) });
    },
    pushSong(id) {
      controller.setSongId(id);
    },
    host() {
      return dom.host();
    },
    panel(label) {
      return dom.panel(label);
    },
    status() {
      const node = dom.panel('Section status');
      return node ? node.textContent : '';
    },
    fromValue() {
      const node = dom.panel('From');
      return node ? node.value : '';
    },
    typeInto(label, value) {
      const node = dom.panel(label);
      assert.ok(node, `field ${label} exists`);
      node.value = value;
      node.dispatchEvent('input');
      return node;
    },
    commit(label, value) {
      const node = this.typeInto(label, value);
      node.dispatchEvent('change');
      return node;
    },
    click(label) {
      const node = dom.panel(label);
      assert.ok(node, `control ${label} exists`);
      node.dispatchEvent('click');
      return node;
    },
    async start() {
      await controller.start();
      await settle();
    },
  };
}

// ---------------------------------------------------------------------------
// parseTimeInput (pear table, verbatim)
// ---------------------------------------------------------------------------

const EMPTY = { kind: 'empty' };
const INVALID = { kind: 'invalid' };
const time = (seconds) => ({ kind: 'time', seconds });

const parseCases = [
  { input: '', expected: EMPTY },
  { input: '0:30', expected: time(30) },
  { input: '5:00', expected: time(300) },
  { input: '1:02:03', expected: time(3723) },
  { input: ' 5:00 ', expected: time(300) },
  { input: '5', expected: time(5) },
  { input: '5:60', expected: INVALID },
  { input: '1:60:00', expected: INVALID },
  { input: 'abc', expected: INVALID },
  { input: '-5', expected: INVALID },
  { input: '1:2:3:4', expected: INVALID },
];

for (const { input, expected } of parseCases) {
  test(`parseTimeInput ${JSON.stringify(input)}`, () => {
    assert.deepEqual(actions.parseTimeInput(input), expected);
  });
}

const formatCases = [
  { input: 300, expected: '5:00' },
  { input: 59, expected: '0:59' },
  { input: 0, expected: '0:00' },
  { input: 3723, expected: '1:02:03' },
  { input: 3599, expected: '59:59' },
  { input: NaN, expected: '0:00' },
  { input: -1, expected: '0:00' },
];

for (const { input, expected } of formatCases) {
  test(`formatTime ${input}`, () => {
    assert.equal(actions.formatTime(input), expected);
  });
}

// ---------------------------------------------------------------------------
// resolveSeekTarget / resolveEndSeekTarget / isLoopEngaged (pear tables)
// ---------------------------------------------------------------------------

const loop = (overrides) => ({
  active: true,
  startSeconds: null,
  endSeconds: null,
  ...(overrides || {}),
});

const sample = (overrides) => ({
  currentTime: 0,
  duration: 0,
  paused: false,
  seeking: false,
  ...(overrides || {}),
});

const resolveCases = [
  { name: 'inactive', state: loop({ active: false, startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 340, duration: 400 }), expected: null },
  { name: 'start null', state: loop({ endSeconds: 340 }), player: sample({ currentTime: 340, duration: 400 }), expected: 0 },
  { name: 'to-only loop arms at the song start', state: loop({ endSeconds: 340 }), player: sample({ currentTime: 0, duration: 400 }), expected: null },
  { name: 'to-only loop triggers at the end threshold', state: loop({ endSeconds: 340 }), player: sample({ currentTime: 339.95, duration: 400 }), expected: 0 },
  { name: 'to-only loop just below the end threshold stays put', state: loop({ endSeconds: 340 }), player: sample({ currentTime: 339.9499999999999, duration: 400 }), expected: null },
  { name: 'to-only loop past the song end clamps to the song end', state: loop({ endSeconds: 340 }), player: sample({ currentTime: 299.75, duration: 300 }), expected: 0 },
  { name: 'to-only loop past the song end clamps: below threshold', state: loop({ endSeconds: 340 }), player: sample({ currentTime: 299.6, duration: 300 }), expected: null },
  { name: 'clear stays disarmed', state: loop(), player: sample({ currentTime: 100, duration: 400 }), expected: null },
  { name: 'to-only loop collapsed into the song tail stays disarmed', state: loop({ endSeconds: 0.2 }), player: sample({ currentTime: 0.15, duration: 0.2 }), expected: null },
  { name: 'paused', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 340, duration: 400, paused: true }), expected: null },
  { name: 'seeking', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 340, duration: 400, seeking: true }), expected: null },
  { name: 'currentTime NaN', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: NaN, duration: 400 }), expected: null },
  { name: 'start NaN', state: loop({ startSeconds: NaN, endSeconds: 340 }), player: sample({ currentTime: 340, duration: 400 }), expected: null },
  { name: 'end equals start', state: loop({ startSeconds: 300, endSeconds: 300 }), player: sample({ currentTime: 340, duration: 400 }), expected: null },
  { name: 'end below start', state: loop({ startSeconds: 300, endSeconds: 200 }), player: sample({ currentTime: 340, duration: 400 }), expected: null },
  { name: 'no end and unknown duration', state: loop({ startSeconds: 300 }), player: sample({ currentTime: 340, duration: NaN }), expected: null },
  { name: 'explicit end with currentTime at end', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 340, duration: 400 }), expected: 300 },
  { name: 'explicit end with currentTime exactly at threshold', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 339.95, duration: 400 }), expected: 300 },
  { name: 'duration end with currentTime exactly at threshold', state: loop({ startSeconds: 300 }), player: sample({ currentTime: 359.7, duration: 360 }), expected: 300 },
  { name: 'explicit end with NaN duration and currentTime past end', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 400, duration: NaN }), expected: 300 },
  { name: 'explicit end with NaN duration and currentTime at end', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 340, duration: NaN }), expected: 300 },
  { name: 'explicit end with Infinity duration and currentTime at end', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 340, duration: Infinity }), expected: 300 },
  { name: 'explicit end with currentTime just below threshold', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 339.9499999999999, duration: 400 }), expected: null },
  { name: 'duration end with currentTime just below threshold', state: loop({ startSeconds: 300 }), player: sample({ currentTime: 359.69, duration: 360 }), expected: null },
  { name: 'explicit end past the song end disarms a range collapsed into the tail', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 299.75, duration: 300 }), expected: null },
  { name: 'explicit end past the song end disarms: below threshold', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 299.6, duration: 300 }), expected: null },
  { name: 'explicit end past the song end disarms: currentTime past the end', state: loop({ startSeconds: 300, endSeconds: 340 }), player: sample({ currentTime: 340, duration: 300 }), expected: null },
  { name: 'start inside the last 0.3s of the song stays inactive', state: loop({ startSeconds: 299.8, endSeconds: 340 }), player: sample({ currentTime: 299.9, duration: 300 }), expected: null },
  { name: 'explicit end equal to the song end clamps to the song end', state: loop({ startSeconds: 200, endSeconds: 300 }), player: sample({ currentTime: 299.75, duration: 300 }), expected: 200 },
  { name: 'explicit end equal to the song end clamps: below threshold', state: loop({ startSeconds: 200, endSeconds: 300 }), player: sample({ currentTime: 299.6, duration: 300 }), expected: null },
  { name: 'explicit end past the song end still loops from mid-song', state: loop({ startSeconds: 180, endSeconds: 340 }), player: sample({ currentTime: 299.75, duration: 300 }), expected: 180 },
  { name: 'explicit end past the song end from mid-song: below threshold', state: loop({ startSeconds: 180, endSeconds: 340 }), player: sample({ currentTime: 299.6, duration: 300 }), expected: null },
  { name: 'zero-length loop at the song end stays inactive', state: loop({ startSeconds: 300, endSeconds: 300 }), player: sample({ currentTime: 299.75, duration: 300 }), expected: null },
  { name: 'zero-length loop at the song end stays inactive below threshold', state: loop({ startSeconds: 300, endSeconds: 300 }), player: sample({ currentTime: 299.6, duration: 300 }), expected: null },
];

for (const { name, state, player, expected } of resolveCases) {
  test(`resolveSeekTarget: ${name}`, () => {
    assert.equal(actions.resolveSeekTarget(state, player), expected);
  });
}

const endSeekCases = [
  { name: 'inactive', state: loop({ active: false, startSeconds: 300, endSeconds: 340 }), duration: 300, expected: null },
  { name: 'start null', state: loop({ endSeconds: 340 }), duration: 300, expected: 0 },
  { name: 'to-only loop resolves to the song start', state: loop({ endSeconds: 340 }), duration: 400, expected: 0 },
  { name: 'clear resolves to nothing', state: loop(), duration: 400, expected: null },
  { name: 'to-only loop collapsed into the song tail stays disarmed', state: loop({ endSeconds: 0.2 }), duration: 0.2, expected: null },
  { name: 'to-end loop whose start sits at the song end stays disarmed', state: loop({ startSeconds: 300 }), duration: 300, expected: null },
  { name: 'start inside the last 0.3s of the song stays disarmed', state: loop({ startSeconds: 299.8, endSeconds: 340 }), duration: 300, expected: null },
  { name: 'start at the song end stays disarmed', state: loop({ startSeconds: 300, endSeconds: 340 }), duration: 300, expected: null },
  { name: 'no end and unknown duration', state: loop({ startSeconds: 300 }), duration: NaN, expected: null },
  { name: 'to-end loop', state: loop({ startSeconds: 200 }), duration: 300, expected: 200 },
  { name: 'explicit end past the song end still loops from mid-song', state: loop({ startSeconds: 200, endSeconds: 340 }), duration: 300, expected: 200 },
  { name: 'explicit end inside the song', state: loop({ startSeconds: 300, endSeconds: 340 }), duration: 999, expected: 300 },
];

for (const { name, state, duration, expected } of endSeekCases) {
  test(`resolveEndSeekTarget: ${name}`, () => {
    assert.equal(actions.resolveEndSeekTarget(state, duration), expected);
  });
}

const engagedCases = [
  { name: 'active with no points is disarmed', state: loop(), expected: false },
  { name: 'inactive with an explicit range is disarmed', state: loop({ active: false, startSeconds: 300, endSeconds: 340 }), expected: false },
  { name: 'inactive with a blank From and an end is disarmed', state: loop({ active: false, endSeconds: 340 }), expected: false },
  { name: 'blank From with an end is engaged', state: loop({ endSeconds: 340 }), expected: true },
  { name: 'explicit From with a blank end is engaged', state: loop({ startSeconds: 300 }), expected: true },
  { name: 'explicit range is engaged', state: loop({ startSeconds: 300, endSeconds: 340 }), expected: true },
  { name: 'a non-finite From is still engaged (the resolve guard disarms it)', state: loop({ startSeconds: NaN, endSeconds: 340 }), expected: true },
];

for (const { name, state, expected } of engagedCases) {
  test(`isLoopEngaged: ${name}`, () => {
    assert.equal(actions.isLoopEngaged(state), expected);
  });
}

// ---------------------------------------------------------------------------
// guard: blank From = 0:00, including a To-only section
// ---------------------------------------------------------------------------

test('guard: blank From resolves a To-only section to the song start', () => {
  const state = { active: true, startSeconds: null, endSeconds: 90 };
  assert.equal(actions.resolveEndSeekTarget(state, 300), 0);
  assert.equal(actions.resolveSeekTarget(state, { currentTime: 89.96, duration: 300, paused: false, seeking: false }), 0);
});

// ---------------------------------------------------------------------------
// guard: explicit end loops without a finite duration (livestream/late metadata)
// ---------------------------------------------------------------------------

test('guard: an explicit end loops when duration is NaN or Infinity', () => {
  const state = { active: true, startSeconds: 30, endSeconds: 60 };
  for (const duration of [NaN, Infinity]) {
    assert.equal(actions.resolveEndSeekTarget(state, duration), 30);
    assert.equal(
      actions.resolveSeekTarget(state, { currentTime: 60, duration, paused: false, seeking: false }),
      30,
    );
  }
});

// ---------------------------------------------------------------------------
// guard: end clamped to the song end (no past-EOF seek)
// ---------------------------------------------------------------------------

test('guard: a typed end past the song end clamps to the song end', () => {
  const state = { active: true, startSeconds: 10, endSeconds: 9999 };
  assert.equal(actions.resolveEndSeekTarget(state, 300), 10);
  assert.equal(
    actions.resolveSeekTarget(state, { currentTime: 299.75, duration: 300, paused: false, seeking: false }),
    10,
  );
  assert.equal(
    actions.resolveSeekTarget(state, { currentTime: 299.5, duration: 300, paused: false, seeking: false }),
    null,
  );
});

// ---------------------------------------------------------------------------
// guard: a range collapsed to <= 50 ms never re-seeks every tick
// ---------------------------------------------------------------------------

test('guard: a threshold at or below start + 50 ms disarms the loop', () => {
  const collapsed = { active: true, startSeconds: 30, endSeconds: 30 };
  assert.equal(actions.resolveSeekTarget(collapsed, { currentTime: 31, duration: 300, paused: false, seeking: false }), null);
  assert.equal(actions.resolveEndSeekTarget(collapsed, 300), null);
  const justOver = { active: true, startSeconds: 30, endSeconds: 30.1 };
  assert.equal(actions.resolveEndSeekTarget(justOver, 300), null);
  const past = { active: true, startSeconds: 30, endSeconds: 30.2 };
  assert.equal(actions.resolveEndSeekTarget(past, 300), 30);
});

// ---------------------------------------------------------------------------
// sanitizeSaved / lookupSaved / upsertSaved (pear table) + 100-entry cap
// ---------------------------------------------------------------------------

const entry = (overrides) => ({
  videoId: 'video-a',
  startSeconds: 10,
  endSeconds: 20,
  ...(overrides || {}),
});

const sanitizeCases = [
  { name: 'null', raw: null, expected: [] },
  { name: 'record', raw: { videoId: 'video-a' }, expected: [] },
  { name: 'string', raw: 'video-a', expected: [] },
  { name: 'number', raw: 7, expected: [] },
  { name: 'empty array', raw: [], expected: [] },
  { name: 'non-object entries', raw: [null, 7, 'video-a', []], expected: [] },
  { name: 'missing videoId', raw: [{ startSeconds: 1, endSeconds: 2 }], expected: [] },
  { name: 'empty videoId', raw: [entry({ videoId: '' })], expected: [] },
  { name: 'non-string videoId', raw: [{ videoId: 7, startSeconds: 1, endSeconds: 2 }], expected: [] },
  { name: 'missing times', raw: [{ videoId: 'video-a' }], expected: [] },
  { name: 'both times null', raw: [entry({ startSeconds: null, endSeconds: null })], expected: [] },
  { name: 'negative start', raw: [entry({ startSeconds: -1 })], expected: [] },
  { name: 'NaN end', raw: [entry({ endSeconds: NaN })], expected: [] },
  { name: 'infinite start', raw: [entry({ startSeconds: Infinity })], expected: [] },
  { name: 'string time', raw: [entry({ endSeconds: '20' })], expected: [] },
  {
    name: 'keeps valid entries and drops garbage',
    raw: [
      null,
      entry({ videoId: 'video-b', startSeconds: 0, endSeconds: null }),
      entry({ videoId: 'video-c', startSeconds: null, endSeconds: 5 }),
      entry({ videoId: 'video-d', startSeconds: NaN, endSeconds: 5 }),
      entry({ videoId: 'video-e', startSeconds: null, endSeconds: null }),
    ],
    expected: [
      { videoId: 'video-b', startSeconds: 0, endSeconds: null },
      { videoId: 'video-c', startSeconds: null, endSeconds: 5 },
    ],
  },
  {
    name: 'dedupes by videoId keeping the last occurrence',
    raw: [
      entry({ videoId: 'video-a', startSeconds: 1, endSeconds: 2 }),
      entry({ videoId: 'video-b', startSeconds: 3, endSeconds: 4 }),
      entry({ videoId: 'video-a', startSeconds: 5, endSeconds: 6 }),
    ],
    expected: [
      { videoId: 'video-b', startSeconds: 3, endSeconds: 4 },
      { videoId: 'video-a', startSeconds: 5, endSeconds: 6 },
    ],
  },
];

for (const { name, raw, expected } of sanitizeCases) {
  test(`sanitizeSaved: ${name}`, () => {
    assert.deepEqual(actions.sanitizeSaved(raw), expected);
  });
}

const lookupCases = [
  { name: 'empty list', saved: [], videoId: 'video-a', expected: null },
  { name: 'miss', saved: [entry({ videoId: 'video-b' })], videoId: 'video-a', expected: null },
  { name: 'hit', saved: [entry({ videoId: 'video-b' }), entry({ endSeconds: null })], videoId: 'video-a', expected: { videoId: 'video-a', startSeconds: 10, endSeconds: null } },
  {
    name: 'keeps the last occurrence on a raw duplicate',
    saved: [entry({ startSeconds: 1, endSeconds: 2 }), entry({ startSeconds: 5, endSeconds: 6 })],
    videoId: 'video-a',
    expected: { videoId: 'video-a', startSeconds: 5, endSeconds: 6 },
  },
];

for (const { name, saved, videoId, expected } of lookupCases) {
  test(`lookupSaved: ${name}`, () => {
    assert.deepEqual(actions.lookupSaved(saved, videoId), expected);
  });
}

const upsertCases = [
  { name: 'appends a new song', saved: [], next: entry(), expected: [entry()] },
  { name: 'appends after existing songs', saved: [entry({ videoId: 'video-b' })], next: entry({ startSeconds: 1, endSeconds: null }), expected: [entry({ videoId: 'video-b' }), entry({ startSeconds: 1, endSeconds: null })] },
  { name: 'replaces an existing song', saved: [entry({ startSeconds: 1, endSeconds: 2 }), entry({ videoId: 'video-b' })], next: entry({ startSeconds: 7, endSeconds: 8 }), expected: [entry({ videoId: 'video-b' }), entry({ startSeconds: 7, endSeconds: 8 })] },
  { name: 'removes the entry when both times are null', saved: [entry(), entry({ videoId: 'video-b' })], next: entry({ startSeconds: null, endSeconds: null }), expected: [entry({ videoId: 'video-b' })] },
  { name: 'removing an absent song changes nothing', saved: [entry({ videoId: 'video-b' })], next: entry({ startSeconds: null, endSeconds: null }), expected: [entry({ videoId: 'video-b' })] },
  { name: 'removes every duplicate of the song', saved: [entry({ startSeconds: 1, endSeconds: 2 }), entry({ startSeconds: 3, endSeconds: 4 })], next: entry({ startSeconds: null, endSeconds: null }), expected: [] },
];

for (const { name, saved, next, expected } of upsertCases) {
  test(`upsertSaved: ${name}`, () => {
    assert.deepEqual(actions.upsertSaved(saved, next), expected);
  });
}

test('capSaved: keeps the newest entries and drops the oldest', () => {
  const saved = [];
  for (let index = 0; index < 105; index += 1) {
    saved.push({ videoId: 'song-' + index, startSeconds: index, endSeconds: null });
  }
  const capped = actions.capSaved(saved, 100);
  assert.equal(capped.length, 100);
  assert.equal(capped[0].videoId, 'song-5');
  assert.equal(capped[99].videoId, 'song-104');
  assert.equal(actions.capSaved(saved.slice(0, 3), 100).length, 3);
});

// ---------------------------------------------------------------------------
// section session helpers: song key, one-restore latch, retry budget, clear
// ---------------------------------------------------------------------------

test('songKeyFrom prefers the URL v param over the media source', () => {
  assert.equal(actions.songKeyFrom('https://music.youtube.com/watch?v=abc&list=x', 'blob:src'), 'abc');
});

test('songKeyFrom uses the URL v param only: no media source, no URL key', () => {
  assert.equal(actions.songKeyFrom('https://music.youtube.com/watch?v=abc&list=x'), 'abc');
  assert.equal(actions.songKeyFrom('https://music.youtube.com/'), null);
  assert.equal(actions.songKeyFrom('https://music.youtube.com/watch?list=x'), null);
  assert.equal(actions.songKeyFrom('not a url'), null);
  assert.equal(actions.songKeyFrom(''), null);
  // A source argument is ignored entirely: it can never become an id.
  assert.equal(
    actions.songKeyFrom('https://music.youtube.com/', 'https://rr1.googlevideo.com/videoplayback?sig=x'),
    null,
  );
  assert.equal(actions.sourceKey, undefined);
});

test('guard: a null song key defers instead of restoring the previous song', () => {
  const session = actions.createSectionSession();
  assert.equal(actions.beginSong(session, null), false);
  assert.equal(session.songKey, null);
  assert.equal(actions.songRestorePending(session, null), false);
});

test('guard: clearing on a song change keeps Repeat but drops the points', () => {
  const session = actions.createSectionSession();
  assert.equal(actions.beginSong(session, 'song-a'), true);
  session.startSeconds = 12;
  session.endSeconds = 30;
  assert.equal(actions.beginSong(session, 'song-a'), false);
  assert.equal(session.startSeconds, 12);
  assert.equal(actions.beginSong(session, 'song-b'), true);
  assert.equal(session.startSeconds, null);
  assert.equal(session.endSeconds, null);
});

test('guard: one restore per song visit', () => {
  const session = actions.createSectionSession();
  actions.beginSong(session, 'song-a');
  assert.equal(actions.songRestorePending(session, 'song-a'), true);
  actions.markSongRestored(session, 'song-a');
  assert.equal(actions.songRestorePending(session, 'song-a'), false);
  actions.beginSong(session, 'song-b');
  assert.equal(actions.songRestorePending(session, 'song-a'), true);
});

// ---------------------------------------------------------------------------
// Wheel: pixel conversion, accumulation, clamp reset
// ---------------------------------------------------------------------------

test('wheelPixels converts deltaMode lines and pages to pixels', () => {
  assert.equal(actions.wheelPixels({ deltaY: -100, deltaMode: 0 }), -100);
  assert.equal(actions.wheelPixels({ deltaY: -3, deltaMode: 1 }), -48);
  assert.equal(actions.wheelPixels({ deltaY: -1, deltaMode: 2 }), -100);
  assert.equal(actions.wheelPixels({ deltaY: NaN, deltaMode: 0 }), 0);
});

test('wheel: one mouse notch is one 5 % step', () => {
  const accumulator = { remainder: 0 };
  const result = actions.stepVolumeFromWheel(accumulator, { deltaY: -100, deltaMode: 0 }, 50);
  assert.deepEqual(result, { steps: 1, volume: 55, applied: true });
  assert.equal(accumulator.remainder, 0);
});

test('wheel: small trackpad deltas accumulate before a step lands', () => {
  const accumulator = { remainder: 0 };
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: -30, deltaMode: 0 }, 50), { steps: 0, volume: null, applied: false });
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: -30, deltaMode: 0 }, 50), { steps: 0, volume: null, applied: false });
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: -40, deltaMode: 0 }, 50), { steps: 1, volume: 55, applied: true });
});

test('wheel: several notches in one event apply several steps', () => {
  const accumulator = { remainder: 0 };
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: -300, deltaMode: 0 }, 50), { steps: 3, volume: 65, applied: true });
});

test('wheel: a clamped wheel resets the accumulator instead of banking steps', () => {
  const accumulator = { remainder: 0 };
  const up = actions.stepVolumeFromWheel(accumulator, { deltaY: -500, deltaMode: 0 }, 98);
  assert.deepEqual(up, { steps: 5, volume: 100, applied: true });
  assert.equal(accumulator.remainder, 0);
  const again = actions.stepVolumeFromWheel(accumulator, { deltaY: -500, deltaMode: 0 }, 100);
  assert.deepEqual(again, { steps: 5, volume: 100, applied: false });
  assert.equal(accumulator.remainder, 0);
  const back = actions.stepVolumeFromWheel(accumulator, { deltaY: 100, deltaMode: 0 }, 100);
  assert.deepEqual(back, { steps: -1, volume: 95, applied: true });
});

test('wheel: the floor clamps at 0 and resets the accumulator', () => {
  const accumulator = { remainder: 0 };
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: 500, deltaMode: 0 }, 3), { steps: -5, volume: 0, applied: true });
  assert.equal(accumulator.remainder, 0);
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: 100, deltaMode: 0 }, 0), { steps: -1, volume: 0, applied: false });
});

test('wheel: a step snaps up to the 5 % grid the slider uses', () => {
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: -100, deltaMode: 0 }, 37), {
    steps: 1,
    volume: 40,
    applied: true,
  });
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: -100, deltaMode: 0 }, 40), {
    steps: 1,
    volume: 45,
    applied: true,
  });
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: -100, deltaMode: 0 }, 97), {
    steps: 1,
    volume: 100,
    applied: true,
  });
});

test('wheel: a step snaps down to the 5 % grid the slider uses', () => {
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: 100, deltaMode: 0 }, 37), {
    steps: -1,
    volume: 35,
    applied: true,
  });
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: 100, deltaMode: 0 }, 40), {
    steps: -1,
    volume: 35,
    applied: true,
  });
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: 100, deltaMode: 0 }, 2), {
    steps: -1,
    volume: 0,
    applied: true,
  });
});

test('wheel: a snapped step clamps at the rails and resets the accumulator', () => {
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: -100, deltaMode: 0 }, 100), {
    steps: 1,
    volume: 100,
    applied: false,
  });
  assert.deepEqual(actions.stepVolumeFromWheel({ remainder: 0 }, { deltaY: 100, deltaMode: 0 }, 0), {
    steps: -1,
    volume: 0,
    applied: false,
  });
  const accumulator = { remainder: 0 };
  actions.stepVolumeFromWheel(accumulator, { deltaY: -500, deltaMode: 0 }, 97);
  assert.equal(accumulator.remainder, 0);
});

test('wheel: trackpad accumulation snaps when the grid is crossed', () => {
  const accumulator = { remainder: 0 };
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: -30, deltaMode: 0 }, 37), {
    steps: 0,
    volume: null,
    applied: false,
  });
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: -30, deltaMode: 0 }, 37), {
    steps: 0,
    volume: null,
    applied: false,
  });
  assert.deepEqual(actions.stepVolumeFromWheel(accumulator, { deltaY: -40, deltaMode: 0 }, 37), {
    steps: 1,
    volume: 40,
    applied: true,
  });
});

// ---------------------------------------------------------------------------
// Wheel predicate ladder
// ---------------------------------------------------------------------------

function fakeNode(tagName, options) {
  const settings = options || {};
  const attributes = new Map(Object.entries(settings.attributes || {}));
  return {
    tagName: String(tagName).toUpperCase(),
    parentElement: settings.parent || null,
    isContentEditable: Boolean(settings.editable),
    computedOverflow: settings.overflow || 'visible',
    computedVisibility: settings.visibility || 'visible',
    computedDisplay: settings.display || 'block',
    scrollHeight: settings.scrollHeight === undefined ? 0 : settings.scrollHeight,
    clientHeight: settings.clientHeight === undefined ? 0 : settings.clientHeight,
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
  };
}

function predicateDoc() {
  return { documentElement: fakeNode('html') };
}

const getStyle = (node) => ({
  overflowY: node.computedOverflow || 'visible',
  visibility: node.computedVisibility || 'visible',
  display: node.computedDisplay || 'block',
});

/** Puts the node inside the persistent player bar. */
function inBar(node) {
  node.parentElement = fakeNode('ytmusic-player-bar');
  return node;
}

/** Puts the node inside the player panel; `hidden` models an inactive player. */
function inPanel(node, options) {
  const settings = options || {};
  node.parentElement = fakeNode('div', {
    attributes: { id: 'main-panel' },
    visibility: settings.visibility || 'visible',
    display: settings.display || 'block',
  });
  return node;
}

function wheelEvent(overrides) {
  return {
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    deltaY: -100,
    deltaMode: 0,
    ...(overrides || {}),
  };
}

test('wheel guard: defaultPrevented events belong to someone else', () => {
  const target = fakeNode('div');
  assert.equal(actions.shouldHandleWheel(wheelEvent({ defaultPrevented: true }), target, predicateDoc(), getStyle).handle, false);
});

test('wheel guard: the player bar handles the wheel (collapsed mode)', () => {
  const target = inBar(fakeNode('div'));
  assert.deepEqual(actions.shouldHandleWheel(wheelEvent(), target, predicateDoc(), getStyle), {
    handle: true,
    reason: 'handle',
  });
});

test('wheel guard: song-mode artwork in the visible player panel handles the wheel', () => {
  const artwork = inPanel(fakeNode('img'));
  assert.deepEqual(actions.shouldHandleWheel(wheelEvent(), artwork, predicateDoc(), getStyle), {
    handle: true,
    reason: 'handle',
  });
});

test('wheel guard: video-mode media in the visible player panel handles the wheel', () => {
  const video = inPanel(fakeNode('video'));
  assert.deepEqual(actions.shouldHandleWheel(wheelEvent(), video, predicateDoc(), getStyle), {
    handle: true,
    reason: 'handle',
  });
});

test('wheel guard: a hidden player panel does not handle (inactive player)', () => {
  const artwork = inPanel(fakeNode('img'), { visibility: 'hidden' });
  const verdict = actions.shouldHandleWheel(wheelEvent(), artwork, predicateDoc(), getStyle);
  assert.equal(verdict.handle, false);
  assert.equal(verdict.reason, 'not-player-surface');
});

test('wheel guard: browse content keeps native scrolling', () => {
  for (const tagName of ['div', 'ytmusic-carousel-shelf-renderer', 'img', 'span']) {
    const verdict = actions.shouldHandleWheel(wheelEvent(), fakeNode(tagName), predicateDoc(), getStyle);
    assert.equal(verdict.handle, false, tagName);
    assert.equal(verdict.reason, 'not-player-surface');
  }
});

test('wheel guard: the guide, queue, lyrics and nav bar keep native scrolling', () => {
  for (const tagName of ['ytmusic-guide-renderer', 'ytmusic-queue', 'ytmusic-lyrics', 'ytmusic-nav-bar']) {
    const verdict = actions.shouldHandleWheel(wheelEvent(), fakeNode(tagName), predicateDoc(), getStyle);
    assert.equal(verdict.handle, false, tagName);
  }
});

test('wheel guard: a scrollable descendant inside the bar keeps native scrolling', () => {
  const bar = fakeNode('ytmusic-player-bar');
  const scroller = fakeNode('div', { parent: bar, overflow: 'auto', scrollHeight: 400, clientHeight: 200 });
  const child = fakeNode('span', { parent: scroller });
  const verdict = actions.shouldHandleWheel(wheelEvent(), child, predicateDoc(), getStyle);
  assert.equal(verdict.handle, false);
  assert.equal(verdict.reason, 'scrollable-ancestor');
});

test('wheel guard: modifier wheels pass through (zoom/back/alt-scroll)', () => {
  const target = fakeNode('div');
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    const verdict = actions.shouldHandleWheel(wheelEvent({ [modifier]: true }), target, predicateDoc(), getStyle);
    assert.equal(verdict.handle, false);
    assert.equal(verdict.reason, 'modifier');
  }
});

test('wheel guard: a horizontal-only gesture passes through', () => {
  assert.equal(actions.shouldHandleWheel(wheelEvent({ deltaY: 0 }), fakeNode('div'), predicateDoc(), getStyle).handle, false);
});

test('wheel guard: the player-actions panel keeps its own wheel', () => {
  const host = fakeNode('div', { attributes: { [HOST_ATTR]: '' } });
  const inner = fakeNode('span', { parent: host });
  assert.equal(actions.shouldHandleWheel(wheelEvent(), inner, predicateDoc(), getStyle).handle, false);
});

test('wheel guard: text fields and selects keep native scrolling/typing', () => {
  for (const tagName of ['input', 'textarea', 'select']) {
    assert.equal(actions.shouldHandleWheel(wheelEvent(), fakeNode(tagName), predicateDoc(), getStyle).handle, false);
  }
  assert.equal(actions.shouldHandleWheel(wheelEvent(), fakeNode('div', { editable: true }), predicateDoc(), getStyle).handle, false);
  assert.equal(
    actions.shouldHandleWheel(wheelEvent(), fakeNode('div', { attributes: { contenteditable: 'true' } }), predicateDoc(), getStyle).handle,
    false,
  );
});

test('wheel guard: an open dialog or a modal keeps the wheel', () => {
  const dialog = fakeNode('dialog', { attributes: { open: '' } });
  assert.equal(actions.shouldHandleWheel(wheelEvent(), fakeNode('span', { parent: dialog }), predicateDoc(), getStyle).handle, false);
  const modal = fakeNode('div', { attributes: { 'aria-modal': 'true' } });
  assert.equal(actions.shouldHandleWheel(wheelEvent(), fakeNode('span', { parent: modal }), predicateDoc(), getStyle).handle, false);
});

// ---------------------------------------------------------------------------
// Controller: lifecycle, wheel path, panel, tick, restore
// ---------------------------------------------------------------------------

test('controller: start installs one wheel listener and one panel host; stop removes them', async () => {
  const harness = createHarness();
  await harness.start();
  assert.equal(harness.wheelListeners(), 1);
  assert.equal(harness.hostCount(), 1);
  assert.equal(harness.timers.intervalCount(), 0);

  harness.controller.stop();
  assert.equal(harness.wheelListeners(), 0);
  assert.equal(harness.hostCount(), 0);
  assert.equal(harness.timers.intervalCount(), 0);
});

test('controller: a stop during a pending storage read leaves nothing installed', async () => {
  const harness = createHarness();
  const release = harness.storage.hold();
  const started = harness.controller.start();
  await settle(2);
  harness.controller.stop();
  release();
  await started;
  await settle();
  assert.equal(harness.wheelListeners(), 0);
  assert.equal(harness.hostCount(), 0);
  assert.equal(harness.timers.intervalCount(), 0);
});

test('controller: a second start without stop owns exactly one registration set', async () => {
  const harness = createHarness();
  await harness.start();
  await harness.start();
  assert.equal(harness.wheelListeners(), 1);
  assert.equal(harness.hostCount(), 1);
});

test('controller: re-enabling after stop owns exactly one registration set', async () => {
  const harness = createHarness();
  await harness.start();
  harness.controller.stop();
  await harness.start();
  assert.equal(harness.wheelListeners(), 1);
  assert.equal(harness.hostCount(), 1);
  const event = harness.wheel(-100);
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.pageHook.volume(), 55);
});

test('controller: a wheel over the player bar writes the page volume', async () => {
  const harness = createHarness();
  await harness.start();
  const event = harness.wheel(-100);
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.deepEqual(harness.pageHook.calls.at(-1), { percent: 55 });
  assert.equal(harness.dom.hasHud(), false);
});

test('controller: preventDefault only fires when a volume step lands', async () => {
  const harness = createHarness();
  await harness.start();
  const modifier = harness.wheel(-100, { ctrlKey: true });
  assert.equal(modifier.defaultPrevented, false);
  const short = harness.wheel(-10);
  assert.equal(short.defaultPrevented, false);
  await settle();
  assert.equal(harness.pageHook.calls.length, 0);

  const railHarness = createHarness();
  await railHarness.start();
  railHarness.media().volume = 1;
  railHarness.controller.sync();
  const atRail = railHarness.wheel(-100);
  assert.equal(atRail.defaultPrevented, false);
  assert.equal(railHarness.pageHook.calls.length, 0);
});

test('controller: a page hook without a player API falls back to media.volume and syncs the UI', async () => {
  const pageHook = createPageHook(50, { source: 'none' });
  const harness = createHarness({ pageHook });
  await harness.start();
  harness.wheel(-100);
  await settle();
  assert.equal(harness.media().volume, 0.55);
  // The hook could not paint the slider itself, so it is asked to.
  assert.deepEqual(harness.pageHook.uiSyncs, [55]);
});

test('controller: guard - a stale volume reply cannot overwrite a newer write', async () => {
  const pendingReplies = [];
  const pageHook = {
    setVolume(percent) {
      return new Promise((resolve) => {
        pendingReplies.push({ percent, resolve });
      });
    },
  };
  const harness = createHarness({ pageHook });
  await harness.start();

  harness.wheel(-100);
  harness.wheel(-100);
  assert.equal(pendingReplies.length, 2);
  assert.equal(pendingReplies[1].percent, 60);

  pendingReplies[1].resolve({ volume: 60, applied: true, source: 'player' });
  await settle();
  pendingReplies[0].resolve({ volume: 55, applied: true, source: 'player' });
  await settle();

  // The next step starts from 60, not from the stale 55.
  harness.wheel(-100);
  assert.equal(pendingReplies[2].percent, 65);

  // A late failure from the oldest request must not rewrite media volume.
  pendingReplies[0].resolve({ volume: null, applied: false, source: 'none' });
  await settle();
  assert.equal(harness.media().volume, 0.5);
});

test('controller: the wheel writes the snapped value', async () => {
  const harness = createHarness({ pageHook: createPageHook(37), mediaOptions: { volume: 0.37 } });
  await harness.start();
  harness.wheel(-100);
  await settle();
  assert.deepEqual(harness.pageHook.calls.at(-1), { percent: 40 });
});

test('controller: the fallback path ends on the snapped value too', async () => {
  const harness = createHarness({
    pageHook: createPageHook(37, { source: 'none' }),
    mediaOptions: { volume: 0.37 },
  });
  await harness.start();
  harness.wheel(-100);
  await settle();
  assert.equal(harness.media().volume, 0.4);
});

test('controller: the 100 ms tick exists only while a loop is engaged', async () => {
  const harness = createHarness();
  await harness.start();
  assert.equal(harness.timers.intervalCount(), 0);

  harness.commit('From', '0:30');
  assert.equal(harness.timers.intervalCount(), 1);
  assert.deepEqual(harness.timers.intervalDelays(), [100]);

  harness.commit('To', '1:00');
  assert.equal(harness.timers.intervalCount(), 1);

  harness.click('Clear section');
  assert.equal(harness.timers.intervalCount(), 0);
});

test('controller: a to-end loop ticks and seeks at the song end', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '0:30');
  harness.media().currentTime = 299.75;
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, 30);
});

test('controller: committing From seeks immediately, To never seeks', async () => {
  const harness = createHarness();
  await harness.start();
  harness.media().currentTime = 12;
  harness.commit('From', '0:30');
  assert.equal(harness.media().currentTime, 30);
  harness.commit('To', '1:00');
  assert.equal(harness.media().currentTime, 30);
});

test('controller: guard - committing From seeks with Repeat off and no known duration', async () => {
  const harness = createHarness({ mediaOptions: { duration: NaN } });
  await harness.start();
  harness.panel('Repeat').checked = false;
  harness.panel('Repeat').dispatchEvent('change');
  harness.media().currentTime = 7;

  harness.commit('From', '0:30');
  assert.equal(harness.media().currentTime, 30);
  assert.equal(harness.status(), 'Repeat off');
});

test('controller: guard - a swallowed From seek is retried and lands', async () => {
  const harness = createHarness();
  await harness.start();
  const media = harness.media();
  let swallows = 1;
  let value = 0;
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get() {
      return value;
    },
    set(next) {
      if (swallows > 0) {
        swallows -= 1;
        return;
      }
      value = next;
    },
  });

  harness.commit('From', '0:30');
  assert.equal(media.currentTime, 0);
  harness.timers.flushTimeouts();
  assert.equal(media.currentTime, 30);
});

test('controller: a Now button captures the current time', async () => {
  const harness = createHarness();
  await harness.start();
  harness.media().currentTime = 42.9;
  harness.click('Set From to now');
  assert.equal(harness.fromValue(), '0:42');
  assert.equal(harness.media().currentTime, 42);
});

test('controller: a reversed range refuses the commit and marks both fields', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '2:00');
  assert.equal(harness.media().currentTime, 120);
  const to = harness.commit('To', '0:30');
  assert.equal(harness.media().currentTime, 120);
  assert.equal(to.getAttribute('aria-invalid'), 'true');
  assert.equal(harness.panel('From').getAttribute('aria-invalid'), 'true');
  assert.equal(harness.status(), 'Invalid range');
});

test('controller: guard - sync never clobbers a field being edited', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('To', '1:00');
  harness.typeInto('From', '0:42');
  harness.controller.sync();
  assert.equal(harness.fromValue(), '0:42');
});

test('controller: guard - the ended backstop is gated on the loop invariant', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '0:30');
  harness.commit('To', '1:00');
  const media = harness.media();
  media.currentTime = 300;
  media.dispatchEvent('ended');
  assert.equal(media.currentTime, 30);
  assert.equal(media.playCalls, 1);

  harness.click('Clear section');
  media.currentTime = 300;
  media.dispatchEvent('ended');
  assert.equal(media.currentTime, 300);
  assert.equal(media.playCalls, 1);
});

test('controller: guard - element replacement clears the points before the next song', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '0:30');
  assert.equal(harness.fromValue(), '0:30');

  harness.setMedia(harness.dom.makeMedia('song-b'));
  harness.controller.sync();
  assert.equal(harness.fromValue(), '');
  assert.equal(harness.timers.intervalCount(), 0);
});

test('controller: guard - old media, a null scan, then a new element still clears the points', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '0:30');
  assert.equal(harness.fromValue(), '0:30');

  harness.setMedia(null);
  harness.controller.sync();
  harness.setMedia(harness.dom.makeMedia('song-b'));
  harness.controller.sync();

  assert.equal(harness.fromValue(), '');
  assert.equal(harness.media().currentTime, 0);
});

test('controller: guard - enabling mid-song seeds the id and restores the saved section', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  assert.equal(harness.media().currentTime, 40);
  assert.equal(harness.fromValue(), '0:40');
  assert.equal(harness.timers.intervalCount(), 1);
});

test('controller: guard - a song change restores with no tick running (listener independent of the tick)', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-b', startSeconds: 20, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  assert.equal(harness.timers.intervalCount(), 0);

  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.media().currentTime, 20);
  assert.equal(harness.timers.intervalCount(), 1);
});

test('controller: guard - restoring a saved section turns Repeat back on', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-b', startSeconds: 30, endSeconds: 60 }] },
  });
  const harness = createHarness({ storage });
  await harness.start();

  harness.panel('Repeat').checked = false;
  harness.panel('Repeat').dispatchEvent('change');
  assert.equal(harness.status(), 'Repeat off');
  assert.equal(harness.timers.intervalCount(), 0);

  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.media().currentTime, 30);
  assert.equal(harness.panel('Repeat').checked, true);
  assert.equal(harness.status(), '0:30 → 1:00');
  assert.equal(harness.timers.intervalCount(), 1);
});

test('controller: guard - an autoplay advance (page-data-updated) restores too', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-b', startSeconds: 25, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-page-data-updated');
  await settle();
  assert.equal(harness.media().currentTime, 25);
});

test('controller: guard - one restore per song visit (a repeat event never re-seeks)', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-b', startSeconds: 20, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.media().currentTime, 20);

  harness.media().currentTime = 120;
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.media().currentTime, 120);
});

test('controller: guard - a restore seek the player swallows is retried inside the 3 s budget', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  const media = harness.media();
  let swallows = 3;
  let value = 120;
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get() {
      return value;
    },
    set(next) {
      if (swallows > 0) {
        swallows -= 1;
        return;
      }
      value = next;
    },
  });

  await harness.start();
  // The restore keeps retrying through the seek ladder instead of giving up.
  assert.equal(media.currentTime, 120);
  harness.timers.flushTimeouts();
  harness.timers.flushTimeouts();
  harness.timers.flushTimeouts();
  assert.equal(media.currentTime, 40);
});

test('controller: guard - a player reset after the restore seek is corrected once', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  assert.equal(harness.media().currentTime, 40);

  // Our own seek landing is not a user seek: the settle stays armed.
  harness.media().dispatchEvent('seeked');
  assert.equal(harness.timers.timeoutCount(), 1);
  harness.media().dispatchEvent('seeked');
  assert.equal(harness.timers.timeoutCount(), 1);

  // YTM applies its own startup position after the restore landed.
  harness.media().currentTime = 0;
  assert.equal(harness.timers.timeoutCount(), 1);
  harness.timers.flushTimeouts();
  assert.equal(harness.media().currentTime, 40);

  // Exactly once: a later reset is not fought forever.
  harness.media().currentTime = 0;
  assert.equal(harness.timers.timeoutCount(), 0);
  assert.equal(harness.media().currentTime, 0);
});

test('controller: guard - real user input cancels the restore settle and the seek retry', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });

  for (const eventName of ['pointerdown', 'keydown', 'touchstart']) {
    const harness = createHarness({ storage });
    await harness.start();
    assert.equal(harness.timers.timeoutCount(), 1, eventName + ' arms the settle');

    harness.dom.win.dispatch(eventName);
    assert.equal(harness.timers.timeoutCount(), 0, eventName + ' disowns the settle');
    harness.media().currentTime = 0;
    harness.timers.flushTimeouts();
    assert.equal(harness.media().currentTime, 0, eventName + ' leaves the position alone');
  }
});

test('controller: guard - a seeked event is not proof of a user seek', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();

  // A player reset to zero emits seeked; the settle must still correct it once.
  harness.media().currentTime = 0;
  harness.media().dispatchEvent('seeked');
  harness.timers.flushTimeouts();
  assert.equal(harness.media().currentTime, 40);
});

test('controller: guard - save composes from fresh storage and keeps other songs', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'other', startSeconds: 5, endSeconds: 9 }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');
  harness.commit('To', '0:20');
  harness.click('Save section');
  harness.timers.flushTimeouts();
  await settle();

  const sections = storage.sections();
  assert.deepEqual(
    sections.map((item) => item.videoId).sort(),
    ['other', 'song-a'],
  );
  const saved = sections.find((item) => item.videoId === 'song-a');
  assert.deepEqual(saved, { videoId: 'song-a', startSeconds: 10, endSeconds: 20 });
  assert.deepEqual(storage.writes.at(-1), { playerActions: { sections } });
  assert.equal(harness.status(), 'Saved');
});

test('controller: guard - the save notice is gated on the same song and points', async () => {
  const storage = createStorage();
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');
  harness.commit('To', '0:20');
  const release = storage.hold();
  harness.click('Save section');
  harness.timers.flushTimeouts();
  await settle(2);
  harness.commit('To', '0:30');
  release();
  await settle();

  const saved = storage.sections().find((item) => item.videoId === 'song-a');
  assert.deepEqual(saved, { videoId: 'song-a', startSeconds: 10, endSeconds: 20 });
  assert.notEqual(harness.status(), 'Saved');
});

test('controller: guard - a stop during an in-flight save writes nothing and leaves no timer', async () => {
  const storage = createStorage();
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');

  const release = storage.hold();
  harness.click('Save section');
  harness.timers.flushTimeouts();
  await settle(2);
  harness.controller.stop();
  release();
  await settle();

  assert.deepEqual(storage.sections(), []);
  assert.equal(storage.writes.length, 0);
  assert.equal(harness.timers.timeoutCount(), 0);
  assert.equal(harness.timers.intervalCount(), 0);
  assert.equal(harness.hostCount(), 0);
  assert.equal(harness.wheelListeners(), 0);
  assert.notEqual(harness.status(), 'Saved');
});

test('controller: saving an empty section removes the song entry', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 10, endSeconds: 20 }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  harness.click('Clear section');
  harness.click('Save section');
  harness.timers.flushTimeouts();
  await settle();
  assert.deepEqual(storage.sections(), []);
  assert.equal(harness.status(), 'Removed');
});

test('controller: guard - the cache load restores the first song', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: 60 }] },
  });
  const harness = createHarness({ storage });
  await harness.start();

  assert.equal(harness.media().currentTime, 40);
  assert.equal(harness.fromValue(), '0:40');
  assert.equal(harness.panel('Repeat').checked, true);
  assert.equal(harness.timers.intervalDelays().includes(100), true);
});

test('controller: guard - input during the cache load does not block the restore', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  const release = storage.hold();
  const started = harness.controller.start();
  await settle(2);

  harness.dom.win.dispatch('keydown');
  release();
  await started;
  await settle();

  assert.equal(harness.media().currentTime, 40);
  assert.equal(harness.fromValue(), '0:40');
});

test('controller: guard - an edit before the cache lands is not overwritten', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  const release = storage.hold();
  const started = harness.controller.start();
  await settle(2);

  harness.commit('From', '1:10');
  harness.media().currentTime = 70;
  release();
  await started;
  await settle();

  assert.equal(harness.fromValue(), '1:10');
  assert.equal(harness.media().currentTime, 70);
});

test('controller: guard - concurrent song signals apply the cache once', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-b', startSeconds: 20, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();

  const media = harness.media();
  let writes = 0;
  let value = 0;
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get() {
      return value;
    },
    set(next) {
      writes += 1;
      value = Number(next);
    },
  });

  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  harness.dom.win.dispatch('yt-navigate-finish');
  harness.controller.sync();
  await settle();

  assert.equal(writes, 1);
  assert.equal(value, 20);
  assert.equal(harness.fromValue(), '0:20');
});

test('controller: guard - a failed save leaves the cache untouched', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-b', startSeconds: 25, endSeconds: null }] },
  });
  storage.saveSection = async () => ({ ok: false, error: 'storage unavailable' });
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');
  harness.click('Save section');
  await settle();
  assert.equal(harness.status(), 'Save failed');

  // The cached section still restores: the failed write changed nothing.
  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.media().currentTime, 25);
});

test('controller: guard - a successful save updates the cache from the reply', async () => {
  const storage = createStorage();
  storage.saveSection = async (entry) => ({ ok: true, sections: [entry] });
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');
  harness.commit('To', '0:20');
  harness.click('Save section');
  await settle();

  // A second visit restores from the cache alone (the fake never stored it).
  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  harness.setHref('https://music.youtube.com/watch?v=song-a');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();

  assert.equal(harness.media().currentTime, 10);
  assert.equal(harness.fromValue(), '0:10');
});

test('controller: the service-worker save path is used when the content script supplies it', async () => {
  const calls = [];
  const storage = createStorage();
  storage.saveSection = async (entry) => {
    calls.push(entry);
    return { ok: true, sections: [{ videoId: 'song-a', startSeconds: 10, endSeconds: null }] };
  };
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');
  harness.click('Save section');
  harness.timers.flushTimeouts();
  await settle();

  assert.deepEqual(calls, [{ videoId: 'song-a', startSeconds: 10, endSeconds: null }]);
  assert.equal(harness.status(), 'Saved');
});

/** One ordered writer, as background.js implements it. */
function createSectionQueue(storage) {
  let chain = Promise.resolve();
  return (entry) => {
    chain = chain.catch(() => []).then(async () => {
      const stored = await storage.get('playerActions');
      const raw = stored && stored.playerActions;
      const current = actions.sanitizeSaved(raw ? raw.sections : undefined);
      const next = actions.capSaved(actions.upsertSaved(current, entry), 100);
      await storage.set({ playerActions: { sections: next } });
      return { ok: true, sections: next };
    });
    return chain;
  };
}

test('controller: cross-tab - two tabs saving through one writer keep both songs', async () => {
  const shared = createStorage();
  const saveSection = createSectionQueue(shared);
  const storageFor = () => ({
    get: (key) => shared.get(key),
    set: (items) => shared.set(items),
    saveSection,
  });

  const tabA = createHarness({ storage: storageFor() });
  const tabB = createHarness({ storage: storageFor() });
  await tabA.start();
  await tabB.start();

  tabA.commit('From', '0:10');
  tabB.setHref('https://music.youtube.com/watch?v=song-b');
  tabB.dom.win.dispatch('yt-navigate-finish');
  await settle();
  tabB.commit('From', '0:20');

  // Overlapping saves: neither tab may lose the other's song.
  tabA.click('Save section');
  tabB.click('Save section');
  tabA.timers.flushTimeouts();
  tabB.timers.flushTimeouts();
  await settle(10);

  const sections = shared.sections();
  assert.deepEqual(sections.map((item) => item.videoId).sort(), ['song-a', 'song-b']);
  assert.equal(sections.find((item) => item.videoId === 'song-a').startSeconds, 10);
  assert.equal(sections.find((item) => item.videoId === 'song-b').startSeconds, 20);
});

test('controller: the persisted list is capped at 100 entries, oldest dropped', async () => {
  const sections = [];
  for (let index = 0; index < 100; index += 1) {
    sections.push({ videoId: 'song-' + index, startSeconds: index, endSeconds: null });
  }
  const storage = createStorage({ playerActions: { sections } });
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:05');
  harness.click('Save section');
  harness.timers.flushTimeouts();
  await settle();

  const written = storage.sections();
  assert.equal(written.length, 100);
  assert.equal(written[0].videoId, 'song-1');
  assert.equal(written[99].videoId, 'song-a');
});

test('controller: status copy mirrors the section state', async () => {
  const harness = createHarness();
  await harness.start();
  assert.equal(harness.status(), 'Set From or To');
  harness.commit('From', '0:30');
  assert.equal(harness.status(), '0:30 → end of song');
  harness.commit('To', '1:00');
  assert.equal(harness.status(), '0:30 → 1:00');
  harness.panel('Repeat').checked = false;
  harness.panel('Repeat').dispatchEvent('change');
  assert.equal(harness.status(), 'Repeat off');
  assert.equal(harness.timers.intervalCount(), 0);
});

// ---------------------------------------------------------------------------
// Round 3: identity, save correctness, cross-tab reads, seek provenance
// ---------------------------------------------------------------------------

test('controller: guard - no song id means no loop seek; the same id resumes, a new one clears', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '0:30');
  assert.equal(harness.timers.intervalDelays().includes(100), true);

  harness.media().currentTime = 299.75;
  harness.setHref('https://music.youtube.com/watch');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();

  // No id: the loop tick is gone (only the bounded restore retry may run) and
  // nothing seeks, even when the retry ticks.
  assert.equal(harness.timers.intervalDelays().includes(100), false);
  harness.timers.tickIntervals();
  await settle();
  assert.equal(harness.media().currentTime, 299.75);

  // The same song comes back: the points were kept and the loop resumes.
  harness.setHref('https://music.youtube.com/watch?v=song-a');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.fromValue(), '0:30');
  assert.equal(harness.timers.intervalDelays().includes(100), true);

  // A different song clears them.
  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.fromValue(), '');
  assert.equal(harness.timers.intervalDelays().includes(100), false);
});

test('controller: guard - a failed storage write never reports Saved', async () => {
  const storage = createStorage();
  storage.saveSection = async () => ({ ok: false, error: 'storage unavailable' });
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');
  harness.click('Save section');
  await settle();
  assert.equal(harness.status(), 'Save failed');
});

test('controller: guard - Save snapshots the song and points at the click', async () => {
  const calls = [];
  const storage = createStorage();
  storage.saveSection = async (entry) => {
    calls.push(entry);
    return { ok: true, sections: [entry] };
  };
  const harness = createHarness({ storage });
  await harness.start();
  harness.commit('From', '0:10');
  harness.commit('To', '0:20');

  harness.click('Save section');
  // Navigate while the write is in flight: the composed entry must not change.
  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();

  assert.deepEqual(calls, [{ videoId: 'song-a', startSeconds: 10, endSeconds: 20 }]);
  assert.notEqual(harness.status(), 'Saved');
});

test('controller: guard - Save without a song id asks for a song and writes nothing', async () => {
  const writes = [];
  const storage = createStorage();
  storage.saveSection = async (entry) => {
    writes.push(entry);
    return { ok: true, sections: [] };
  };
  const harness = createHarness({ storage });
  harness.setHref('https://music.youtube.com/');
  await harness.start();
  harness.commit('From', '0:10');
  harness.click('Save section');
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(harness.status(), 'Play a track to save');
});

test('controller: guard - an onChanged save from another tab restores on the next visit', async () => {
  const storage = createStorage();
  const harness = createHarness({ storage });
  await harness.start();

  // Another tab writes; the cache learns it through storage.subscribe.
  storage.setSections([{ videoId: 'song-b', startSeconds: 25, endSeconds: null }]);
  await settle();

  harness.setHref('https://music.youtube.com/watch?v=song-b');
  harness.dom.win.dispatch('yt-navigate-finish');
  await settle();
  assert.equal(harness.media().currentTime, 25);
  assert.equal(harness.fromValue(), '0:25');
});

test('controller: guard - a restore that lands on the retry marks restored and arms the settle', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  const media = harness.media();
  let swallows = 1;
  let value = 0;
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get() {
      return value;
    },
    set(next) {
      if (swallows > 0) {
        swallows -= 1;
        return;
      }
      value = next;
    },
  });

  await harness.start();
  assert.equal(media.currentTime, 0);
  harness.timers.flushTimeouts();
  assert.equal(media.currentTime, 40);
  // Restored (no restore retry left) and settled (one settle timer armed).
  assert.equal(harness.timers.intervalDelays().includes(150), false);
  assert.equal(harness.timers.timeoutCount(), 1);

  media.currentTime = 0;
  harness.timers.flushTimeouts();
  assert.equal(media.currentTime, 40);
});

test('controller: guard - a reply from before a restart cannot overwrite the new session', async () => {
  const pending = [];
  const pageHook = {
    setVolume(percent) {
      return new Promise((resolve) => {
        pending.push({ percent, resolve });
      });
    },
  };
  const harness = createHarness({ pageHook });
  await harness.start();
  harness.wheel(-100);
  assert.equal(pending.length, 1);

  harness.controller.stop();
  await harness.start();
  harness.wheel(-100);
  assert.equal(pending.length, 2);

  pending[1].resolve({ volume: 55, applied: true, source: 'player' });
  await settle();
  pending[0].resolve({ volume: 10, applied: true, source: 'player' });
  await settle();

  // The new session's next step is based on 55, not on the old session's 10.
  harness.wheel(-100);
  assert.equal(pending[2].percent, 60);
});

// ---------------------------------------------------------------------------
// Round 4: restore token and seek cancellation
// ---------------------------------------------------------------------------

test('controller: guard - Clear cancels an outstanding From retry and never seeks', async () => {
  const harness = createHarness();
  await harness.start();
  const media = harness.media();
  let writes = 0;
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get() {
      return 0;
    },
    set() {
      writes += 1;
    },
  });

  harness.commit('From', '0:30');
  const afterFrom = writes;
  assert.equal(afterFrom, 1);

  harness.click('Clear section');
  harness.timers.flushTimeouts();
  assert.equal(writes, afterFrom);
  assert.equal(harness.fromValue(), '');
});

// ---------------------------------------------------------------------------
// Round 6: player identity, playback modes, surfaces, loop timing, zero HUD
// ---------------------------------------------------------------------------

test('identity: a pushed id arms the loop from Home with no ?v=', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'home-id', startSeconds: 30, endSeconds: 60 }] },
  });
  const harness = createHarness({ storage });
  harness.setHref('https://music.youtube.com/');
  await harness.start();
  harness.pushSong('home-id');
  await settle();

  assert.equal(harness.fromValue(), '0:30');
  assert.equal(harness.media().currentTime, 30);
  assert.equal(harness.timers.intervalDelays().includes(100), true);
});

test('identity: a different id clears the points', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'id-a', startSeconds: 30, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  harness.pushSong('id-a');
  await settle();
  assert.equal(harness.fromValue(), '0:30');

  harness.pushSong('id-b');
  await settle();
  assert.equal(harness.fromValue(), '');
  assert.equal(harness.timers.intervalDelays().includes(100), false);
});

test('identity: a null id stops the tick and keeps the points', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'id-a', startSeconds: 30, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  harness.pushSong('id-a');
  await settle();
  assert.equal(harness.timers.intervalDelays().includes(100), true);

  harness.pushSong(null);
  await settle();
  assert.equal(harness.timers.intervalDelays().includes(100), false);
  assert.equal(harness.fromValue(), '0:30');
});

test('identity: the same id returns and the loop resumes', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'id-a', startSeconds: 30, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  harness.pushSong('id-a');
  await settle();
  harness.pushSong(null);
  await settle();
  assert.equal(harness.timers.intervalDelays().includes(100), false);

  harness.pushSong('id-a');
  await settle();
  assert.equal(harness.timers.intervalDelays().includes(100), true);
  assert.equal(harness.fromValue(), '0:30');
  assert.equal(harness.media().currentTime, 30);
});

test('identity: the URL ?v= is the fallback until the player pushes an id', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'url-id', startSeconds: 10, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  harness.setHref('https://music.youtube.com/watch?v=url-id');
  await harness.start();
  assert.equal(harness.fromValue(), '0:10');

  // Once the player speaks, the URL no longer decides.
  harness.pushSong('player-id');
  await settle();
  assert.equal(harness.fromValue(), '');
});

test('identity: a save under the pushed id survives a fresh controller', async () => {
  const storage = createStorage();
  const first = createHarness({ storage });
  await first.start();
  first.pushSong('stable-id');
  await settle();
  first.commit('From', '0:10');
  first.commit('To', '0:20');
  first.click('Save section');
  await settle();
  assert.equal(first.status(), 'Saved');

  const second = createHarness({ storage });
  await second.start();
  second.pushSong('stable-id');
  await settle();
  assert.equal(second.fromValue(), '0:10');
  assert.equal(second.media().currentTime, 10);
});

test('identity: the same id on Home and on a watch URL is one section', async () => {
  const storage = createStorage();
  const home = createHarness({ storage });
  home.setHref('https://music.youtube.com/');
  await home.start();
  home.pushSong('id-x');
  await settle();
  home.commit('From', '0:10');
  home.click('Save section');
  await settle();

  // A watch URL whose `v` names something else: the player id still wins.
  const watch = createHarness({ storage });
  watch.setHref('https://music.youtube.com/watch?v=other-url-id');
  await watch.start();
  watch.pushSong('id-x');
  await settle();
  assert.equal(watch.fromValue(), '0:10');
});

test('modes: song mode - a hidden 0x0 video still supplies the loop timing', async () => {
  const harness = createHarness({
    mediaOptions: { width: 0, height: 0, computedVisibility: 'hidden', duration: 300 },
  });
  await harness.start();
  harness.commit('From', '0:30');
  harness.media().currentTime = 299.75;
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, 30);
});

test('modes: video mode - the visible video loops identically', async () => {
  const harness = createHarness({ mediaOptions: { computedVisibility: 'visible', duration: 300 } });
  await harness.start();
  harness.commit('From', '0:30');
  harness.media().currentTime = 299.75;
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, 30);
});

test('modes: collapsed mode - the bar drives the wheel and the same element loops', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '0:30');

  const event = harness.wheel(-100);
  assert.equal(event.defaultPrevented, true);

  harness.media().currentTime = 299.75;
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, 30);
});

test('loop: a To already passed seeks back on the next tick', async () => {
  const harness = createHarness();
  await harness.start();
  harness.commit('From', '0:30');
  harness.commit('To', '1:00');
  harness.media().currentTime = 65;
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, 30);
});

test('loop: an explicit end loops without a known duration', async () => {
  const harness = createHarness({ mediaOptions: { duration: NaN } });
  await harness.start();
  harness.commit('From', '0:30');
  harness.commit('To', '1:00');
  harness.media().currentTime = 60;
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, 30);
});

test('ui: the volume HUD is gone and the status follows a pushed id', async () => {
  const harness = createHarness();
  await harness.start();
  assert.equal(harness.dom.hasHud(), false);

  harness.pushSong('ui-id');
  await settle();
  harness.commit('From', '0:10');
  harness.commit('To', '0:20');
  assert.equal(harness.status(), '0:10 → 0:20');
  assert.equal(harness.dom.hasHud(), false);
});

test('ui: without an id the status is medium-neutral', async () => {
  const harness = createHarness();
  harness.setHref('https://music.youtube.com/');
  await harness.start();
  harness.pushSong(null);
  await settle();
  assert.equal(harness.status(), 'Play a track to repeat');
});

// ---------------------------------------------------------------------------
// Storage schema
// ---------------------------------------------------------------------------

test('storage keeps sections under one playerActions key with no volume field', async () => {
  const storage = createStorage();
  const harness = createHarness({ storage });
  await harness.start();
  harness.wheel(-100);
  await settle();
  harness.commit('From', '0:10');
  harness.click('Save section');
  harness.timers.flushTimeouts();
  await settle();

  const keys = Object.keys(storage.data);
  assert.deepEqual(keys, ['playerActions']);
  assert.deepEqual(Object.keys(storage.data.playerActions), ['sections']);
  const [saved] = storage.data.playerActions.sections;
  assert.deepEqual(Object.keys(saved).sort(), ['endSeconds', 'startSeconds', 'videoId']);
  assert.equal(Number.isInteger(saved.startSeconds), true);
  assert.equal(saved.endSeconds, null);
});

// ---------------------------------------------------------------------------
// Static product guards
// ---------------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const manifestSource = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const playerActionsSource = fs.readFileSync(path.join(ROOT, 'player-actions.js'), 'utf8');
const contentScriptSource = fs.readFileSync(path.join(ROOT, 'content-script.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(ROOT, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');

test('static: permissions and host scope are unchanged', () => {
  assert.deepEqual(manifest.permissions, ['scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['https://music.youtube.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://music.youtube.com/*']);
  assert.equal(manifestSource.includes('m.youtube.com'), false);
});

test('static: player-actions.js loads between shared.js and content-script.js', () => {
  assert.deepEqual(manifest.content_scripts[0].js, ['shared.js', 'player-actions.js', 'content-script.js']);
});

test('static: the popup still ships exactly four controls', () => {
  const controls = popupSource.match(/<(input|button|select|textarea)\b/g) || [];
  assert.equal(controls.length, 4);
  for (const id of ['slow-slider', 'intensity-slider', 'power-toggle', 'reset-btn']) {
    assert.equal(popupSource.includes(`id="${id}"`), true);
  }
});

test('static: player-actions.js adds no second gain-based volume path', () => {
  assert.equal(/createGain|GainNode|masterGain|\.gain\b/.test(playerActionsSource), false);
});

test('static: the release zip list ships player-actions.js', () => {
  const lines = releaseWorkflow.split('\n');
  const slowed = lines.find((line) => line.includes('slowed-reverb.zip'));
  assert.ok(slowed, 'slowed-reverb zip line exists');
  assert.equal(slowed.includes('shared.js player-actions.js content-script.js'), true);
  const others = lines.filter((line) => line.includes('.zip') && !line.includes('slowed-reverb.zip'));
  for (const line of others) assert.equal(line.includes('player-actions.js'), false);
});

test('static: the content script wires the player-actions module in one place', () => {
  const mentions = contentScriptSource.match(/SlowedReverbPlayerActions/g) || [];
  assert.equal(mentions.length, 1);
  assert.equal(contentScriptSource.includes('createPlayerActions'), true);
});

// ---------------------------------------------------------------------------
// page-hook.js: token-verified volume protocol
// ---------------------------------------------------------------------------

const pageHookSource = fs.readFileSync(path.join(ROOT, 'page-hook.js'), 'utf8');

function createPageHookSandbox(options) {
  const settings = options || {};
  const posted = [];
  const listeners = new Map();
  const player = {
    volume: settings.volume === undefined ? 40 : settings.volume,
    setVolumeCalls: [],
    setVolume(value) {
      this.setVolumeCalls.push(value);
      // `appliedVolume` models the page landing on its own value.
      this.volume = settings.appliedVolume === undefined ? value : settings.appliedVolume;
    },
    getVolume() {
      return this.volume;
    },
    getVideoData() {
      if (!settings.videoId) return {};
      return { video_id: settings.videoId, title: settings.title || '', author: 'artist' };
    },
  };

  const win = {
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    postMessage(message) {
      posted.push(message);
    },
  };

  const sliders = settings.sliders || null;
  const document = {
    documentElement: { dataset: { slraToken: settings.token === undefined ? 'tok-1' : settings.token } },
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === '#movie_player') return settings.noPlayer ? null : player;
      if (selector === 'video') return settings.video || null;
      if (sliders && selector in sliders) return sliders[selector];
      return null;
    },
  };

  const timers = [];
  let timerId = 1;

  const sandbox = {
    window: win,
    document,
    location: { href: 'https://music.youtube.com/watch?v=song-a' },
    console,
    setTimeout(fn, ms) {
      const id = timerId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pageHookSource, sandbox, { filename: 'page-hook.js' });

  return {
    player,
    posted() {
      return posted;
    },
    timers,
    flushTimers() {
      const pending = [...timers];
      timers.length = 0;
      for (const timer of pending) timer.fn();
    },
    replies() {
      return posted.filter((message) => message && message.type === 'SLRA_VOLUME_STATE');
    },
    fire(data) {
      for (const fn of listeners.get('message') || []) fn({ source: win, data });
    },
  };
}

test('page-hook: SLRA_SET_VOLUME applies the percent and replies with the applied value', () => {
  const hook = createPageHookSandbox();
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 7, token: 'tok-1', percent: 65 });

  assert.deepEqual(hook.player.setVolumeCalls, [65]);
  assert.equal(hook.player.volume, 65);
  const [reply] = hook.replies();
  assert.equal(reply.id, 7);
  assert.equal(reply.token, 'tok-1');
  assert.equal(reply.volume, 65);
  assert.equal(reply.applied, true);
  assert.equal(reply.source, 'player');
});

test('page-hook: a volume request with the wrong token is ignored', () => {
  const hook = createPageHookSandbox();
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 9, token: 'stale', percent: 80 });
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 10, percent: 80 });
  assert.deepEqual(hook.player.setVolumeCalls, []);
  assert.equal(hook.replies().length, 0);
});

test('page-hook: a missing player API replies source none', () => {
  const hook = createPageHookSandbox({ noPlayer: true });
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 11, token: 'tok-1', percent: 80 });
  const [reply] = hook.replies();
  assert.equal(reply.id, 11);
  assert.equal(reply.applied, false);
  assert.equal(reply.source, 'none');
  assert.equal(reply.volume, null);
});

function createSlider() {
  const names = new Set();
  return {
    value: '',
    title: '',
    attributes: {},
    classList: {
      add(name) {
        names.add(name);
      },
      remove(name) {
        names.delete(name);
      },
      contains(name) {
        return names.has(name);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

function createSliderSet() {
  return {
    '#volume-slider': createSlider(),
    '#expand-volume-slider': createSlider(),
    'tp-yt-paper-icon-button.volume': createSlider(),
    '#expand-volume': createSlider(),
  };
}

test('page-hook: a successful SET syncs the slider, tooltips and hover state', () => {
  const sliders = createSliderSet();
  const hook = createPageHookSandbox({ sliders });
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 31, token: 'tok-1', percent: 40 });

  assert.equal(sliders['#volume-slider'].value, '40');
  assert.equal(sliders['#volume-slider'].attributes.value, '40');
  assert.equal(sliders['#expand-volume-slider'].value, '40');
  assert.equal(sliders['#expand-volume-slider'].attributes.value, '40');
  assert.equal(sliders['#volume-slider'].title, '40%');
  assert.equal(sliders['tp-yt-paper-icon-button.volume'].title, '40%');
  assert.equal(sliders['#expand-volume-slider'].title, '40%');
  assert.equal(sliders['#expand-volume'].title, '40%');
  assert.equal(sliders['#volume-slider'].classList.contains('on-hover'), true);

  // The hover state is transient: one 2500 ms timer, then it is gone.
  assert.equal(hook.timers.length, 1);
  assert.equal(hook.timers[0].ms, 2500);
  hook.flushTimers();
  assert.equal(sliders['#volume-slider'].classList.contains('on-hover'), false);
});

test('page-hook: the UI follows the value the page applied, not the request', () => {
  const sliders = createSliderSet();
  const hook = createPageHookSandbox({ sliders, appliedVolume: 39 });
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 32, token: 'tok-1', percent: 40 });

  assert.equal(hook.player.setVolumeCalls[0], 40);
  assert.equal(sliders['#volume-slider'].value, '39');
  assert.equal(sliders['#volume-slider'].title, '39%');
  const [reply] = hook.replies();
  assert.equal(reply.volume, 39);
});

test('page-hook: missing slider elements are a no-op', () => {
  const hook = createPageHookSandbox();
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 33, token: 'tok-1', percent: 40 });
  assert.deepEqual(hook.player.setVolumeCalls, [40]);
  assert.equal(hook.replies().length, 1);
});

test('page-hook: SLRA_SYNC_VOLUME_UI syncs the UI after a media fallback', () => {
  const sliders = createSliderSet();
  const hook = createPageHookSandbox({ sliders, noPlayer: true });
  hook.fire({ __slra: true, type: 'SLRA_SYNC_VOLUME_UI', token: 'tok-1', percent: 40 });
  assert.equal(sliders['#volume-slider'].value, '40');
  assert.equal(sliders['#volume-slider'].title, '40%');
  assert.equal(sliders['#volume-slider'].classList.contains('on-hover'), true);
});

test('page-hook: SLRA_SYNC_VOLUME_UI with a wrong token is ignored', () => {
  const sliders = createSliderSet();
  const hook = createPageHookSandbox({ sliders });
  hook.fire({ __slra: true, type: 'SLRA_SYNC_VOLUME_UI', token: 'stale', percent: 40 });
  assert.equal(sliders['#volume-slider'].value, '');
});

test('page-hook: SLRA_SONG pushes the player video id on install', () => {
  const hook = createPageHookSandbox({ videoId: 'abc123', title: 'A song' });
  const songs = hook.posted().filter((message) => message.type === 'SLRA_SONG');
  assert.ok(songs.length >= 1);
  assert.equal(songs[0].videoId, 'abc123');
  assert.equal(songs[0].title, 'A song');
  assert.equal(songs[0].token, 'tok-1');
});

test('page-hook: SLRA_SONG pushes null when the player has no id', () => {
  const hook = createPageHookSandbox();
  const songs = hook.posted().filter((message) => message.type === 'SLRA_SONG');
  assert.ok(songs.length >= 1);
  assert.equal(songs[0].videoId, null);
});

test('page-hook: no GET_VOLUME surface and no mute write survive', () => {
  const hook = createPageHookSandbox();
  const video = { muted: false, setCount: 0 };
  Object.defineProperty(video, 'muted', {
    configurable: true,
    get() {
      return false;
    },
    set() {
      video.setCount += 1;
    },
  });
  const withVideo = createPageHookSandbox({ video });
  withVideo.fire({ __slra: true, type: 'SLRA_GET_VOLUME', id: 12, token: 'tok-1' });
  withVideo.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 13, token: 'tok-1', percent: 55, keepMuted: true, session: 's1' });
  assert.equal(withVideo.replies().filter((reply) => reply.id === 12).length, 0);
  assert.equal(withVideo.player.setVolumeCalls.length, 1);
  assert.equal(video.setCount, 0);
  assert.equal(hook.player.setVolumeCalls.length, 0);
});

test('static: page-hook.js writes volume only - no muted assignment, no attach channel', () => {
  assert.equal(/\.muted\s*=/.test(pageHookSource), false);
  assert.equal(pageHookSource.includes('ATTACH_STATE'), false);
  assert.equal(pageHookSource.includes('keepMuted'), false);
  assert.equal(pageHookSource.includes('SLRA_GET_VOLUME'), false);
});

test('static: content-script is the single writer of media.muted', () => {
  assert.equal(/ATTACH_STATE|keepMuted|SLRA_GET_VOLUME/.test(contentScriptSource), false);
  // The only mute writer in the extension runtime that touches an element.
  assert.equal(/\.muted\s*=/.test(playerActionsSource), false);
  assert.equal(/\.muted\s*=/.test(contentScriptSource), true);
  assert.equal(/\.muted\s*=/.test(pageHookSource), false);
});
