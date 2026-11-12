// Emergency hotfix: the CORS-safe, non-stealing route.
//
// The page hook now routes media through `captureStream()` +
// `createMediaStreamSource()` instead of `createMediaElementSource()`. The
// stream tap does not steal the element's output, so STOP can hand native audio
// back (disconnect + unmute) and a re-enable can capture a fresh stream. The
// element source survives only as the engine-without-captureStream fallback.
//
// No audio is played: every context, stream, track and analyser below is a
// recorder that counts calls and exposes a signal amplitude to assert on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = 'https://www.example.com/watch';
const WORKLET_URL = 'chrome-extension://test-id/audio/normalizer-worklet.js';

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(cond, timeoutMs, label) {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(20);
  }
}

function loadHook(options = {}) {
  const counters = {
    captureStream: 0,
    elementSource: 0,
    mediaStreamSource: 0,
    probeRuns: 0,
    queryAudioVideo: 0,
    queryAll: 0,
    tracksStopped: 0,
  };
  const parked = [];
  const streams = [];
  const streamSources = [];
  const worklets = [];
  const edges = new Set();
  const edgeKey = (from, to) => `${from}->${to}`;
  const documentListeners = {};
  const windowListeners = {};

  class FakeNode {
    constructor(context) { this.context = context || null; this._eid = FakeNode.next++; }
    connect(dest) {
      if (dest && typeof dest._eid === 'number') edges.add(edgeKey(this._eid, dest._eid));
      return dest;
    }
    disconnect(dest) {
      if (dest && typeof dest._eid === 'number') {
        edges.delete(edgeKey(this._eid, dest._eid));
        return;
      }
      for (const entry of Array.from(edges)) {
        if (entry.startsWith(`${this._eid}->`)) edges.delete(entry);
      }
    }
  }
  FakeNode.next = 1;

  class FakeTrack {
    constructor(kind, stream) {
      this.kind = kind;
      this.stream = stream;
      this.muted = false;
      this.readyState = 'live';
    }
    stop() { counters.tracksStopped += 1; this.readyState = 'ended'; }
  }

  class FakeStream {
    constructor({ audio = true, signal = 0.5, mutedTrack = false } = {}) {
      this._tracks = [];
      this._listeners = {};
      this.signal = signal;
      this._audio = audio;
      this._mutedTrack = mutedTrack;
      if (audio) this.addAudioTrack();
    }
    addAudioTrack() {
      const track = new FakeTrack('audio', this);
      track.muted = this._mutedTrack;
      this._tracks.push(track);
      for (const fn of (this._listeners.addtrack || []).slice()) {
        try { fn.call(this, { type: 'addtrack', track }); } catch {}
      }
      return track;
    }
    getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
    getTracks() { return this._tracks.slice(); }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] || []).filter((entry) => entry !== fn);
    }
  }

  class FakeAnalyser extends FakeNode {
    constructor(context) {
      super(context);
      this.fftSize = 256;
      this._stream = null;
    }
    getFloatTimeDomainData(buffer) {
      const signal = this._stream ? this._stream.signal : 0;
      for (let i = 0; i < buffer.length; i += 1) {
        buffer[i] = i % 2 === 0 ? signal : -signal;
      }
    }
  }

  class FakeMediaStreamSource extends FakeNode {
    constructor(context, stream) {
      super(context);
      this.stream = stream;
    }
  }

  const contexts = [];
  let resumeStuck = false;
  class FakeAudioContext {
    constructor() {
      contexts.push(this);
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = new FakeNode(this);
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() { if (!resumeStuck) this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() {
      const node = new FakeNode(this);
      node.gain = { value: 1 };
      return node;
    }
    createAnalyser() {
      counters.probeRuns += 1;
      return new FakeAnalyser(this);
    }
    createMediaStreamSource(stream) {
      counters.mediaStreamSource += 1;
      const source = new FakeMediaStreamSource(this, stream);
      const connect = source.connect.bind(source);
      source.connect = (dest) => {
        if (dest instanceof FakeAnalyser) dest._stream = stream;
        return connect(dest);
      };
      streamSources.push(source);
      return source;
    }
    createMediaElementSource() {
      counters.elementSource += 1;
      throw new Error('the stream tap must be preferred');
    }
    addEventListener() {}
    removeEventListener() {}
  }

  class FakeWorkletNode extends FakeNode {
    constructor() {
      super(null);
      this._ope = null;
      this.port = { postMessage: () => {} };
      worklets.push(this);
    }
    set onprocessorerror(value) { this._ope = value; }
    get onprocessorerror() { return this._ope; }
  }

  class FakeMutationObserver {
    constructor(cb) { this._cb = cb; }
    observe() {}
    disconnect() {}
  }

  class FakeMediaElement {
    constructor({ src = 'https://www.example.com/media.mp4', paused = true, audio = true, signal = 0.5, mutedTrack = false } = {}) {
      this.tagName = 'VIDEO';
      this.muted = false;
      this.paused = paused;
      this.ended = false;
      this.volume = 1;
      this.readyState = paused ? 0 : 4;
      this.preload = 'auto';
      this.isConnected = true;
      this.src = src;
      this.currentSrc = src;
      this.crossOrigin = null;
      this.mediaKeys = null;
      this.srcObject = null;
      this.capturedSrc = null;
      this._listeners = {};
      this._audio = audio;
      this._signal = signal;
      this._mutedTrack = mutedTrack;
      this.captureStreamCalls = 0;
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] || []).filter((entry) => entry !== fn);
    }
    dispatch(type) {
      // The hook watches media events once, on the document, in the capture
      // phase (they do not bubble). Model that path first, then the element's
      // own listeners.
      for (const fn of (documentListeners[type] || []).slice()) {
        try { fn.call(documentStub, { type, target: this }); } catch {}
      }
      for (const fn of (this._listeners[type] || []).slice()) {
        try { fn.call(this, { type, target: this }); } catch {}
      }
    }
    querySelectorAll() { return []; }
    captureStream() {
      counters.captureStream += 1;
      this.captureStreamCalls += 1;
      this.capturedSrc = this.currentSrc;
      const stream = new FakeStream({
        audio: this._audio,
        signal: this._signal,
        mutedTrack: this._mutedTrack,
      });
      streams.push(stream);
      return stream;
    }
    play() {
      return Promise.resolve().then(() => {
        this.paused = false;
        this.readyState = 4;
        this.dispatch('play');
        this.dispatch('playing');
      });
    }
  }

  const documentElement = {
    _attrs: { 'data-tn-worklet-url': WORKLET_URL },
    getAttribute(key) { return Object.hasOwn(this._attrs, key) ? this._attrs[key] : null; },
    setAttribute(key, value) { this._attrs[key] = String(value); },
    removeAttribute(key) { delete this._attrs[key]; },
  };
  const documentStub = {
    hidden: false,
    readyState: 'complete',
    documentElement,
    querySelectorAll(selector) {
      if (String(selector).includes('audio')) {
        counters.queryAudioVideo += 1;
        return parked.slice();
      }
      counters.queryAll += 1;
      return [];
    },
    addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      documentListeners[type] = (documentListeners[type] || []).filter((entry) => entry !== fn);
    },
  };
  const windowStub = {
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    webkitAudioContext: undefined,
    addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      windowListeners[type] = (windowListeners[type] || []).filter((entry) => entry !== fn);
    },
  };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: { href: PAGE_URL, hostname: 'www.example.com', origin: 'https://www.example.com' },
    HTMLMediaElement: FakeMediaElement,
    Element: FakeMediaElement,
    AudioNode: FakeNode,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    MutationObserver: FakeMutationObserver,
    DOMException: Error,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'page-hook.js'), 'utf8'), sandbox, { filename: 'page-hook.js' });

  const control = (action, payload) => (typeof sandbox.__tnHookV6 === 'function'
    ? sandbox.__tnHookV6(action, payload || {})
    : { ok: false, alive: false, active: false, error: 'no hook' });
  const start = () => control('start', { gainDb: 0, workletUrl: WORKLET_URL });
  const stop = () => control('stop', {});
  const destroy = () => control('destroy', {});
  const status = () => control('status', {});
  const surface = () => parked.slice();

  return {
    sandbox, counters, streams, contexts, parked, FakeMediaElement,
    edges, streamSources, worklets,
    // Model an autoplay-gated tab: a suspended context whose resume() never
    // reaches `running`.
    stickResume: () => { resumeStuck = true; },
    control, start, stop, destroy, status, surface,
    fireDocument: (type) => {
      for (const fn of (documentListeners[type] || []).slice()) {
        try { fn.call(documentStub, { type }); } catch {}
      }
    },
    // The hook only routes a media element once its context is running and the
    // worklet exists: give it a beat, like a real start.
    ready: () => waitFor(() => control('status', {}).active, 10000, 'hook active'),
  };
}

