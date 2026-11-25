'use strict';

/* global require, __dirname, setImmediate */


const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const actions = require(path.join(__dirname, '..', 'player-actions.js'));

const HOST_ATTR = 'data-slra-player-actions';
const SECTION = { videoId: 'song-a', startSeconds: 30, endSeconds: 60 };


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
  let media = settings.startWithoutMedia ? null : settings.media || dom.makeMedia('song-a');
  let clock = 1000;

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
    advance(ms) {
      clock += ms;
    },
    setHref(href) {
      dom.win.location.href = href;
    },
    pushSong(id, href) {
      controller.setSongId(id, href);
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


test('latch: a saved section returns to its start on the first, second and third pass', async () => {
  const harness = await armed();
  const media = harness.media();
  assert.equal(media.currentTime, SECTION.startSeconds, 'restored and armed at the section start');

  assert.equal(tickPass(harness), SECTION.startSeconds);

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

  harness.pushSong(null);
  assert.equal(harness.fromValue(), '0:30', 'the points survive the blip');
  assert.equal(harness.backstop(), true, 'the backstop is not torn down by one transient signal');

  media.currentTime = SECTION.endSeconds;
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds);
  assert.equal(timeupdatePass(harness), SECTION.endSeconds);

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



const SONG_B = { videoId: 'song-b', startSeconds: 10, endSeconds: 20 };

function songUrl(id) {
  return 'https://music.youtube.com/watch?v=' + id;
}

test('isolation: a missed song push must not run A\'s section on B', async () => {
  const harness = await armed();
  const media = harness.media();
  harness.pushSong('song-a');
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A is armed at its own start');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();

  assert.equal(harness.fromValue(), '', 'B must not carry A\'s From');
  assert.equal(harness.status(), 'Set From or To', 'B must not show A\'s armed range');
  assert.equal(harness.backstop(), false, 'B must not inherit A\'s loop');

  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds, 'A\'s section must not seek B');
});

test('isolation: returning to A restores only A\'s own section', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a');
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A armed');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  media.currentTime = 0;
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B restores its own saved start');
  assert.equal(harness.fromValue(), '0:10', 'B shows its own From');
  assert.equal(harness.status(), '0:10 → 0:20', 'B shows its own range');

  media.currentTime = SONG_B.endSeconds;
  media.dispatchEvent('timeupdate');
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B loops its own section');

  harness.setHref(songUrl('song-a'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'A comes back at A\'s own start');
  assert.equal(harness.fromValue(), '0:30', 'A shows A\'s own From');
  assert.equal(harness.status(), '0:30 → 1:00', 'A shows A\'s own range');
});

test('isolation: a pushed id still wins when the URL names no song', async () => {
  const harness = createHarness({ storage: createStorage([SECTION]) });
  harness.setHref('https://music.youtube.com/');
  await harness.start();
  harness.pushSong('song-a');
  await settle();

  const media = harness.media();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the pushed id still restores its section');
  assert.equal(harness.fromValue(), '0:30');
});



test('identity: a replayed stale push cannot re-anchor on the new URL', async () => {
  const first = createHarness({ storage: createStorage([SECTION]) });
  await first.start();
  first.pushSong('song-a', songUrl('song-a'));
  await settle();
  assert.equal(first.media().currentTime, SECTION.startSeconds, 'precondition: A restored');

  const second = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  second.setHref(songUrl('song-b'));
  await second.start();
  second.pushSong('song-a', songUrl('song-a'));
  await settle();

  const media = second.media();
  assert.equal(second.status(), '0:10 → 0:20', 'B must not adopt the replayed A');
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  second.timers.tickIntervals();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B loops its own start, never A\'s');
});

test('ordering: a URL that moves before the player must not seek the outgoing song', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A is playing inside its section');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the outgoing A must not jump to B\'s saved start');
  assert.equal(harness.status(), 'Set From or To', 'A\'s section stops immediately');

  media.currentTime = 0;
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B restores once its source is confirmed');
});

test('ordering: a push for the new song restores it while the URL is still old', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();

  harness.pushSong('song-b', songUrl('song-a'));
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B restores on its push, before the URL moves');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'the catch-up URL changes nothing');
  assert.equal(harness.status(), '0:10 → 0:20', 'B keeps its own section');
});

