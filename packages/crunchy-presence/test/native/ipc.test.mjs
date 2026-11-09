import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import {
  DiscordFrameDecoder,
  DiscordPipeClient,
  NativeMessageDecoder,
  encodeDiscordFrame,
  encodeNativeMessage,
} from '../../native/ipc.mjs';
import { Host, fakeDiscordPipe } from '../../native/host.mjs';

/* ---------------------------------------------------------------- helpers */

let pipeSeq = 0;
function nextPipeName() {
  pipeSeq += 1;
  return `\\\\.\\pipe\\crp-test-${process.pid}-${pipeSeq}-${Date.now().toString(36)}`;
}

/** Deterministic clock: the client's timers only fire when `advance` says so. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: now + Math.max(0, ms) });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          if (!timers.delete(id)) continue;
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function waitFor(predicate, label = 'condition', timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch {
        ok = false;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function startMockPipe(options = {}) {
  const name = nextPipeName();
  const state = { handshakes: 0, clientIds: [], frames: [], sockets: [], connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.push(socket);
    const decoder = new DiscordFrameDecoder();
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.op === 0) {
          state.handshakes += 1;
          state.clientIds.push(frame.payload?.client_id);
          socket.write(
            encodeDiscordFrame(1, {
              cmd: 'DISPATCH',
              evt: 'READY',
              data: { v: 1, user: { username: 'tester' } },
            }),
          );
        } else if (frame.op === 1) {
          state.frames.push(frame.payload);
          const nonce = frame.payload?.nonce;
          if (options.mode === 'error') {
            socket.write(
              encodeDiscordFrame(1, {
                cmd: 'SET_ACTIVITY',
                evt: 'ERROR',
                nonce,
                data: { code: 4000, message: 'Invalid activity for this client' },
              }),
            );
          } else {
            socket.write(
              encodeDiscordFrame(1, {
                cmd: 'SET_ACTIVITY',
                evt: null,
                nonce,
                data: {
                  name: 'Crunchyroll Presence',
                  activity: frame.payload?.args?.activity ?? null,
                },
              }),
            );
          }
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    name,
    server,
    state,
    drop() {
      for (const socket of state.sockets) socket.destroy();
    },
    async close() {
      for (const socket of state.sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

class Capture extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  decode() {
    const decoder = new NativeMessageDecoder();
    return this.chunks.flatMap((chunk) => decoder.push(chunk));
  }
}

/** A socket that fails to connect, as a missing Discord pipe does. */
function missingPipeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  setImmediate(() => {
    if (!socket.destroyed) {
      socket.emit('error', Object.assign(new Error('connect ENOENT \\\\.\\pipe\\discord-ipc-0'), { code: 'ENOENT' }));
    }
  });
  return socket;
}

function makeClient(pipePath, extra = {}) {
  const statuses = [];
  const client = new DiscordPipeClient({
    clientId: '123456789012345678',
    pipes: [pipePath],
    connectTimeoutMs: 1_000,
    replyTimeoutMs: 1_000,
    logger: {
      info() {},
      warn() {},
      error() {},
      status: (status) => statuses.push(status),
    },
    ...extra,
  });
  return { client, statuses };
}

/* ------------------------------------------------------------------ tests */

test('handshake reaches READY and SET_ACTIVITY is echoed back', async (t) => {
  const mock = await startMockPipe();
  const { client } = makeClient(mock.name);
  t.after(() => client.close());
  t.after(() => mock.close());

  const connection = await client.connect();
  assert.equal(connection.ok, true);
  assert.equal(client.user, 'tester');
  assert.equal(mock.state.handshakes, 1);
  assert.equal(mock.state.clientIds[0], '123456789012345678');

  const activity = { type: 3, details: 'Episode 1', state: 'Crunchyroll' };
  const result = await client.setActivity(activity);
  assert.equal(result.ok, true);
  assert.equal(result.appName, 'Crunchyroll Presence');

  assert.equal(mock.state.frames.length, 1);
  assert.equal(mock.state.frames[0].cmd, 'SET_ACTIVITY');
  assert.equal(mock.state.frames[0].args.pid, process.pid);
  assert.deepEqual(mock.state.frames[0].args.activity, activity);
});

