/**
 * Shared application identity for web-discord-rpc.
 *
 * A fresh install publishes presence with the built-in Discord
 * application, so there is no paste step. A stored 17-20 digit ID overrides it.
 * `activity.name` overrides the displayed app label per source, so one
 * application ID serves both YouTube (WATCHING) and YouTube Music (LISTENING).
 *
 * The same storage carries two preferences: which transport the native host
 * should use (`auto | ipc | arrpc`, `ipc` by default) and whether presence is
 * on at all. Both are validated here so no consumer has to invent a fourth
 * spelling or trust an unvalidated value.
 */

export const HOST_NAME = "com.nathwn12.web_discord_rpc";
export const DEFAULT_CLIENT_ID = "1566530911514923188";

/** `storage.local` keys the options surface and the worker both read. */
export const TRANSPORT_KEY = "transport";
export const ENABLED_KEY = "enabled";

/**
 * The transport preference sent in `hello`: `ipc` is the installed Discord
 * desktop app and the default; `auto` lets the host try IPC and fall back to
 * arRPC; a forced mode never falls back. `auto` and `arrpc` reach the deferred
 * Discord Web path and are marked as such on the surfaces.
 */
export const TRANSPORT_AUTO = "auto";
export const TRANSPORT_IPC = "ipc";
export const TRANSPORT_ARRPC = "arrpc";
export const TRANSPORTS = Object.freeze([TRANSPORT_AUTO, TRANSPORT_IPC, TRANSPORT_ARRPC]);
export const DEFAULT_TRANSPORT = TRANSPORT_IPC;

export const SOURCE_YOUTUBE = "youtube";
export const SOURCE_YOUTUBE_MUSIC = "youtube-music";

export const SOURCE_META = Object.freeze({
  youtube: {
    type: 3,
    name: "YouTube",
    label: "YouTube",
    buttonLabel: "Watch on YouTube",
  },
  "youtube-music": {
    type: 2,
    name: "YouTube Music",
    label: "YouTube Music",
    buttonLabel: "Listen on YouTube Music",
  },
});

const CLIENT_ID_RE = /^[0-9]{17,20}$/;

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
const isValidClientId = (value) => CLIENT_ID_RE.test(value);

/** Only https URLs are trusted. Hosts map to a source; anything else is null. */
export function sourceForUrl(url) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "music.youtube.com") return SOURCE_YOUTUBE_MUSIC;
  if (host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com") {
    return SOURCE_YOUTUBE;
  }
  return null;
}

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

/** The stored transport preference, or desktop IPC for anything unknown. */
export function resolveTransport(stored) {
  const text = trimmed(stored).toLowerCase();
  return TRANSPORTS.includes(text) ? text : DEFAULT_TRANSPORT;
}

/** Presence is on unless it was switched off; only a real `false` disables. */
export function resolveEnabled(stored) {
  return stored !== false;
}
