/**
 * Discord IPC transport for the native host.
 *
 * Two framings live here:
 *  - Chrome native messaging: uint32LE length + UTF-8 JSON (stdin/stdout)
 *  - Discord IPC:             uint32LE opcode + uint32LE length + UTF-8 JSON
 *
 * Both decoders reassemble partial reads, so a frame split at any byte
 * boundary decodes exactly once.
 */

import net from 'node:net';

export const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

export const DISCORD_PIPES = Object.freeze(
  Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`),
);

export const MAX_NATIVE_MESSAGE = 1024 * 1024;
export const MAX_DISCORD_FRAME = 8 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ frames */

export function encodeDiscordFrame(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + json.length);
  frame.writeUInt32LE(op >>> 0, 0);
  frame.writeUInt32LE(json.length, 4);
  json.copy(frame, 8);
  return frame;
}

export function encodeNativeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.length > MAX_NATIVE_MESSAGE) {
    throw new ProtocolError(`native message too large: ${json.length} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32LE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

function append(buffer, chunk) {
  if (!chunk || chunk.length === 0) return buffer;
  return buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
}

function decodeJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

/** Decoder for `opcode + length + json` frames read off the Discord pipe. */
export class DiscordFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.skipped = 0;
  }

  push(chunk) {
    this.buffer = append(this.buffer, chunk);
    const frames = [];
    for (;;) {
      if (this.buffer.length < 8) break;
      const op = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > MAX_DISCORD_FRAME) {
        throw new ProtocolError(`discord frame too large: ${length} bytes`);
      }
      if (this.buffer.length < 8 + length) break;
      const raw = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);
      const decoded = decodeJson(raw);
      if (!decoded.ok) {
        this.skipped += 1;
        continue;
      }
      frames.push({ op, payload: decoded.value });
    }
    return frames;
  }
}

/** Decoder for `length + json` frames read off stdin (Chrome native messaging). */
export class NativeMessageDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.skipped = 0;
  }

  push(chunk) {
    this.buffer = append(this.buffer, chunk);
    const messages = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE) {
        throw new ProtocolError(`native message too large: ${length} bytes`);
      }
      if (this.buffer.length < 4 + length) break;
      const raw = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      const decoded = decodeJson(raw);
      if (!decoded.ok) {
        this.skipped += 1;
        continue;
      }
      messages.push(decoded.value);
    }
    return messages;
  }
}

/* ------------------------------------------------------------------ timing */

const defaultTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const noop = () => {};

const defaultLogger = { info: noop, warn: noop, error: noop, status: noop };

/* ------------------------------------------------------------------ client */

export class DiscordPipeClient {
  constructor(options = {}) {
    this.clientId = options.clientId;
    this.pipes = options.pipes ?? DISCORD_PIPES;
    this.connectImpl = options.connectImpl ?? ((path) => net.connect(path));
    this.timers = options.timers ?? defaultTimers;
    this.logger = { ...defaultLogger, ...(options.logger ?? {}) };
    this.pid = options.pid ?? process.pid;

    // Backstop guard only: the extension already coalesces to 4 ordinary
    // sends per 20 s plus bypassing clears, so the host allows bursts up to
    // 5 per 20 s without adding a second throttle layer.
    this.rateLimit = options.rateLimit ?? 5;
    this.rateWindowMs = options.rateWindowMs ?? 20_000;
    this.backoffStart = options.backoffStart ?? 250;
    this.backoffMax = options.backoffMax ?? 5_000;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 5_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2_000;

    this.socket = null;
    this.pipePath = null;
    this.ready = false;
    this.closed = false;
    this.appName = null;
    this.user = null;

    this.lastActivity = null;
    this.hasActivity = false;

    this._decoder = null;
    this._pending = new Map();
    this._sentAt = [];
    this._queued = undefined;
    this._flushFailures = 0;
    this._flushTimer = null;
    this._reconnectTimer = null;
    this._backoff = this.backoffStart;
    this._seq = 0;
    this._connecting = null;
    this._readyWaiter = null;
  }

  /* --------------------------------------------------------------- connect */

