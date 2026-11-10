/**
 * Discord activity builder for web-discord-rpc.
 *
 * `buildActivity(source, state, now)` turns one content-script state into the
 * SET_ACTIVITY payload for that source, or null when there is nothing worth
 * showing. YouTube becomes WATCHING (type 3), YouTube Music LISTENING (type 2);
 * `name` overrides the Discord application label so one application ID serves
 * both, and on Music it is the track's artist when one resolved.
 *
 * Rules live here, not in the worker: text limits, the source-hosted button,
 * and the timestamp maths are all decided in one place and proved by
 * test/extension/activity.test.mjs.
 */

import { SOURCE_YOUTUBE_MUSIC, SOURCE_META, sourceForUrl } from "./config.js";

const MAX_TEXT = 128;
const MAX_BUTTON_LABEL = 32;
const MAX_BUTTON_URL = 512;

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

/** Only an https page on the source's own host may become a Discord button. */
export function pickButtonUrl(raw, source) {
  if (sourceForUrl(raw) !== source) return null;
  const url = httpsUrl(raw);
  if (!url || url.length > MAX_BUTTON_URL) return null;
  return url;
}

/**
 * ONE activity for one source state, or null.
 *
 * Timestamps are whole seconds and follow the contract exactly:
 * `start = floor(now/1000)*1000 - floor(position)*1000`,
 * `end = start + floor(duration)*1000`, position clamped to `[0, duration]`,
 * and no timestamps at all unless the tab is playing with a positive duration.
 */
export function buildActivity(source, state, now = Date.now()) {
  const meta = SOURCE_META[source];
  if (!meta || !state || typeof state !== "object") return null;

  const details = clampText(state.title);
  if (!details) return null;

  const channel = clampText(state.channel);
  const album = source === SOURCE_YOUTUBE_MUSIC ? clampText(state.album) : null;

  // Music names the card after the artist: Discord renders the header and the
  // status line from `name`, so the static source label would hide the artist
  // the state line no longer carries. Without an artist the old shape stands.
  const artist = source === SOURCE_YOUTUBE_MUSIC ? channel : null;
  const labelledState = album
    ? clampText(`${channel || meta.label} — ${album}`)
    : channel || meta.label;
  const stateLine = artist ? album || meta.label : labelledState;

  const activity = {
    name: artist || meta.name,
    type: meta.type,
    details,
    state: stateLine,
  };

  const artwork = httpsUrl(state.artworkUrl);
  if (artwork) {
    activity.assets = { large_image: artwork };
    const largeText = album || details;
    if (largeText) activity.assets.large_text = largeText;
  }

  const pageUrl = pickButtonUrl(state.pageUrl, source);
  const label = clampText(meta.buttonLabel, MAX_BUTTON_LABEL);
  if (pageUrl && label) activity.buttons = [{ label, url: pageUrl }];

  const duration = Number(state.duration);
  if (state.paused === false && Number.isFinite(duration) && duration > 0) {
    const position = Number(state.position);
    const clamped = Number.isFinite(position)
      ? Math.min(Math.max(position, 0), duration)
      : 0;
    const start = Math.floor(now / 1000) * 1000 - Math.floor(clamped) * 1000;
    activity.timestamps = {
      start,
      end: start + Math.floor(duration) * 1000,
    };
  }

  return activity;
}