test('SET_ACTIVITY ERROR is surfaced, not swallowed', async (t) => {
  const mock = await startMockPipe({ mode: 'error' });
  const { client } = makeClient(mock.name);
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  const result = await client.setActivity({ type: 3, details: 'Episode 2' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid activity for this client');
  assert.equal(result.code, 4000);
});

test('activity null clears presence and acks', async (t) => {
  const mock = await startMockPipe();
  const { client } = makeClient(mock.name);
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  await client.setActivity({ type: 3, details: 'Episode 3' });
  const cleared = await client.setActivity(null);

  assert.equal(cleared.ok, true);
  assert.equal(mock.state.frames.at(-1).args.activity, null);
});

test('frames reassemble when split at every byte boundary', () => {
  const nativeFrame = encodeNativeMessage({ t: 'status', state: 'connected', appName: 'x' });
  let nativeChecks = 0;
  for (let split = 0; split <= nativeFrame.length; split += 1) {
    const decoder = new NativeMessageDecoder();
    const messages = [
      ...decoder.push(nativeFrame.subarray(0, split)),
      ...decoder.push(nativeFrame.subarray(split)),
    ];
    assert.equal(messages.length, 1, `native split at ${split}`);
    assert.equal(messages[0].appName, 'x');
    nativeChecks += 1;
  }
  assert.equal(nativeChecks, nativeFrame.length + 1);

  const discordFrame = encodeDiscordFrame(1, { cmd: 'SET_ACTIVITY', nonce: 'n1' });
  let discordChecks = 0;
  for (let split = 0; split <= discordFrame.length; split += 1) {
    const decoder = new DiscordFrameDecoder();
    const frames = [
      ...decoder.push(discordFrame.subarray(0, split)),
      ...decoder.push(discordFrame.subarray(split)),
    ];
    assert.equal(frames.length, 1, `discord split at ${split}`);
    assert.equal(frames[0].op, 1);
    assert.equal(frames[0].payload.nonce, 'n1');
    discordChecks += 1;
  }
  assert.equal(discordChecks, discordFrame.length + 1);
});

test('a byte-at-a-time stream decodes three frames exactly once', () => {
  const stream = Buffer.concat([
    encodeNativeMessage({ t: 'ping' }),
    encodeNativeMessage({ t: 'hello', clientId: '123456789012345678' }),
    encodeNativeMessage({ t: 'activity', activity: null }),
  ]);
  const decoder = new NativeMessageDecoder();
  const messages = [];
  for (const byte of stream) messages.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(
    messages.map((message) => message.t),
    ['ping', 'hello', 'activity'],
  );
});

test('pipe drop reconnects with backoff and republishes the last activity', async (t) => {
  const clock = makeClock();
  const mock = await startMockPipe();
  const { client, statuses } = makeClient(mock.name, { timers: clock, backoffStart: 250 });
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  const first = await client.setActivity({ type: 3, details: 'a1' });
  assert.equal(first.ok, true);
  assert.equal(mock.state.frames.length, 1);

  mock.state.sockets[0].destroy();
  await waitFor(() => client.ready === false, 'client to notice the drop');
  assert.equal(client.ready, false);

  clock.advance(250);
  await waitFor(() => mock.state.handshakes === 2, 'second handshake');
  await waitFor(
    () => mock.state.frames.filter((frame) => frame.args?.activity?.details === 'a1').length === 2,
    'activity republished',
  );
  await waitFor(() => statuses.length > 0, 'reconnect status');

  const republished = mock.state.frames.filter((frame) => frame.args?.activity?.details === 'a1');
  assert.equal(republished.length, 2);
  assert.equal(statuses.at(-1).state, 'connected');
  assert.equal(statuses.at(-1).reconnected, true);
  assert.equal(statuses.at(-1).appName, 'Crunchyroll Presence');
});

test('rate guard holds 2 frames per window and coalesces to the newest', async (t) => {
  const clock = makeClock();
  const mock = await startMockPipe();
  const { client } = makeClient(mock.name, {
    timers: clock,
    rateLimit: 2,
    rateWindowMs: 20_000,
  });
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  const one = await client.setActivity({ type: 3, details: 'one' });
  const two = await client.setActivity({ type: 3, details: 'two' });
  const three = await client.setActivity({ type: 3, details: 'three' });
  const four = await client.setActivity({ type: 3, details: 'four' });

  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(three.queued, true);
  assert.equal(four.queued, true);
  assert.equal(mock.state.frames.length, 2, 'no frame above the rate limit');

  clock.advance(20_001);
  await waitFor(() => mock.state.frames.length === 3, 'coalesced frame');
  const sent = mock.state.frames.map((frame) => frame.args?.activity?.details);
  assert.deepEqual(sent, ['one', 'two', 'four']);
});

test('no Discord pipe is a transient failure, never fatal', async () => {
  const client = new DiscordPipeClient({
    clientId: '123456789012345678',
    pipes: ['\\\\.\\pipe\\crp-definitely-missing'],
    connectTimeoutMs: 200,
    logger: { info() {}, warn() {}, error() {}, status() {} },
  });
  await assert.rejects(
    client.connect(),
    (error) => {
      assert.equal(error.fatal, undefined, 'absence must not be fatal');
      assert.match(error.message, /ENOENT|no discord ipc pipe found/i);
      return true;
    },
  );
  client.close();
});

test('host reports no-pipe as waiting, then connects later and republishes', async (t) => {
  const capture = new Capture();
  const fake = fakeDiscordPipe();
  let present = false;
  const host = new Host({
    stdout: capture,
    stderr: { write: () => {} },
    onExit: () => {},
  });
  host.retryDelay = 5;
  host.makeClient = (clientId) =>
    new DiscordPipeClient({
      clientId,
      logger: host.logger,
      pipes: ['crp-later'],
      connectImpl: () => (present ? fake.connect() : missingPipeSocket()),
      connectTimeoutMs: 200,
      replyTimeoutMs: 200,
      backoffStart: 5,
    });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: '123456789012345678' });
  let messages = capture.decode();
  const waiting = messages.find((message) => message.t === 'status');
  assert.equal(waiting.state, 'waiting', 'expected absence is not an error frame');
  assert.equal(waiting.reason, 'discord-closed');
  assert.match(waiting.detail, /ENOENT|no discord ipc pipe found/i);
  assert.equal(messages.some((message) => message.state === 'error'), false);

  await host.handle({
    t: 'activity',
    id: 'offline',
    activity: { type: 3, details: 'Episode 1' },
  });
  messages = capture.decode();
  const offline = messages.find((message) => message.t === 'ack' && message.id === 'offline');
  assert.equal(offline.ok, false, 'the host keeps the payload while offline');

  present = true;
  await waitFor(() => fake.state.handshakes === 1, 'Discord to appear');
  await waitFor(
    () => fake.state.frames.some((frame) => frame.args?.activity?.details === 'Episode 1'),
    'republished activity',
  );

  messages = capture.decode();
  const connected = messages.filter((message) => message.t === 'status' && message.state === 'connected');
  assert.ok(connected.length >= 1, 'a later connect reports connected');
});

