// Minimal Chrome DevTools Protocol client.
// Zero dependencies: lib/ws.mjs over node:net, and node:http for discovery.
//
// One socket to the browser endpoint, flattened sessions per target
// (Target.attachToTarget { flatten: true }), so every call carries a sessionId.

import { openWebSocket } from "./ws.mjs";

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message}${error.data ? ` (${error.data})` : ""}`);
    this.method = method;
    this.code = error.code;
  }
}

/** @param {string} url browser websocket endpoint */
export async function connect(url, { timeoutMs = 30000 } = {}) {
  const socket = await openWebSocket(url, { timeoutMs });
  const pending = new Map();
  /** @type {Array<(evt: {method: string, params: any, sessionId?: string}) => void>} */
  const listeners = [];
  let nextId = 1;
  let closed = false;

  socket.onMessage((text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new CdpError(entry.method, msg.error));
      else entry.resolve(msg.result);
      return;
    }
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch {
        /* a listener must never break the socket pump */
      }
    }
  });

  socket.onClose((reason) => {
    closed = true;
    for (const [, entry] of pending) {
      entry.reject(new Error(`${entry.method}: session closed (${reason})`));
    }
    pending.clear();
  });

  function send(method, params = {}, sessionId) {
    if (closed) return Promise.reject(new Error(`${method}: session is closed`));
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no reply within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.send(JSON.stringify(payload));
    });
  }

  return {
    send,
    on(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    close() {
      closed = true;
      socket.close();
    },
  };
}

/** Wait for one matching event, or resolve undefined on timeout. */
export function waitForEvent(client, predicate, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const off = client.on((msg) => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      off();
      resolve(msg);
    });
    const timer = setTimeout(() => {
      off();
      resolve(undefined);
    }, timeoutMs);
  });
}
