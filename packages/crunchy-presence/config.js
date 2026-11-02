/**
 * Shared application identity.
 *
 * A fresh install publishes presence with the built-in Crunchyroll
 * application, so there is no paste step. A stored 17-20 digit ID overrides it.
 */

export const HOST_NAME = "com.nathwn12.crunchy_presence";
export const DEFAULT_CLIENT_ID = "1566530911514923188";

const CLIENT_ID_RE = /^[0-9]{17,20}$/;

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
const isValidClientId = (value) => CLIENT_ID_RE.test(value);

/** The stored override when it is a real application ID, otherwise the built-in. */
export function resolveClientId(stored) {
  const text = trimmed(stored);
  return isValidClientId(text) ? text : DEFAULT_CLIENT_ID;
}

/**
 * What the options form should persist for a submitted value: a 17-20 digit
 * override, `null` to clear the override and use the built-in, or `undefined`
 * when the input is neither empty nor a valid application ID.
 */
export function clientIdToPersist(input) {
  const text = trimmed(input);
  if (!text) return null;
  if (!isValidClientId(text)) return undefined;
  return text === DEFAULT_CLIENT_ID ? null : text;
}
