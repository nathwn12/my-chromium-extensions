/**
 * One Discord desktop IPC connection for one source.
 *
 * Discord listens on `\\.\pipe\discord-ipc-0` through `-9` and frames a
 * payload as `uint32LE opcode | uint32LE length | UTF-8 JSON`. The client
 * probes the pipes in order, sends `{v:1, client_id}` as opcode 0, accepts the
 * first READY dispatch, and matches SET_ACTIVITY replies by nonce.
 *
 * One client per source means one pipe and one socket per source, so Discord
 * desktop stacks both activities exactly as the web client does.
 *
 * Every failure is returned, never thrown: the host must keep the native loop
 * alive. This client does not reconnect on its own; the host owns backoff and
 * resends the last activity for both transports through one code path.
 */

import net from "node:net";

export const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

export const DISCORD_PIPES = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `\\\\.\\pipe\\discord-ipc-${index}`),
);

export const MAX_DISCORD_FRAME = 8 * 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
export const DEFAULT_REPLY_TIMEOUT_MS = 5000;

const defaultTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** Encode one `opcode | length | json` frame. */
export function encodeDiscordFrame(op, payload) {
  if (!Number.isInteger(op) || op < 0 || op > 4) {
    throw new TypeError("opcode must be an integer 0-4");
  }
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_DISCORD_FRAME) {
    throw new RangeError(`discord frame of ${json.length} bytes exceeds ${MAX_DISCORD_FRAME}`);
  }
  const frame = Buffer.allocUnsafe(8 + json.length);
  frame.writeUInt32LE(op, 0);
  frame.writeUInt32LE(json.length, 4);
  json.copy(frame, 8);
  return frame;
}

/** Decoder for `opcode + length + json` frames read off the pipe. */
export class DiscordFrameDecoder {
  #buffer = Buffer.alloc(0);

  /** @param {Uint8Array} chunk @returns {{op: number, payload: unknown}[]} */
  push(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("chunk must be a Uint8Array");
    }
    this.#buffer = this.#buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.#buffer, chunk]);

    const frames = [];
    for (;;) {
      if (this.#buffer.length < 8) break;
      const op = this.#buffer.readUInt32LE(0);
      const length = this.#buffer.readUInt32LE(4);
      if (length > MAX_DISCORD_FRAME) {
        // Reset so one bad length cannot poison every later chunk: the caller
        // destroys the socket and the next connection decodes cleanly.
        this.#buffer = Buffer.alloc(0);
        throw new RangeError(`discord frame of ${length} bytes exceeds ${MAX_DISCORD_FRAME}`);
      }
      if (this.#buffer.length < 8 + length) break;
      const body = this.#buffer.subarray(8, 8 + length);
      this.#buffer = this.#buffer.subarray(8 + length);
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        // A frame that is not JSON carries nothing this client can match.
        continue;
      }
      frames.push({ op, payload });
    }
    return frames;
  }

  get pendingBytes() {
    return this.#buffer.length;
  }
}

