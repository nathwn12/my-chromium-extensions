/**
 * Discord activity builder for youtube-music-presence.
 *
 * Music-only. `buildActivity(state, now)` turns one content-script state into
 * the SET_ACTIVITY payload for YouTube Music, or null when there is nothing
 * worth showing. LISTENING (type 2); `name` is the static `YouTube Music`
 * label so the expanded card reads "Listening to YouTube Music"; `details`
 * is the track, `state` is the artists (album fallback, then the label).
 *
 * The card is plain text. Discord underlines every linked field and offers no
 * way to link without the underline, so no `*_url` field is ever emitted —
 * not `details_url`, not `state_url`, not `assets.large_url`. The cover is
 * not a link. Two buttons are the only clickable things, each pinned to https
 * on `music.youtube.com` and capped at 512 characters, and each judged by its
 * own path — a same-host Home or Explore URL is never a button:
 *   - button 1 "Listen on YouTube Music" -> the canonical track URL, which
 *     must be `/watch` with an 11-character `v`; `pageUrl` is only a fallback
 *     when it has that same shape, else no button 1 at all.
 *   - button 2 "View album" -> an album URL whose path starts `/browse/MPRE`,
 *     else "View artist" -> an artist URL whose path starts `/channel/`.
 *     A URL that fails its shape is dropped; it never becomes another target.
 * The cover tooltip (`assets.large_text`) is the album while it is distinct
 * from every visible line, else the view count while it is distinct from
 * them, else absent. The title is never the tooltip.
 *
 * Timestamps are integer SECONDS on the wire: `start = floor(anchor/1000) -
 * floor(clamp(position))`, `end = start + floor(duration)`. A caller that also
 * supplies the un-biased sample instant gets a rate-scaled `end` at non-1x;
 * 1x is byte-identical with or without it. Nothing is stamped unless the tab is
 * playing with a finite position and a positive duration; `now` goes in as
 * milliseconds.
 *
 * The anchor is a property of the SAMPLE, never of the send. `now` is the
 * sample reference: the instant the position was sampled, always a stored
 * value on the caller's side — never a clock read taken at build time. A
 * finite `state.at` (the content script's own stamp) is used whenever it is
 * not more than 5 seconds ahead of that reference; otherwise — no stamp, a
 * junk stamp, or a stamp far in the future — the passed `now` is used.
 * Discord renders elapsed time as `clientNow - start`, so anchoring to the
 * send instead would push `start` later by exactly the staleness: the bar
 * would lose the time since the last sample on every rebuild and snap back on
 * the next media event. Anchoring to the sample makes the payload for one
 * sample byte-identical whenever it is rebuilt, which is what lets the worker
 * skip the resend.
 *
 * This function cannot enforce that contract: a caller that passes `Date.now()`
 * as `now` makes the "not more than 5 s ahead" guard relative to the rebuild
 * clock, so a rejected stamp falls back to a limit that moves every tick. The
 * worker therefore passes an instant it has stored (see `sampleAt` in
 * background.js); there is deliberately no second clock in here to paper over
 * a caller who does not.
 *
 * `status_display_type: 1` (State) asks the member list to show the artist
 * from `state` instead of the app name. UNVERIFIED: actual Discord member-list
 * rendering was not observed in this environment; only the outgoing IPC
 * payload is asserted (see `scripts/e2e-ipc.mjs` and
 * `test/extension/activity.test.mjs`).
 *
 * Rules live here, not in the worker: text limits, the button policy, and the
 * timestamp maths are all decided in one place and proved by
 * test/extension/activity.test.mjs.
 */

import { SOURCE_META, SOURCE_YOUTUBE_MUSIC, sourceForUrl } from "./config.js";

const MAX_TEXT = 128;
const MAX_BUTTON_LABEL = 32;
const MAX_BUTTON_URL = 512;
/** A sample stamp this far ahead of `now` is still trusted, as clock skew. */
export const SAMPLE_SKEW_MS = 5000;
/**
 * A rate this close to 1 is 1x. Single owner: background.js imports this, and
 * the classic content script keeps a literal pinned by rate-epsilon.test.mjs
 * because a content script cannot import.
 */
export const RATE_EPSILON = 0.01;

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

/** A YouTube Music song page: `/watch` and video id `v`, exactly as YTM serves it. */
const WATCH_ID = /^[A-Za-z0-9_-]{11}$/;
/** Album and artist pages are told apart by path, never by host or query. */
const ALBUM_PATH = "/browse/MPRE";
const ARTIST_PATH = "/channel/";

/** A button URL only for a path with the given prefix; host/scheme/length first. */
function pathShapedUrl(raw, prefix) {
  const url = pickButtonUrl(raw);
  if (!url) return null;
  try {
    return new URL(url).pathname.startsWith(prefix) ? url : null;
  } catch {
    return null;
  }
}

/** An album button opens `/browse/MPRE…`, never Home or a playlist. */
function albumPageUrl(raw) {
  return pathShapedUrl(raw, ALBUM_PATH);
}

/** An artist button opens `/channel/…`, never Home or a watch page. */
function artistPageUrl(raw) {
  return pathShapedUrl(raw, ARTIST_PATH);
}

/**
 * The page URL is only a song when it is that song's own watch page. YTM is
 * an SPA, so a playing tab's `pageUrl` can be Home, Explore, a playlist or a
 * channel; opening any of those from the card is the wrong door. Outer host,
 * scheme and length policy stays `pickButtonUrl`'s.
 */
function watchPageUrl(raw) {
  const url = pickButtonUrl(raw);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/watch") return null;
    return WATCH_ID.test(parsed.searchParams.get("v") || "") ? url : null;
  } catch {
    return null;
  }
}

