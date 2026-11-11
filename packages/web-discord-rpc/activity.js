/**
 * Discord activity builder for web-discord-rpc.
 *
 * Music-only. `buildActivity(state, now)` turns one content-script state into
 * the SET_ACTIVITY payload for YouTube Music, or null when there is nothing
 * worth showing. LISTENING (type 2); `name` is the static `YouTube Music`
 * label so the expanded card reads "Listening to YouTube Music"; `details`
 * is the track, `state` is the artist, and the album survives only as a
 * tooltip while unique.
 *
 * `status_display_type: 1` (State) asks the member list to show the artist
 * from `state` instead of the app name. UNVERIFIED: actual Discord member-list
 * rendering was not observed in this environment; only the outgoing IPC
 * payload is asserted (see `scripts/e2e-ipc.mjs` and
 * `test/extension/activity.test.mjs`).
 *
 * Rules live here, not in the worker: text limits, the source-hosted button,
 * and the timestamp maths are all decided in one place and proved by
 * test/extension/activity.test.mjs.
 */

import { SOURCE_META, SOURCE_YOUTUBE_MUSIC, sourceForUrl } from "./config.js";

const MAX_TEXT = 128;
const MAX_BUTTON_LABEL = 32;
const MAX_BUTTON_URL = 512;

/** Member-list line: 1 = State (the artist). See header UNVERIFIED note. */
export const STATUS_DISPLAY_STATE = 1;

/**
 * Collapse whitespace, drop empties and single chars, hard-cap the length.
 * Discord requires details/state to be 2-128 characters, so a one-character
 * title is not showable and becomes null.
 */
export function clampText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function httpsUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Only an https page on the Music host may become a Discord button. */
export function pickButtonUrl(raw) {
  if (sourceForUrl(raw) !== SOURCE_YOUTUBE_MUSIC) return null;
  const url = httpsUrl(raw);
  if (!url || url.length > MAX_BUTTON_URL) return null;
  return url;
}

/**
 * ONE activity for the Music state, or null.
 *
 * Timestamps are whole seconds and follow the contract exactly:
 * `start = floor(now/1000)*1000 - floor(position)*1000`,
 * `end = start + floor(duration)*1000`, position clamped to `[0, duration]`,
 * and no timestamps at all unless the tab is playing with a positive duration.
 *
 * Accepts the legacy `(source, state, now)` call shape: when the first
 * argument is the `"youtube-music"` source string it is skipped.
 */
export function buildActivity(sourceOrState, stateOrNow, nowArg = Date.now()) {
  let state;
  let now;
  if (typeof sourceOrState === "string") {
    if (sourceOrState !== SOURCE_YOUTUBE_MUSIC) return null;
    state = stateOrNow;
    now = nowArg;
  } else {
    state = sourceOrState;
    now = typeof stateOrNow === "number" ? stateOrNow : Date.now();
  }
  const meta = SOURCE_META[SOURCE_YOUTUBE_MUSIC];
  if (!state || typeof state !== "object") return null;

  const details = clampText(state.title);
  if (!details) return null;

  const channel = clampText(state.channel);
  const album = clampText(state.album);

  // Music header is static: Discord renders "Listening to <name>", so the
  // artist must live in `state` to stay visible in the member list and the
  // card. The album never earns a visible line; that is what printed the same
  // album twice (state plus large_text).
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  let stateLine;
  if (channel && !same(channel, details) && !same(channel, meta.name)) {
    stateLine = channel;
  } else if (album && !same(album, details) && !same(album, meta.name)) {
    stateLine = album;
  } else {
    stateLine = meta.label;
  }

  const activity = {
    name: meta.name,
    type: meta.type,
    details,
    state: stateLine,
    status_display_type: STATUS_DISPLAY_STATE,
  };

  const artwork = httpsUrl(state.artworkUrl);
  if (artwork) {
    activity.assets = { large_image: artwork };
    // Tooltip only, and only when it says something the card does not.
    if (
      album &&
      !same(album, details) &&
      !same(album, meta.name) &&
      !same(album, stateLine)
    ) {
      activity.assets.large_text = album;
    }
  }

  const pageUrl = pickButtonUrl(state.pageUrl);
  const label = clampText(meta.buttonLabel, MAX_BUTTON_LABEL);
  if (pageUrl && label) activity.buttons = [{ label, url: pageUrl }];

  const duration = Number(state.duration);
  const position = state.position === null || state.position === undefined || state.position === ""
    ? Number.NaN
    : Number(state.position);
  if (
    state.paused === false &&
    Number.isFinite(duration) && duration > 0 &&
    Number.isFinite(position)
  ) {
    const clamped = Math.min(Math.max(position, 0), duration);
    const start = Math.floor(now / 1000) * 1000 - Math.floor(clamped) * 1000;
    activity.timestamps = {
      start,
      end: start + Math.floor(duration) * 1000,
    };
  }

  return activity;
}