/** A close that Discord sent on purpose: retrying the same id will fail again. */
function fatalError(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

function taggedError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

export class DiscordIpcClient {
  #clientId;
  #source;
  #logger;
  #pipes;
  #connectImpl;
  #pid;
  #rateLimit;
  #rateWindowMs;
  #connectTimeoutMs;
  #replyTimeoutMs;
  #timers;
  #onClose;

  #socket = null;
  #decoder = null;
  #ready = false;
  #closed = false;
  #pipePath = null;
  #appName = null;
  #user = null;
  #pending = new Map();
  #sentAt = [];
  #queued;
  #flushTimer = null;
  #seq = 0;
  #connecting = null;
  #readyWaiter = null;

  constructor({
    clientId,
    source,
    logger = null,
    pipes = DISCORD_PIPES,
    connectImpl = (pipePath) => net.connect(pipePath),
    pid = process.pid,
    // The worker paces every update (1.5 s gap, 8 per 20 s; 0.9 s and 30 per
    // 30 s when the playback rate is not 1x) and this guard only exists for a
    // host driven directly, so its budget must never bind under the worker's:
    // 40 per 20 s leaves the worker's ceiling in charge in either mode.
    rateLimit = 40,
    rateWindowMs = 20_000,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
    timers = defaultTimers,
    onClose = null,
  } = {}) {
    if (typeof clientId !== "string" || clientId.length === 0) {
      throw new TypeError("clientId is required");
    }
    if (typeof source !== "string" || source.length === 0) {
      throw new TypeError("source is required");
    }
    if (!Array.isArray(pipes) || pipes.length === 0
      || pipes.some((pipePath) => typeof pipePath !== "string" || pipePath.length === 0)) {
      throw new TypeError("pipes must be a non-empty array of paths");
    }
    this.#clientId = clientId;
    this.#source = source;
    this.#logger = logger;
    this.#pipes = pipes;
    this.#connectImpl = connectImpl;
    this.#pid = pid;
    this.#rateLimit = rateLimit;
    this.#rateWindowMs = rateWindowMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#timers = timers;
    this.#onClose = typeof onClose === "function" ? onClose : null;
  }

  get ready() {
    return this.#ready;
  }

  get pipePath() {
    return this.#pipePath;
  }

  get appName() {
    return this.#appName;
  }

  get user() {
    return this.#user;
  }

  /**
   * Probe each pipe until a READY answers.
   * @returns {Promise<{ok: true, pipePath: string, user: string|null}
   *   | {ok: false, error: string, detail: string, fatal?: true}>}
   */
  connect() {
    if (this.#closed) {
      return Promise.resolve({ ok: false, error: "discord-closed", detail: "client is closed" });
    }
    if (this.#ready) {
      return Promise.resolve({ ok: true, pipePath: this.#pipePath, user: this.#user });
    }
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connectLoop().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  /**
   * Send one SET_ACTIVITY and wait for the reply with the same nonce.
   * @param {object|null} activity
   * @returns {Promise<{ok: true, appName: string|null, queued?: true}
   *   | {ok: false, error: string}>}
   */
  async setActivity(activity) {
    if (activity !== null && (typeof activity !== "object" || Array.isArray(activity))) {
      return { ok: false, error: "invalid-activity" };
    }
    if (this.#closed || !this.#ready || !this.#socket || this.#socket.destroyed) {
      return { ok: false, error: "discord-closed" };
    }
    // A clear bypasses the budget: presence never takes a window to disappear.
    if (activity === null) return this.#send(null);

    this.#prune();
    if (this.#sentAt.length >= this.#rateLimit) {
      this.#queued = activity;
      this.#scheduleFlush();
      return { ok: true, appName: this.#appName, queued: true };
    }
    return this.#send(activity);
  }

  /** Close the pipe without reporting it as an unexpected disconnect. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearFlush();
    this.#queued = undefined;
    this.#readyWaiter?.reject(taggedError("discord-closed", "discord ipc client closed"));
    this.#failPending("discord-closed", "discord ipc client closed");
    this.#teardown();
  }

  /* ------------------------------------------------------------- connecting */

  async #connectLoop() {
    let primary = null;

    for (const pipePath of this.#pipes) {
      if (this.#closed) break;

      let socket;
      try {
        socket = await this.#openPipe(pipePath);
      } catch (error) {
        primary ??= error;
        this.#logger?.warn?.(`[discord-ipc:${this.#source}] probe failed on ${pipePath}: ${error?.message ?? error}`);
        continue;
      }

      this.#bind(socket, pipePath);
      let ready;
      try {
        ready = await this.#handshake();
      } catch (error) {
        this.#teardown();
        if (error?.fatal) {
          return { ok: false, error: "discord-rejected", detail: error.message, fatal: true };
        }
        primary ??= error;
        this.#logger?.warn?.(`[discord-ipc:${this.#source}] handshake failed on ${pipePath}: ${error?.message ?? error}`);
        continue;
      }

      if (this.#closed) {
        this.#teardown();
        return { ok: false, error: "discord-closed", detail: "client is closed" };
      }

      this.#ready = true;
      this.#pipePath = pipePath;
      const user = ready?.data?.user;
      this.#user = typeof user?.username === "string" && user.username.length > 0
        ? user.username
        : typeof user?.id === "string" && user.id.length > 0
          ? user.id
          : null;
      this.#logger?.info?.(`[discord-ipc:${this.#source}] connected on ${pipePath}`);
      return { ok: true, pipePath, user: this.#user };
    }

    return {
      ok: false,
      error: "discord-unavailable",
      detail: primary?.message ?? `no Discord IPC pipe answered on ${this.#pipes.length} path(s)`,
    };
  }

  #openPipe(pipePath) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = this.#connectImpl(pipePath);
      } catch (error) {
        reject(error);
        return;
      }
      if (!socket || typeof socket.once !== "function") {
        reject(new Error(`connectImpl did not return a socket for ${pipePath}`));
        return;
      }

      let settled = false;
      const timer = this.#timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy?.();
        reject(new Error(`connect timeout on ${pipePath}`));
      }, this.#connectTimeoutMs);
      timer?.unref?.();

      const onConnect = () => {
        if (settled) return;
        settled = true;
        this.#timers.clearTimeout(timer);
        socket.removeListener?.("error", onError);
        resolve(socket);
      };
      const onError = (error) => {
        if (settled) return;
        settled = true;
        this.#timers.clearTimeout(timer);
        reject(error);
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  #bind(socket, pipePath) {
    this.#socket = socket;
    this.#pipePath = pipePath;
    this.#decoder = new DiscordFrameDecoder();

    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => {
      this.#logger?.error?.(`[discord-ipc:${this.#source}] ${error?.message ?? error}`);
      this.#readyWaiter?.reject(error);
      try {
        socket.destroy();
      } catch {
        // A socket that is already gone has nothing left to destroy.
      }
    });
    socket.on("close", () => this.#handleClose(socket));
    socket.on("end", () => {
      try {
        socket.destroy();
      } catch {
        // A socket that is already gone has nothing left to destroy.
      }
    });
  }

  #teardown() {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#decoder = null;
    this.#clearFlush();
    if (socket) {
      try {
        socket.destroy();
      } catch {
        // A socket that is already gone has nothing left to destroy.
      }
    }
  }

  #handleClose(socket) {
    if (this.#socket !== socket) return;
    const wasReady = this.#ready;
    this.#socket = null;
    this.#ready = false;
    this.#decoder = null;
    this.#clearFlush();
    this.#failPending("discord-closed", "discord ipc connection closed");
    if (this.#closed || !wasReady) return;
    this.#onClose?.({ reason: "discord-closed" });
  }

  #handshake() {
    return new Promise((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        if (!this.#readyWaiter) return;
        this.#readyWaiter = null;
        reject(new Error("discord ipc handshake timed out"));
      }, this.#replyTimeoutMs);
      timer?.unref?.();

      this.#readyWaiter = {
        resolve: (ready) => {
          this.#timers.clearTimeout(timer);
          this.#readyWaiter = null;
          resolve(ready);
        },
        reject: (error) => {
          this.#timers.clearTimeout(timer);
          this.#readyWaiter = null;
          reject(error);
        },
      };

      try {
        this.#write(OP.HANDSHAKE, { v: 1, client_id: this.#clientId });
      } catch (error) {
        this.#readyWaiter?.reject(error);
      }
    });
  }

  /* -------------------------------------------------------------- transport */

  #write(op, payload) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      throw taggedError("discord-closed", "discord ipc not connected");
    }
    socket.write(encodeDiscordFrame(op, payload));
  }

  #request(payload) {
    const nonce = `${this.#timers.now().toString(36)}-${++this.#seq}`;
    const frame = { ...payload, nonce };

    return new Promise((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        if (!this.#pending.delete(nonce)) return;
        reject(taggedError("hung", "discord ipc reply timed out"));
      }, this.#replyTimeoutMs);
      timer?.unref?.();

      this.#pending.set(nonce, {
        resolve: (value) => {
          this.#timers.clearTimeout(timer);
          this.#pending.delete(nonce);
          resolve(value);
        },
        reject: (error) => {
          this.#timers.clearTimeout(timer);
          this.#pending.delete(nonce);
          reject(error);
        },
      });

      try {
        this.#write(OP.FRAME, frame);
      } catch (error) {
        this.#pending.get(nonce)?.reject(error);
      }
    });
  }

  #failPending(kind, message) {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) entry.reject(taggedError(kind, message));
  }

  #onData(chunk) {
    if (!this.#decoder) return;
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#logger?.error?.(`[discord-ipc:${this.#source}] framing error: ${error?.message ?? error}`);
      try {
        this.#socket?.destroy();
      } catch {
        // A socket that is already gone has nothing left to destroy.
      }
      return;
    }
    for (const frame of frames) this.#onFrame(frame);
  }

  #onFrame({ op, payload }) {
    if (op === OP.PONG) return;
    if (op === OP.PING) {
      try {
        this.#write(OP.PONG, {});
      } catch {
        // The pipe went away between the ping and the pong.
      }
      return;
    }
    if (op === OP.CLOSE) {
      const detail = payload?.message ?? payload?.data?.message ?? "Discord closed the connection";
      this.#logger?.warn?.(`[discord-ipc:${this.#source}] ${detail}`);
      this.#readyWaiter?.reject(fatalError(String(detail)));
      return;
    }
    if (op !== OP.FRAME) return;

    if (payload?.evt === "READY") {
      this.#readyWaiter?.resolve(payload);
      return;
    }
    // A handshake ERROR carries no nonce, so only the nonce path below can
    // match it; surface the real reason instead of "handshake timed out".
    if (payload?.evt === "ERROR" && this.#readyWaiter) {
      const nonce = payload?.nonce;
      if (typeof nonce !== "string" || !this.#pending.has(nonce)) {
        const detail = payload?.data?.message ?? "Discord rejected the handshake";
        this.#readyWaiter.reject(fatalError(String(detail)));
        return;
      }
    }
    const nonce = payload?.nonce;
    if (typeof nonce === "string" && this.#pending.has(nonce)) {
      this.#pending.get(nonce).resolve(payload);
    }
  }

  /* --------------------------------------------------------------- activity */

  #prune() {
    const cutoff = this.#timers.now() - this.#rateWindowMs;
    while (this.#sentAt.length > 0 && this.#sentAt[0] <= cutoff) this.#sentAt.shift();
  }

  #clearFlush() {
    if (this.#flushTimer === null) return;
    this.#timers.clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
  }

  #scheduleFlush() {
    if (this.#flushTimer !== null) return;
    this.#prune();
    const wait = this.#sentAt.length === 0
      ? 1
      : Math.max(0, this.#sentAt[0] + this.#rateWindowMs - this.#timers.now()) + 1;
    const timer = this.#timers.setTimeout(() => {
      this.#flushTimer = null;
      this.#flush().catch((error) => {
        this.#logger?.error?.(`[discord-ipc:${this.#source}] flush failed: ${error?.message ?? error}`);
      });
    }, wait);
    timer?.unref?.();
    this.#flushTimer = timer;
  }

  async #flush() {
    if (this.#queued === undefined) return;
    if (!this.#ready) {
      // The pipe is down but a payload is queued: keep it for the host's
      // reconnect instead of stranding it.
      this.#scheduleFlush();
      return;
    }
    const activity = this.#queued;
    this.#queued = undefined;
    const result = await this.#send(activity);
    if (!result.ok) {
      this.#logger?.warn?.(`[discord-ipc:${this.#source}] queued activity rejected: ${result.error}`);
    }
    if (this.#queued !== undefined) this.#scheduleFlush();
  }

  async #send(activity) {
    let reply;
    try {
      reply = await this.#request({
        cmd: "SET_ACTIVITY",
        args: { pid: this.#pid, activity: activity ?? null },
      });
    } catch (error) {
      return { ok: false, error: error?.kind ?? error?.message ?? String(error) };
    }

    if (reply?.evt === "ERROR" || reply?.evt === "INVALID") {
      return {
        ok: false,
        error: String(reply?.data?.message ?? reply?.message ?? "SET_ACTIVITY rejected"),
      };
    }

    // Only successful sends seed the rolling window.
    this.#sentAt.push(this.#timers.now());
    const name = reply?.data?.name;
    if (typeof name === "string" && name.length > 0) this.#appName = name;
    return { ok: true, appName: this.#appName };
  }
}