function park(hook, element) {
  hook.parked.push(element);
  return element;
}

/**
 * The probe graph is proved in tests/probe-sink.test.js, which drives
 * `probeStreamSignal` directly with an instrumented context (edge-by-edge,
 * both the audible and the timeout path).
 */
test('normal media is routed through captureStream, never createMediaElementSource', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'stream route attached');

  assert.equal(hook.counters.captureStream, 1, 'captureStream is the route');
  assert.equal(hook.counters.mediaStreamSource, 1, 'through a MediaStreamSource');
  assert.equal(hook.counters.elementSource, 0, 'createMediaElementSource is never called');
  assert.equal(video.muted, true, 'the element is muted while the tap owns the output');
  const source = hook.streamSources[0];
  assert.ok(Array.from(hook.edges).some((entry) => entry.startsWith(`${source._eid}->`)),
    'the tap is connected into the session');
  assert.equal(hook.status().active, true);
});

test('stop hands the page back to native: stream disconnected, tracks stopped, element unmuted', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'attached');

  hook.stop();
  await sleep(60);
  assert.equal(hook.status().active, false, 'nothing is processing');
  assert.equal(video.muted, false, 'the element is native again (unmuted)');
  assert.equal(video.__tnAttached, false, 'and no longer owned');
  assert.ok(hook.counters.tracksStopped >= 1, 'the captured tracks were stopped');
  assert.equal(hook.counters.elementSource, 0, 'still never a stolen element source');

  // Re-enable captures a NEW stream: no one-source wall.
  hook.start();
  await hook.ready();
  await waitFor(() => hook.counters.captureStream === 2, 10000, 'a fresh stream on re-enable');
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 're-attached');
  assert.equal(video.muted, true, 'muted again while routed');
  const session = Array.from(hook.contexts).length;
  assert.equal(session, 1, 'one context is reused, never a second');
});