test('identity: a push for the URL-adopted song confirms the visit', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A is restored and armed');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'B waits without a vouch');

  harness.pushSong('song-b', songUrl('song-b'));
  await settle();
  harness.timers.tickIntervals();
  media.dispatchEvent('timeupdate');
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'the push vouches B and restores its own section');
  assert.equal(harness.status(), '0:10 → 0:20', 'B stays armed at its own range');
});

test('identity: a deferred restore does not seek while the read is in flight; the answer releases it', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A is restored and armed');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'B waits for a vouch');

  harness.controller.suspendSongIdentity();
  media.currentTime = 0;
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, 0, 'nothing may seek while the identity read is in flight');

  harness.pushSong('song-b', songUrl('song-b'));
  await settle();
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'the answer releases the deferred restore');
  assert.equal(harness.status(), '0:10 → 0:20', 'B is armed at its own range');
});

test('identity: a pushed null defers, a late push still restores', async () => {
  const harness = createHarness({ storage: createStorage([SONG_B]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong(null, songUrl('song-a'));
  await settle();
  assert.equal(harness.status(), 'Play a track to repeat', 'a pushed null means no identity');

  media.currentTime = 25;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, 25, 'no identity means no seek');

  harness.setHref(songUrl('song-b'));
  harness.pushSong('song-b', songUrl('song-b'));
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'the late push restores its own song');
});

const SONG_C = { videoId: 'song-c', startSeconds: 40, endSeconds: 50 };

test('identity: a same-id push taken on the new URL cannot re-anchor', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A armed');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(harness.status(), 'Set From or To', 'B is not armed from an unconfirmed URL');

  harness.pushSong('song-a', songUrl('song-b'));
  await settle();
  assert.notEqual(harness.status(), '0:30 → 1:00', 'the stale id must not be re-anchored to B');
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds, 'A section must not seek B');

  media.currentTime = 0;
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B restores its own section');
});

test('identity: leaving a watch page for a v-less URL drops the old identity', async () => {
  const harness = createHarness({ storage: createStorage([SECTION]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A armed');

  harness.setHref('https://music.youtube.com/');
  harness.timers.tickIntervals();
  await settle();
  assert.equal(harness.status(), 'Play a track to repeat', 'Home must not inherit the watch page identity');
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds, 'no seek after leaving the watch page');
});

test('identity: an element that appears mid-stream unconfirmed is not seeked', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]), startWithoutMedia: true });
  await harness.start();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();

  harness.setHref(songUrl('song-b'));
  harness.controller.sync();
  await settle();

  const media = harness.dom.makeMedia('song-b', { currentTime: 45 });
  harness.setMedia(media);
  harness.controller.sync();
  await settle();
  media.dispatchEvent('timeupdate');
  assert.equal(media.currentTime, 45, 'an unconfirmed identity must not seek a mid-stream element');

  media.currentTime = 0;
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B restores once its own source loads');
});

