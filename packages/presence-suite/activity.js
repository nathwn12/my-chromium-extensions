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
 * floor(clamp(position))`, `end = start + floor(duration)`. A sample already at
 * the end (floor(clamp(position)) >= floor(duration)) is the repeat boundary:
 * its pair would end at or before the sample instant, which Discord renders as
 * an elapsed-only card, so the start rolls over to `floor(anchor/1000)`. A pair
 * that would still be empty or expired is omitted, as is a total under one
 * whole second. The span is the real duration at every playback rate. Discord's
 * timer counts wall time and carries no playback rate, so the worker biases the
 * elapsed reference before it gets here; stretching `end` would instead change
 * the displayed length of the track. Nothing is stamped unless the tab is
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

import { CLOCK_MINIMAL, SOURCE_META, SOURCE_YOUTUBE_MUSIC, sourceForUrl } from "./config.js";

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
 * floor(clamp(position))`, `end = start + floor(duration)`. The span is the real
 * duration at 1x and at any other rate: Discord's timer counts wall time and
 * has no rate field, so a rate-scaled end would change how long the track reads
 * as (3:27 becomes 4:51 at 0.70x and 2:42 at 1.30x). A position already at the
 * end while playing is the repeat boundary: its pair would finish at or before
 * the sample instant, so the start rolls over to the anchor and the card keeps
 * a full span instead of an expired one. An empty or expired pair, or a total
 * below one whole second, is omitted rather than put on the wire. Position is
 * clamped to `[0, duration]`, and no timestamps at all unless the tab is
 * playing with a positive duration and a real position. `now` is milliseconds
 * and is the sample reference: the instant the position was sampled, a stored
 * value, not a clock read taken here. The anchor is `state.at` when that is a
 * finite stamp no more than 5 s ahead of `now`, else `now` itself — so a state
 * sampled at T stamps the same `start` however late it is rebuilt. Passing a
 * fresh clock as `now` breaks that guarantee (a rejected stamp then falls
 * back to a moving limit); the builder does not second-guess the caller.
 * Whole seconds leave on the wire.
 *
 * The optional trailing argument `{ clock, listenButton, albumButton, start }`
 * carries the stored display settings in; this builder never reads storage
 * and takes no clock of its own. Omitting it keeps the original payload
 * byte-for-byte. `clock: "minimal"` emits one `start` and no `end`, so
 * Discord counts up without bound; `start` is the worker's remembered whole
 * seconds for this track identity, and without one no timestamps go out. An
 * explicit false on a button flag drops that button, and no empty `buttons`
 * array is ever emitted.
 *
 * Also accepts `(source, state, now, options)`; a leading source other than
 * `youtube-music` builds nothing. In the object form the second argument is
 * `now`, the sample reference and the third is `options`. The rate bias
 * lives in that anchor; there is no separate sample instant and no rate
 * arithmetic here.
 */
export function buildActivity(sourceOrState, stateOrNow, nowArgOrOptions, optionsArg) {
  let state;
  let now;
  let options;
  if (typeof sourceOrState === "string") {
    if (sourceOrState !== SOURCE_YOUTUBE_MUSIC) return null;
    state = stateOrNow;
    now = typeof nowArgOrOptions === "number" ? nowArgOrOptions : Date.now();
    options = optionsArg;
  } else {
    state = sourceOrState;
    now = typeof stateOrNow === "number" ? stateOrNow : Date.now();
    options = nowArgOrOptions;
  }
  if (!options || typeof options !== "object") options = {};
  const meta = SOURCE_META[SOURCE_YOUTUBE_MUSIC];
  if (!state || typeof state !== "object") return null;

  const sampledAt =
    typeof state.at === "number" && Number.isFinite(state.at) ? state.at : null;
  const anchor =
    sampledAt !== null && sampledAt - now <= SAMPLE_SKEW_MS ? sampledAt : now;

  const details = clampText(state.title);
  if (!details) return null;

  const channel = clampText(state.channel);
  const album = clampText(state.album);

  const trackUrl = watchPageUrl(state.trackUrl);
  const artistUrl = artistPageUrl(state.artistUrl);
  const albumUrl = albumPageUrl(state.albumUrl);

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
  if (options.listenButton !== false && primaryUrl && label) buttons.push({ label, url: primaryUrl });
  if (options.albumButton !== false && albumUrl) buttons.push({ label: "View album", url: albumUrl });
  else if (options.albumButton !== false && artistUrl) buttons.push({ label: "View artist", url: artistUrl });
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
    const seconds = Math.floor(duration);
    if (seconds >= 1) {
      if (options.clock === CLOCK_MINIMAL) {
        /**
         * Minimal clock: one start and no end. Discord reads that as an
         * open-ended elapsed timer, so a repeated song keeps climbing. The
         * anchor is remembered by the worker for this track identity; with no
         * remembered anchor no stamp is sent, never one rebuilt from the
         * current pass's position.
         */
        const remembered = options.start;
        if (Number.isInteger(remembered) && remembered > 0) {
          activity.timestamps = { start: remembered };
        }
      } else {
        const clamped = Math.min(Math.max(position, 0), duration);
        /**
         * floor(clamped) >= floor(duration) is the repeat boundary: Discord's
         * integer clock already reads the end, so the sampled pair would finish
         * at or before its own instant. Anchor a fresh loop instead of emitting
         * a pair Discord renders as an elapsed-only card.
         */
        const atEnd = Math.floor(clamped) >= seconds;
        const start = atEnd
          ? Math.floor(anchor / 1000)
          : Math.floor(anchor / 1000) - Math.floor(clamped);
        const end = start + seconds;
        /** Never put an empty or already-expired pair on the wire. */
        if (end > start && end > Math.floor(now / 1000)) {
          activity.timestamps = { start, end };
        }
      }
    }
  }

  return activity;
}
