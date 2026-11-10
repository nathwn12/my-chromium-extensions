import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import {
  NativeMessageDecoder,
  encodeNativeMessage,
} from '../../native/ipc.mjs';
import { Host } from '../../native/host.mjs';

const CLIENT_ID = '123456789012345678';
const ACTIVITY = { type: 3, details: 'Episode 1' };

/* ---------------------------------------------------------------- helpers */

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

function fakeArRpc(log, { fail = null } = {}) {
  return {
    clientId: CLIENT_ID,
    ready: false,
    closed: false,
    appName: null,
    user: null,
    async connect() {
      log.push('arrpc.connect');
      if (fail) throw new Error(fail);
      this.ready = true;
      this.user = 'arrpc';
      return { ok: true, port: 6463, user: 'arrpc' };
    },
    async setActivity(activity) {
      log.push(['arrpc.setActivity', activity]);
      if (!this.ready) return { ok: false, error: 'arrpc not connected', appName: this.appName };
      return { ok: true, appName: 'Discord' };
    },
    close() {
      log.push('arrpc.close');
      this.closed = true;
    },
  };
}

function fakeIpc(log, { fail = null } = {}) {
  return {
    clientId: CLIENT_ID,
    ready: false,
    closed: false,
    appName: 'Crunchyroll Presence',
    user: 'tester',
    async connect() {
      log.push('ipc.connect');
      if (fail) throw new Error(fail);
      this.ready = true;
      return { ok: true };
    },
    async setActivity(activity) {
      log.push(['ipc.setActivity', activity]);
      if (!this.ready) return { ok: false, error: 'discord ipc not connected', appName: this.appName };
      return { ok: true, appName: 'Crunchyroll Presence' };
    },
    close() {
      log.push('ipc.close');
      this.closed = true;
    },
  };
}

function makeHost({ log = [], arrpc = null, ipc = null, ipcOnly = false } = {}) {
  const capture = new Capture();
  const errors = [];
  const host = new Host({
    stdout: capture,
    stderr: { write: (line) => errors.push(String(line)) },
    onExit: () => {},
    makeClient: (clientId) => {
      log.push('ipc.create');
      return ipc ?? fakeIpc(log);
    },
    ...(ipcOnly
      ? {}
      : {
          makeArrpc: (clientId) => {
            log.push('arrpc.create');
            return arrpc ?? fakeArRpc(log);
          },
        }),
  });
  return { host, capture, errors };
}

const statuses = (capture) => capture.decode().filter((message) => message.t === 'status');
const lastStatus = (capture) => statuses(capture).at(-1);

/* ------------------------------------------------------------------ tests */

test('auto uses Discord IPC when it is available and never builds arRPC', async (t) => {
  const log = [];
  const { host, capture } = makeHost({ log });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID });

  const status = lastStatus(capture);
  assert.equal(status.state, 'connected');
  assert.equal(status.transport, 'discord-ipc');
  assert.equal(status.user, 'tester');
  assert.equal(status.appName, 'Crunchyroll Presence');
  assert.ok(!log.includes('arrpc.create'), 'the primary path never builds arRPC');

  await host.handle({ t: 'activity', id: 'n1', activity: ACTIVITY });
  const ack = capture.decode().find((message) => message.t === 'ack' && message.id === 'n1');
  assert.equal(ack.ok, true);
  assert.equal(ack.appName, 'Crunchyroll Presence');
});

test('auto falls back to arRPC only when Discord IPC is unavailable', async (t) => {
  const log = [];
  const { host, capture, errors } = makeHost({
    log,
    ipc: fakeIpc(log, { fail: 'connect ENOENT \\\\.\\pipe\\discord-ipc-0' }),
  });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID });

  const status = lastStatus(capture);
  assert.equal(status.state, 'connected');
  assert.equal(status.transport, 'arrpc');
  assert.equal(status.user, 'arrpc');
  assert.ok(log.includes('ipc.close'), 'the failed IPC client is closed');
  assert.ok(log.includes('arrpc.connect'), 'arRPC is the fallback');
  assert.ok(
    errors.some((line) => /discord ipc unavailable.*trying arrpc/i.test(line)),
    `fallback is logged, got ${JSON.stringify(errors)}`,
  );

  await host.handle({ t: 'activity', id: 'n2', activity: ACTIVITY });
  const ack = capture.decode().find((message) => message.t === 'ack' && message.id === 'n2');
  assert.equal(ack.ok, true);
  assert.equal(ack.appName, 'Discord');
});

test('auto with neither transport reports the primary absence, not an arRPC one', async (t) => {
  const log = [];
  const { host, capture } = makeHost({
    log,
    ipc: fakeIpc(log, { fail: 'connect ENOENT \\\\.\\pipe\\discord-ipc-0' }),
    arrpc: fakeArRpc(log, { fail: 'arrpc is not listening' }),
  });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID });

  const status = lastStatus(capture);
  assert.equal(status.state, 'waiting');
  assert.equal(status.transport, 'discord-ipc');
  assert.equal(status.reason, 'discord-closed');
  assert.match(status.detail, /ENOENT/);
  assert.ok(log.includes('arrpc.close'), 'the failed arRPC fallback is closed');
  assert.equal(statuses(capture).some((message) => message.state === 'error'), false);
});