test('identity: returning to the same song after a v-less page rearms it', async () => {
  const harness = createHarness({ storage: createStorage([SECTION]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A armed');

  harness.setHref('https://music.youtube.com/');
  harness.timers.tickIntervals();
  await settle();
  assert.equal(harness.status(), 'Play a track to repeat', 'the visit is lost on a v-less page');

  harness.setHref(songUrl('song-a'));
  harness.controller.sync();
  await settle();
  assert.equal(harness.status(), '0:30 → 1:00', 'the return adopts the song again');
  assert.equal(harness.backstop(), true, 'and the latch is running');
});

test('identity: a URL-sourced adoption after invalidation is not a virgin visit', async () => {
  const harness = createHarness({ storage: createStorage([SECTION]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A armed at its own start');

  harness.controller.invalidateSongIdentity();
  await settle();

  media.currentTime = 45;
  harness.controller.sync();
  await settle();
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, 45, 'a post-invalidation URL adoption must not seek');
});

test('identity: a read in flight suspends the armed section', async () => {
  const harness = createHarness({ storage: createStorage([SECTION]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();

  harness.controller.suspendSongIdentity();
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds, 'no seek while the id is being re-read');

  harness.controller.setSongId('song-a', songUrl('song-a'));
  await settle();
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  assert.equal(media.currentTime, SECTION.startSeconds, 'the latch works again after the answer');
});

test('identity: an unreadable source change clears Home and a later read rearms', async () => {
  const harness = createHarness({ storage: createStorage([SECTION]) });
  harness.setHref('https://music.youtube.com/');
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', 'https://music.youtube.com/');
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A armed on Home');

  harness.controller.invalidateSongIdentity();
  await settle();
  assert.equal(harness.status(), 'Play a track to repeat', 'the visit is dropped');
  assert.equal(harness.backstop(), false, 'nothing is armed');
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds, 'the stale section cannot seek');

  media.currentTime = 0;
  harness.pushSong('song-a', 'https://music.youtube.com/');
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the same id adopts again');
});

test('identity: a push after the restore deadline restores', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A is restored and armed');

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'B waits while A holds the element');

  harness.advance(3100);
  harness.timers.tickIntervals();
  await settle();
  assert.equal(harness.backstop(), false, 'the deadline still ends the retry');

  media.currentTime = 0;
  harness.pushSong('song-b', songUrl('song-b'));
  await settle();
  harness.timers.tickIntervals();
  media.dispatchEvent('timeupdate');
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'a late confirming push restores B');
  assert.equal(harness.status(), '0:10 → 0:20', 'B holds its own range');
});

test('identity: a restore that cannot confirm stops the backstop at its deadline', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]), startWithoutMedia: true });
  await harness.start();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();
  harness.setHref(songUrl('song-b'));
  harness.controller.sync();
  await settle();
  assert.equal(harness.backstop(), true, 'the deferred restore keeps a bounded backstop');

  harness.advance(3100);
  harness.timers.tickIntervals();
  await settle();
  assert.equal(harness.backstop(), false, 'after the deadline nothing keeps retrying');
});

test('identity: each deferred song gets its own restore window', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B, SONG_C]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  harness.advance(2900);
  harness.setHref(songUrl('song-c'));
  harness.timers.tickIntervals();
  await settle();
  harness.advance(200);
  harness.timers.tickIntervals();
  await settle();

  media.currentTime = 0;
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_C.startSeconds, 'C keeps its own window and restores');
  assert.equal(harness.status(), '0:40 → 0:50', 'C holds its own section');
});

test('identity: a deferred restore applies when the element returns to its top', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();

  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'deferred while A still holds the element');

  media.currentTime = 0;
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'the reset position releases the restore');
});

test('identity: a URL-only song never seeks without a confirmation (fail closed)', async () => {
  const harness = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  await harness.start();
  const media = harness.media();
  harness.pushSong('song-a', songUrl('song-a'));
  await settle();

  harness.setHref(songUrl('song-b'));
  for (let i = 0; i < 4; i++) {
    harness.timers.tickIntervals();
    media.dispatchEvent('timeupdate');
    await settle();
  }
  assert.equal(media.currentTime, SECTION.startSeconds, 'unconfirmed identity never seeks');
});

function volumeReadout(harness) {
  const host = harness.dom.documentElement.children.find((child) => child.hasAttribute(HOST_ATTR));
  if (!host || !host.shadowRoot) return null;
  const stack = [host.shadowRoot];
  while (stack.length > 0) {
    const node = stack.pop();
    if (String(node.className || '').split(/\s+/).includes('slra-volume')) return node.textContent;
    for (const child of node.children || []) stack.push(child);
  }
  return null;
}

test('repeat/HUD: a native volume push repaints the readout and leaves the section armed', async () => {
  const harness = await armed();
  const media = harness.media();
  harness.pushSong('song-a');
  await settle();
  assert.equal(volumeReadout(harness), '50%', 'precondition: the readout shows the page volume');

  harness.controller.setPlayerVolume(65);
  await settle();

  assert.equal(volumeReadout(harness), '65%', 'the readout follows the push');
  assert.equal(harness.status(), '0:30 → 1:00', 'the section copy is untouched');
  assert.equal(media.currentTime, SECTION.startSeconds, 'the push did not move playback');
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  assert.equal(media.currentTime, SECTION.startSeconds, 'the section still loops after the push');
});

