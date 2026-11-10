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
import { ArRpcClient } from './arrpc.mjs';
import { statusMessage, validateActivity, validateMessage } from './protocol.mjs';
import { classifyBridgeFailure } from '../bridge-status.js';

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

    // Which transport this process is on. `preference` is what the extension
    // asked for; `transport` is what was actually chosen and is what the status
    // frame reports.
    this.preference = null;
    this.transport = null;

    this.logger = {
      info: (line) => this.log(line),
      warn: (line) => this.log(line),
      error: (line) => this.log(line),
      status: (status) => this.emitStatus(status),
    };
    this.defaultIpc = (clientId) => new DiscordPipeClient({ clientId, logger: this.logger });
    this.defaultArrpc = (clientId) => new ArRpcClient({ clientId, logger: this.logger });
    this.makeClient = options.makeClient ?? this.defaultIpc;
    this.makeArrpc = options.makeArrpc ?? this.defaultArrpc;
  }

  /**
   * The wire resolves one client per preference. `ipc` and `arrpc` are forced;
   * `auto` starts on Discord IPC, the primary desktop path, and only reaches
   * arRPC through `connectClient`'s fallback. An `auto` host narrowed to a
   * custom IPC client and no custom arRPC factory has no fallback to make, so
   * it can never probe the network behind an embedder's back. Measured per
   * hello because a caller may assign `makeClient` after construction (the
   * existing host tests do).
   */
  arrpcWired() {
    return this.makeClient === this.defaultIpc || this.makeArrpc !== this.defaultArrpc;
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
      this.write(
        statusMessage('error', {
          detail: status.detail,
          code: status.code,
          // A transient diagnostic never becomes a permanent error.
          fatal: status.fatal !== false,
          transport: this.transport ?? undefined,
        }),
      );
      return;
    }
    if (
      status?.state === 'waiting' ||
      status?.state === 'unavailable' ||
      status?.state === 'disconnected'
    ) {
      this.write(
        statusMessage('waiting', {
          detail: status.detail,
          reason: status.reason ?? classifyBridgeFailure(status?.detail).kind,
          transport: this.transport ?? undefined,
        }),
      );
      return;
    }
    this.write(
      statusMessage('connected', {
        appName: status?.appName,
        user: status?.user,
        transport: this.transport ?? undefined,
      }),
    );
  }

  /** Write the neutral waiting frame for a non-fatal connect failure. */
  emitFailure(error) {
    if (error && error.fatal) {
      this.write(
        statusMessage('error', {
          detail: error.message,
          code: error.code ?? null,
          fatal: true,
          transport: this.transport ?? undefined,
        }),
      );
      return;
    }
    const verdict = classifyBridgeFailure(error?.message);
    const detail = error?.message ?? verdict.detail;
    this.log(`bridge waiting: ${detail}`);
    this.write(
      statusMessage('waiting', {
        detail,
        reason: verdict.kind,
        transport: this.transport ?? undefined,
      }),
    );
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
        // A malformed envelope is a local defect, not a Discord absence:
        // keep the wording neutral on the wire and non-fatal.
        this.write(statusMessage('error', { detail: valid.error, code: null, fatal: false }));
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
    // Missing transport means "auto": Discord IPC first, arRPC as the fallback.
    const preference = message.transport ?? 'auto';
    const sameClient =
      this.client &&
      !this.client.closed &&
      this.client.clientId === message.clientId &&
      this.preference === preference;
    if (this.client && !sameClient) {
      this.client.close();
      this.client = null;
      this.transport = null;
    }
    this.preference = preference;
    if (!this.client && !this.createClient(message.clientId)) {
      this.transport = 'arrpc';
      this.log('arrpc transport requested, but this host has no arRPC client wired');
      this.write(
        statusMessage('waiting', {
          detail: 'arRPC transport is not wired in this host',
          reason: 'arrpc-closed',
          transport: 'arrpc',
        }),
      );
      return;
    }

    if (this.client.ready) {
      this.write(
        statusMessage('connected', {
          appName: this.client.appName ?? 'Discord',
          user: this.client.user ?? '',
          transport: this.transport,
        }),
      );
      return;
    }

    try {
      await this.connectClient(message.clientId);
    } catch (error) {
      this.emitFailure(error);
      // A permanent handshake rejection (invalid client id) never recovers
      // on retry: hold the error until a new hello carries a new id.
      if (!error || !error.fatal) this.scheduleConnectRetry();
      else this.log(`discord ipc permanent failure, waiting for a new client id: ${error.message}`);
      return;
    }

    this.retryDelay = CONNECT_RETRY_START;
    if (this.lastActivity === undefined) {
      // First connect with nothing to publish: report connected without
      // pushing a null clear to Discord.
      this.write(
        statusMessage('connected', {
          appName: this.client.appName ?? 'Discord',
          user: this.client.user ?? '',
          transport: this.transport,
        }),
      );
      return;
    }
    const result = await this.client.setActivity(this.lastActivity);
    this.write(
      statusMessage('connected', {
        appName: result.appName ?? this.client.appName ?? 'Discord',
        user: this.client.user ?? '',
        transport: this.transport,
      }),
    );
  }

  /** Build the client for the resolved preference and record the transport. */
  createClient(clientId) {
    if (this.preference === 'arrpc') {
      if (!this.arrpcWired()) return false;
      this.client = this.makeArrpc(clientId);
      this.transport = 'arrpc';
      return true;
    }
    // `ipc`, and the primary leg of `auto`: desktop Discord over the pipe.
    this.client = this.makeClient(clientId);
    this.transport = 'discord-ipc';
    return true;
  }

  /**
   * Connect the chosen client. Under `auto` an unavailable Discord IPC falls
   * back to arRPC once per hello; the forced preferences never fall back, so
   * the caller's catch reports the absence. When both are absent the primary
   * failure is the one reported, so a desktop user still reads "Discord is not
   * running" rather than an arRPC diagnostic.
   */
  async connectClient(clientId) {
    try {
      await this.client.connect();
    } catch (error) {
      if (this.preference !== 'auto' || this.transport !== 'discord-ipc') throw error;
      if (!this.arrpcWired()) throw error;
      this.log(`discord ipc unavailable (${error.message}); trying arrpc`);
      const fallback = this.makeArrpc(clientId);
      try {
        await fallback.connect();
      } catch (secondary) {
        fallback.close();
        this.log(`arrpc unavailable (${secondary.message})`);
        throw error;
      }
      this.client.close();
      this.client = fallback;
      this.transport = 'arrpc';
    }
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
          this.emitFailure(error);
          if (error && error.fatal) {
            this.log(`discord ipc permanent failure, waiting for a new client id: ${error.message}`);
            return;
          }
          this.log(`discord ipc still unavailable: ${error.message}`);
          this.scheduleConnectRetry();
          return;
        }
        this.retryDelay = CONNECT_RETRY_START;
        if (this.lastActivity === undefined) {
          this.write(
            statusMessage('connected', {
              appName: this.client.appName ?? 'Discord',
              user: this.client.user ?? '',
              transport: this.transport,
            }),
          );
          return;
        }
        const activity = this.lastActivity;
        const result = await this.client.setActivity(activity);
        this.write(
          statusMessage('connected', {
            appName: result.appName ?? this.client.appName ?? 'Discord',
            user: this.client.user ?? '',
            transport: this.transport,
          }),
        );
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

