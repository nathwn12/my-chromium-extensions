/**
 * Shared application identity for web-discord-rpc.
 *
 * Music-only, desktop-IPC-only. A fresh install publishes YouTube Music
 * presence with the built-in Discord application, so there is no paste step.
 * `activity.name` is the static `YouTube Music` label, so the card reads
 * "Listening to YouTube Music" while `state` carries the artist.
 *
 * The only user-facing preference is the master presence switch
 * (`storage.local` key `enabled`, on unless explicitly `false`). The native
 * host is always addressed over desktop IPC (`transport: "ipc"` in `hello`);
 * any stored legacy `transport` / per-site / `clientId` values are ignored.
 */

export const HOST_NAME = "com.nathwn12.web_discord_rpc";
export const DEFAULT_CLIENT_ID = "1566530911514923188";

/** `storage.local` key the toggle and the worker both read. */
export const ENABLED_KEY = "enabled";

/** Desktop IPC is the only transport. Kept as a constant for the hello. */
export const TRANSPORT_IPC = "ipc";
export const DEFAULT_TRANSPORT = TRANSPORT_IPC;

/** Legacy storage key, ignored: the worker always sends `ipc`. */
export const TRANSPORT_KEY = "transport";

export const SOURCE_YOUTUBE_MUSIC = "youtube-music";

export const SOURCE_META = Object.freeze({
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

/** Only music.youtube.com over https is trusted; everything else is null. */
export function sourceForUrl(url) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return parsed.hostname.toLowerCase() === "music.youtube.com"
    ? SOURCE_YOUTUBE_MUSIC
    : null;
}

/** The stored override when it is a real application ID, otherwise the built-in. */
export function resolveClientId(stored) {
  const text = trimmed(stored);
  return isValidClientId(text) ? text : DEFAULT_CLIENT_ID;
}

/**
 * What the options form would persist for a submitted value. Retained for the
 * native host import surface; the Music-only UI no longer offers an override.
 */
export function clientIdToPersist(input) {
  const text = trimmed(input);
  if (!text) return null;
  if (!isValidClientId(text)) return undefined;
  return text === DEFAULT_CLIENT_ID ? null : text;
}

/** Desktop IPC, always: any stored or legacy value resolves to `ipc`. */
export function resolveTransport() {
  return TRANSPORT_IPC;
}

/** Presence is on unless it was switched off; only a real `false` disables. */
export function resolveEnabled(stored) {
  return stored !== false;
}
