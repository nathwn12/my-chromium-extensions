#!/usr/bin/env node
/**
 * Native messaging host: bridges Chrome's stdin/stdout framing to Discord IPC.
 *
 * stdout carries protocol frames only; every diagnostic goes to stderr.
 * Run with `--selftest` to exercise the whole bridge against an in-process
 * fake Discord pipe and print the result as JSON.
 */

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  DiscordFrameDecoder,
  DiscordPipeClient,
  NativeMessageDecoder,
  encodeDiscordFrame,
  encodeNativeMessage,
} from './ipc.mjs';
import { statusMessage, validateActivity, validateMessage } from './protocol.mjs';

const CONNECT_RETRY_START = 1_000;
const CONNECT_RETRY_MAX = 30_000;

export class Host {
  constructor(options = {}) {
    this.out = options.stdout ?? process.stdout;
    this.err = options.stderr ?? process.stderr;
    this.onExit = options.onExit ?? ((code) => process.exit(code));

    this.client = null;
    this.queue = Promise.resolve();
    this.lastActivity = undefined;
    this.seq = 0;
    this.closing = false;
    this.retryTimer = null;
    this.retryDelay = CONNECT_RETRY_START;

    this.logger = {
      info: (line) => this.log(line),
      warn: (line) => this.log(line),
      error: (line) => this.log(line),
      status: (status) => this.emitStatus(status),
    };
    this.makeClient =
      options.makeClient ?? ((clientId) => new DiscordPipeClient({ clientId, logger: this.logger }));
  }

  /* ------------------------------------------------------------------ io */

  write(message) {
    this.out.write(encodeNativeMessage(message));
  }

  log(line) {
    this.err.write(`[crunchyroll-presence] ${line}\n`);
  }

  emitStatus(status) {
    if (status?.state === 'error') {
      this.write(statusMessage('error', { detail: status.detail, code: status.code }));
      return;
    }
    this.write(statusMessage('connected', { appName: status?.appName, user: status?.user }));
  }

  nextId() {
    this.seq += 1;
    return `${this.seq}-${Date.now().toString(36)}`;
  }

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /* ------------------------------------------------------------- dispatch */

  handle(raw) {
    const valid = validateMessage(raw);
    if (!valid.ok) {
      this.log(`invalid message: ${valid.error}`);
      if (raw && raw.t === 'activity') {
        this.write({
          t: 'ack',
          id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : this.nextId(),
          ok: false,
          error: valid.error,
        });
      } else {
        this.write(statusMessage('error', { detail: valid.error, code: null }));
      }
      return Promise.resolve();
    }

    switch (raw.t) {
      case 'ping':
        this.write({ t: 'pong' });
        return Promise.resolve();
      case 'hello':
        return this.enqueue(() => this.onHello(raw));
      case 'activity':
        return this.enqueue(() => this.onActivity(raw));
      default:
        return Promise.resolve();
    }
  }

  async onHello(message) {
    if (this.client && this.client.clientId !== message.clientId) {
      this.client.close();
      this.client = null;
    }
    if (this.client?.closed) this.client = null;
    if (!this.client) this.client = this.makeClient(message.clientId);

    if (this.client.ready) {
      this.write(
        statusMessage('connected', {
          appName: this.client.appName ?? 'Discord',
          user: this.client.user ?? '',
        }),
      );
      return;
    }

    try {
      await this.client.connect();
    } catch (error) {
      this.write(statusMessage('error', { detail: error.message, code: error.code ?? null }));
      this.scheduleConnectRetry();
      return;
    }

    this.retryDelay = CONNECT_RETRY_START;
    const activity = this.lastActivity === undefined ? null : this.lastActivity;
    const result = await this.client.setActivity(activity);
    this.write(
      statusMessage('connected', {
        appName: result.appName ?? this.client.appName ?? 'Discord',
        user: this.client.user ?? '',
      }),
    );
  }

  async onActivity(message) {
    const id =
      typeof message.id === 'string' && message.id.length > 0 ? message.id : this.nextId();
    this.lastActivity = message.activity ?? null;
    if (!this.client) {
      this.write({ t: 'ack', id, ok: false, error: 'not connected' });
      return;
    }
    const result = await this.client.setActivity(message.activity ?? null);
    if (result.ok) {
      this.write({
        t: 'ack',
        id,
        ok: true,
        appName: result.appName ?? this.client.appName ?? 'Discord',
      });
      return;
    }
    this.write({ t: 'ack', id, ok: false, error: result.error ?? 'unknown error' });
  }

  scheduleConnectRetry() {
    if (this.closing || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(Math.round(this.retryDelay * 2), CONNECT_RETRY_MAX);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.enqueue(async () => {
        if (!this.client || this.client.ready) return;
        try {
          await this.client.connect();
        } catch (error) {
          this.log(`discord ipc still unavailable: ${error.message}`);
          this.scheduleConnectRetry();
          return;
        }
        this.retryDelay = CONNECT_RETRY_START;
        const activity = this.lastActivity === undefined ? null : this.lastActivity;
        await this.client.setActivity(activity);
      }).catch((error) => this.log(`connect retry failed: ${error.message}`));
    }, delay);
  }

  /* ----------------------------------------------------------------- life */

  start(input) {
    const decoder = new NativeMessageDecoder();
    input.on('data', (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        this.log(`stdin framing error: ${error.message}`);
        return;
      }
      for (const message of messages) this.handle(message);
    });
    input.on('end', () => this.shutdown(0));
    input.on('close', () => this.shutdown(0));
    input.on('error', (error) => {
      this.log(`stdin error: ${error.message}`);
      this.shutdown(1);
    });
  }

  shutdown(code) {
    if (this.closing) return;
    this.closing = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.client?.close();
    this.queue
      .catch(() => {})
      .then(() => {
        this.out.write('', () => this.onExit(code));
      });
  }
}

