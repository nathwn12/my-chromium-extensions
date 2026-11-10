import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FramingError,
  MAX_FRAME_BYTES,
  createDecoder,
  encodeMessage,
} from "../../native/native-framing.mjs";

const decodeAll = (chunks) => {
  const decoder = createDecoder();
  return chunks.flatMap((chunk) => decoder.push(chunk));
};

test("a frame is a uint32LE byte length followed by UTF-8 JSON", () => {
  const frame = encodeMessage({ t: "ping" });
  const body = JSON.stringify({ t: "ping" });

  assert.equal(frame.readUInt32LE(0), Buffer.byteLength(body));
  assert.equal(frame.subarray(4).toString("utf8"), body);
  assert.deepEqual(decodeAll([frame]), [{ t: "ping" }]);
});

test("the length counts UTF-8 bytes, not characters", () => {
  const frame = encodeMessage({ title: "café 東京" });
  assert.equal(frame.readUInt32LE(0), Buffer.byteLength(JSON.stringify({ title: "café 東京" })));
  assert.deepEqual(decodeAll([frame]), [{ title: "café 東京" }]);
});

test("a frame survives being split at every byte boundary", () => {
  const frame = encodeMessage({ t: "hello", clientId: "1566530911514923188" });
  for (let split = 0; split <= frame.length; split += 1) {
    const decoder = createDecoder();
    const first = decoder.push(frame.subarray(0, split));
    const second = decoder.push(frame.subarray(split));
    assert.deepEqual([...first, ...second], [{ t: "hello", clientId: "1566530911514923188" }], `split at ${split}`);
    assert.equal(decoder.pendingBytes, 0);
  }
});

test("one chunk can complete several frames and leave a partial tail", () => {
  const one = encodeMessage({ n: 1 });
  const two = encodeMessage({ n: 2 });
  const three = encodeMessage({ n: 3 });

  const decoder = createDecoder();
  const joined = Buffer.concat([one, two, three.subarray(0, 3)]);
  assert.deepEqual(decoder.push(joined), [{ n: 1 }, { n: 2 }]);
  assert.equal(decoder.pendingBytes, 3);
  assert.deepEqual(decoder.push(three.subarray(3)), [{ n: 3 }]);
});

test("a frame over 1 MiB is refused before allocation and on encode", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
  const decoder = createDecoder();
  assert.throws(
    () => decoder.push(header),
    (error) => error instanceof FramingError && error.code === "frame-too-large",
  );

  assert.throws(
    () => encodeMessage({ blob: "x".repeat(MAX_FRAME_BYTES) }),
    (error) => error instanceof FramingError && error.code === "frame-too-large",
  );
});

test("malformed bodies fail with a named code, never a partial message", () => {
  const badJson = Buffer.from("not json", "utf8");
  const frame = Buffer.alloc(4 + badJson.length);
  frame.writeUInt32LE(badJson.length, 0);
  badJson.copy(frame, 4);

  assert.throws(
    () => createDecoder().push(frame),
    (error) => error instanceof FramingError && error.code === "bad-json",
  );

  const invalidUtf8 = Buffer.from([0xff, 0xfe]);
  const binaryFrame = Buffer.alloc(4 + invalidUtf8.length);
  binaryFrame.writeUInt32LE(invalidUtf8.length, 0);
  invalidUtf8.copy(binaryFrame, 4);
  assert.throws(
    () => createDecoder().push(binaryFrame),
    (error) => error instanceof FramingError && error.code === "bad-json",
  );

  const empty = Buffer.alloc(4);
  assert.throws(
    () => createDecoder().push(empty),
    (error) => error instanceof FramingError && error.code === "bad-json",
  );
});

test("encoding a value that has no JSON form is refused", () => {
  assert.throws(
    () => encodeMessage(undefined),
    (error) => error instanceof FramingError && error.code === "bad-message",
  );
  const circular = {};
  circular.self = circular;
  assert.throws(
    () => encodeMessage(circular),
    (error) => error instanceof FramingError && error.code === "bad-message",
  );
});

test("only Uint8Array chunks are accepted", () => {
  const decoder = createDecoder();
  assert.throws(() => decoder.push("string"), TypeError);
  assert.throws(() => decoder.push([1, 2, 3]), TypeError);
});