test('rate: the loop latches above 1x, including a sample that jumps the end', async () => {
  const harness = await armed();
  const media = harness.media();
  media.playbackRate = 1.3;

  media.currentTime = SECTION.endSeconds + 0.22;
  media.dispatchEvent('timeupdate');
  assert.equal(media.currentTime, SECTION.startSeconds, 'a jumped end still snaps back');

  media.currentTime = SECTION.endSeconds + 0.22;
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the backstop loops at 1.3x too');
  assert.equal(media.playbackRate, 1.3, 'looping never rewrites the rate');
});

test('rate: a section that runs to the song end loops at 1.3x', async () => {
  const harness = createHarness({
    storage: createStorage([{ videoId: 'song-a', startSeconds: 30, endSeconds: null }]),
  });
  await harness.start();
  const media = harness.media();
  media.playbackRate = 1.3;
  media.duration = 300;

  media.currentTime = 299.75;
  media.dispatchEvent('timeupdate');
  assert.equal(media.currentTime, 30, 'the song-end threshold fires before the end');

  media.currentTime = 300;
  media.dispatchEvent('ended');
  assert.equal(media.currentTime, 30, 'ended restarts the armed section');
  assert.ok(media.playCalls >= 1, 'and resumes playback');
});


/** Records extension writes with the source and elapsed time at write time. */
function recordSeeks(media) {
  const writes = [];
  let elapsed = media.currentTime;
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get() { return elapsed; },
    set(next) { writes.push({ from: elapsed, to: next, src: media.currentSrc }); elapsed = next; },
  });
  media.__setTime = (next) => { elapsed = next; };
  return writes;
}

test('identity: a v-less Home push never seeks an unconfirmed source', async () => {
  const home = 'https://music.youtube.com/';
  const incoming = { videoId: 'song-b', startSeconds: 30, endSeconds: 60 };
  const harness = createHarness({ storage: createStorage([incoming]) });
  harness.setHref(home);
  const media = harness.media();
  const writes = recordSeeks(media);
  harness.pushSong('song-a', home);
  await harness.start();

  media.currentSrc = 'https://music.youtube.com/stream/song-a';
  media.__setTime(0.2);
  writes.length = 0;

  harness.pushSong('song-b', home);       // metadata leads the source on Home
  harness.timers.tickIntervals();

  assert.equal(writes.some((w) => w.from === 0.2), false,
    'the outgoing element at 0.2 s is never seeked');
  assert.equal(media.currentTime, 0.2, 'the outgoing element keeps its own elapsed time');

  media.currentSrc = 'https://music.youtube.com/stream/song-b';
  media.__setTime(0);
  media.dispatchEvent('loadedmetadata');  // the genuine source finally arrives
  harness.pushSong('song-b', home);
  harness.timers.tickIntervals();

  assert.equal(writes.some((w) => w.to === 30), false,
    'an ambiguous v-less push never auto-restores the incoming section');
});


