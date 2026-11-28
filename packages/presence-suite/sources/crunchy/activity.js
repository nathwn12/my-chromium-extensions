/**
 * Crunchyroll activity builder adapter for presence-suite.
 * Ported from crunchy-presence/background.js; WATCHING (type 3).
 * The worker calls buildActivity(state, now, options) for the crunchy source.
 * `options` carries the shared display settings: `clock: "minimal"` emits a
 * single remembered `start` with no `end`, and an explicit false on
 * `listenButton` / `albumButton` drops that button. Omitting the fields
 * keeps the original payload byte-for-byte.
 */
import { CLOCK_MINIMAL } from "../../config.js";

const MAX_TEXT = 128;

/** Collapse whitespace, drop empties and single chars, hard-cap at 128 characters. */
export function clampText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length < 2) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Fit text into `max` characters: cut at the last sentence end, else the last
 * space, strip a dangling separator and append "…" only when text was cut.
 */
export function smartTruncate(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= max) return text;

  const body = text.slice(0, max);
  let end = -1;
  for (const mark of [". ", "! ", "? "]) {
    const at = body.lastIndexOf(mark);
    if (at > end) end = at;
  }
  if (end >= 0) {
    end += 1; // keep the punctuation, drop the space
  } else {
    const space = body.lastIndexOf(" ");
    end = space > 0 ? space : Math.max(1, max - 1);
  }
  const cut = body.slice(0, end).replace(/[\s·,]+$/, "");
  return `${cut || body.slice(0, max - 1).trim()}…`;
}

/** Seconds -> "m:ss" (or "h:mm:ss" past an hour). */
export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "S1 E5 · 12:34 / 24:00" when the numbers exist, otherwise "Crunchyroll". */
export function formatStateLine(state) {
  if (!state) return "Crunchyroll";
  const season = Number.isFinite(Number(state.seasonNumber)) && state.seasonNumber !== null
    ? Number(state.seasonNumber)
    : null;
  const episode = Number.isFinite(Number(state.episodeNumber)) && state.episodeNumber !== null
    ? Number(state.episodeNumber)
    : null;

  let base = null;
  if (season !== null && episode !== null) base = `S${season} E${episode}`;
  else if (episode !== null) base = `E${episode}`;
  else return "Crunchyroll";

  const duration = Number(state.duration);
  const position = Number(state.position);
  if (Number.isFinite(duration) && duration > 0) {
    base += ` · ${clock(Number.isFinite(position) ? position : 0)} / ${clock(duration)}`;
  }
  return clampText(base) || "Crunchyroll";
}

function httpsUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Only an https Crunchyroll watch page may become a Discord button. */
export function pickButtonUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (!/(^|\.)crunchyroll\.com$/i.test(url.hostname)) return null;
    const out = url.toString();
    if (out.length > 512) return null;
    return out;
  } catch {
    return null;
  }
}

/** Discord SET_ACTIVITY payload for one merged tab state, or null. */
export function buildActivity(state, now = Date.now(), options = {}) {
  if (!state) return null;

  const season =
    Number.isFinite(Number(state.seasonNumber)) && state.seasonNumber !== null
      ? Number(state.seasonNumber)
      : null;
  const episode =
    Number.isFinite(Number(state.episodeNumber)) && state.episodeNumber !== null
      ? Number(state.episodeNumber)
      : null;

  const synopsis = options.synopsis === true ? smartTruncate(state.synopsis) : null;
  let details;
  let stateLine;
  if (synopsis) {
    details = clampText(state.series);
    if (details && season !== null && episode !== null) {
      details = clampText(`${details} · S${season} E${episode}`);
    }
    if (!details) details = clampText(state.episodeTitle);
    stateLine = synopsis;
  } else {
    details = clampText(state.series) || clampText(state.episodeTitle);
    stateLine = formatStateLine(state);
  }
  if (!details) return null;

  const activity = {
    type: 3, // WATCHING
    details,
    state: stateLine
  };

  const artwork = pickButtonUrl(state.artworkUrl);
  const largeText = clampText(state.episodeTitle) || clampText(state.series);
  if (artwork) {
    activity.assets = { large_image: artwork };
    if (largeText) activity.assets.large_text = largeText;
  }

  const seriesUrl = pickButtonUrl(state.seriesUrl);
  let episodeUrl = pickButtonUrl(state.episodeUrl);
  if (!episodeUrl && !seriesUrl) episodeUrl = pickButtonUrl(state.pageUrl);
  const buttons = [];
  if (options.listenButton !== false && episodeUrl) {
    const label = seriesUrl ? "Watch Episode" : "Watch on Crunchyroll";
    buttons.push({ label: clampText(label, 32), url: episodeUrl });
  }
  if (options.albumButton !== false && seriesUrl) {
    buttons.push({ label: clampText("View Series", 32), url: seriesUrl });
  }
  if (buttons.length) activity.buttons = buttons.slice(0, 2);

  const position = Number(state.position);
  const duration = Number(state.duration);
  const durationSec = Math.floor(duration);
  if (state.paused === false && Number.isFinite(duration) && duration > 0 && durationSec >= 1) {
    const reportedSec =
      Number.isFinite(position) && position >= 0 ? Math.floor(position) : 0;
    // At or past the end, the old maths stamped `end` at `now`; the pair was
    // born expired and Discord dropped the total for a bare elapsed timer.
    // Stop one whole second short instead: an end at the next second boundary
    // is still in the future, and `end - start` stays the real episode length,
    // so the total is never rewritten to a shorter read.
    const atSec = Math.min(reportedSec, durationSec - 1);
    const baseSec = Math.floor(now / 1000) * 1000;
    if (options.clock === CLOCK_MINIMAL) {
      // No end: Discord counts up. The worker owns the per-identity anchor.
      const remembered = options.start;
      if (Number.isInteger(remembered) && remembered > 0) {
        activity.timestamps = { start: remembered };
      }
    } else {
      activity.timestamps = {
        start: Math.round(baseSec - atSec * 1000),
        end: Math.round(baseSec + (durationSec - atSec) * 1000)
      };
    }
  }

  return activity;
}

