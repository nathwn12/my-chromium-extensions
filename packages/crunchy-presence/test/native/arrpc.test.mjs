import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ARRPC_MOCK_USER_ID, ARRPC_PORTS, ArRpcClient } from '../../native/arrpc.mjs';

const CLIENT_ID = '123456789012345678';

/* ---------------------------------------------------------------- helpers */

function waitFor(predicate, label = 'condition', timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch {
        ok = false;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A WebSocket stand-in: records what was sent, and lets a test play the server. */
class FakeSocket {
  constructor(url, { openError = null } = {}) {
    this.url = url;
    this.openError = openError;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    this.onopen = null;
    this.onSend = null;
    queueMicrotask(() => {
      if (this.closed) return;
      if (this.openError) {
        this.emit('error', new Error(this.openError));
        return;
      }
      this.emit('open', {});
      this.onopen?.(this);
    });
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(fn);
    if (index !== -1) list.splice(index, 1);
  }

  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  send(text) {
    if (this.closed) throw new Error('socket is closed');
    const frame = JSON.parse(text);
    this.sent.push(frame);
    this.onSend?.(frame, this);
  }

  receive(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }
}

/** `behaviour` runs once the socket opens, playing the arRPC server side. */
function makeTransport(behaviour, options = {}) {
  const sockets = [];
  class Impl extends FakeSocket {
    constructor(url) {
      super(url, options);
      this.onopen = () => behaviour(this, url);
      sockets.push(this);
    }
  }
  return { impl: Impl, sockets };
}

const readyFrame = (user = { id: ARRPC_MOCK_USER_ID, username: 'arrpc' }) => ({
  cmd: 'DISPATCH',
  evt: 'READY',
  data: { v: 1, user },
});

function makeClient(impl, extra = {}) {
  const statuses = [];
  const client = new ArRpcClient({
    clientId: CLIENT_ID,
    WebSocketImpl: impl,
    ports: [6463, 6464],
    connectTimeoutMs: 200,
    replyTimeoutMs: 200,
    logger: {
      info() {},
      warn() {},
      error() {},
      status: (status) => statuses.push(status),
    },
    ...extra,
  });
  return { client, statuses };
}

/** Auto-answer SET_ACTIVITY so a test can await a reply without a timer. */
function answerActivity(socket) {
  socket.onSend = (frame) => {
    socket.receive({
      cmd: 'SET_ACTIVITY',
      evt: null,
      nonce: frame.nonce,
      data: { name: 'Crunchyroll' },
    });
  };
}

/* ------------------------------------------------------------------ tests */

test('arRPC listens on the documented 6463-6472 range', () => {
  assert.deepEqual(ARRPC_PORTS, [6463, 6464, 6465, 6466, 6467, 6468, 6469, 6470, 6471, 6472]);
  assert.equal(ARRPC_MOCK_USER_ID, '1045800378228281345');
});

test('connect resolves on the arRPC READY and reports the port it used', async () => {
  const { impl, sockets } = makeTransport((socket) => socket.receive(readyFrame()));
  const { client } = makeClient(impl);

  const result = await client.connect();
  assert.deepEqual(result, { ok: true, port: 6463, user: 'arrpc' });
  assert.equal(client.ready, true);
  assert.equal(client.port, 6463);
  assert.equal(client.user, 'arrpc');
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, `ws://127.0.0.1:6463/?v=1&client_id=${CLIENT_ID}`);
  client.close();
});

test('a READY from a non-arRPC listener is refused and the next port is tried', async () => {
  const { impl, sockets } = makeTransport((socket, url) => {
    if (new URL(url).port === '6463') {
      socket.receive(readyFrame({ id: '999', username: 'someone-else' }));
      return;
    }
    socket.receive(readyFrame());
  });
  const { client } = makeClient(impl);

  const result = await client.connect();
  assert.equal(result.port, 6464);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true, 'the foreign listener is closed');
  client.close();
});

test('no listener rejects with an arrpc diagnostic and never fatal', async () => {
  const { impl } = makeTransport(() => {}, { openError: 'connect ECONNREFUSED 127.0.0.1:6463' });
  const { client } = makeClient(impl);

  await assert.rejects(
    client.connect(),
    (error) => {
      assert.match(error.message, /arrpc/i);
      assert.equal(error.fatal, undefined);
      return true;
    },
  );
  assert.equal(client.ready, false);
  client.close();
});

