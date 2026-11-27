import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FramingError,
  MAX_FRAME_BYTES,
  createDecoder,
  encodeMessage,
} from "../native/native-framing.mjs";

// Mutation: write the length prefix big-endian instead of UInt32LE.
test("framing: encode/decode round-trip with a little-endian prefix", () => {
  const message = { t: "activity", source: "crunchy", n: 7 };
  const frame = encodeMessage(message);
  const body = Buffer.from(JSON.stringify(message), "utf8");
  assert.equal(frame.readUInt32LE(0), body.length);
  assert.deepEqual([...frame.subarray(4)], [...body]);
  const decoder = createDecoder();
  assert.deepEqual(decoder.push(frame), [message]);
  assert.equal(decoder.pendingBytes, 0);
});

// Mutation: decode only when a whole frame arrives in a single chunk.
test("framing: one frame split across chunks is reassembled", () => {
  const decoder = createDecoder();
  const frame = encodeMessage({ t: "hello", id: 1 });
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.equal(decoder.pendingBytes, 2);
  assert.deepEqual(decoder.push(frame.subarray(2, 9)), []);
  assert.ok(decoder.pendingBytes > 0);
  assert.deepEqual(decoder.push(frame.subarray(9)), [{ t: "hello", id: 1 }]);
  assert.equal(decoder.pendingBytes, 0);
});

// Mutation: return after the first complete frame in a chunk.
test("framing: two frames in one chunk both decode", () => {
  const a = { t: "a", n: 1 };
  const b = { t: "b", n: 2 };
  const chunk = Buffer.concat([encodeMessage(a), encodeMessage(b)]);
  assert.deepEqual(createDecoder().push(chunk), [a, b]);
});

// Mutation: treat a zero-length frame body as an empty message instead of rejecting it.
test("framing: empty chunks are harmless; a zero-length frame is rejected as bad-json", () => {
  const decoder = createDecoder();
  assert.deepEqual(decoder.push(new Uint8Array(0)), []);
  assert.equal(decoder.pendingBytes, 0);
  assert.throws(
    () => decoder.push(Buffer.alloc(4)),
    (error) => error instanceof FramingError && error.code === "bad-json"
  );
  assert.equal(decoder.pendingBytes, 0);
  assert.throws(
    () => encodeMessage(() => {}),
    (error) => error instanceof FramingError && error.code === "bad-message"
  );
});

// Mutation: remove the length > maxBytes guard in createDecoder's push.
test("framing: oversized payloads are refused on encode and on decode", () => {
  assert.throws(
    () => encodeMessage({ blob: "x".repeat(MAX_FRAME_BYTES) }),
    (error) => error instanceof FramingError && error.code === "frame-too-large"
  );
  const decoder = createDecoder({ maxBytes: 32 });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(33, 0);
  assert.throws(
    () => decoder.push(prefix),
    (error) => error instanceof FramingError && error.code === "frame-too-large"
  );
  assert.equal(decoder.pendingBytes, 0);
  assert.deepEqual(decoder.push(encodeMessage({ ok: true })), [{ ok: true }]);
});

// Mutation: remove the while (pending.length >= 4) guard so a short prefix is read anyway.
test("framing: an incomplete prefix is buffered without throwing; a nonsense prefix is rejected", () => {
  const decoder = createDecoder();
  const frame = encodeMessage({ t: "pong" });
  assert.doesNotThrow(() => decoder.push(frame.subarray(0, 3)));
  assert.equal(decoder.pendingBytes, 3);
  assert.deepEqual(decoder.push(frame.subarray(3)), [{ t: "pong" }]);

  const bad = createDecoder();
  const nonsense = Buffer.alloc(4);
  nonsense.writeUInt32LE(0xffffffff, 0);
  assert.throws(
    () => bad.push(nonsense),
    (error) => error instanceof FramingError && error.code === "frame-too-large"
  );
  assert.equal(bad.pendingBytes, 0);
  assert.deepEqual(bad.push(encodeMessage({ t: "still-working" })), [{ t: "still-working" }]);
});