test('transport arrpc never falls back and reports the absence as waiting', async (t) => {
  const log = [];
  const { host, capture } = makeHost({
    log,
    arrpc: fakeArRpc(log, { fail: 'arrpc is not listening' }),
  });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'arrpc' });

  const status = lastStatus(capture);
  assert.equal(status.state, 'waiting');
  assert.equal(status.transport, 'arrpc');
  assert.equal(status.reason, 'arrpc-closed');
  assert.ok(!log.includes('ipc.create'), 'arrpc never constructs the IPC client');
  assert.equal(statuses(capture).some((message) => message.state === 'error'), false);

  await host.handle({ t: 'activity', id: 'n3', activity: ACTIVITY });
  const ack = capture.decode().find((message) => message.t === 'ack' && message.id === 'n3');
  assert.equal(ack.ok, false, 'an absent transport acks honestly');
});

test('transport ipc keeps today\'s path and never touches arRPC', async (t) => {
  const log = [];
  const { host, capture } = makeHost({ log });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'ipc' });

  const status = lastStatus(capture);
  assert.equal(status.state, 'connected');
  assert.equal(status.transport, 'discord-ipc');
  assert.ok(!log.includes('arrpc.create'), 'no arRPC client is built for ipc');
  assert.ok(!log.includes('arrpc.connect'));
});

test('forced ipc never falls back to arRPC when Discord is absent', async (t) => {
  const log = [];
  const { host, capture } = makeHost({
    log,
    ipc: fakeIpc(log, { fail: 'connect ENOENT \\\\.\\pipe\\discord-ipc-0' }),
  });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'ipc' });

  const status = lastStatus(capture);
  assert.equal(status.state, 'waiting');
  assert.equal(status.transport, 'discord-ipc');
  assert.equal(status.reason, 'discord-closed');
  assert.ok(!log.includes('arrpc.create'), 'a forced ipc never reaches arRPC');
  assert.equal(statuses(capture).some((message) => message.state === 'error'), false);
});

test('a host wired with only an IPC client keeps the IPC path for auto', async (t) => {
  const log = [];
  const { host, capture } = makeHost({ log, ipcOnly: true });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID });

  const status = lastStatus(capture);
  assert.equal(status.transport, 'discord-ipc');
  assert.ok(!log.includes('arrpc.create'));
});

test('a hello with an unknown transport is rejected before any client is built', async (t) => {
  const log = [];
  const { host, capture } = makeHost({ log });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'gateway' });

  assert.deepEqual(log, []);
  const status = lastStatus(capture);
  assert.equal(status.state, 'error');
  assert.match(status.detail, /transport/);
  assert.equal(status.fatal, false);
});

test('an explicit arrpc preference on an IPC-only host waits and never builds IPC', async (t) => {
  const log = [];
  const { host, capture } = makeHost({ log, ipcOnly: true });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'arrpc' });

  const status = lastStatus(capture);
  assert.equal(status.state, 'waiting');
  assert.equal(status.transport, 'arrpc');
  assert.equal(status.reason, 'arrpc-closed');
  assert.deepEqual(log, [], 'no client is built when the transport is not wired');
});

test('a second hello with the same preference reuses the connected transport', async (t) => {
  const log = [];
  const { host, capture } = makeHost({ log });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID });
  await host.handle({ t: 'hello', clientId: CLIENT_ID });

  assert.equal(log.filter((entry) => entry === 'ipc.connect').length, 1);
  assert.equal(log.filter((entry) => entry === 'ipc.create').length, 1);
  assert.ok(!log.includes('arrpc.create'));
  assert.equal(lastStatus(capture).transport, 'discord-ipc');
});

test('switching transport rebuilds the client', async (t) => {
  const log = [];
  const { host, capture } = makeHost({ log });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'arrpc' });
  assert.equal(lastStatus(capture).transport, 'arrpc');

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'ipc' });
  assert.equal(lastStatus(capture).transport, 'discord-ipc');
  assert.ok(log.includes('arrpc.close'), 'the old transport is closed');
  assert.ok(log.includes('ipc.connect'));
});

test('an activity is carried to whichever transport was chosen', async (t) => {
  const log = [];
  const { host } = makeHost({ log });
  t.after(() => host.shutdown(0));

  await host.handle({ t: 'hello', clientId: CLIENT_ID, transport: 'ipc' });
  await host.handle({ t: 'activity', id: 'n4', activity: ACTIVITY });

  assert.deepEqual(
    log.find((entry) => Array.isArray(entry) && entry[0] === 'ipc.setActivity'),
    ['ipc.setActivity', ACTIVITY],
  );
});

test('the native status frame still decodes when transport is carried inside it', () => {
  const encoded = encodeNativeMessage({ t: 'status', state: 'connected', transport: 'arrpc' });
  const message = new NativeMessageDecoder().push(encoded)[0];
  assert.equal(message.transport, 'arrpc');
});
