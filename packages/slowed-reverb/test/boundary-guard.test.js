'use strict';

/* global require, __dirname, setImmediate */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const actions = require(path.join(__dirname, '..', 'player-actions.js'));

const HOST_ATTR = 'data-slra-player-actions';
const TO_END = { videoId: 'song-a', startSeconds: 30, endSeconds: null };
const DURATION = 300;

function songUrl(id) {
  return 'https://music.youtube.com/watch?v=' + id;
}

function createElement(tagName) {
  const listeners = new Map();
  return {
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
    duration: DURATION,
    paused: false,
    seeking: false,
    muted: true,
    volume: 50 * actions.YTM_ELEMENT_PER_PLAYER,
    currentSrc: '',
    playCalls: 0,
    playbackRate: 1,
    classList: {
      names: new Set(),
      add() {},
      remove() {},
      contains() { return false; },
      toggle() { return false; },
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
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    removeAttribute(name) { this.attributes.delete(name); },
    hasAttribute(name) { return this.attributes.has(name); },
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
        type,
        target: this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
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
    contains(node) { return node === this; },
  };
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

  const document = {
    documentElement,
    body,
    defaultView: null,
    visibilityState: 'visible',
    createElement: (tagName) => createElement(tagName),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };

  const win = {
    document,
    location: { href: songUrl('song-a') },
    innerHeight: 800,
    getComputedStyle: (node) => ({
      overflowY: (node && node.computedOverflow) || 'visible',
      visibility: (node && node.computedVisibility) || 'visible',
      display: (node && node.computedDisplay) || 'block',
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = win;

  function makeMedia(videoId) {
    const media = createElement('video');
    media.currentSrc = 'https://music.youtube.com/stream/' + videoId;
    media.duration = DURATION;
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
    const host = documentElement.children.find((child) => child.hasAttribute(HOST_ATTR));
    if (!host || !host.shadowRoot) return null;
    return walk(host.shadowRoot).find((node) => node.getAttribute('aria-label') === label) || null;
  }

  return { win, document, documentElement, makeMedia, panel };
}

function createTimers() {
  let nextId = 1;
  const intervals = new Map();
  return {
    setTimeout() { return nextId++; },
    clearTimeout() {},
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    intervalDelays() { return [...intervals.values()].map((timer) => timer.ms); },
    tickIntervals() { for (const timer of [...intervals.values()]) timer.fn(); },
  };
}

function createStorage(sections) {
  const data = { playerActions: { sections } };
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(items) { Object.assign(data, items); },
    subscribe() { return () => {}; },
  };
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function createHarness(sections) {
  const dom = createDom();
  const timers = createTimers();
  let media = dom.makeMedia('song-a');
  const controller = actions.createPlayerActions({
    window: dom.win,
    document: dom.document,
    mediaProvider: () => media,
    pageHook: {
      setVolume: async (percent) => ({ volume: percent, applied: true, source: 'player' }),
      syncVolumeUi() {},
    },
    storage: createStorage(sections || [TO_END]),
    timers,
    now: () => 1000,
  });
  return {
    controller,
    dom,
    timers,
    media: () => media,
    setMedia(next) { media = next; },
    setHref(href) { dom.win.location.href = href; },
    pushSong(id, href) { controller.setSongId(id, href || songUrl(id)); },
    backstop() { return timers.intervalDelays().includes(actions.TICK_MS); },
    panel(label) { return dom.panel(label); },
    fromValue() { const node = dom.panel('From'); return node ? node.value : ''; },
    status() { const node = dom.panel('Section status'); return node ? node.textContent : ''; },
    async start() { await controller.start(); await settle(); },
  };
}

// The fake element records playbackRate but never advances currentTime on a
// clock. A "modeled accelerated boundary" below is a media-time position
// near the end (DURATION - 0.25 s), not simulated 1.3x wall-clock playback.
// The numeric proof at the end models rate 1.3 arithmetically only.
async function armedAtBoundary(rate, sections) {
  const harness = createHarness(sections);
  await harness.start();
  harness.pushSong('song-a');
  await settle();
  const media = harness.media();
  media.playbackRate = rate === undefined ? 1.3 : rate;
  assert.equal(media.currentTime, TO_END.startSeconds, 'precondition: restored and armed at the section start');
  assert.equal(harness.backstop(), true, 'precondition: the loop backstop runs');
  media.currentTime = DURATION - 0.25;
  return harness;
}

// The early push is the page hook reporting the queued next id on
// videodatachange/loadedmetadata before the current media has ended. YTM has
// already moved the watch URL, and the content script forwards the pushed id
// and href to setSongId.
function pushEarlyNext(harness) {
  harness.setHref(songUrl('song-b'));
  harness.pushSong('song-b');
}

test('boundary: early next-song push at modeled accelerated boundary holds an armed section', async () => {
  const harness = await armedAtBoundary();

  pushEarlyNext(harness);
  await settle();

  assert.equal(harness.fromValue(), '0:30', 'the points survive the early push');
  assert.equal(harness.backstop(), true, 'the backstop is still armed');
  harness.media().dispatchEvent('timeupdate');
  assert.equal(harness.media().currentTime, TO_END.startSeconds, 'the armed section still owns the media');
});

test('boundary: ended restarts the current track after an early next-song push', async () => {
  const harness = await armedAtBoundary();
  const media = harness.media();

  pushEarlyNext(harness);
  await settle();
  media.currentTime = DURATION;
  media.dispatchEvent('ended');

  assert.equal(media.currentTime, TO_END.startSeconds, 'ended restarts the armed section, not the next song');
  assert.ok(media.playCalls >= 1, 'playback resumes on the current track');
});

test('boundary: a media-time sample inside the 0.3s lead still loops', async () => {
  const harness = await armedAtBoundary();
  const media = harness.media();

  pushEarlyNext(harness);
  await settle();
  media.currentTime = DURATION - 0.22;
  media.dispatchEvent('timeupdate');

  assert.equal(media.currentTime, TO_END.startSeconds, 'progress snaps back before the media ends');
});

test('boundary: a genuine media switch and confirmed push adopt the next id', async () => {
  const harness = await armedAtBoundary();

  pushEarlyNext(harness);
  await settle();
  assert.equal(harness.fromValue(), '0:30', 'the early push is held');

  const replacement = harness.dom.makeMedia('song-b');
  harness.setMedia(replacement);
  harness.controller.sync();
  replacement.currentTime = 0;
  replacement.dispatchEvent('loadedmetadata');
  harness.pushSong('song-b');
  await settle();

  assert.equal(harness.status(), 'Set From or To', 'the genuine switch drops the held section');
  assert.equal(harness.backstop(), false, 'no loop runs on the new track');
});

test('boundary: repeat-off in the boundary window is not swallowed', async () => {
  const harness = createHarness();
  await harness.start();
  harness.pushSong('song-a');
  await settle();
  harness.panel('Repeat').checked = false;
  harness.panel('Repeat').dispatchEvent('change');
  const media = harness.media();
  media.playbackRate = 1.3;
  media.currentTime = DURATION - 0.25;

  pushEarlyNext(harness);
  await settle();

  assert.equal(harness.status(), 'Repeat off', 'repeat-off keeps its state and advances with the push');
  assert.equal(media.currentTime, DURATION - 0.25, 'no seek without an armed section');
});

test('scope: native repeat-one is external; the custom section owns the loop', async () => {
  const harness = await armedAtBoundary();
  assert.equal(harness.panel('Repeat').checked, true, 'the extension control is its own Repeat flag');

  harness.panel('Repeat').checked = false;
  harness.panel('Repeat').dispatchEvent('change');
  assert.equal(harness.backstop(), false, 'only the custom section control can release the loop');
});


test('boundary: an explicit-end section holds at the modeled accelerated boundary', async () => {
  const section = { videoId: 'song-a', startSeconds: 30, endSeconds: 60 };
  const harness = await armedAtBoundary(1.3, [section]);
  const media = harness.media();
  media.currentTime = 59.98;

  pushEarlyNext(harness);
  await settle();
  media.dispatchEvent('timeupdate');

  assert.equal(media.currentTime, 30, 'the explicit-end section loops instead of adopting the queued id');
  assert.equal(harness.fromValue(), '0:30', 'its points are intact');
});

test('boundary: turning repeat off at the boundary advances once on ended', async () => {
  const harness = await armedAtBoundary();
  const media = harness.media();

  pushEarlyNext(harness);
  await settle();
  harness.panel('Repeat').checked = false;
  harness.panel('Repeat').dispatchEvent('change');
  media.currentTime = DURATION;
  media.dispatchEvent('ended');

  assert.equal(harness.status(), 'Repeat off', 'repeat-off state is preserved');
  assert.equal(harness.fromValue(), '', 'the held next id is adopted once and its points are dropped');
  assert.equal(harness.backstop(), false, 'no loop remains');
});

test('ordering: page-hook force-pushes the queued id on videodatachange before media ends', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'page-hook.js'), 'utf8');
  const posted = [];
  const docListeners = new Map();
  let currentId = 'song-a';
  const player = {
    getVideoData: () => ({ video_id: currentId, title: '' }),
    getVolume: () => 50,
    setVolume() {},
  };
  const win = {
    addEventListener() {},
    postMessage(message) { posted.push(message); },
  };
  const document = {
    documentElement: { dataset: { slraToken: 'tok' } },
    addEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener() {},
    querySelector(selector) { return selector === '#movie_player' ? player : null; },
  };
  const sandbox = {
    window: win,
    document,
    location: { href: songUrl('song-a') },
    console,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'page-hook.js' });

  const songs = () => posted.filter((message) => message && message.type === 'SLRA_SONG');
  assert.equal(songs()[songs().length - 1].videoId, 'song-a', 'install push is the current song');

  currentId = 'song-b';
  for (const fn of docListeners.get('videodatachange') || []) fn({});

  assert.equal(
    songs()[songs().length - 1].videoId,
    'song-b',
    'the queued id is force-pushed before the current media ends',
  );
});