test('identity: a v-less Home push skips restore until a watch URL confirms', async () => {
  const home = 'https://music.youtube.com/';
  const watchB = 'https://music.youtube.com/watch?v=song-b';
  const incoming = { videoId: 'song-b', startSeconds: 30, endSeconds: 60 };
  const srcA = 'https://music.youtube.com/stream/song-a';
  const srcB = 'https://music.youtube.com/stream/song-b';
  const seeks = (writes) => writes.filter((w) => w.to === 30);

  // 1. The source arrives before the pushed id. The restore is still skipped.
  const early = createHarness({ storage: createStorage([incoming]) });
  early.setHref(home);
  const first = early.media();
  const firstWrites = recordSeeks(first);
  early.pushSong('song-a', home);
  await early.start();
  first.currentSrc = srcB;
  first.__setTime(0);
  first.dispatchEvent('loadedmetadata');
  firstWrites.length = 0;
  early.pushSong('song-b', home);
  early.timers.tickIntervals();
  assert.deepEqual(seeks(firstWrites), [],
    'an ambiguous v-less push skips the automatic restore');

  // 2. Unrelated metadata on the outgoing source, including emptied, must not seek.
  const held = createHarness({ storage: createStorage([incoming]) });
  held.setHref(home);
  const outgoing = held.media();
  const heldWrites = recordSeeks(outgoing);
  held.pushSong('song-a', home);
  await held.start();
  outgoing.currentSrc = srcA;
  outgoing.__setTime(0.2);
  heldWrites.length = 0;
  held.pushSong('song-b', home);
  held.timers.tickIntervals();
  outgoing.dispatchEvent('emptied');
  outgoing.dispatchEvent('loadedmetadata');
  held.timers.tickIntervals();
  assert.deepEqual(seeks(heldWrites), [],
    'same-source emptied and metadata never approve a seek');

  // 3. The same key corroborated by a watch URL releases without a metadata event.
  const watched = createHarness({ storage: createStorage([incoming]) });
  watched.setHref(home);
  const watchedMedia = watched.media();
  const watchedWrites = recordSeeks(watchedMedia);
  watched.pushSong('song-a', home);
  await watched.start();
  watchedMedia.currentSrc = srcA;
  watchedMedia.__setTime(0.2);
  watchedWrites.length = 0;
  watched.pushSong('song-b', home);
  watched.timers.tickIntervals();
  assert.deepEqual(seeks(watchedWrites), [], 'precondition: the wait holds');
  watchedMedia.currentSrc = srcB;
  watchedMedia.__setTime(0);
  watched.setHref(watchB);
  watched.pushSong('song-b', watchB);
  watched.timers.tickIntervals();
  assert.deepEqual(seeks(watchedWrites), [{ from: 0, to: 30, src: srcB }],
    'corroboration with the observed source releases the wait');
});


test('identity: consecutive push-first handoffs never seek the outgoing source', async () => {
  const home = 'https://music.youtube.com/';
  const savedB = { videoId: 'song-b', startSeconds: 30, endSeconds: 60 };
  const srcA = 'https://music.youtube.com/stream/song-a';
  const srcB = 'https://music.youtube.com/stream/song-b';
  const seeks = (writes, to) => writes.filter((w) => w.to === to);

  async function handoff(sections) {
    const harness = createHarness({ storage: createStorage(sections) });
    harness.setHref(home);
    const media = harness.media();
    const writes = recordSeeks(media);
    harness.pushSong('song-a', home);
    await harness.start();
    media.currentSrc = srcA;
    media.__setTime(0.2);
    writes.length = 0;

    harness.pushSong('song-b', home);   // A to B, source still A
    harness.timers.tickIntervals();
    assert.deepEqual(seeks(writes, 30), [], 'precondition: B waits for its own source');

    media.currentSrc = srcB;
    media.__setTime(0);
    media.dispatchEvent('loadedmetadata');
    writes.length = 0;

    harness.pushSong('song-c', home);   // B to C, source still B
    harness.timers.tickIntervals();
    return writes;
  }

  const bothSaved = await handoff([savedB, SONG_C]);
  assert.deepEqual(seeks(bothSaved, 40), [],
    'C must not seek into the outgoing B source');

  const cOnly = await handoff([SONG_C]);
  assert.deepEqual(seeks(cOnly, 40), [],
    'a saved-section-free B still binds its source before C is pushed');
});


