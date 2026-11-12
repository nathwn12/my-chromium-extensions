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
    getComputedStyle: () => ({ overflowY: 'hidden' }),
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

  function hudText() {
    const current = host();
    if (!current || !current.shadowRoot) return '';
    const hud = nodes(current.shadowRoot).find((node) => node.classList.contains('slra-hud'));
    return hud ? hud.textContent : '';
  }

  function hudVisible() {
    const current = host();
    if (!current || !current.shadowRoot) return false;
    const hud = nodes(current.shadowRoot).find((node) => node.classList.contains('slra-hud'));
    return Boolean(hud && hud.classList.contains('visible'));
  }

  return {
    win,
    document,
    documentElement,
    makeMedia,
    host,
    panel,
    hudText,
    hudVisible,
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
    },
  };
}

function createPageHook(volume, options) {
  const state = { volume, source: (options && options.source) || 'player' };
  const calls = [];

  return {
    calls,
    volume() {
      return state.volume;
    },
    async getVolume() {
      return { volume: state.volume, applied: state.source === 'player', source: state.source };
    },
    async setVolume(percent, keepMuted) {
      calls.push({ percent, keepMuted });
      if (state.source === 'none') {
        return { volume: null, applied: false, source: 'none' };
      }
      state.volume = percent;
      return { volume: percent, applied: true, source: state.source };
    },
    reply(volume, source) {
      state.volume = volume;
      state.source = source;
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
  let clock = 1000;

  const controller = actions.createPlayerActions({
    window: dom.win,
    document: dom.document,
    mediaProvider: () => media,
    pageHook,
    storage,
    timers,
    now: () => clock,
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
    advance(ms) {
      clock += ms;
    },
    hostCount() {
      return dom.documentElement.children.filter((child) => child.hasAttribute(HOST_ATTR)).length;
    },
    wheelListeners() {
      return dom.win.listenerCount('wheel');
    },
    wheel(deltaY, props) {
      return dom.win.dispatch('wheel', { deltaY, target: dom.documentElement, ...(props || {}) });
    },
    host() {
      return dom.host();
    },
    panel(label) {
      return dom.panel(label);
    },
    hudText() {
      return dom.hudText();
    },
    hudVisible() {
      return dom.hudVisible();
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

test('songKeyFrom: the currentSrc fallback is a short stable key, never the URL', () => {
  const url = 'https://rr1.googlevideo.com/videoplayback?expire=1&sig=LONGSIGNEDVALUE&id=abc';
  const first = actions.songKeyFrom('https://music.youtube.com/', url);
  assert.equal(first, actions.songKeyFrom('https://music.youtube.com/', url));
  assert.match(first, /^src:[0-9a-f]{8}$/);
  assert.equal(first.includes('googlevideo'), false);
  assert.equal(first.length, 12);
  assert.notEqual(actions.songKeyFrom('https://music.youtube.com/', url + '&extra=1'), first);
  assert.equal(actions.songKeyFrom('https://music.youtube.com/', ''), null);
  assert.equal(actions.songKeyFrom('not a url', ''), null);
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

test('guard: a pending restore retries for at most 3 s', () => {
  const session = actions.createSectionSession();
  actions.beginSong(session, 'song-a');
  actions.deferRestore(session, 1000);
  assert.equal(session.pendingRestore, true);
  assert.equal(actions.restoreDeadlineReached(session, 2500), false);
  assert.equal(actions.restoreDeadlineReached(session, 4001), true);
  actions.clearPendingRestore(session);
  assert.equal(session.pendingRestore, false);
  assert.equal(actions.restoreDeadlineReached(session, 9999), false);
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

function predicateDoc(options) {
  const settings = options || {};
  const documentElement = fakeNode('html', {
    overflow: settings.htmlOverflow || 'hidden',
    scrollHeight: settings.htmlScrollHeight === undefined ? 800 : settings.htmlScrollHeight,
    clientHeight: 800,
  });
  return {
    documentElement,
    defaultView: { innerHeight: settings.innerHeight === undefined ? 800 : settings.innerHeight },
  };
}

const getStyle = (node) => ({ overflowY: node.computedOverflow || 'visible' });

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

test('wheel guard: a handled event on plain player chrome', () => {
  const playerBar = fakeNode('div', { overflow: 'hidden' });
  const verdict = actions.shouldHandleWheel(wheelEvent(), playerBar, predicateDoc(), getStyle);
  assert.deepEqual(verdict, { handle: true, reason: 'handle' });
});

test('wheel guard: defaultPrevented events belong to someone else', () => {
  const target = fakeNode('div');
  assert.equal(actions.shouldHandleWheel(wheelEvent({ defaultPrevented: true }), target, predicateDoc(), getStyle).handle, false);
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

test('wheel guard: a scrollable ancestor keeps native scrolling', () => {
  const scroller = fakeNode('div', { overflow: 'auto', scrollHeight: 400, clientHeight: 200 });
  assert.equal(actions.shouldHandleWheel(wheelEvent(), scroller, predicateDoc(), getStyle).handle, false);
  const child = fakeNode('span', { parent: scroller });
  const verdict = actions.shouldHandleWheel(wheelEvent(), child, predicateDoc(), getStyle);
  assert.equal(verdict.handle, false);
  assert.equal(verdict.reason, 'scrollable-ancestor');
});

test('wheel guard: a scrolling document keeps native scrolling', () => {
  const doc = predicateDoc({ htmlOverflow: 'auto', htmlScrollHeight: 4000, innerHeight: 800 });
  const verdict = actions.shouldHandleWheel(wheelEvent(), fakeNode('div', { parent: doc.documentElement }), doc, getStyle);
  assert.equal(verdict.handle, false);
  assert.equal(verdict.reason, 'document-scroller');
});

test('wheel guard: a tall non-scrolling auto container does not block the wheel', () => {
  const doc = predicateDoc({ innerHeight: 800 });
  const container = fakeNode('div', { overflow: 'auto', scrollHeight: 2000, clientHeight: 2000, parent: doc.documentElement });
  const verdict = actions.shouldHandleWheel(wheelEvent(), fakeNode('span', { parent: container }), doc, getStyle);
  assert.equal(verdict.handle, true);
});

test('wheel guard: a non-scrolling document over the player bar handles the wheel', () => {
  const doc = predicateDoc({ htmlOverflow: 'auto', htmlScrollHeight: 800, innerHeight: 800 });
  const verdict = actions.shouldHandleWheel(wheelEvent(), fakeNode('div', { parent: doc.documentElement }), doc, getStyle);
  assert.equal(verdict.handle, true);
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

test('controller: a wheel over the player bar writes the page volume and shows the HUD', async () => {
  const harness = createHarness();
  await harness.start();
  const event = harness.wheel(-100);
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.deepEqual(harness.pageHook.calls.at(-1), { percent: 55, keepMuted: true });
  assert.equal(harness.hudText(), '55 %');
  assert.equal(harness.hudVisible(), true);
  harness.timers.flushTimeouts();
  assert.equal(harness.hudVisible(), false);
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

test('controller: a page hook without a player API falls back to media.volume', async () => {
  const pageHook = createPageHook(50, { source: 'none' });
  const harness = createHarness({ pageHook });
  await harness.start();
  harness.wheel(-100);
  await settle();
  assert.equal(harness.media().volume, 0.55);
  assert.equal(harness.hudText(), '55 %');
});

test('controller: guard - a stale volume reply cannot overwrite a newer write', async () => {
  const pendingReplies = [];
  const pageHook = {
    async getVolume() {
      return { volume: 50, applied: true, source: 'player' };
    },
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

  pendingReplies[1].resolve({ volume: 60, applied: true, source: 'player' });
  await settle();
  assert.equal(harness.hudText(), '60 %');

  // The older request answers late, both as a value and as a failure.
  pendingReplies[0].resolve({ volume: 55, applied: true, source: 'player' });
  await settle();
  assert.equal(harness.hudText(), '60 %');

  pendingReplies[0].resolve({ volume: null, applied: false, source: 'none' });
  await settle();
  assert.equal(harness.media().volume, 0.5);
  assert.equal(harness.hudText(), '60 %');
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

test('controller: guard - a restore retries when the song id arrives with no event', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-c', startSeconds: 30, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  harness.setHref('https://music.youtube.com/');
  harness.media().currentSrc = '';
  await harness.start();

  // No id at all: the pending restore keeps the tick alive.
  assert.equal(harness.timers.intervalCount(), 1);
  assert.equal(harness.media().currentTime, 0);

  // The id appears with no named navigation event.
  harness.setHref('https://music.youtube.com/watch?v=song-c');
  harness.advance(500);
  harness.timers.tickIntervals();
  assert.equal(harness.media().currentTime, 30);
  assert.equal(harness.panel('Repeat').checked, true);
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

test('controller: guard - the restore retry gives up after the 3 s budget', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  const media = harness.media();
  let writes = 0;
  const value = 120;
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get() {
      return value;
    },
    set() {
      writes += 1;
    },
  });

  await harness.start();
  harness.advance(4000);
  harness.timers.tickIntervals();
  harness.timers.flushTimeouts();
  const settled = writes;
  harness.timers.tickIntervals();
  harness.timers.flushTimeouts();
  assert.equal(writes, settled);
  assert.equal(media.currentTime, 120);
});

test('controller: guard - a player reset after the restore seek is corrected once', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'song-a', startSeconds: 40, endSeconds: null }] },
  });
  const harness = createHarness({ storage });
  await harness.start();
  assert.equal(harness.media().currentTime, 40);

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
  const video = { muted: false, volume: 1 };
  const player = {
    volume: settings.volume === undefined ? 40 : settings.volume,
    setVolumeCalls: [],
    setVolume(value) {
      this.volume = value;
      this.setVolumeCalls.push(value);
    },
    getVolume() {
      return this.volume;
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

  const document = {
    documentElement: { dataset: { slraToken: settings.token === undefined ? 'tok-1' : settings.token } },
    querySelector(selector) {
      if (selector === '#movie_player') return settings.noPlayer ? null : player;
      if (selector === 'video') return video;
      return null;
    },
  };

  const sandbox = {
    window: win,
    document,
    location: { href: 'https://music.youtube.com/watch?v=song-a' },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pageHookSource, sandbox, { filename: 'page-hook.js' });

  return {
    player,
    video,
    attach(session, attached) {
      for (const fn of listeners.get('message') || []) {
        fn({
          source: win,
          data: { __slra: true, type: 'SLRA_ATTACH_STATE', token: 'tok-1', session, attached },
        });
      }
    },
    replies() {
      return posted.filter((message) => message && message.type === 'SLRA_VOLUME_STATE');
    },
    fire(data) {
      for (const fn of listeners.get('message') || []) fn({ source: win, data });
    },
  };
}

function createBackgroundSandbox() {
  const handlers = [];
  const storageData = {};
  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          handlers.push(fn);
        },
      },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      getURL: (value) => String(value),
    },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      onReplaced: { addListener() {} },
      query: async () => [],
      get: async () => null,
      sendMessage: async () => ({ ok: true }),
    },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        async get(key) {
          const out = {};
          out[key] = storageData[key];
          return out;
        },
        async set(items) {
          Object.assign(storageData, items);
        },
      },
      session: { async get() { return {}; }, async set() {} },
      onChanged: { addListener() {} },
    },
  };

  let context = null;
  const sandbox = {
    chrome,
    console,
    URL,
    importScripts(...files) {
      for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
      }
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  return {
    sections() {
      const value = storageData.playerActions;
      return value && Array.isArray(value.sections) ? value.sections : [];
    },
    send(message) {
      return new Promise((resolve) => {
        for (const fn of handlers) fn(message, {}, resolve);
      });
    },
  };
}

test('background: two overlapping section saves both survive the queue', async () => {
  const app = createBackgroundSandbox();
  const [first, second] = await Promise.all([
    app.send({ type: 'SAVE_PLAYER_SECTION', entry: { videoId: 'song-a', startSeconds: 10, endSeconds: null } }),
    app.send({ type: 'SAVE_PLAYER_SECTION', entry: { videoId: 'song-b', startSeconds: 20, endSeconds: 30 } }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(
    Array.from(app.sections(), (item) => item.videoId).sort(),
    ['song-a', 'song-b'],
  );
  assert.equal(second.sections.length, 2);
});

test('background: a both-null entry removes the song and a malformed entry is refused', async () => {
  const app = createBackgroundSandbox();
  await app.send({ type: 'SAVE_PLAYER_SECTION', entry: { videoId: 'song-a', startSeconds: 10, endSeconds: null } });
  const removed = await app.send({ type: 'SAVE_PLAYER_SECTION', entry: { videoId: 'song-a', startSeconds: null, endSeconds: null } });
  assert.equal(removed.ok, true);
  assert.equal(removed.sections.length, 0);

  const refused = await app.send({ type: 'SAVE_PLAYER_SECTION', entry: { videoId: '', startSeconds: 1, endSeconds: 2 } });
  assert.equal(refused.ok, false);
});

test('page-hook: SLRA_SET_VOLUME applies the percent and re-asserts the mute contract', () => {
  const hook = createPageHookSandbox();
  hook.attach('sess-1', true);
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 7, token: 'tok-1', session: 'sess-1', percent: 65, keepMuted: true });

  assert.deepEqual(hook.player.setVolumeCalls, [65]);
  assert.equal(hook.player.volume, 65);
  assert.equal(hook.video.muted, true);
  const [reply] = hook.replies();
  assert.equal(reply.id, 7);
  assert.equal(reply.token, 'tok-1');
  assert.equal(reply.volume, 65);
  assert.equal(reply.applied, true);
  assert.equal(reply.source, 'player');
});

test('page-hook: SLRA_GET_VOLUME reports the live player volume without writing', () => {
  const hook = createPageHookSandbox({ volume: 33 });
  hook.fire({ __slra: true, type: 'SLRA_GET_VOLUME', id: 3, token: 'tok-1' });
  assert.deepEqual(hook.player.setVolumeCalls, []);
  const [reply] = hook.replies();
  assert.equal(reply.id, 3);
  assert.equal(reply.volume, 33);
  assert.equal(reply.applied, true);
  assert.equal(reply.source, 'player');
});

test('page-hook: a volume request with the wrong token is ignored', () => {
  const hook = createPageHookSandbox();
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 9, token: 'stale', percent: 80, keepMuted: true });
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 10, percent: 80, keepMuted: true });
  assert.deepEqual(hook.player.setVolumeCalls, []);
  assert.equal(hook.replies().length, 0);
  assert.equal(hook.video.muted, false);
});

test('page-hook: attach state - a set followed by a detach ends unmuted', () => {
  const hook = createPageHookSandbox();
  hook.attach('sess-1', true);
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 21, token: 'tok-1', session: 'sess-1', percent: 70, keepMuted: true });
  assert.equal(hook.video.muted, true);

  // Teardown posts the detach after the (already queued) set.
  hook.attach('sess-1', false);
  assert.equal(hook.video.muted, false);
});

test('page-hook: attach state - a detach before a queued set skips the mute', () => {
  const hook = createPageHookSandbox();
  hook.attach('sess-1', true);
  hook.attach('sess-1', false);
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 22, token: 'tok-1', session: 'sess-1', percent: 70, keepMuted: true });

  // The write still lands; the mute must not.
  assert.deepEqual(hook.player.setVolumeCalls, [70]);
  assert.equal(hook.video.muted, false);
});

test('page-hook: attach state - a set from an older session never re-mutes', () => {
  const hook = createPageHookSandbox();
  hook.attach('sess-old', true);
  hook.attach('sess-new', false);
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 23, token: 'tok-1', session: 'sess-old', percent: 90, keepMuted: true });
  assert.equal(hook.video.muted, false);
});

test('page-hook: attach state - a detach never unmutes a video we did not mute', () => {
  const hook = createPageHookSandbox();
  hook.video.muted = true;
  hook.attach('sess-1', false);
  assert.equal(hook.video.muted, true);
});

test('page-hook: a missing player API replies source none and still keeps the element muted', () => {
  const hook = createPageHookSandbox({ noPlayer: true });
  hook.attach('sess-1', true);
  hook.fire({ __slra: true, type: 'SLRA_SET_VOLUME', id: 11, token: 'tok-1', session: 'sess-1', percent: 80, keepMuted: true });
  const [reply] = hook.replies();
  assert.equal(reply.id, 11);
  assert.equal(reply.applied, false);
  assert.equal(reply.source, 'none');
  assert.equal(reply.volume, null);
  assert.equal(hook.video.muted, true);
});
