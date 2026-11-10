/**
 * arRPC transport for the native host.
 *
 * arRPC runs a WebSocket listener that speaks Discord's RPC commands, so the
 * host reaches Discord Web the same way Vencord does. Frames are plain JSON
 * text; only the READY, ERROR and nonce-matched replies matter here.
 *
 * Nothing in this file binds a port: it is a client, and every socket is
 * injected in tests. No `Origin` header is set (arRPC rejects a foreign one,
 * and Node's global WebSocket sends none).
 */

export const ARRPC_PORTS = Object.freeze(
  Array.from({ length: 10 }, (_, i) => 6463 + i),
);

/** arRPC's mock user: the only identity that proves this listener is arRPC. */
export const ARRPC_MOCK_USER_ID = '1045800378228281345';

export class ProtocolError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const CONNECT_TIMEOUT_MS = 1_200;
const REPLY_TIMEOUT_MS = 5_000;
const BACKOFF_START = 250;
const BACKOFF_MAX = 5_000;

const defaultTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const noop = () => {};

const defaultLogger = { info: noop, warn: noop, error: noop, status: noop };

/** A listener that answers READY with arRPC's mock user is arRPC. */
function isArRpcReady(payload) {
  const user = payload?.data?.user;
  return user?.id === ARRPC_MOCK_USER_ID || user?.username === 'arrpc';
}

let nonceSeq = 0;

export class ArRpcClient {
  constructor(options = {}) {
    this.clientId = options.clientId;
    this.ports = options.ports ?? ARRPC_PORTS;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.timers = options.timers ?? defaultTimers;
    this.logger = { ...defaultLogger, ...(options.logger ?? {}) };
    this.pid = options.pid ?? process.pid;

    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.backoffStart = options.backoffStart ?? BACKOFF_START;
    this.backoffMax = options.backoffMax ?? BACKOFF_MAX;

    this.ws = null;
    this.port = null;
    this.ready = false;
    this.closed = false;
    this.appName = null;
    this.user = null;

    this.lastActivity = null;
    this.hasActivity = false;

    this._pending = new Map();
    this._readyWaiter = null;
    this._seq = 0;
    this._backoff = this.backoffStart;
    this._reconnectTimer = null;
    this._connecting = null;
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
    if (typeof this.WebSocketImpl !== 'function') {
      throw new ProtocolError('arrpc needs a WebSocket implementation');
    }
    let lastError = null;
    // One bounded budget for the whole probe: auto must fall back to Discord
    // IPC quickly rather than spend a timeout on every one of ten ports.
    const deadline = this.timers.now() + this.connectTimeoutMs;

    for (const port of this.ports) {
      if (this.closed) break;
      const remaining = deadline - this.timers.now();
      if (remaining <= 0) break;
      try {
        const ready = await this._openPort(port, remaining);
        // A socket that closes between READY and this line must not leave a
        // ready client with nothing behind it.
        if (!this.ws) throw new ProtocolError(`arrpc closed before ready on ${port}`);
        this.ready = true;
        this._backoff = this.backoffStart;
        const user = ready?.data?.user?.username;
        if (typeof user === 'string' && user.length > 0) this.user = user;
        this.logger.info(`arrpc connected on ${port}`);
        return { ok: true, port, user: this.user };
      } catch (error) {
        lastError = error;
        this._teardown();
        this.logger.warn(`arrpc probe failed on ${port}: ${error.message}`);
      }
    }

    if (lastError) {
      const detail = lastError.message ?? String(lastError);
      throw new ProtocolError(`arrpc is not listening on 127.0.0.1 (${detail})`);
    }
    throw new ProtocolError('arrpc is not listening on 127.0.0.1');
  }

