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


// ---------------------------------------------------------------------------
// Cross-song isolation: the owner report "repeat section set on one song leaks
// into another song, then relatches when original returns". The identity used
// to be the page hook's last push, forever: once the hook had pushed song A, a
// missed push left the controller believing B was still A, so A's armed range
// kept driving B. These tests drive a real queue transition (one reused
// <video>, which is what YouTube Music does) and never touch internals.
// ---------------------------------------------------------------------------

const SONG_B = { videoId: 'song-b', startSeconds: 10, endSeconds: 20 };

function songUrl(id) {
  return 'https://music.youtube.com/watch?v=' + id;
}

test('isolation: a missed song push must not run A\'s section on B', async () => {
  const harness = await armed();
  const media = harness.media();
  // The hook pushes A's id on load, as the page does; that push is what used to
  // become a permanent identity.
  harness.pushSong('song-a');
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'precondition: A is armed at its own start');

  // The queue moves to B on the same element. The page hook does not push
  // (a missed SLRA_SONG is the reported case); the URL is the only signal.
  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();

  assert.equal(harness.fromValue(), '', 'B must not carry A\'s From');
  assert.equal(harness.status(), 'Set From or To', 'B must not show A\'s armed range');
  assert.equal(harness.backstop(), false, 'B must not inherit A\'s loop');

  // B plays through the point where A would have wrapped.
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

  // A -> B, no push: the URL carries the change, then the element holds the new
  // source back at its top.
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

  // B -> A, still no push.
  harness.setHref(songUrl('song-a'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'A comes back at A\'s own start');
  assert.equal(harness.fromValue(), '0:30', 'A shows A\'s own From');
  assert.equal(harness.status(), '0:30 → 1:00', 'A shows A\'s own range');
});

test('isolation: a pushed id still wins when the URL names no song', async () => {
  // YouTube Music Home plays from "/" with no ?v=: the push is the only id.
  const harness = createHarness({ storage: createStorage([SECTION]) });
  harness.setHref('https://music.youtube.com/');
  await harness.start();
  harness.pushSong('song-a');
  await settle();

  const media = harness.media();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the pushed id still restores its section');
  assert.equal(harness.fromValue(), '0:30');
});

// ---------------------------------------------------------------------------
// Sped-up playback: the section must latch on the media clock, not on a rate.
// The owner listens above 1x, and one timeupdate sample can cross most of a
// short section, so an exact-end equality check would never fire.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Identity provenance: the push carries the href it was taken in, so a replayed
// or late push is anchored to the navigation it describes, never to whatever
// URL happens to be current when it is delivered.
// ---------------------------------------------------------------------------

test('identity: a replayed stale push cannot re-anchor on the new URL', async () => {
  // Document 1: the hook pushed A while the URL named A.
  const first = createHarness({ storage: createStorage([SECTION]) });
  await first.start();
  first.pushSong('song-a', songUrl('song-a'));
  await settle();
  assert.equal(first.media().currentTime, SECTION.startSeconds, 'precondition: A restored');

  // The URL moves to B, the B push is missed, and the controller is recreated
  // (bypass toggled): the content script replays its cached A push.
  const second = createHarness({ storage: createStorage([SECTION, SONG_B]) });
  second.setHref(songUrl('song-b'));
  await second.start();
  second.pushSong('song-a', songUrl('song-a'));
  await settle();

  const media = second.media();
  // B has its own saved section: that is the one it must hold.
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

  // The SPA URL moves to B while the page player is still on A.
  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the outgoing A must not jump to B\'s saved start');
  assert.equal(harness.status(), 'Set From or To', 'A\'s section stops immediately');

  // The element then reports it loaded the new source: that is the confirmation.
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

  // The player swaps to B first. The hook reads the player, but the document
  // URL has not moved yet, so its href is still A's.
  harness.pushSong('song-b', songUrl('song-a'));
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'B restores on its push, before the URL moves');

  // The URL catches up to the same song with no new push: no second adoption,
  // no re-seek, and the confirmed identity is not downgraded.
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

  // The URL adopts B first, while the element still holds A's playback
  // position. Nothing vouches for B yet, so its restore stays deferred.
  harness.setHref(songUrl('song-b'));
  harness.timers.tickIntervals();
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'B waits without a vouch');

  // The player pushes B. It is the same evidence that restores instantly when
  // the push arrives before the URL, so it must confirm this visit too.
  harness.pushSong('song-b', songUrl('song-b'));
  await settle();
  harness.timers.tickIntervals();
  media.dispatchEvent('timeupdate');
  await settle();
  assert.equal(media.currentTime, SONG_B.startSeconds, 'the push vouches B and restores its own section');
  assert.equal(harness.status(), '0:10 → 0:20', 'B stays armed at its own range');
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

  // A revive re-pushes the id the player still reads (A) with the href the page
  // is in now (B). Provenance belongs to the id change, so it must not move.
  harness.pushSong('song-a', songUrl('song-b'));
  await settle();
  assert.notEqual(harness.status(), '0:30 → 1:00', 'the stale id must not be re-anchored to B');
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds, 'A section must not seek B');

  // The player finally shows B's own source.
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

  // Watch -> Home: the URL names no song, and the last push described a watch
  // page. That push belongs to a navigation we have left.
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

  // The URL moves while no element has ever been bound: the adoption is
  // unconfirmed, so nothing may be armed for it.
  harness.setHref(songUrl('song-b'));
  harness.controller.sync();
  await settle();

  // The first element appears already mid-stream.
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

  // Back to A: that is a fresh visit, so it must rearm its own section. The
  // content script pushes state on every navigation, which is this sync.
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

  // The URL still names A, so the next sync adopts A from the URL - but the
  // media is mid-stream and nothing has confirmed it since the invalidation.
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

  // The read answers with the same song: the section resumes.
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

  // The page hook could not read the player after the source changed.
  harness.controller.invalidateSongIdentity();
  await settle();
  assert.equal(harness.status(), 'Play a track to repeat', 'the visit is dropped');
  assert.equal(harness.backstop(), false, 'nothing is armed');
  media.currentTime = SECTION.endSeconds;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, SECTION.endSeconds, 'the stale section cannot seek');

  // A readable id for the same song adopts it again.
  media.currentTime = 0;
  harness.pushSong('song-a', 'https://music.youtube.com/');
  await settle();
  assert.equal(media.currentTime, SECTION.startSeconds, 'the same id adopts again');
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

  // C's confirmation arrives after B's window would have expired.
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

  // The new resource starts at the top: that is the confirmation, even when no
  // metadata signal reaches us.
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

  // A YTM slider drag arrives as native truth while the section is armed.
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

  // One 1.3x timeupdate cadence lands past the section end, not on it.
  media.currentTime = SECTION.endSeconds + 0.22;
  media.dispatchEvent('timeupdate');
  assert.equal(media.currentTime, SECTION.startSeconds, 'a jumped end still snaps back');

  // The backstop uses the same threshold on the same clock.
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

  // The last sample can be swallowed at speed; `ended` still restarts it.
  media.currentTime = 300;
  media.dispatchEvent('ended');
  assert.equal(media.currentTime, 30, 'ended restarts the armed section');
  assert.ok(media.playCalls >= 1, 'and resumes playback');
});
