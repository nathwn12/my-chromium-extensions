import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { DiscordPipeClient, NativeMessageDecoder } from '../../native/ipc.mjs';
import { Host } from '../../native/host.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ipcSource = readFileSync(join(here, '..', '..', 'native', 'ipc.mjs'), 'utf8');
const hostSource = readFileSync(join(here, '..', '..', 'native', 'host.mjs'), 'utf8');

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

// 5. host backstop no longer double-throttles: a burst of 5 sends at once.
test('host backstop allows a burst of 5 with no queue (extension guard binds)', async () => {
  const clock = makeClock();
  const client = silentClient('unused', { timers: clock });
  client.ready = true;
  client.socket = { destroyed: false };
  client._request = async () => ({ cmd: 'SET_ACTIVITY', data: { name: 'X' } });

  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(await client.setActivity({ type: 3, details: `b${i}` }));
  }
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.queued, undefined);
  }
  assert.equal(client._sentAt.length, 5);
  assert.equal(clock.pending(), 0);
  assert.match(ipcSource, /Backstop guard only/);
  client.close();
});

// 5b. delay bound: the 5th send in a burst is not deferred a full window.
test('burst delay bound stays under one window', async () => {
  const clock = makeClock();
  const client = silentClient('unused', { timers: clock });
  client.ready = true;
  client.socket = { destroyed: false };
  client._request = async () => ({ cmd: 'SET_ACTIVITY', data: { name: 'X' } });
  const started = clock.now();
  for (let i = 0; i < 5; i += 1) await client.setActivity({ type: 3, details: `d${i}` });
  assert.ok(clock.now() - started < 20_000, 'burst of 5 completes without a 20 s deferral');
  client.close();
});

// 6. _flush reschedules when the pipe is down instead of stranding the queue.
test('_flush reschedules while not ready so a queued update is not stranded', async () => {
  const clock = makeClock();
  const client = silentClient('unused', {
    timers: clock,
    rateLimit: 1,
    rateWindowMs: 20_000,
  });
  client.ready = true;
  client.socket = { destroyed: false };
  client._request = async () => ({ cmd: 'SET_ACTIVITY', data: { name: 'X' } });

  await client.setActivity({ type: 3, details: 'first' });
  const second = await client.setActivity({ type: 3, details: 'second' });
  assert.equal(second.queued, true);

  client.ready = false;
  client.socket = null;
  await client._flush();
  assert.notEqual(client._queued, undefined);
  assert.ok(clock.pending() > 0, 'flush rescheduled a timer while offline');
  client.close();
});

// 3. a successful connect retry emits status connected.
test('connect retry emits status connected on success', async () => {
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
  const fake = {
    ready: false,
    closed: false,
    appName: 'Discord',
    user: '',
    async connect() {
      this.ready = true;
      return { ok: true };
    },
    async setActivity() {
      return { ok: true, appName: 'Crunchyroll Selftest' };
    },
    close() {},
  };
  const host = new Host({
    stdout: capture,
    stderr: { write: () => {} },
    onExit: () => {},
    makeClient: () => fake,
  });
  host.client = fake;
  host.lastActivity = { type: 3, details: 'retry' };
  host.retryDelay = 5;
  host.scheduleConnectRetry();
  await new Promise((resolve) => setTimeout(resolve, 100));
  host.shutdown(0);
  const statuses = capture.decode().filter((m) => m.t === 'status' && m.state === 'connected');
  assert.ok(statuses.length >= 1, `expected a connected status after retry, got ${JSON.stringify(capture.decode())}`);
  assert.match(hostSource, /statusMessage\('connected'/);
});
