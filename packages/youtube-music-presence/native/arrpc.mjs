/**
 * One arRPC WebSocket connection for one source.
 *
 * arRPC listens on 127.0.0.1:6463-6472 and answers an un-originated WebSocket
 * with a READY dispatch. The client probes ports in order, accepts only the
 * arRPC mock user, sends SET_ACTIVITY, and matches the reply by nonce. Every
 * failure is returned, never thrown: the host must keep the native loop alive.
 */

export const ARRPC_PORTS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => 6463 + index),
);

export const ARRPC_USER_ID = "1045800378228281345";
export const ARRPC_USERNAME = "arrpc";

export const DEFAULT_CONNECT_TIMEOUT_MS = 1200;
export const DEFAULT_REPLY_TIMEOUT_MS = 5000;

const NO_SERVER = "arrpc-unavailable";

/** Text from a WebSocket message event, or null when the payload is not text. */
function textOf(event) {
  const data = event?.data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return null;
}

function parseFrame(event) {
  const text = textOf(event);
  if (text === null) return null;
  try {
    const frame = JSON.parse(text);
    return frame && typeof frame === "object" ? frame : null;
  } catch {
    return null;
  }
}

function isArRpcUser(user) {
  if (!user || typeof user !== "object") return false;
  return user.id === ARRPC_USER_ID || user.username === ARRPC_USERNAME;
}

export class ArRpcClient {
  #clientId;
  #source;
  #logger;
  #WebSocketImpl;
  #ports;
  #connectTimeoutMs;
  #replyTimeoutMs;
  #onClose;
  #setTimeout;
  #clearTimeout;

  #ws = null;
  #ready = false;
  #port = null;
  #user = null;
  #nonce = 0;
  /** nonce -> { resolve, timer } */
  #pending = new Map();
  #closedExplicitly = false;

  constructor({
    clientId,
    source,
    logger = null,
    WebSocketImpl = globalThis.WebSocket,
    ports = ARRPC_PORTS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
    onClose = null,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    if (typeof clientId !== "string" || clientId.length === 0) {
      throw new TypeError("clientId is required");
    }
    if (typeof source !== "string" || source.length === 0) {
      throw new TypeError("source is required");
    }
    this.#clientId = clientId;
    this.#source = source;
    this.#logger = logger;
    this.#WebSocketImpl = WebSocketImpl;
    this.#ports = ports;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#onClose = typeof onClose === "function" ? onClose : null;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
  }

  get ready() {
    return this.#ready;
  }

  get port() {
    return this.#port;
  }

  /**
   * Probe each port until an arRPC READY arrives.
   * @returns {Promise<{ok: true, port: number, user: object}
   *   | {ok: false, reason: string, detail: string}>}
   */
  async connect() {
    if (this.#ready) {
      return { ok: true, port: this.#port, user: this.#user };
    }
    if (typeof this.#WebSocketImpl !== "function") {
      return { ok: false, reason: NO_SERVER, detail: "WebSocket is not available" };
    }

    for (const port of this.#ports) {
      const attempt = await this.#probe(port);
      if (!attempt.ok) continue;

      this.#ws = attempt.ws;
      this.#ready = true;
      this.#port = port;
      this.#user = attempt.user;
      this.#closedExplicitly = false;
      this.#attachLive(attempt.ws);
      return { ok: true, port, user: attempt.user };
    }

    return {
      ok: false,
      reason: NO_SERVER,
      detail: `no arRPC server answered on ports ${this.#ports.join(", ")}`,
    };
  }

  /**
   * Send one SET_ACTIVITY and wait for the reply with the same nonce.
   * @param {object|null} activity
   * @returns {Promise<{ok: true} | {ok: false, error: string}>}
   */
  async setActivity(activity) {
    if (activity !== null && (typeof activity !== "object" || Array.isArray(activity))) {
      return { ok: false, error: "invalid-activity" };
    }
    const socket = this.#ws;
    if (!this.#ready || !socket) {
      return { ok: false, error: NO_SERVER };
    }

    const nonce = String(++this.#nonce);
    const reply = new Promise((resolve) => {
      const timer = this.#setTimeout(() => {
        this.#pending.delete(nonce);
        resolve({ ok: false, error: "hung" });
      }, this.#replyTimeoutMs);
      timer?.unref?.();
      this.#pending.set(nonce, { resolve, timer });
    });

    try {
      socket.send(JSON.stringify({
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity },
        nonce,
      }));
    } catch (error) {
      const entry = this.#pending.get(nonce);
      if (entry) {
        this.#clearTimeout(entry.timer);
        this.#pending.delete(nonce);
        entry.resolve({ ok: false, error: "arrpc-closed" });
      }
      this.#logger?.warn?.(`[arrpc:${this.#source}] send failed: ${error?.message ?? error}`);
    }

    return reply;
  }

  /** Close the socket without reporting it as an unexpected disconnect. */
  close() {
    this.#closedExplicitly = true;
    this.#ready = false;
    this.#failPending("arrpc-closed");
    const socket = this.#ws;
    this.#ws = null;
    this.#port = null;
    this.#user = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // A socket that is already gone has nothing left to close.
      }
    }
  }

  async #probe(port) {
    return new Promise((resolve) => {
      let socket;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.#clearTimeout(timer);
        if (!result.ok && socket) {
          try {
            socket.close();
          } catch {
            // Probing a port that refused the connection; nothing to close.
          }
        }
        resolve(result);
      };

      const timer = this.#setTimeout(() => finish({ ok: false }), this.#connectTimeoutMs);
      timer?.unref?.();

      try {
        socket = new this.#WebSocketImpl(
          `ws://127.0.0.1:${port}/?v=1&client_id=${this.#clientId}`,
        );
      } catch {
        finish({ ok: false });
        return;
      }

      socket.addEventListener("message", (event) => {
        const frame = parseFrame(event);
        if (!frame) return;
        if (frame.cmd !== "DISPATCH" || frame.evt !== "READY") return;
        finish(
          isArRpcUser(frame.data?.user)
            ? { ok: true, ws: socket, user: frame.data.user }
            : { ok: false },
        );
      });
      socket.addEventListener("error", () => finish({ ok: false }));
      socket.addEventListener("close", () => finish({ ok: false }));
    });
  }

  #attachLive(socket) {
    socket.addEventListener("message", (event) => {
      const frame = parseFrame(event);
      if (!frame || frame.nonce === null || frame.nonce === undefined) return;
      const key = String(frame.nonce);
      const entry = this.#pending.get(key);
      if (!entry) return;
      this.#pending.delete(key);
      this.#clearTimeout(entry.timer);
      entry.resolve(
        frame.evt === "ERROR"
          ? {
              ok: false,
              error: String(frame.error ?? frame.data?.message ?? "rejected"),
            }
          : { ok: true },
      );
    });

    socket.addEventListener("close", () => {
      if (this.#ws !== socket) return;
      const wasReady = this.#ready;
      this.#ws = null;
      this.#ready = false;
      this.#port = null;
      this.#user = null;
      this.#failPending("arrpc-closed");
      if (wasReady && !this.#closedExplicitly) {
        this.#onClose?.({ reason: "arrpc-closed" });
      }
    });
  }

  #failPending(error) {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      this.#clearTimeout(entry.timer);
      entry.resolve({ ok: false, error });
    }
  }
}