test('a listener that never sends READY times out instead of hanging the hello', async () => {
  const { impl, sockets } = makeTransport(() => {});
  const { client } = makeClient(impl, { connectTimeoutMs: 40 });

  await assert.rejects(client.connect(), /arrpc.*(timeout|timed out)/i);
  assert.equal(sockets[0].closed, true);
  assert.equal(client.ready, false);
  client.close();
});

test('setActivity sends the contract frame and matches the reply by nonce', async () => {
  const { impl, sockets } = makeTransport((socket) => {
    socket.receive(readyFrame());
    answerActivity(socket);
  });
  const { client } = makeClient(impl);
  await client.connect();

  const activity = { type: 3, details: 'Episode 1' };
  const result = await client.setActivity(activity);

  assert.equal(result.ok, true);
  assert.equal(result.appName, 'Crunchyroll');
  const frame = sockets[0].sent[0];
  assert.equal(frame.cmd, 'SET_ACTIVITY');
  assert.equal(frame.args.pid, process.pid);
  assert.deepEqual(frame.args.activity, activity);
  assert.equal(typeof frame.nonce, 'string');
  assert.ok(frame.nonce.length > 0);

  const cleared = await client.setActivity(null);
  assert.equal(cleared.ok, true);
  assert.equal(sockets[0].sent.at(-1).args.activity, null);
  client.close();
});

test('every SET_ACTIVITY carries a distinct nonce', async () => {
  const { impl, sockets } = makeTransport((socket) => {
    socket.receive(readyFrame());
    answerActivity(socket);
  });
  const { client } = makeClient(impl);
  await client.connect();

  await client.setActivity({ type: 3, details: 'a' });
  await client.setActivity({ type: 3, details: 'b' });

  const nonces = sockets[0].sent.map((frame) => frame.nonce);
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
  client.close();
});

test('a SET_ACTIVITY rejection is surfaced, not swallowed', async () => {
  const { impl } = makeTransport((socket) => {
    socket.receive(readyFrame());
    socket.onSend = (frame) => {
      socket.receive({
        cmd: 'SET_ACTIVITY',
        evt: 'ERROR',
        nonce: frame.nonce,
        data: { code: 4000, message: 'Invalid activity for this client' },
      });
    };
  });
  const { client } = makeClient(impl);
  await client.connect();

  const result = await client.setActivity({ type: 3, details: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid activity for this client');
  assert.equal(result.code, 4000);
  client.close();
});

test('setActivity before connect is a typed failure, not a throw', async () => {
  const { impl, sockets } = makeTransport(() => {});
  const { client } = makeClient(impl);

  const result = await client.setActivity({ type: 3, details: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /arrpc not connected/);
  assert.equal(sockets.length, 0);
  client.close();
});

test('a dropped connection reports waiting and republishes the last activity', async () => {
  const { impl, sockets } = makeTransport((socket) => {
    socket.receive(readyFrame());
    answerActivity(socket);
  });
  const { client, statuses } = makeClient(impl, { backoffStart: 5 });

  await client.connect();
  const sent = await client.setActivity({ type: 3, details: 'Episode 1' });
  assert.equal(sent.ok, true);

  sockets[0].close();
  await waitFor(() => client.ready === false, 'the client to notice the drop');
  assert.equal(statuses.at(-1).state, 'disconnected');
  assert.equal(statuses.at(-1).reason, 'arrpc-closed');

  await waitFor(() => sockets.length === 2, 'a second connection');
  await waitFor(() => client.ready === true, 'the second connection to be ready');
  await waitFor(
    () => sockets[1].sent.some((frame) => frame.args?.activity?.details === 'Episode 1'),
    'the activity to be republished',
  );
  assert.equal(statuses.at(-1).state, 'connected');
  client.close();
});

test('close stops the client and leaves no reconnect timer behind', async () => {
  const { impl, sockets } = makeTransport((socket) => {
    socket.receive(readyFrame());
    answerActivity(socket);
  });
  const { client } = makeClient(impl, { backoffStart: 5 });
  await client.connect();
  client.close();

  assert.equal(client.ready, false);
  assert.equal(client.closed, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sockets.length, 1, 'a closed client does not reconnect');
});