/* ---------------------------------------------------------------- selftest */

class LoopSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.peer = null;
  }

  write(chunk) {
    if (this.destroyed) return false;
    const peer = this.peer;
    if (peer && !peer.destroyed) peer.emit('data', Buffer.from(chunk));
    return true;
  }

  end() {
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

function fakeDiscordPipe() {
  const clientSide = new LoopSocket();
  const serverSide = new LoopSocket();
  clientSide.peer = serverSide;
  serverSide.peer = clientSide;

  const state = { handshakes: 0, frames: [] };
  const decoder = new DiscordFrameDecoder();
  serverSide.on('data', (chunk) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.op === 0) {
        state.handshakes += 1;
        serverSide.write(
          encodeDiscordFrame(1, {
            cmd: 'DISPATCH',
            evt: 'READY',
            data: { v: 1, user: { username: 'selftest' } },
          }),
        );
      } else if (frame.op === 1) {
        state.frames.push(frame.payload);
        serverSide.write(
          encodeDiscordFrame(1, {
            cmd: 'SET_ACTIVITY',
            evt: null,
            nonce: frame.payload.nonce,
            data: { name: 'Crunchyroll Selftest', activity: frame.payload.args?.activity ?? null },
          }),
        );
      }
    }
  });

  const connect = () => {
    const socket = clientSide;
    setImmediate(() => socket.emit('connect'));
    return socket;
  };

  return { connect, state };
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

export async function selftest() {
  const checks = [];
  const record = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

  // 1. Chrome framing survives a split at every byte boundary.
  const sample = { t: 'status', state: 'connected', appName: 'x', user: 'y' };
  const encoded = encodeNativeMessage(sample);
  let splits = 0;
  let splitOk = true;
  for (let i = 0; i <= encoded.length; i += 1) {
    const decoder = new NativeMessageDecoder();
    const messages = [
      ...decoder.push(encoded.subarray(0, i)),
      ...decoder.push(encoded.subarray(i)),
    ];
    if (messages.length !== 1 || messages[0].appName !== 'x') splitOk = false;
    splits += 1;
  }
  record('native-framing-byte-split', splitOk, `${splits} split points`);

  // 2. Activity validation accepts a watching activity and rejects a bad type.
  record('activity-valid', validateActivity({ type: 3, details: 'Episode 1' }).ok);
  record('activity-rejects-type-0', !validateActivity({ type: 0, details: 'x' }).ok);

  // 3. Full host round trip against the fake pipe.
  const capture = new Capture();
  const fake = fakeDiscordPipe();
  let connected = false;
  const host = new Host({
    stdout: capture,
    stderr: { write: () => {} },
    onExit: () => {},
    makeClient: (clientId) =>
      new DiscordPipeClient({
        clientId,
        logger: host.logger,
        pipes: ['selftest'],
        connectImpl: () => fake.connect(),
        rateLimit: 4,
        rateWindowMs: 20_000,
      }),
  });

  await host.handle({ t: 'hello', clientId: '123456789012345678' });
  let messages = capture.decode();
  const status = messages.find((m) => m.t === 'status');
  record(
    'hello-status',
    status?.state === 'connected' &&
      status?.appName === 'Crunchyroll Selftest' &&
      status?.user === 'selftest',
    JSON.stringify(status ?? null),
  );
  connected = status?.state === 'connected';

  await host.handle({ t: 'activity', id: 'n1', activity: { type: 3, details: 'Episode 1' } });
  messages = capture.decode();
  const ack = messages.find((m) => m.t === 'ack' && m.id === 'n1');
  record('activity-ack', ack?.ok === true && ack?.appName === 'Crunchyroll Selftest', JSON.stringify(ack ?? null));

  await host.handle({ t: 'activity', id: 'n2', activity: null });
  messages = capture.decode();
  const clear = messages.find((m) => m.t === 'ack' && m.id === 'n2');
  record('activity-clear', clear?.ok === true, JSON.stringify(clear ?? null));

  await host.handle({ t: 'activity', id: 'n3', activity: { type: 0 } });
  messages = capture.decode();
  const rejected = messages.find((m) => m.t === 'ack' && m.id === 'n3');
  record('activity-rejects-type-0-ack', rejected?.ok === false, JSON.stringify(rejected ?? null));

  await host.handle({ t: 'ping' });
  messages = capture.decode();
  record('ping-pong', messages.some((m) => m.t === 'pong'));

  record('handshake-once', fake.state.handshakes === 1, `${fake.state.handshakes} handshakes`);
  host.client?.close();
  if (!connected) record('connected', false, 'host never reported connected');

  const ok = checks.every((check) => check.ok);
  return { ok, checks };
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (process.argv.includes('--selftest')) {
    const result = await selftest();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  const host = new Host();
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  host.start(process.stdin);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[crunchyroll-presence] fatal: ${error.message}\n`);
    process.exit(1);
  });
}
