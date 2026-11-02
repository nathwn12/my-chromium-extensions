import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { DiscordPipeClient, NativeMessageDecoder } from '../../native/ipc.mjs';
import { Host } from '../../native/host.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hostSource = readFileSync(join(here, '..', '..', 'native', 'host.mjs'), 'utf8');

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

function silentClient(pipePath, extra = {}) {
  return new DiscordPipeClient({
    clientId: '123456789012345678',
    pipes: [pipePath],
    connectTimeoutMs: 1_000,
    replyTimeoutMs: 1_000,
    logger: { info() {}, warn() {}, error() {}, status() {} },
    ...extra,
  });
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 10));

// 7. host backstop matches Discord's documented 5/20 s.
test('host backstop defaults to 5 per 20 s', () => {
  const client = silentClient('unused');
  assert.equal(client.rateLimit, 5);
  assert.equal(client.rateWindowMs, 20_000);
  client.close();
});

// 8. a clear bypasses a full rate window and sends immediately.
test('clear after five ordinary sends is delivered immediately', async () => {
  const clock = makeClock();
  const client = silentClient('unused', { timers: clock });
  client.ready = true;
  client.socket = { destroyed: false };
  const frames = [];
  client._request = async (frame) => {
    frames.push(frame);
    return { cmd: 'SET_ACTIVITY', data: { name: 'X' } };
  };

  for (let i = 0; i < 5; i += 1) {
    const result = await client.setActivity({ type: 3, details: `b${i}` });
    assert.equal(result.ok, true);
    assert.equal(result.queued, undefined);
  }
  const clear = await client.setActivity(null);
  assert.equal(clear.ok, true);
  assert.equal(clear.queued, undefined);
  assert.equal(frames.length, 6);
  assert.equal(frames.at(-1).args.activity, null);
  assert.equal(clock.pending(), 0);
  client.close();
});

// 9. a rejected queued payload is kept and retried with backoff.
test('failed flush keeps the payload and retries until it sends', async () => {
  const clock = makeClock();
  const client = silentClient('unused', { timers: clock, rateLimit: 1, rateWindowMs: 20_000 });
  client.ready = true;
  client.socket = { destroyed: false };
  const frames = [];
  let succeed = true;
  client._request = async (frame) => {
    if (!succeed) {
      return { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: 'n', data: { code: 500, message: 'boom' } };
    }
    frames.push(frame);
    return { cmd: 'SET_ACTIVITY', data: { name: 'X' } };
  };

  await client.setActivity({ type: 3, details: 'first' });
  const second = await client.setActivity({ type: 3, details: 'second' });
  assert.equal(second.ok, true);
  assert.equal(second.queued, true);

  succeed = false;
  clock.advance(20_001);
  await drain();
  await drain();
  assert.notEqual(client._queued, undefined, 'rejected payload is kept, not dropped');
  assert.ok(clock.pending() > 0, 'retry is rescheduled with backoff');

  succeed = true;
  clock.advance(5_000);
  await drain();
  await drain();
  assert.equal(client._queued, undefined);
  assert.deepEqual(
    frames.map((frame) => frame.args?.activity?.details),
    ['first', 'second'],
  );
  client.close();
});

// 9b. a newer payload supersedes a failed one.
test('a newer payload supersedes a failed queued payload', async () => {
  const clock = makeClock();
  const client = silentClient('unused', { timers: clock, rateLimit: 1, rateWindowMs: 60_000 });
  client.ready = true;
  client.socket = { destroyed: false };
  const frames = [];
  let succeed = true;
  client._request = async (frame) => {
    if (!succeed) {
      return { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: 'n', data: { code: 500, message: 'boom' } };
    }
    frames.push(frame);
    return { cmd: 'SET_ACTIVITY', data: { name: 'X' } };
  };

  await client.setActivity({ type: 3, details: 'first' });
  await client.setActivity({ type: 3, details: 'stale' });
  succeed = false;
  await client._flush();
  assert.notEqual(client._queued, undefined);
  await client.setActivity({ type: 3, details: 'fresh' });
  succeed = true;
  clock.advance(60_001);
  await drain();
  await drain();
  assert.deepEqual(
    frames.map((frame) => frame.args?.activity?.details),
    ['first', 'fresh'],
  );
  client.close();
});

// 10. first hello with nothing to publish sends no SET_ACTIVITY.
test('hello without prior activity skips the null clear', async () => {
  assert.match(hostSource, /if \(this\.lastActivity === undefined\)/);
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
  const capture = new Capture();
  const calls = [];
  const fake = {
    ready: false,
    closed: false,
    appName: 'Discord',
    user: '',
    async connect() {
      this.ready = true;
      return { ok: true };
    },
    async setActivity(activity) {
      calls.push(activity);
      return { ok: true, appName: 'Discord' };
    },
    close() {},
  };
  const host = new Host({
    stdout: capture,
    stderr: { write: () => {} },
    onExit: () => {},
    makeClient: () => fake,
  });
  await host.handle({ t: 'hello', clientId: '123456789012345678' });
  assert.equal(calls.length, 0, 'no SET_ACTIVITY(null) on first connect');
  const statuses = capture.decode().filter((m) => m.t === 'status');
  assert.equal(statuses.at(-1)?.state, 'connected');

  await host.handle({ t: 'activity', id: 'n1', activity: { type: 3, details: 'Episode 1' } });
  await host.handle({ t: 'hello', clientId: '123456789012345678' });
  assert.equal(calls.length, 1, 'reconnect republishes the last activity');
  host.client?.close?.();
});
