import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLIENT_ID_RE, statusMessage, validateClientId, validateMessage } from '../../native/protocol.mjs';

const ACCEPTED = ['1'.repeat(17), '1'.repeat(19), '1'.repeat(20)];

const REJECTED = [
  ['1'.repeat(16), '16 digits'],
  ['1'.repeat(21), '21 digits'],
  ['1234567890123456a', 'non-numeric'],
];

const hello = (clientId) => ({ t: 'hello', clientId });

test('hello.clientId accepts 17, 19 and 20 digit ids', () => {
  assert.equal(CLIENT_ID_RE.source, '^[0-9]{17,20}$');
  for (const clientId of ACCEPTED) {
    assert.deepEqual(validateClientId(clientId), { ok: true, value: clientId }, clientId);
    assert.deepEqual(validateMessage(hello(clientId)), { ok: true, value: hello(clientId) }, clientId);
  }
});

test('hello.clientId rejects 16 and 21 digits and non-numeric ids with a reason', () => {
  for (const [clientId, label] of REJECTED) {
    const result = validateClientId(clientId);
    assert.equal(result.ok, false, label);
    assert.match(result.error, /17-20 digits/, label);

    const message = validateMessage(hello(clientId));
    assert.equal(message.ok, false, label);
    assert.equal(typeof message.error, 'string', label);
    assert.ok(message.error.length > 0, label);
  }
});

const ID = '1'.repeat(18);

test('hello.transport accepts auto, arrpc and ipc, and missing means auto', () => {
  for (const transport of ['auto', 'arrpc', 'ipc']) {
    const message = { t: 'hello', clientId: ID, transport };
    assert.deepEqual(validateMessage(message), { ok: true, value: message }, transport);
  }
  const bare = { t: 'hello', clientId: ID };
  assert.deepEqual(validateMessage(bare), { ok: true, value: bare });
});

test('hello.transport rejects an unknown transport with a reason', () => {
  for (const transport of ['gateway', null, 1]) {
    const result = validateMessage({ t: 'hello', clientId: ID, transport });
    assert.equal(result.ok, false, String(transport));
    assert.match(result.error, /transport/);
  }
});

test('a status frame carries the chosen transport only when it is one of the two', () => {
  const connected = statusMessage('connected', {
    appName: 'Discord',
    user: 'arrpc',
    transport: 'arrpc',
  });
  assert.equal(connected.transport, 'arrpc');
  assert.equal(connected.state, 'connected');
  assert.equal(connected.user, 'arrpc');

  const waiting = statusMessage('waiting', {
    reason: 'arrpc-closed',
    detail: 'arrpc is not listening',
    transport: 'discord-ipc',
  });
  assert.equal(waiting.transport, 'discord-ipc');
  assert.equal(waiting.reason, 'arrpc-closed');

  assert.equal(statusMessage('connected', { appName: 'x' }).transport, undefined);
  assert.equal(statusMessage('error', { detail: 'x' }).transport, undefined);
  assert.equal(
    statusMessage('connected', { transport: 'gateway' }).transport,
    undefined,
    'an unknown transport is dropped, not echoed',
  );
});

test('waiting reasons include arrpc-closed and still fall back to discord-closed', () => {
  assert.equal(statusMessage('waiting', { reason: 'arrpc-closed' }).reason, 'arrpc-closed');
  assert.equal(statusMessage('waiting', { reason: 'nowhere' }).reason, 'discord-closed');
});
