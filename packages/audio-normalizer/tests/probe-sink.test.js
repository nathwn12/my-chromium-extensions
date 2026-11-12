// The CORS probe's GRAPH, proved edge by edge.
//
// `probeStreamSignal` measures a captureStream tap before the element is muted.
// An AnalyserNode that nothing pulls is not guaranteed to render, and an
// unrendered analyser reports zeros — which would judge every CORS tap
// "protected" and leave the page native. The probe therefore wires
// source -> analyser -> zero-gain sink -> destination (the steady-volume
// silent-sink pattern) and must tear all three edges down on every exit.
//
// This drives the product function directly instead of through the whole hook,
// so the graph is the only thing under test and nothing else can connect a node
// into the picture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function createHarness({ signal, active = true, analyserAvailable = true, gainAvailable = true }) {
  const edges = new Set();
  const key = (a, b) => `${a}->${b}`;
  const gains = [];
  let nextId = 1;

  class Node {
    constructor() { this._eid = nextId++; }
    connect(dest) {
      if (dest) edges.add(key(this._eid, dest._eid));
      return dest;
    }
    disconnect(dest) {
      if (dest) {
        edges.delete(key(this._eid, dest._eid));
        return;
      }
      for (const entry of Array.from(edges)) {
        if (entry.startsWith(`${this._eid}->`)) edges.delete(entry);
      }
    }
  }

  const destination = new Node();
  const context = {
    destination,
    createAnalyser: analyserAvailable
      ? () => {
        const analyser = new Node();
        analyser.fftSize = 256;
        analyser.getFloatTimeDomainData = (buffer) => {
          for (let i = 0; i < buffer.length; i += 1) {
            buffer[i] = i % 2 === 0 ? signal : -signal;
          }
        };
        return analyser;
      }
      : undefined,
    createGain: gainAvailable
      ? () => {
        const gain = new Node();
        gain.gain = { value: 1 };
        gains.push(gain);
        return gain;
      }
      : undefined,
  };
  const source = new Node();

  const state = { active };
  const sandbox = {
    state,
    STREAM_PROBE_MS: 120,
    trackTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)),
    untrackTimeout: () => {},
    Date,
    Float32Array,
    Promise,
    URL,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const hookSource = fs.readFileSync(path.join(ROOT, 'page-hook.js'), 'utf8');
  vm.runInContext(`${extractFunction(hookSource, 'probeStreamSignal')}\nglobalThis.probeStreamSignal = probeStreamSignal;`, sandbox, {
    filename: 'page-hook.js#probeStreamSignal',
  });
  return { sandbox, context, source, edges, gains, destination, state };
}

test('the probe builds source -> analyser -> zero-gain sink -> destination and tears it down (audible path)', async () => {
  const harness = createHarness({ signal: 0.5 });
  const result = await harness.sandbox.probeStreamSignal(harness.context, harness.source);
  assert.equal(result, true, 'signal means the tap is audible');

  // The sink was silent, and it was the analyser's only downstream path.
  assert.equal(harness.gains.length, 1, 'exactly one sink was created');
  const sink = harness.gains[0];
  assert.equal(sink.gain.value, 0, 'the sink is zero-gain');
  const sinkEid = sink._eid;
  const destinationEid = harness.destination._eid;
  assert.equal(harness.edges.has(`${sinkEid}->${destinationEid}`), false, 'sink -> destination is released');

  // Every edge of the probe is gone; the session graph is not touched by this
  // helper, so the edge set must be empty.
  assert.deepEqual(Array.from(harness.edges), [], 'all three probe edges are disconnected on the audible exit');
});

test('the probe tears the graph down on the timeout path too (silent tap)', async () => {
  const harness = createHarness({ signal: 0 });
  const result = await harness.sandbox.probeStreamSignal(harness.context, harness.source);
  assert.equal(result, false, 'silence means the tap is not accessible');
  assert.equal(harness.gains.length, 1);
  assert.equal(harness.gains[0].gain.value, 0, 'the sink was silent');
  assert.deepEqual(Array.from(harness.edges), [], 'all three probe edges are disconnected on the timeout exit');
});

test('a stop mid-probe tears the graph down (inactive exit)', async () => {
  const harness = createHarness({ signal: 0 });
  const pending = harness.sandbox.probeStreamSignal(harness.context, harness.source);
  harness.state.active = false;
  const result = await pending;
  assert.equal(result, false, 'an inactive hook never routes');
  assert.deepEqual(Array.from(harness.edges), [], 'and leaves no probe edge behind');
});

test('the probe graph edges are exactly the documented chain', async () => {
  // Capture the edge set while the graph is live, via the analyser's read.
  const harness = createHarness({ signal: 0.5 });
  let live = null;
  let analyserEid = null;
  const realCreateAnalyser = harness.context.createAnalyser;
  harness.context.createAnalyser = () => {
    const analyser = realCreateAnalyser();
    analyserEid = analyser._eid;
    const read = analyser.getFloatTimeDomainData;
    analyser.getFloatTimeDomainData = (buffer) => {
      if (!live) live = new Set(harness.edges);
      read(buffer);
    };
    return analyser;
  };
  await harness.sandbox.probeStreamSignal(harness.context, harness.source);
  assert.ok(live, 'the analyser was read while the graph was up');
  assert.ok(analyserEid, 'the analyser is the middle node');
  const sink = harness.gains[0];
  assert.ok(live.has(`${harness.source._eid}->${analyserEid}`), 'source -> analyser');
  assert.ok(live.has(`${analyserEid}->${sink._eid}`), 'analyser -> sink');
  assert.ok(live.has(`${sink._eid}->${harness.destination._eid}`), 'sink -> destination');
  assert.equal(sink.gain.value, 0, 'and the sink is silent');
});

test('a zero-gain sink is required by the source (static guard)', () => {
  const hookSource = fs.readFileSync(path.join(ROOT, 'page-hook.js'), 'utf8');
  const probe = extractFunction(hookSource, 'probeStreamSignal');
  assert.match(probe, /sink\.gain\.value = 0/, 'the sink is silent');
  assert.match(probe, /analyser\.connect\(sink\)/, 'the analyser is pulled by the sink');
  assert.match(probe, /sink\.connect\(context\.destination\)/, 'the sink reaches the destination');
  assert.match(probe, /source\.disconnect\(analyser\)/, 'the tap edge is released');
  assert.match(probe, /analyser\.disconnect\(sink\)/, 'the analyser edge is released');
  assert.match(probe, /sink\.disconnect\(context\.destination\)/, 'the sink edge is released');
});