test('identity: an unknown outgoing source never approves a v-less transition', async () => {
  const home = 'https://music.youtube.com/';
  const srcA = 'https://music.youtube.com/stream/song-a';
  const savedB = { videoId: 'song-b', startSeconds: 30, endSeconds: 60 };

  const unknown = createHarness({ storage: createStorage([savedB, SONG_C]), startWithoutMedia: true });
  unknown.setHref(home);
  await unknown.start();
  unknown.pushSong('song-a', home);           // adopted with no media at all
  await settle();
  const lateMedia = unknown.dom.makeMedia('song-a');
  unknown.setMedia(lateMedia);
  unknown.controller.sync();
  const lateWrites = recordSeeks(lateMedia);
  lateMedia.currentSrc = srcA;
  lateMedia.__setTime(0.2);
  lateWrites.length = 0;

  unknown.pushSong('song-b', home);           // v-less push over a source learned too late
  unknown.timers.tickIntervals();
  assert.deepEqual(lateWrites.filter((w) => w.to === 30), [],
    'a source learned after A adoption cannot approve B');

  const first = createHarness({ storage: createStorage([savedB, SONG_C]) });
  first.setHref(home);
  await first.start();
  const media = first.media();
  const writes = recordSeeks(media);
  first.pushSong('song-a', home);
  await settle();
  media.__setTime(0.2);
  writes.length = 0;
  first.pushSong('song-b', home);             // A to B, source-first on B
  media.currentSrc = 'https://music.youtube.com/stream/song-b';
  media.__setTime(0);
  media.dispatchEvent('loadedmetadata');
  writes.length = 0;
  first.pushSong('song-c', home);             // B to C, no new source signal
  first.timers.tickIntervals();
  assert.deepEqual(writes.filter((w) => w.to === 40), [],
    'back-to-back source-first pushes never seek C into B');
});


test('identity: a watch visit leaving for Home must not restore a pushed section into A', async () => {
  const home = 'https://music.youtube.com/';
  const watchA = 'https://music.youtube.com/watch?v=song-a';
  const savedB = { videoId: 'song-b', startSeconds: 30, endSeconds: 60 };

  const dropped = createHarness({ storage: createStorage([SECTION, savedB]) });
  await dropped.start();
  const outgoing = dropped.media();
  const writes = recordSeeks(outgoing);
  dropped.pushSong('song-a', watchA);
  await settle();
  outgoing.currentSrc = 'https://music.youtube.com/stream/song-a';
  outgoing.__setTime(0.2);
  writes.length = 0;

  dropped.setHref(home);
  dropped.timers.tickIntervals();
  await settle();
  assert.equal(dropped.status(), 'Play a track to repeat', 'Home drops the watch identity');
  assert.equal(dropped.media(), outgoing,
    'the observed element is the same outgoing A the recorder bound');

  dropped.pushSong('song-b', home);
  dropped.timers.tickIntervals();
  assert.deepEqual(writes.filter((w) => w.to === 30), [],
    'B must not seek the outgoing A after a watch-to-Home drop');

  dropped.pushSong('song-b', home);
  dropped.timers.tickIntervals();
  assert.deepEqual(writes.filter((w) => w.to === 30), [],
    'a second identical push must not seek either');

  outgoing.currentTime = 15;
  outgoing.dispatchEvent('seeked');
  dropped.timers.tickIntervals();
  assert.equal(outgoing.currentTime, 15, 'a tick after the user seek does not snap it back');
  assert.deepEqual(writes.filter((w) => w.to === 30), [], 'no tick or seeked handler restores to 30');
  assert.ok(writes.some((w) => w.to === 15), 'recorder reachability: the element setter is observed');

  // Same controller: adopt song-a, drop identity, then re-adopt the same key.
  const sameSong = createHarness({ storage: createStorage([SECTION]) });
  sameSong.setHref(home);
  await sameSong.start();
  const media = sameSong.media();
  const sameWrites = recordSeeks(media);
  sameSong.pushSong('song-a', home);
  await settle();
  sameWrites.length = 0;
  sameSong.controller.invalidateSongIdentity();
  await settle();
  media.__setTime(0);
  sameSong.pushSong('song-a', home);
  await settle();
  assert.deepEqual(sameWrites.filter((w) => w.to === 30), [{ from: 0, to: 30, src: media.currentSrc }],
    'a same-id re-adoption on the same controller still restores');

  sameWrites.length = 0;
  media.__setTime(0.2);
  sameSong.pushSong('song-b', home);
  sameSong.timers.tickIntervals();
  assert.deepEqual(sameWrites.filter((w) => w.to === 30), [],
    'the same controller still blocks a different key on Home');
});