test('Discord quitting while connected reports waiting, not connected', async (t) => {
  const capture = new Capture();
  const fake = fakeDiscordPipe();
  const host = new Host({
    stdout: capture,
    stderr: { write: () => {} },
    onExit: () => {},
    makeClient: (clientId) =>
      new DiscordPipeClient({
        clientId,
        logger: host.logger,
        pipes: ['fake'],
        connectImpl: () => fake.connect(),
        connectTimeoutMs: 200,
        replyTimeoutMs: 200,
        backoffStart: 5,
      }),
  });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: '123456789012345678' });
  assert.equal(
    capture.decode().find((message) => message.t === 'status').state,
    'connected',
  );

  fake.drop();
  await waitFor(
    () => capture.decode().some((message) => message.t === 'status' && message.state === 'waiting'),
    'waiting status after the pipe closes',
  );
  const statuses = capture.decode().filter((message) => message.t === 'status');
  const last = statuses.at(-1);
  assert.equal(last.state, 'waiting');
  assert.equal(last.reason, 'discord-closed');
  assert.equal(statuses.some((message) => message.state === 'error'), false);
});

test('every SET_ACTIVITY carries a distinct nonce', async (t) => {
  const mock = await startMockPipe();
  const { client } = makeClient(mock.name);
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  await client.setActivity({ type: 3, details: 'x' });
  await client.setActivity({ type: 3, details: 'y' });

  const nonces = mock.state.frames.map((frame) => frame.nonce);
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal(typeof nonces[0], 'string');
});
