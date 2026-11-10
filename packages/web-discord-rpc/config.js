/**
 * Shared application identity for web-discord-rpc.
 *
 * A fresh install publishes presence with the built-in Discord
 * application, so there is no paste step. A stored 17-20 digit ID overrides it.
 * `activity.name` overrides the displayed app label per source, so one
 * application ID serves both YouTube (WATCHING) and YouTube Music (LISTENING).
 */

export const HOST_NAME = "com.nathwn12.web_discord_rpc";
export const DEFAULT_CLIENT_ID = "1566530911514923188";

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