test('handoff: suspendSongIdentity releases a held push on a new-media source signal', async () => {
  const harness = await armedAtBoundary();

  pushEarlyNext(harness);
  await settle();
  assert.equal(harness.fromValue(), '0:30', 'precondition: the early push is held');

  // This is the exact call content-script.js makes on loadedmetadata/emptied
  // before it asks the page for the new id.
  harness.controller.suspendSongIdentity();
  harness.controller.sync();
  assert.equal(harness.fromValue(), '', 'the suspend handoff alone releases the held id');

  const replacement = harness.dom.makeMedia('song-b');
  harness.setMedia(replacement);
  harness.controller.sync();
  replacement.currentTime = 0;
  replacement.dispatchEvent('emptied');
  replacement.dispatchEvent('loadedmetadata');
  harness.pushSong('song-b');
  await settle();

  assert.equal(harness.status(), 'Set From or To', 'the confirmed next id is adopted');
  assert.equal(harness.backstop(), false, 'no loop runs on the new track');
});

test('transport: user Next at the held boundary works on a same-node source signal', async () => {
  const harness = await armedAtBoundary();
  const media = harness.media();

  pushEarlyNext(harness);
  await settle();
  assert.equal(harness.fromValue(), '0:30', 'precondition: the early push is held');

  // YTM reuses the same element for the next track. No media replacement.
  media.currentSrc = songUrl('song-b');
  media.currentTime = 0;
  harness.controller.suspendSongIdentity();
  harness.controller.sync();
  assert.equal(harness.fromValue(), '', 'the suspend handoff alone releases the held id');
  media.dispatchEvent('emptied');
  media.dispatchEvent('loadedmetadata');
  harness.pushSong('song-b');
  await settle();

  assert.equal(harness.status(), 'Set From or To', 'the next track is adopted');
  assert.equal(harness.backstop(), false, 'A\'s loop is dropped');
  assert.equal(harness.fromValue(), '', 'A\'s points are dropped');
});