  _openPort(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new this.WebSocketImpl(`ws://127.0.0.1:${port}/?v=1&client_id=${this.clientId}`);
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = ws;
      this.port = port;

      let settled = false;
      const timer = this.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        this._readyWaiter = null;
        this._teardown();
        reject(new ProtocolError(`arrpc connect timeout on ${port}`));
      }, timeoutMs);

      this._readyWaiter = {
        resolve: (ready) => {
          if (settled) return;
          settled = true;
          this.timers.clearTimeout(timer);
          this._readyWaiter = null;
          resolve(ready);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          this.timers.clearTimeout(timer);
          this._readyWaiter = null;
          reject(error);
        },
      };

      // A discarded socket must never speak for the current one.
      const owns = () => this.ws === ws;

      ws.addEventListener('open', () => {
        this.logger.info(`arrpc socket open on ${port}`);
      });
      ws.addEventListener('message', (event) => {
        if (!owns()) return;
        this._onData(event);
      });
      ws.addEventListener('error', () => {
        if (owns()) this._readyWaiter?.reject(new ProtocolError(`arrpc connection failed on ${port}`));
      });
      ws.addEventListener('close', () => this._onClose(ws));
    });
  }

  _teardown() {
    const ws = this.ws;
    this.ws = null;
    this.port = null;
    this.ready = false;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already dead */
      }
    }
  }

  _onClose(ws) {
    if (this.ws !== ws) return;
    const wasReady = this.ready;
    this.ws = null;
    this.port = null;
    this.ready = false;
    this._failPending(new ProtocolError('arrpc connection closed'));
    this._readyWaiter?.reject(new ProtocolError('arrpc connection closed'));
    if (this.closed) return;
    if (!wasReady) return;
    // A probe that closes before READY is handled by connect(); only a live
    // session is worth telling the extension about.
    this.logger.status({
      state: 'disconnected',
      reason: 'arrpc-closed',
      detail: 'arrpc connection closed',
    });
    this.logger.warn('arrpc dropped; reconnecting');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || this._reconnectTimer) return;
    const delay = this._backoff;
    this._backoff = Math.min(Math.round(this._backoff * 2), this.backoffMax);
    this._reconnectTimer = this.timers.setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnect().catch((error) => {
        this.logger.error(`arrpc reconnect error: ${error.message}`);
      });
    }, delay);
  }

  async _reconnect() {
    try {
      await this.connect();
    } catch (error) {
      this.logger.warn(`arrpc reconnect failed: ${error.message}`);
      this._scheduleReconnect();
      return;
    }
    await this._afterReconnect();
  }

  async _afterReconnect() {
    if (this.hasActivity) {
      const result = await this._sendNow(this.lastActivity).catch((error) => ({
        ok: false,
        error: error.message,
      }));
      if (!result.ok) this.logger.warn(`arrpc activity republish failed: ${result.error}`);
    }
    this.logger.status(this.statusPayload({ reconnected: true }));
  }

  /* --------------------------------------------------------------- frames */

  _onData(event) {
    const raw = event?.data;
    let text;
    if (typeof raw === 'string') text = raw;
    else if (raw && typeof raw.toString === 'function') text = raw.toString();
    else return;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      this.logger.warn('arrpc sent an unparseable frame');
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    if (payload.evt === 'READY') {
      if (this._readyWaiter) {
        if (isArRpcReady(payload)) {
          this._readyWaiter.resolve(payload);
        } else {
          this._readyWaiter.reject(
            new ProtocolError('the listener on this port is not arrpc'),
          );
        }
      }
      return;
    }

    const nonce = payload.nonce;
    if (typeof nonce === 'string' && this._pending.has(nonce)) {
      this._pending.get(nonce).resolve(payload);
      return;
    }
    this.logger.info(`arrpc frame ignored (evt=${String(payload.evt)})`);
  }

  _request(frame) {
    const nonce = frame.nonce;
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (!this._pending.delete(nonce)) return;
        reject(new ProtocolError('arrpc reply timed out'));
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
        this.ws.send(JSON.stringify(frame));
      } catch (error) {
        this._pending.get(nonce)?.reject(error);
      }
    });
  }

  _failPending(error) {
    for (const entry of this._pending.values()) entry.reject(error);
    this._pending.clear();
  }

  nextNonce() {
    nonceSeq += 1;
    return `${this.timers.now().toString(36)}-${nonceSeq}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  /* ------------------------------------------------------------- activity */

  /** Remember an activity without requiring a live socket (republished on reconnect). */
  remember(activity) {
    this.lastActivity = activity ?? null;
    this.hasActivity = true;
  }

  async setActivity(activity) {
    this.remember(activity);
    if (!this.ready || !this.ws) {
      return { ok: false, error: 'arrpc not connected', appName: this.appName };
    }
    return this._sendNow(this.lastActivity);
  }

  async _sendNow(activity) {
    const frame = {
      cmd: 'SET_ACTIVITY',
      args: { pid: this.pid, activity: activity ?? null },
      nonce: this.nextNonce(),
    };

    let reply;
    try {
      reply = await this._request(frame);
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

    const name = reply?.data?.name;
    if (typeof name === 'string' && name.length > 0) this.appName = name;
    return { ok: true, appName: this.appName ?? 'Discord', data: reply?.data ?? null };
  }

  statusPayload(extra = {}) {
    return {
      state: 'connected',
      appName: this.appName ?? 'Discord',
      user: this.user ?? '',
      ...extra,
    };
  }

  /* ---------------------------------------------------------------- close */

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._reconnectTimer) {
      this.timers.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._failPending(new ProtocolError('arrpc client closed'));
    this._readyWaiter?.reject(new ProtocolError('arrpc client closed'));
    this._teardown();
  }
}
