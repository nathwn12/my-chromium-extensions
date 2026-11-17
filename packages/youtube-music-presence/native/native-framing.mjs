/**
 * Chrome native-messaging framing: `uint32LE length | UTF-8 JSON`.
 *
 * Chrome writes whole frames but a pipe read can split one anywhere; the
 * decoder therefore buffers until a complete frame is present. A frame larger
 * than 1 MiB is refused rather than allocated — Chrome disconnects a host that
 * sends more than that, and a corrupt length must not become a memory bug.
 */

export const MAX_FRAME_BYTES = 1024 * 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true });

export class FramingError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "FramingError";
    this.code = code;
  }
}

/** Encode one message as a length-prefixed frame. */
export function encodeMessage(message) {
  let json;
  try {
    json = JSON.stringify(message);
  } catch (cause) {
    throw new FramingError("message is not JSON-serialisable", "bad-message", { cause });
  }
  if (typeof json !== "string") {
    throw new FramingError("message does not serialise to JSON", "bad-message");
  }
  const body = Buffer.from(json, "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new FramingError(
      `message of ${body.length} bytes exceeds the ${MAX_FRAME_BYTES} byte cap`,
      "frame-too-large",
    );
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** A stateful decoder: push any chunk shape, get every message it completed. */
export function createDecoder({ maxBytes = MAX_FRAME_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive integer");
  }

  let pending = Buffer.alloc(0);

  return {
    /** @param {Uint8Array} chunk @returns {unknown[]} complete messages */
    push(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("chunk must be a Uint8Array");
      }
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);

      const messages = [];
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (length > maxBytes) {
          pending = Buffer.alloc(0);
          throw new FramingError(
            `frame of ${length} bytes exceeds the ${maxBytes} byte cap`,
            "frame-too-large",
          );
        }
        if (pending.length < 4 + length) break;

        const body = pending.subarray(4, 4 + length);
        pending = pending.subarray(4 + length);

        let text;
        try {
          text = utf8.decode(body);
        } catch (cause) {
          throw new FramingError("frame body is not valid UTF-8", "bad-json", { cause });
        }
        try {
          messages.push(JSON.parse(text));
        } catch (cause) {
          throw new FramingError("frame body is not JSON", "bad-json", { cause });
        }
      }
      return messages;
    },

    /** Bytes held for a frame that has not fully arrived. */
    get pendingBytes() {
      return pending.length;
    },

    /** Drop buffered bytes, e.g. after a framing error ends the session. */
    reset() {
      pending = Buffer.alloc(0);
    },
  };
}