export function fakeDiscordPipe() {
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

  return {
    connect,
    state,
    /** Emulate Discord quitting: drop the connected pipe. */
    drop() {
      clientSide.destroy();
      serverSide.destroy();
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
      status?.appName === 'Discord' &&
      status?.user === 'selftest',
    JSON.stringify(status ?? null),
  );
  record('hello-skips-clear', fake.state.frames.length === 0, `${fake.state.frames.length} frames`);
  record('hello-transport-ipc', status?.transport === 'discord-ipc', JSON.stringify(status ?? null));
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

  // 4. Transport selection: auto uses Discord IPC when it is available, falls
  //    back to arRPC only when IPC is absent, and a forced transport never
  //    falls back.
  const transportRun = async (preference, { ipcFails = false, arrpcFails = false } = {}) => {
    const out = new Capture();
    const created = [];
    const clientId = '123456789012345678';
    const fakeArrpc = {
      clientId,
      ready: false,
      closed: false,
      appName: null,
      user: null,
      async connect() {
        if (arrpcFails) throw new Error('arrpc is not listening on 127.0.0.1');
        this.ready = true;
        this.user = 'arrpc';
        return { ok: true, port: 6463, user: 'arrpc' };
      },
      async setActivity() {
        return { ok: true, appName: 'Discord' };
      },
      close() {
        this.closed = true;
        created.push('arrpc.close');
      },
    };
    const fakeIpc = {
      clientId,
      ready: false,
      closed: false,
      appName: 'Discord',
      user: 'selftest',
      async connect() {
        if (ipcFails) throw new Error('connect ENOENT \\\\.\\pipe\\discord-ipc-0');
        this.ready = true;
        return { ok: true };
      },
      async setActivity() {
        return { ok: true, appName: 'Discord' };
      },
      close() {
        this.closed = true;
        created.push('ipc.close');
      },
    };
    const probe = new Host({
      stdout: out,
      stderr: { write: () => {} },
      onExit: () => {},
      makeClient: () => {
        created.push('ipc.create');
        return fakeIpc;
      },
      makeArrpc: () => {
        created.push('arrpc.create');
        return fakeArrpc;
      },
    });
    await probe.handle({
      t: 'hello',
      clientId,
      ...(preference === undefined ? {} : { transport: preference }),
    });
    probe.shutdown(0);
    return {
      created,
      status: out.decode().filter((message) => message.t === 'status').at(-1),
    };
  };

  const autoIpc = await transportRun(undefined);
  record(
    'transport-auto-prefers-ipc',
    autoIpc.status?.state === 'connected' &&
      autoIpc.status?.transport === 'discord-ipc' &&
      autoIpc.status?.user === 'selftest' &&
      !autoIpc.created.includes('arrpc.create'),
    JSON.stringify(autoIpc.status ?? null),
  );

  const autoFallback = await transportRun(undefined, { ipcFails: true });
  record(
    'transport-auto-falls-back-to-arrpc',
    autoFallback.status?.state === 'connected' &&
      autoFallback.status?.transport === 'arrpc' &&
      autoFallback.status?.user === 'arrpc' &&
      autoFallback.created.includes('ipc.close') &&
      autoFallback.created.includes('arrpc.create'),
    JSON.stringify(autoFallback.status ?? null),
  );

  const strictArrpc = await transportRun('arrpc', { arrpcFails: true });
  record(
    'transport-arrpc-never-falls-back',
    strictArrpc.status?.state === 'waiting' &&
      strictArrpc.status?.reason === 'arrpc-closed' &&
      strictArrpc.status?.transport === 'arrpc' &&
      !strictArrpc.created.includes('ipc.create'),
    JSON.stringify(strictArrpc.status ?? null),
  );

  const explicitIpc = await transportRun('ipc');
  record(
    'transport-ipc-skips-arrpc',
    explicitIpc.status?.state === 'connected' &&
      explicitIpc.status?.transport === 'discord-ipc' &&
      !explicitIpc.created.includes('arrpc.create'),
    JSON.stringify(explicitIpc.status ?? null),
  );

  // A forced ipc with no Discord must wait, not silently become the arRPC
  // fallback: only `auto` may cross transports.
  const strictIpc = await transportRun('ipc', { ipcFails: true });
  record(
    'transport-ipc-never-falls-back',
    strictIpc.status?.state === 'waiting' &&
      strictIpc.status?.reason === 'discord-closed' &&
      strictIpc.status?.transport === 'discord-ipc' &&
      !strictIpc.created.includes('arrpc.create'),
    JSON.stringify(strictIpc.status ?? null),
  );

  // Auto with neither transport: the primary absence is what the user reads.
  const autoNone = await transportRun(undefined, { ipcFails: true, arrpcFails: true });
  record(
    'transport-auto-reports-the-primary-absence',
    autoNone.status?.state === 'waiting' &&
      autoNone.status?.reason === 'discord-closed' &&
      autoNone.status?.transport === 'discord-ipc' &&
      autoNone.created.includes('arrpc.close'),
    JSON.stringify(autoNone.status ?? null),
  );

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