/**
 * ONE activity for the Music state, or null.
 *
 * Timestamps follow the contract exactly: `start = floor(anchor/1000) -
 * floor(clamp(position))`, `end = start + floor(duration)` at 1x; a caller that
 * also passes the un-biased sample instant gets `end = floor(sample/1000 +
 * (duration - clamp(position)) / rate)` at a non-1x rate. Position is clamped
 * to `[0, duration]`, and no timestamps at all unless the tab is playing with
 * a positive duration and a real position. `now` is milliseconds and is the
 * sample reference: the instant the position was sampled, a stored value, not
 * a clock read taken here. The anchor is `state.at` when that is a finite
 * stamp no more than 5 s ahead of `now`, else `now` itself — so a state
 * sampled at T stamps the same `start` however late it is rebuilt. Passing a
 * fresh clock as `now` breaks that guarantee (a rejected stamp then falls
 * back to a moving limit); the builder does not second-guess the caller.
 * Whole seconds leave on the wire.
 *
 * Also accepts `(source, state, now, sampleMs)`; a leading source other than
 * `youtube-music` builds nothing. In the object form the third argument is
 * `sampleMs`, the un-biased sample instant the worker kept alongside the biased
 * anchor passed as `now`. It is only used to scale the countdown at non-1x.
 */
export function buildActivity(sourceOrState, stateOrNow, nowArg, sampleMs = undefined) {
  let state;
  let now;
  let sample;
  if (typeof sourceOrState === "string") {
    if (sourceOrState !== SOURCE_YOUTUBE_MUSIC) return null;
    state = stateOrNow;
    now = typeof nowArg === "number" ? nowArg : Date.now();
    sample = sampleMs;
  } else {
    state = sourceOrState;
    now = typeof stateOrNow === "number" ? stateOrNow : Date.now();
    sample = typeof nowArg === "number" ? nowArg : sampleMs;
  }
  const meta = SOURCE_META[SOURCE_YOUTUBE_MUSIC];
  if (!state || typeof state !== "object") return null;

  // The sample's own stamp wins, never the moment of the rebuild; a stamp
  // further than SAMPLE_SKEW_MS ahead is treated as junk and ignored.
  const sampledAt =
    typeof state.at === "number" && Number.isFinite(state.at) ? state.at : null;
  const anchor =
    sampledAt !== null && sampledAt - now <= SAMPLE_SKEW_MS ? sampledAt : now;

  const details = clampText(state.title);
  if (!details) return null;

  const channel = clampText(state.channel);
  const album = clampText(state.album);

  // Each button is decided by its own path shape, so a same-host Home or
  // Explore URL never becomes one; a URL that fails its shape is dropped and
  // never stands in for a different target.
  const trackUrl = watchPageUrl(state.trackUrl);
  const artistUrl = artistPageUrl(state.artistUrl);
  const albumUrl = albumPageUrl(state.albumUrl);

  // Music header is static: Discord renders "Listening to <name>", so the
  // artist must live in `state` to stay visible in the member list and the
  // card. The album is only a fallback line.
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  let stateLine;
  if (channel && !same(channel, details) && !same(channel, meta.name)) {
    stateLine = channel;
  } else if (album && !same(album, details) && !same(album, meta.name)) {
    stateLine = album;
  } else {
    stateLine = meta.label;
  }

  /** Tooltip text must say something no visible line already says. */
  const distinct = (text) =>
    Boolean(text) && !same(text, details) && !same(text, stateLine) && !same(text, meta.name);

  const activity = {
    name: meta.name,
    type: meta.type,
    details,
  };
  activity.state = stateLine;
  activity.status_display_type = STATUS_DISPLAY_STATE;

  const artwork = httpsUrl(state.artworkUrl);
  if (artwork) {
    activity.assets = { large_image: artwork };
    // Tooltip only, and only when it says something the card does not: the
    // album while it is distinct, else the view count while it is distinct.
    // The title owns line 1 and is never repeated here.
    const views =
      typeof state.views === "string" && state.views.trim()
        ? state.views.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)
        : null;
    if (distinct(album)) {
      activity.assets.large_text = album;
    } else if (distinct(views)) {
      activity.assets.large_text = views;
    }
  }

  const label = clampText(meta.buttonLabel, MAX_BUTTON_LABEL);
  const primaryUrl = trackUrl || watchPageUrl(state.pageUrl);
  const buttons = [];
  if (primaryUrl && label) buttons.push({ label, url: primaryUrl });
  // Decided by URL, never by album text: an album name with no album link
  // never produces a "View album" button.
  if (albumUrl) buttons.push({ label: "View album", url: albumUrl });
  else if (artistUrl) buttons.push({ label: "View artist", url: artistUrl });
  if (buttons.length) activity.buttons = buttons;

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
    const start = Math.floor(anchor / 1000) - Math.floor(clamped);
    const rate = state.playbackRate;
    const rateScaled =
      typeof rate === "number" && Number.isFinite(rate) && rate > 0 &&
      Math.abs(rate - 1) > RATE_EPSILON &&
      typeof sample === "number" && Number.isFinite(sample);
    activity.timestamps = {
      start,
      // Discord counts the countdown in wall time; media seconds are not wall
      // seconds at a non-1x rate. Build the end from the un-biased sample
      // second plus the remaining media time divided by the rate, with one
      // floor over the sum: the residual is the sub-second part of one stamp,
      // not a drift that grows with the track. The elapsed bar keeps the
      // biased anchor above.
      end: rateScaled
        ? Math.floor(sample / 1000 + (duration - clamped) / rate)
        : start + Math.floor(duration),
    };
  }

  return activity;
}