test('a CORS element whose stream carries signal is routed by the tap', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({
    paused: false,
    src: 'https://cdn.example.net/video.mp4',
    signal: 0.4,
  }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'CORS element routed');
  assert.equal(hook.counters.captureStream, 1);
  assert.equal(hook.counters.elementSource, 0, 'the tainting element source is never used');
  assert.equal(video.muted, true);
  assert.equal(hook.status().protected, 0, 'no verdict: it is being normalized');
});

test('a CORS element whose stream is silent stays native: no mute, verdict reported', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({
    paused: false,
    src: 'https://cdn.example.net/video.mp4',
    signal: 0,
  }));
  await video.play();
  await waitFor(() => hook.status().protected === 1, 10000, 'protected verdict recorded');
  assert.equal(video.muted, false, 'the page keeps its audio: never muted on a silent tap');
  assert.equal(video.__tnAttached !== true, true, 'and nothing was routed');
  assert.equal(hook.counters.elementSource, 0, 'no stolen element source');

  // The timeout path is the same probe graph; see tests/probe-sink.test.js.
});

test('the silent-sink probe is in the source (static guard)', () => {
  const hookSource = fs.readFileSync(path.join(ROOT, 'page-hook.js'), 'utf8');
  assert.match(hookSource, /sink\.gain\.value = 0/, 'the probe sink is zero-gain');
  assert.match(hookSource, /analyser\.connect\(sink\)/, 'the analyser is pulled by the sink');
  assert.match(hookSource, /sink\.connect\(context\.destination\)/, 'the sink reaches the destination');
  assert.match(hookSource, /source\.disconnect\(analyser\)/, 'the tap edge is released');
  assert.match(hookSource, /analyser\.disconnect\(sink\)/, 'the analyser edge is released');
  assert.match(hookSource, /sink\.disconnect\(context\.destination\)/, 'the sink edge is released');
});

