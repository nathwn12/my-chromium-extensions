/**
 * Shared application identity for presence-suite.
 *
 * One extension, one native host, two sources: YouTube Music (LISTENING) and
 * Crunchyroll (WATCHING). Every source keeps the application ID it shipped
 * with; the host speaks both through SOURCE_META. A stored per-source ID only
 * overrides that source's built-in.
 *
 * Storage (no new permissions):
 *   local:   enabled = { crunchy: true, "youtube-music": true }
 *            clientId:<source> = a 17-20 digit override (optional)
 *            presenceStatus = last published status
 *   session: presenceTabs = per-source tab snapshot across MV3 suspension
 * Old crpStatus / ytmpStatus keys are left untouched; v1 does not migrate.
 */

export const HOST_NAME = "com.nathwn12.presence_suite";

export const SOURCE_CRUNCHY = "crunchy";
export const SOURCE_YOUTUBE_MUSIC = "youtube-music";
export const SOURCES = Object.freeze([SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC]);

/** The two application IDs exactly as the source extensions shipped them. */
export const DEFAULT_CLIENT_IDS = Object.freeze({
  [SOURCE_CRUNCHY]: "1566530911514923188",
  [SOURCE_YOUTUBE_MUSIC]: "1566530911514923188",
});

/** Built-in ID for the single host hello and the legacy import surface. */
export const DEFAULT_CLIENT_ID = DEFAULT_CLIENT_IDS[SOURCE_YOUTUBE_MUSIC];

/** local key holding the per-source switch map. */
export const ENABLED_KEY = "enabled";
/** key holding the published status; mirrors bridge-status.STATUS_KEY. */
export const STATUS_KEY = "presenceStatus";
/** session key holding the tab snapshot. */
export const TABS_KEY = "presenceTabs";

/** Desktop IPC is the only transport. */
export const TRANSPORT_IPC = "ipc";
export const DEFAULT_TRANSPORT = TRANSPORT_IPC;
export const TRANSPORT_KEY = "transport";

/** Source registry: activity type, display copy, trusted host, application ID. */
export const SOURCE_META = Object.freeze({
  [SOURCE_YOUTUBE_MUSIC]: Object.freeze({
    type: 2,
    name: "YouTube Music",
    label: "YouTube Music",
    buttonLabel: "Listen on YouTube Music",
    host: "music.youtube.com",
    clientId: DEFAULT_CLIENT_IDS[SOURCE_YOUTUBE_MUSIC],
  }),
  [SOURCE_CRUNCHY]: Object.freeze({
    type: 3,
    name: "Crunchyroll",
    label: "Crunchyroll",
    buttonLabel: "Watch on Crunchyroll",
    host: "crunchyroll.com",
    clientId: DEFAULT_CLIENT_IDS[SOURCE_CRUNCHY],
  }),
});

const CLIENT_ID_RE = /^[0-9]{17,20}$/;

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
const isValidClientId = (value) => CLIENT_ID_RE.test(value);

/** The source whose page this is; null for anything untrusted. */
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
  if (host === "crunchyroll.com" || host.endsWith(".crunchyroll.com")) return SOURCE_CRUNCHY;
  return null;
}

/** The stored override when it is a real application ID, else that source's built-in. */
export function resolveClientId(stored, source = SOURCE_YOUTUBE_MUSIC) {
  const text = trimmed(stored);
  if (isValidClientId(text)) return text;
  return DEFAULT_CLIENT_IDS[source] ?? DEFAULT_CLIENT_ID;
}

/**
 * What the options form persists: a valid override, null to clear it back to
 * the source's built-in, or undefined for junk input.
 */
export function clientIdToPersist(input, source = SOURCE_YOUTUBE_MUSIC) {
  const text = trimmed(input);
  if (!text) return null;
  if (!isValidClientId(text)) return undefined;
  return text === (DEFAULT_CLIENT_IDS[source] ?? DEFAULT_CLIENT_ID) ? null : text;
}

/** The local key that stores one source's application-ID override. */
export function clientIdKey(source) {
  return "clientId:" + source;
}

/** Desktop IPC, always: any stored value resolves to ipc. */
export function resolveTransport() {
  return TRANSPORT_IPC;
}

/**
 * Presence for a source is on unless its flag is explicitly false.
 * With a source argument the stored enabled map is read; without one the
 * legacy boolean form keeps the original identity logic.
 */
export function resolveEnabled(stored, source) {
  if (source !== undefined) {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return true;
    return stored[source] !== false;
  }
  return stored !== false;
}

/** A complete per-source switch map with both sources defaulted on. */
export function enabledMap(stored) {
  const out = {};
  for (const source of SOURCES) out[source] = resolveEnabled(stored, source);
  return out;
}
