import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLIENT_ID_RE, validateClientId, validateMessage } from '../../native/protocol.mjs';

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