  connect() {
    if (this._connecting) return this._connecting;
    this._connecting = this._connectLoop().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _connectLoop() {
    let lastError = null;
    for (const pipePath of this.pipes) {
      if (this.closed) break;
      try {
        const socket = await this._openPipe(pipePath);
        this._bind(socket, pipePath);
        const ready = await this._handshake();
        this.ready = true;
        this._backoff = this.backoffStart;
        const user = ready?.data?.user?.username;
        if (typeof user === 'string' && user.length > 0) this.user = user;
        this.logger.info(`discord ipc connected on ${pipePath}`);
        return { ok: true, pipePath, user: this.user };
      } catch (error) {
        lastError = error;
        this._teardown();
        this.logger.warn(`discord ipc probe failed on ${pipePath}: ${error.message}`);
      }
    }
    throw lastError ?? new ProtocolError('no discord ipc pipe found');
  }

  _openPipe(pipePath) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = this.connectImpl(pipePath);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const timer = this.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* already dead */
        }
        reject(new ProtocolError(`connect timeout on ${pipePath}`));
      }, this.connectTimeoutMs);

      const onConnect = () => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(socket);
      };
      const onError = (error) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        reject(error);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  _bind(socket, pipePath) {
    this.socket = socket;
    this.pipePath = pipePath;
    this._decoder = new DiscordFrameDecoder();

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (error) => {
      this.logger.error(`discord ipc error: ${error.message}`);
      this._readyWaiter?.reject(error);
      try {
        socket.destroy();
      } catch {
        /* already dead */
      }
    });
    socket.on('close', () => this._onClose(socket));
    socket.on('end', () => {
      try {
        socket.destroy();
      } catch {
        /* already dead */
      }
    });
  }

  _teardown() {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this._decoder = null;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        /* already dead */
      }
    }
  }

  _onClose(socket) {
    if (this.socket !== socket) return;
    const wasReady = this.ready;
    this.socket = null;
    this.pipePath = null;
    this.ready = false;
    this._decoder = null;
    this._failPending(new ProtocolError('discord ipc connection closed'));
    this._readyWaiter?.reject(new ProtocolError('discord ipc connection closed'));
    // The queued frame is superseded by lastActivity, which reconnect republishes.
    this._queued = undefined;
    if (this.closed) return;
    if (!wasReady) return;
    this.logger.warn('discord ipc dropped; reconnecting');
    if (this._flushTimer) {
      this.timers.clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || this._reconnectTimer) return;
    const delay = this._backoff;
    this._backoff = Math.min(Math.round(this._backoff * 2), this.backoffMax);
    this._reconnectTimer = this.timers.setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnect().catch((error) => {
        this.logger.error(`discord ipc reconnect error: ${error.message}`);
      });
    }, delay);
  }

  async _reconnect() {
    try {
      await this.connect();
    } catch (error) {
      this.logger.warn(`discord ipc reconnect failed: ${error.message}`);
      this._scheduleReconnect();
      return;
    }
    await this._afterReconnect();
  }

  async _afterReconnect() {
    if (this.hasActivity) {
      const result = await this._sendGuarded(this.lastActivity).catch((error) => ({
        ok: false,
        error: error.message,
      }));
      if (!result.ok && !result.queued) {
        this.logger.warn(`discord activity republish failed: ${result.error}`);
      }
    }
    this.logger.status(this.statusPayload({ reconnected: true }));
  }

  /* ------------------------------------------------------------- handshake */

  _handshake() {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (!this._readyWaiter) return;
        this._readyWaiter = null;
        reject(new ProtocolError('discord ipc handshake timed out'));
      }, this.replyTimeoutMs);

      this._readyWaiter = {
        resolve: (ready) => {
          this.timers.clearTimeout(timer);
          this._readyWaiter = null;
          resolve(ready);
        },
        reject: (error) => {
          this.timers.clearTimeout(timer);
          this._readyWaiter = null;
          reject(error);
        },
      };

      try {
        this._write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
      } catch (error) {
        this._readyWaiter?.reject(error);
      }
    });
  }

  /* ------------------------------------------------------------- transport */

  _write(op, payload) {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new ProtocolError('discord ipc not connected');
    socket.write(encodeDiscordFrame(op, payload));
  }

  _request(payload) {
    const nonce = `${this.timers.now().toString(36)}-${++this._seq}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const frame = { ...payload, nonce };

    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (!this._pending.delete(nonce)) return;
        reject(new ProtocolError('discord ipc reply timed out'));
      }, this.replyTimeoutMs);

      this._pending.set(nonce, {
        resolve: (value) => {
          this.timers.clearTimeout(timer);
          this._pending.delete(nonce);
          resolve(value);
        },
        reject: (error) => {
          this.timers.clearTimeout(timer);
          this._pending.delete(nonce);
          reject(error);
        },
      });

      try {
        this._write(OP.FRAME, frame);
      } catch (error) {
        this._pending.get(nonce)?.reject(error);
      }
    });
  }

  _failPending(error) {
    for (const entry of this._pending.values()) entry.reject(error);
    this._pending.clear();
  }

  _onData(chunk) {
    let frames;
    try {
      frames = this._decoder.push(chunk);
    } catch (error) {
      this.logger.error(`discord ipc framing error: ${error.message}`);
      try {
        this.socket?.destroy();
      } catch {
        /* already dead */
      }
      return;
    }
    for (const frame of frames) this._onFrame(frame);
  }

  _onFrame({ op, payload }) {
    if (op === OP.PONG) return;
    if (op === OP.PING) {
      try {
        this._write(OP.PONG, {});
      } catch {
        /* socket went away */
      }
      return;
    }
    if (op === OP.CLOSE) {
      this.logger.warn('discord ipc sent CLOSE');
      try {
        this.socket?.destroy();
      } catch {
        /* already dead */
      }
      return;
    }
    if (op !== OP.FRAME) return;

    if (payload?.evt === 'READY') {
      this._readyWaiter?.resolve(payload);
      return;
    }
    const nonce = payload?.nonce;
    if (typeof nonce === 'string' && this._pending.has(nonce)) {
      this._pending.get(nonce).resolve(payload);
      return;
    }
    this.logger.info(`discord ipc frame ignored (evt=${String(payload?.evt)})`);
  }

  /* -------------------------------------------------------------- activity */

  /** Remember an activity without requiring a live pipe (republished on reconnect). */
  remember(activity) {
    this.lastActivity = activity ?? null;
    this.hasActivity = true;
  }

  async setActivity(activity) {
    this.remember(activity);
    if (!this.ready || !this.socket || this.socket.destroyed) {
      return { ok: false, error: 'discord ipc not connected', appName: this.appName };
    }
    return this._sendGuarded(this.lastActivity);
  }

  _prune() {
    const cutoff = this.timers.now() - this.rateWindowMs;
    while (this._sentAt.length > 0 && this._sentAt[0] <= cutoff) this._sentAt.shift();
  }

  async _sendGuarded(activity) {
    // A null clear bypasses the bucket: it is sent immediately even when the
    // window is full, so presence never takes ~20 s to clear.
    if (activity === null || activity === undefined) return this._sendNow(null);
    this._prune();
    if (this._sentAt.length >= this.rateLimit) {
      // Coalesce: the newest activity wins, older deferred ones are dropped.
      this._queued = { activity: activity ?? null };
      this._scheduleFlush();
      return { ok: true, queued: true, appName: this.appName };
    }
    return this._sendNow(activity);
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._prune();
    // An empty window sends at once; otherwise wait for the oldest send to
    // age out.
    const windowWait =
      this._sentAt.length === 0
        ? 1
        : Math.max(0, this._sentAt[0] + this.rateWindowMs - this.timers.now()) + 1;
    // A rejected flush backs off (1 s, 2 s, 4 s, capped) instead of spinning
    // on the window edge.
    const retryWait =
      (this._flushFailures || 0) > 0
        ? 1000 * 2 ** (Math.min(this._flushFailures, 3) - 1)
        : 0;
    const wait = Math.max(windowWait, retryWait);
    this._flushTimer = this.timers.setTimeout(() => {
      this._flushTimer = null;
      this._flush().catch((error) => this.logger.error(`discord activity flush failed: ${error.message}`));
    }, wait);
  }

  async _flush() {
    if (this._queued === undefined) return;
    if (!this.ready) {
      // The pipe is down but a payload is queued: reschedule instead of
      // stranding it, so the next window or reconnect delivers it.
      this._scheduleFlush();
      return;
    }
    const pending = this._queued;
    this._queued = undefined;
    const result = await this._sendNow(pending.activity);
    if (result.ok) {
      this._flushFailures = 0;
    } else {
      this.logger.warn(`discord activity flush rejected: ${result.error}`);
      if (this._queued === undefined) {
        // No newer payload superseded the failed one: keep it and retry
        // with backoff until it sends or a newer payload takes its place.
        this._queued = pending;
        this._flushFailures = Math.min((this._flushFailures || 0) + 1, 3);
      } else {
        this._flushFailures = 0;
      }
    }
    if (this._queued !== undefined) this._scheduleFlush();
  }

  async _sendNow(activity) {
    let reply;
    try {
      reply = await this._request({
        cmd: 'SET_ACTIVITY',
        args: { pid: this.pid, activity: activity ?? null },
      });
    } catch (error) {
      return { ok: false, error: error.message, appName: this.appName };
    }

    if (reply?.evt === 'ERROR' || reply?.evt === 'INVALID') {
      const detail = reply?.data?.message ?? 'SET_ACTIVITY rejected';
      return {
        ok: false,
        error: String(detail),
        code: Number.isInteger(reply?.data?.code) ? reply.data.code : null,
        appName: this.appName,
      };
    }

    // Only successful sends seed the rolling window.
    this._sentAt.push(this.timers.now());
    const name = reply?.data?.name;
    if (typeof name === 'string' && name.length > 0) this.appName = name;
    return { ok: true, appName: this.appName, data: reply?.data ?? null };
  }

  ping() {
    this._write(OP.PING, {});
    return true;
  }

  statusPayload(extra = {}) {
    return {
      state: 'connected',
      appName: this.appName ?? 'Discord',
      user: this.user ?? '',
      ...extra,
    };
  }

  /* ----------------------------------------------------------------- close */

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._flushTimer) {
      this.timers.clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._reconnectTimer) {
      this.timers.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._failPending(new ProtocolError('discord ipc client closed'));
    this._readyWaiter?.reject(new ProtocolError('discord ipc client closed'));
    this._teardown();
  }
}
