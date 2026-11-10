import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ARRPC_USER_ID,
  ArRpcClient,
} from "../../native/arrpc.mjs";

const CLIENT_ID = "1566530911514923188";
const READY = (user) => ({
  cmd: "DISPATCH",
  data: { v: 1, config: { environment: "production" }, user },
  evt: "READY",
  nonce: null,
});

const ARRPC_USER = { id: ARRPC_USER_ID, username: "arrpc" };

/** Minimal WebSocket stand-in: records sends, drives events, no ports. */
class FakeWebSocket {
  static instances = [];
  static handler = null;

  static reset(handler = null) {
    FakeWebSocket.instances = [];
    FakeWebSocket.handler = handler;
  }

  constructor(...args) {
    this.url = args[0];
    this.argumentCount = args.length;
    this.port = Number(new URL(this.url).port);
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (!this.closed) FakeWebSocket.handler?.(this, null);
    });
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  send(text) {
    const frame = JSON.parse(text);
    this.sent.push(frame);
    FakeWebSocket.handler?.(this, frame);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close", { code: 1000, wasClean: true }));
  }

  receive(frame) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

function makeClient(overrides = {}) {
  return new ArRpcClient({
    clientId: CLIENT_ID,
    source: "youtube",
    WebSocketImpl: FakeWebSocket,
    ports: [6463],
    connectTimeoutMs: 20,
    replyTimeoutMs: 20,
    ...overrides,
  });
}

test("connect probes ports in order and accepts only the arRPC READY", async () => {
  FakeWebSocket.reset((socket, frame) => {
    if (frame !== null) return;
    socket.receive(READY(socket.port === 6463
      ? { id: "999999999999999999", username: "discord" }
      : ARRPC_USER));
  });
  const client = makeClient({ ports: [6463, 6464] });

  const result = await client.connect();

  assert.equal(result.ok, true);
  assert.equal(result.port, 6464);
  assert.equal(result.user.id, ARRPC_USER_ID);
  assert.equal(client.ready, true);
  assert.equal(client.port, 6464);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(FakeWebSocket.instances[0].url, "ws://127.0.0.1:6463");
  assert.equal(FakeWebSocket.instances[0].closed, true, "the non-arRPC socket is closed");
  assert.equal(FakeWebSocket.instances[1].closed, false);

  client.close();
});

test("connect opens the WebSocket with no origin or option object", async () => {
  FakeWebSocket.reset((socket) => socket.receive(READY(ARRPC_USER)));
  const client = makeClient();

  await client.connect();

  assert.equal(FakeWebSocket.instances[0].argumentCount, 1);
  client.close();
});

test("connect reports no server when every port stays silent", async () => {
  FakeWebSocket.reset();
  const client = makeClient({ ports: [6463, 6464], connectTimeoutMs: 5 });

  const result = await client.connect();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "arrpc-unavailable");
  assert.equal(client.ready, false);
  assert.equal(client.port, null);
  assert.equal(FakeWebSocket.instances.every((socket) => socket.closed), true);
});

test("connect returns the live connection when called again", async () => {
  FakeWebSocket.reset((socket) => socket.receive(READY(ARRPC_USER)));
  const client = makeClient();

  const first = await client.connect();
  const second = await client.connect();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.port, first.port);
  assert.equal(FakeWebSocket.instances.length, 1);
  client.close();
});

test("connect survives a WebSocket constructor that throws", async () => {
  class BrokenWebSocket {
    constructor() {
      throw new Error("no network");
    }
  }
  const client = makeClient({ WebSocketImpl: BrokenWebSocket });

  const result = await client.connect();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "arrpc-unavailable");
});

test("setActivity sends pid, activity and nonce, then resolves on the matching reply", async () => {
  FakeWebSocket.reset((socket, frame) => {
    if (frame === null) {
      socket.receive(READY(ARRPC_USER));
      return;
    }
    if (frame.cmd !== "SET_ACTIVITY") return;
    socket.receive({ cmd: "SET_ACTIVITY", data: {}, evt: null, nonce: "999" });
    socket.receive({ cmd: "SET_ACTIVITY", data: {}, evt: null, nonce: frame.nonce });
  });
  const client = makeClient();
  await client.connect();

  const activity = { details: "Big Buck Bunny", type: 3 };
  const result = await client.setActivity(activity);

  assert.equal(result.ok, true);
  const sent = FakeWebSocket.instances[0].sent[0];
  assert.equal(sent.cmd, "SET_ACTIVITY");
  assert.equal(sent.args.pid, process.pid);
  assert.deepEqual(sent.args.activity, activity);
  assert.equal(typeof sent.nonce, "string");
  assert.equal(sent.evt, undefined);

  client.close();
});

test("setActivity clears presence by sending a null activity", async () => {
  FakeWebSocket.reset((socket, frame) => {
    if (frame === null) socket.receive(READY(ARRPC_USER));
    else socket.receive({ cmd: "SET_ACTIVITY", data: null, evt: null, nonce: frame.nonce });
  });
  const client = makeClient();
  await client.connect();

  assert.deepEqual(await client.setActivity(null), { ok: true });
  assert.equal(FakeWebSocket.instances[0].sent[0].args.activity, null);
  client.close();
});

test("setActivity reports hung when the reply never arrives", async () => {
  FakeWebSocket.reset((socket) => socket.receive(READY(ARRPC_USER)));
  const client = makeClient({ replyTimeoutMs: 5 });
  await client.connect();

  assert.deepEqual(await client.setActivity({ details: "x" }), { ok: false, error: "hung" });
  client.close();
});

test("setActivity maps an ERROR reply to a rejected error", async () => {
  FakeWebSocket.reset((socket, frame) => {
    if (frame === null) {
      socket.receive(READY(ARRPC_USER));
      return;
    }
    socket.receive({
      cmd: "SET_ACTIVITY",
      evt: "ERROR",
      data: { message: "Invalid application id" },
      nonce: frame.nonce,
    });
  });
  const client = makeClient();
  await client.connect();

  const result = await client.setActivity({ details: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid application id");
  client.close();
});

test("setActivity before connect and with a non-object activity fails without sending", async () => {
  FakeWebSocket.reset((socket) => socket.receive(READY(ARRPC_USER)));
  const client = makeClient();

  assert.deepEqual(await client.setActivity({ details: "x" }), {
    ok: false,
    error: "arrpc-unavailable",
  });

  await client.connect();
  assert.deepEqual(await client.setActivity("nope"), { ok: false, error: "invalid-activity" });
  assert.equal(FakeWebSocket.instances[0].sent.length, 0);
  client.close();
});

test("an unexpected close marks the client not ready and reports once", async () => {
  FakeWebSocket.reset((socket) => socket.receive(READY(ARRPC_USER)));
  const closes = [];
  const client = makeClient({ onClose: (info) => closes.push(info) });
  await client.connect();

  const pending = client.setActivity({ details: "x" });
  FakeWebSocket.instances[0].emit("close", { code: 1006, wasClean: false });

  assert.deepEqual(await pending, { ok: false, error: "arrpc-closed" });
  assert.equal(client.ready, false);
  assert.equal(client.port, null);
  assert.deepEqual(closes, [{ reason: "arrpc-closed" }]);
});

test("close marks the client not ready and suppresses the onClose report", async () => {
  FakeWebSocket.reset((socket) => socket.receive(READY(ARRPC_USER)));
  const closes = [];
  const client = makeClient({ onClose: (info) => closes.push(info) });
  await client.connect();

  client.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.ready, false);
  assert.equal(client.port, null);
  assert.deepEqual(closes, []);
});