test('transport: user Previous at the held boundary restores its own section', async () => {
  const prev = { videoId: 'song-prev', startSeconds: 120, endSeconds: null };
  const harness = await armedAtBoundary(undefined, [TO_END, prev]);
  const media = harness.media();

  pushEarlyNext(harness);
  await settle();
  assert.equal(harness.fromValue(), '0:30', 'precondition: the early push is held');

  media.currentSrc = songUrl('song-prev');
  media.currentTime = 0;
  harness.controller.suspendSongIdentity();
  media.dispatchEvent('emptied');
  media.dispatchEvent('loadedmetadata');
  harness.setHref(songUrl('song-prev'));
  harness.pushSong('song-prev');
  await settle();

  assert.equal(media.currentTime, 120, 'the previous track restores its own start');
  assert.equal(harness.fromValue(), '2:00', 'its own points are shown');
});

test('numeric: arithmetic 250ms progress at 1.3x can skip the 0.3s lead; ended covers it', () => {
  const state = { active: true, startSeconds: 30, endSeconds: null };
  const rate = 1.3;
  const step = 0.25 * rate;
  const lead = 0.3;

  let sample = DURATION - 0.31;
  let landedInLead = false;
  while (sample < DURATION) {
    if (sample >= DURATION - lead) landedInLead = true;
    sample += step;
  }
  assert.equal(step > lead, true, 'media-time step exceeds the lead, so a phase with no sample exists');
  assert.equal(landedInLead, false, 'this phase never samples the lead window');
  assert.equal(
    actions.resolveSeekTarget(state, { currentTime: DURATION - 0.35, duration: DURATION, paused: false, seeking: false }),
    null,
    'progress alone would miss this phase',
  );
  assert.equal(actions.resolveEndSeekTarget(state, DURATION), 30, 'ended still has an authoritative seek target');
});