test('panel: a dropped identity keeps the saved range visible without a refresh', async () => {
  const home = 'https://music.youtube.com/';
  const watchA = 'https://music.youtube.com/watch?v=song-a';
  const savedB = { videoId: 'song-b', startSeconds: 30, endSeconds: 60 };
  const toValue = (h) => { const node = h.panel('To'); return node ? node.value : ''; };

  const dropped = createHarness({ storage: createStorage([SECTION, savedB]) });
  await dropped.start();
  const media = dropped.media();
  const writes = recordSeeks(media);
  dropped.pushSong('song-a', watchA);
  await settle();
  assert.equal(dropped.fromValue(), '0:30', 'precondition: the saved range was restored');
  assert.equal(toValue(dropped), '1:00');
  writes.length = 0;

  dropped.setHref(home);
  dropped.timers.tickIntervals();
  await settle();
  assert.equal(dropped.status(), 'Play a track to repeat', 'identity dropped');
  assert.equal(dropped.panel('Repeat').checked, true, 'Repeat stays checked');
  assert.equal(dropped.fromValue(), '0:30', 'the saved From stays visible without a refresh');
  assert.equal(toValue(dropped), '1:00', 'the saved To stays visible without a refresh');
  assert.deepEqual(writes, [], 'displaying the saved range never seeks');

  const blocked = createHarness({ storage: createStorage([SECTION, savedB]) });
  await blocked.start();
  const blockedMedia = blocked.media();
  const blockedWrites = recordSeeks(blockedMedia);
  blocked.pushSong('song-a', watchA);
  await settle();
  blocked.setHref(home);
  blocked.timers.tickIntervals();
  await settle();
  blocked.pushSong('song-b', home);
  blocked.timers.tickIntervals();
  assert.deepEqual(blockedWrites.filter((w) => w.to === 30), [], 'blocked B does not seek');
  assert.equal(blocked.fromValue(), '', 'a blocked transition shows no saved range');
  assert.equal(toValue(blocked), '');

  const manual = createHarness({ storage: createStorage([SECTION]) });
  await manual.start();
  manual.pushSong('song-a', watchA);
  await settle();
  manual.setHref(home);
  manual.timers.tickIntervals();
  await settle();
  const from = manual.panel('From');
  from.value = '0:10';
  from.dispatchEvent('change');
  await settle();
  assert.equal(manual.fromValue(), '0:10', 'an explicit edit wins over the saved display');

  const replaced = createHarness({ storage: createStorage([SECTION]) });
  await replaced.start();
  replaced.pushSong('song-a', watchA);
  await settle();
  replaced.setMedia(replaced.dom.makeMedia('song-a'));
  replaced.controller.sync();
  await settle();
  assert.equal(replaced.fromValue(), '0:30', 'element replacement needs no refresh');
  assert.equal(toValue(replaced), '1:00');
  assert.equal(replaced.backstop(), true, 'the loop re-arms once identity is confirmed');
});


test('status: an in-progress edit keeps reporting the committed armed range', async () => {
  const toEmpty = createHarness({ storage: createStorage([SECTION]) });
  await toEmpty.start();
  toEmpty.pushSong('song-a', 'https://music.youtube.com/watch?v=song-a');
  await settle();
  assert.equal(toEmpty.status(), '0:30 → 1:00', 'precondition: the saved range is armed');

  const to = toEmpty.panel('To');
  to.value = '';
  to.dispatchEvent('input');                 // dirty, no change or blur
  assert.equal(to.value, '', 'the in-progress edit stays in the box');
  assert.equal(to.getAttribute('data-editing'), 'true', 'the dirty field is marked as being edited');
  assert.equal(toEmpty.status(), '0:30 → 1:00', 'status still reports the committed range');

  const media = toEmpty.media();
  media.currentTime = SECTION.endSeconds;
  toEmpty.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the latch still targets the committed From');

  const fromEmpty = createHarness({ storage: createStorage([SECTION]) });
  await fromEmpty.start();
  fromEmpty.pushSong('song-a', 'https://music.youtube.com/watch?v=song-a');
  await settle();
  assert.equal(fromEmpty.status(), '0:30 → 1:00', 'precondition: the saved range is armed');

  const from = fromEmpty.panel('From');
  from.value = '';
  from.dispatchEvent('input');
  assert.equal(from.value, '', 'the in-progress edit stays in the box');
  assert.equal(from.getAttribute('data-editing'), 'true', 'the dirty field is marked as being edited');
  assert.equal(fromEmpty.status(), '0:30 → 1:00', 'status still reports the committed range');
});