test('a muted capture track is never routed (cross-origin protection)', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false, mutedTrack: true }));
  await video.play();
  await waitFor(() => hook.status().protected === 1, 10000, 'protected verdict');
  assert.equal(video.muted, false, 'left native and audible');
  assert.equal(hook.counters.mediaStreamSource, 0, 'nothing connected');
});

test('no audio track yet: nothing is muted, the tap retries when the track arrives', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false, audio: false }));
  await video.play();
  await sleep(200);
  assert.equal(video.muted, false, 'a stream with no track never mutes the page');
  assert.equal(video.__tnAttached !== true, true, 'and routes nothing yet');

  // The track arrives and the element plays again: routed then.
  hook.streams[hook.streams.length - 1].addAudioTrack();
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'routed after the track arrives');
  assert.equal(video.muted, true);
});

test('page-owned, DRM and srcObject media are skipped, untouched and never muted', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();

  const pageOwned = park(hook, new hook.FakeMediaElement({ paused: false }));
  pageOwned.__tnWebAudio = true;
  const drm = park(hook, new hook.FakeMediaElement({ paused: false }));
  drm.mediaKeys = { fake: true };
  const objectUrl = park(hook, new hook.FakeMediaElement({ paused: false }));
  objectUrl.srcObject = { fake: 'MediaStream' };

  for (const element of [pageOwned, drm, objectUrl]) {
    await element.play();
  }
  await sleep(300);
  assert.equal(hook.counters.captureStream, 0, 'none of them was captured');
  assert.equal(hook.counters.elementSource, 0);
  for (const element of [pageOwned, drm, objectUrl]) {
    assert.equal(element.muted, false, 'never muted');
    assert.equal(element.__tnAttached !== true, true, 'never routed');
  }
  assert.equal(hook.status().unprocessed >= 2, true, 'the verdict counts the skipped media');
});

test('an audible blob: (MSE) tap is probed and routed', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({
    paused: false,
    src: 'blob:https://www.example.com/6f1e-4a2b',
    signal: 0.3,
  }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'blob element routed');
  assert.equal(hook.counters.probeRuns, 1, 'the tap is proven even for blob:');
  assert.equal(video.muted, true, 'and muted only after the proof');
  assert.equal(hook.status().protected, 0);
});

test('a silent blob: (MSE) tap is probed, never routed and never muted', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({
    paused: false,
    src: 'blob:https://www.tiktok.com/9a8b-7c6d',
    signal: 0,
  }));
  await video.play();
  await waitFor(() => hook.status().protected === 1, 10000, 'protected verdict for the silent blob tap');
  assert.equal(hook.counters.probeRuns, 1, 'blob: is probed, not assumed audible');
  assert.equal(video.muted, false, 'the page keeps its audio');
  assert.equal(video.__tnAttached !== true, true, 'and nothing was routed');
  assert.ok(hook.counters.tracksStopped >= 1, 'the dead tap is released');
});

test('every tap is probed, whatever its origin or scheme', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const sameOrigin = park(hook, new hook.FakeMediaElement({ paused: false, src: 'https://www.example.com/a.mp4', signal: 0.5 }));
  await sameOrigin.play();
  await waitFor(() => sameOrigin.__tnAttached === true, 10000, 'same-origin routed');
  assert.equal(hook.counters.probeRuns, 1, 'same-origin tap is proven');

  const blob = park(hook, new hook.FakeMediaElement({ paused: false, src: 'blob:https://www.example.com/x', signal: 0.5 }));
  await blob.play();
  await waitFor(() => blob.__tnAttached === true, 10000, 'blob routed');
  assert.equal(hook.counters.probeRuns, 2, 'blob tap is proven too: the probe is not origin-gated');
});

test('a suspended context is never routed: the element stays native', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  hook.stickResume();
  hook.contexts[0].state = 'suspended';
  const video = park(hook, new hook.FakeMediaElement({ paused: false }));
  await video.play();
  await sleep(500);
  assert.equal(hook.counters.captureStream, 0, 'nothing is captured into a suspended context');
  assert.equal(video.muted, false, 'the element keeps playing natively');
  assert.equal(video.__tnAttached !== true, true, 'and is not owned');
});

test('a reused element with a new source hands back the old tap and re-evaluates', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false, src: 'https://www.example.com/one.mp4' }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'first source routed');
  assert.equal(video.muted, true);
  assert.equal(video.captureStreamCalls, 1);

  // The feed reuses the element for the next item: a new source, the same node.
  video.currentSrc = 'blob:https://www.example.com/two';
  video.src = video.currentSrc;
  video.dispatch('loadedmetadata');
  // The stale tap is detached synchronously: the page has its own audio back
  // before the new source is judged.
  assert.equal(video.muted, false, 'native immediately after the source swap');
  await waitFor(() => video.__tnAttached === true, 10000, 'the new source is routed');
  assert.equal(video.captureStreamCalls, 2, 'a fresh tap for the new source');
  assert.equal(video.capturedSrc, video.currentSrc, 'the live tap belongs to the current source');
  assert.equal(hook.status().interrupted >= 1, true, 'the broken route is reported');
});

test('a 20-item feed with reused elements never double-taps and never leaves a stale mute', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const items = [];
  for (let i = 0; i < 20; i += 1) {
    items.push(park(hook, new hook.FakeMediaElement({ paused: false, src: `https://www.example.com/${i}.mp4` })));
  }
  // Each item plays once; the feed then swaps the source on whichever elements
  // are routed, exactly like an infinite feed.
  for (const item of items) await item.play();
  await sleep(400);
  for (const item of items) {
    if (item.__tnAttached !== true) continue;
    item.currentSrc = `blob:https://www.example.com/${item.currentSrc.length}-swap`;
    item.src = item.currentSrc;
    item.dispatch('loadedmetadata');
  }
  await sleep(600);

  assert.equal(hook.counters.mediaStreamSource, hook.counters.captureStream,
    'exactly one stream source per capture, never two for one element');
  for (const item of items) {
    if (item.muted === true) {
      assert.equal(item.__tnAttached, true, 'a muted element is always the routed one');
      assert.equal(item.capturedSrc, item.currentSrc, 'and its tap belongs to the current source');
    }
  }
  const routed = items.filter((item) => item.__tnAttached === true).length;
  assert.ok(routed <= 4, `the cap still holds under churn (got ${routed})`);
});

test('a context suspended mid-play fails open to native audio', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'routed');
  assert.equal(video.muted, true);

  hook.stickResume();
  hook.contexts[0].state = 'suspended';
  hook.fireDocument('visibilitychange');
  await waitFor(() => video.muted === false, 10000, 'the watchdog hands the element back');
  assert.equal(video.__tnAttached, false, 'and the dead route is released');
  assert.equal(hook.status().interrupted >= 1, true, 'reported, not silent');
  assert.ok(hook.counters.tracksStopped >= 1, 'its tracks are stopped');
});

test('a worklet processor error fails open to native audio', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'routed');
  assert.ok(hook.worklets.length >= 1, 'a worklet exists');
  // Every session has its own worklet; the one that owns the element is the one
  // whose failure must hand the element back.
  for (const worklet of hook.worklets) {
    if (typeof worklet._ope === 'function') worklet._ope(new Error('boom'));
  }
  await sleep(80);
  assert.equal(video.muted, false, 'the muted element is handed back at once');
  assert.equal(video.__tnAttached, false, 'and the tap is released');
  assert.equal(hook.status().interrupted >= 1, true, 'reported');
});

test('off/on during a source swap: no capture while off, a fresh one after', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false, src: 'https://www.example.com/a.mp4' }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'routed');
  const capturesWhileOn = video.captureStreamCalls;

  hook.stop();
  await sleep(60);
  assert.equal(video.muted, false, 'off is native');
  video.currentSrc = 'https://www.example.com/b.mp4';
  video.src = video.currentSrc;
  video.dispatch('loadedmetadata');
  await sleep(200);
  assert.equal(video.captureStreamCalls, capturesWhileOn, 'nothing is captured while off');
  assert.equal(video.muted, false, 'and the swapped element stays native');

  hook.start();
  await hook.ready();
  video.dispatch('playing');
  await waitFor(() => video.__tnAttached === true, 10000, 're-enabled on the new source');
  assert.equal(video.captureStreamCalls, capturesWhileOn + 1, 'one fresh tap');
  assert.equal(video.capturedSrc, video.currentSrc, 'for the source it is playing now');
});

test('a quiet passage with a running graph stays routed', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false, signal: 0.4 }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'routed');
  // The passage goes quiet: the watchdog is mechanical, never amplitude-based.
  for (const stream of hook.streams) stream.signal = 0;
  video.dispatch('playing');
  hook.fireDocument('visibilitychange');
  await sleep(400);
  assert.equal(video.muted, true, 'still routed through the graph');
  assert.equal(video.__tnAttached, true, 'and still owned');
  assert.equal(hook.status().interrupted, 0, 'a quiet passage is not a failure');
});

test('a feed of 20 paused videos costs nothing; only playing elements are capped at 4', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  for (let i = 0; i < 20; i += 1) {
    park(hook, new hook.FakeMediaElement({ paused: true, src: `https://www.example.com/v${i}.mp4` }));
  }
  // A recovery pass asks for a scan; the sweep must skip every paused item.
  hook.fireDocument('visibilitychange');
  await sleep(400);
  assert.equal(hook.counters.captureStream, 0, 'paused/preloaded feed items are never captured');

  // Six playing videos: at most four are routed (the cap).
  const playing = [];
  for (let i = 0; i < 6; i += 1) {
    const element = park(hook, new hook.FakeMediaElement({ paused: false, src: `https://www.example.com/p${i}.mp4` }));
    playing.push(element);
    await element.play();
  }
  await waitFor(() => playing.filter((el) => el.__tnAttached === true).length >= 4, 10000, 'the cap routes four');
  await sleep(300);
  const routed = playing.filter((el) => el.__tnAttached === true).length;
  assert.equal(routed, 4, 'at most MAX_ROUTED_MEDIA elements are routed at once');
  assert.ok(hook.counters.captureStream <= 4, `captures stay bounded (got ${hook.counters.captureStream})`);
});

test('churn: recovery passes do not rescan the document, and off/on does not grow sources', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const scansAtStart = hook.counters.queryAudioVideo;
  assert.equal(scansAtStart, 1, 'one document scan on enable');

  // Eight recovery ticks (the burst fires on visibility/focus/pageshow).
  for (let i = 0; i < 8; i += 1) {
    hook.fireDocument('visibilitychange');
    await sleep(40);
  }
  await sleep(500);
  assert.equal(hook.counters.queryAudioVideo, scansAtStart, 'the burst never re-walks the document');

  const video = park(hook, new hook.FakeMediaElement({ paused: false }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'attached');
  hook.stop();
  await sleep(60);
  hook.start();
  await hook.ready();
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 're-attached');
  // One source per element, never cumulative.
  assert.equal(video.captureStreamCalls, 2, 'one capture per on-cycle');
  assert.equal(hook.counters.mediaStreamSource, 2, 'and one stream source per capture');
});

test('destroy releases the tap and unmutes (exclusion/uninstall is not a silence trap)', async () => {
  const hook = loadHook();
  hook.start();
  await hook.ready();
  const video = park(hook, new hook.FakeMediaElement({ paused: false }));
  await video.play();
  await waitFor(() => video.__tnAttached === true, 10000, 'attached');

  hook.destroy();
  await sleep(60);
  assert.equal(video.muted, false, 'the element is unmuted: native audio');
  assert.equal(video.__tnAttached, false, 'and released');
  assert.ok(hook.counters.tracksStopped >= 1, 'its tracks are stopped');
  assert.equal(typeof hook.sandbox.__tnHookV6, 'undefined', 'the dispatcher is gone');
});
