import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Load the worker as a module without a `chrome` global: the file guards every
// chrome.* call on `hasChrome`. background.js imports config.js, so it is
// imported by path rather than as a data: URL (which cannot resolve imports).
const worker = await import(
  pathToFileURL(join(here, "..", "..", "background.js")).href
);

const {
  buildActivity,
  formatStateLine,
  pickBestTab,
  pickButtonUrl,
  isEligible,
  isAdBreak,
  clampText,
  clock,
  createCoalescingLimiter,
  bridgeStatusOf,
  mergeFrame,
  resolveTab,
  smartTruncate,
  METADATA_FIELDS
} = worker;

const { classifyBridgeFailure, presentStatus, REASON } = await import(
  pathToFileURL(join(here, "..", "..", "bridge-status.js")).href
);

const NOW = 1_700_000_000_000;
const TAB_URL = "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning";

const playing = (overrides = {}) => ({
  series: "Frieren: Beyond Journey's End",
  episodeTitle: "The Beginning",
  seasonNumber: 1,
  episodeNumber: 5,
  artworkUrl: "https://img.crunchyroll.com/ep5.jpg",
  duration: 1440,
  position: 754,
  paused: false,
  pageUrl: TAB_URL,
  ...overrides
});

test("module loads without chrome and exposes only pure helpers", () => {
  assert.equal(worker.hasChrome, false);
  for (const fn of [buildActivity, formatStateLine, pickBestTab, pickButtonUrl, isEligible, clampText, clock]) {
    assert.equal(typeof fn, "function");
  }
});

test("full activity: WATCHING, capped text, artwork, button, timestamps while playing", () => {
  const activity = buildActivity(playing(), NOW);
  assert.deepEqual(activity, {
    type: 3,
    details: "Frieren: Beyond Journey's End",
    state: "S1 E5 · 12:34 / 24:00",
    assets: {
      large_image: "https://img.crunchyroll.com/ep5.jpg",
      large_text: "The Beginning"
    },
    buttons: [{ label: "Watch on Crunchyroll", url: TAB_URL }],
    timestamps: {
      start: NOW - 754_000,
      end: NOW + (1440 - 754) * 1000
    }
  });
});

test("paused playback carries no timestamps", () => {
  const activity = buildActivity(playing({ paused: true }), NOW);
  assert.equal(activity.timestamps, undefined);
  assert.equal(activity.state, "S1 E5 · 12:34 / 24:00");
});

test("unknown pause state never produces timestamps", () => {
  const activity = buildActivity(playing({ paused: null }), NOW);
  assert.equal(activity.timestamps, undefined);
});

test("no season/episode numbers collapses state to Crunchyroll", () => {
  const activity = buildActivity(playing({ seasonNumber: null, episodeNumber: null }), NOW);
  assert.equal(activity.state, "Crunchyroll");
});

test("episode number without season renders E<n> plus progress", () => {
  const activity = buildActivity(playing({ seasonNumber: null, episodeNumber: 12 }), NOW);
  assert.equal(activity.state, "E12 · 12:34 / 24:00");
});

test("numbers without a duration keep the short form", () => {
  assert.equal(formatStateLine({ seasonNumber: 2, episodeNumber: 7, duration: 0, position: 0 }), "S2 E7");
  assert.equal(formatStateLine({ seasonNumber: 2, episodeNumber: 7 }), "S2 E7");
  assert.equal(formatStateLine(null), "Crunchyroll");
});

test("details falls back to the episode title, then is absent without either", () => {
  const byEpisode = buildActivity(playing({ series: null }), NOW);
  assert.equal(byEpisode.details, "The Beginning");
  assert.equal(buildActivity({ seasonNumber: 1, episodeNumber: 1 }, NOW), null);
  assert.equal(buildActivity(null, NOW), null);
});

test("details, state and large_text are capped at 128 characters", () => {
  const activity = buildActivity(
    playing({ series: "S".repeat(300), episodeTitle: "E".repeat(300) }),
    NOW
  );
  assert.equal(activity.details.length, 128);
  assert.equal(activity.assets.large_text.length, 128);
  assert.ok(activity.state.length <= 128);
});

test("non-https artwork is dropped, and assets vanish with it", () => {
  const activity = buildActivity(playing({ artworkUrl: "http://img.crunchyroll.com/ep5.jpg" }), NOW);
  assert.equal(activity.assets, undefined);
});

test("button only for an https Crunchyroll URL", () => {
  assert.equal(buildActivity(playing({ pageUrl: "http://www.crunchyroll.com/watch/G1" }), NOW).buttons, undefined);
  assert.equal(buildActivity(playing({ pageUrl: "https://evil.example/watch/G1" }), NOW).buttons, undefined);
  assert.equal(buildActivity(playing({ pageUrl: null }), NOW).buttons, undefined);
  assert.equal(pickButtonUrl(TAB_URL), TAB_URL);
  assert.equal(pickButtonUrl("https://crunchyroll.com/watch/G1"), "https://crunchyroll.com/watch/G1");
  assert.equal(pickButtonUrl("not a url"), null);
});

test("timestamps clamp a position past the end", () => {
  const activity = buildActivity(playing({ position: 9999, duration: 1440 }), NOW);
  assert.equal(activity.timestamps.start, NOW - 9_999_000);
  assert.equal(activity.timestamps.end, NOW);
});

test("pickBestTab prefers playing, then the most recent update", () => {
  const paused = { tabId: 1, paused: true, hasVideo: true, visible: true, updatedAt: 500 };
  const playingOld = { tabId: 2, paused: false, hasVideo: true, visible: false, updatedAt: 100 };
  const playingNew = { tabId: 3, paused: false, hasVideo: true, visible: true, updatedAt: 900 };
  assert.equal(pickBestTab({ a: paused, b: playingOld, c: playingNew }).tabId, 3);
  assert.equal(pickBestTab({ a: paused, b: playingOld }).tabId, 2);
  assert.equal(pickBestTab({ a: paused, b: { ...paused, tabId: 9, updatedAt: 800 } }).tabId, 9);
  assert.equal(pickBestTab({}), null);
});

test("isEligible keeps playing background tabs and live visible tabs", () => {
  assert.equal(isEligible({ hasVideo: true, paused: false, visible: false }), true);
  assert.equal(isEligible({ hasVideo: true, paused: true, visible: true }), true);
  assert.equal(isEligible({ hasVideo: true, paused: true, visible: false }), false);
  assert.equal(isEligible({ hasVideo: false, paused: false, visible: true }), false);
  assert.equal(isEligible(null), false);
});

test("clock and clampText edges", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(754), "12:34");
  assert.equal(clock(1440), "24:00");
  assert.equal(clock(3661), "1:01:01");
  assert.equal(clampText("  a   b  "), "a b");
  assert.equal(clampText(""), null);
  assert.equal(clampText(null), null);
  assert.equal(clampText("x".repeat(200)).length, 128);
});

test("top-frame metadata merged with the iframe video report", () => {
  // The watch page carries the JSON-LD metadata; the player iframe carries the
  // video. Neither frame alone can build the activity.
  const entry = { tabId: 42, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };

  mergeFrame(
    entry,
    {
      frameId: 0,
      series: "Frieren: Beyond Journey's End",
      episodeTitle: "The Beginning",
      seasonNumber: 1,
      episodeNumber: 5,
      artworkUrl: "https://img.crunchyroll.com/ep5.jpg",
      hasVideo: false,
      paused: null,
      position: null,
      duration: null,
      visible: true,
      signals: ["jsonLd"]
    },
    1000
  );

  mergeFrame(
    entry,
    {
      frameId: 3,
      hasVideo: true,
      paused: false,
      position: 754,
      duration: 1440,
      playbackRate: 1,
      signals: ["video"]
    },
    1200
  );

  const merged = resolveTab(entry, 1300);
  assert.equal(merged.series, "Frieren: Beyond Journey's End");
  assert.equal(merged.episodeTitle, "The Beginning");
  assert.equal(merged.position, 754);
  assert.equal(merged.hasVideo, true);
  assert.equal(merged.pageUrl, TAB_URL);
  assert.deepEqual(merged.signals, ["jsonLd", "video"]);

  const activity = buildActivity(merged, NOW);
  assert.equal(activity.details, "Frieren: Beyond Journey's End");
  assert.equal(activity.state, "S1 E5 · 12:34 / 24:00");
  assert.deepEqual(activity.assets, {
    large_image: "https://img.crunchyroll.com/ep5.jpg",
    large_text: "The Beginning"
  });
  assert.deepEqual(activity.timestamps, {
    start: NOW - 754_000,
    end: NOW + (1440 - 754) * 1000
  });
});

test("losing the video frame drops the tab to ineligible activity", () => {
  const entry = { tabId: 7, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };
  mergeFrame(entry, { frameId: 0, series: "Frieren", hasVideo: false, visible: true, signals: ["jsonLd"] }, 20_000);
  mergeFrame(entry, { frameId: 2, hasVideo: true, paused: false, position: 10, duration: 100 }, 20_000);

  const fresh = resolveTab(entry, 30_000);
  assert.equal(fresh.hasVideo, true);
  assert.equal(isEligible(fresh), true);

  // The top frame keeps reporting metadata; the player frame stopped 130s ago.
  mergeFrame(entry, { frameId: 0, series: "Frieren", hasVideo: false, visible: true, signals: ["jsonLd"] }, 150_000);
  const stale = resolveTab(entry, 150_000);
  assert.equal(stale.hasVideo, false);
  assert.equal(stale.series, "Frieren");
  assert.equal(isEligible(stale), false);
  assert.equal(pickBestTab({ 7: stale }), null);
});

test("a crp-gone video frame is replaced by whatever frames remain", () => {
  const entry = { tabId: 9, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };
  mergeFrame(entry, { frameId: 0, series: "Frieren", hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 1, hasVideo: true, paused: false, duration: 100, position: 5 }, 1000);
  delete entry.frames[1];
  const merged = resolveTab(entry, 1100);
  assert.equal(merged.hasVideo, false);
  assert.equal(merged.series, "Frieren");
});

test("limiter caps ordinary payloads at max and coalesces the newest value", () => {
  const sent = [];
  const scheduled = [];
  let now = 0;
  const limiter = createCoalescingLimiter({
    send: (value) => sent.push(value),
    max: 4,
    windowMs: 20000,
    now: () => now,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    }
  });

  // Ordinary updates fill the whole window (4 per 20 s); a null clear
  // bypasses the bucket instead of spending a reserved token.
  for (const value of ["a", "b", "c", "d", "e", "f", "g"]) limiter.push(value);
  assert.deepEqual(sent, ["a", "b", "c", "d"]);
  assert.equal(limiter.pending, "g");

  now = 20000;
  scheduled.shift().fn();
  assert.deepEqual(sent, ["a", "b", "c", "d", "g"]);

  limiter.push("h");
  assert.deepEqual(sent.at(-1), "h");
});

/* ------------------------------------------------- phase 2: links + synopsis */

const EPISODE_URL = "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning";
const SERIES_URL = "https://www.crunchyroll.com/series/G6NQ5DWZ6/frieren";

test("two direct links: episode first, series second", () => {
  const activity = buildActivity(
    playing({ episodeUrl: EPISODE_URL, seriesUrl: SERIES_URL }),
    NOW
  );
  assert.deepEqual(activity.buttons, [
    { label: "Watch Episode", url: EPISODE_URL },
    { label: "View Series", url: SERIES_URL }
  ]);
});

test("a lone episode link keeps the phase-1 label; a lone series link is View Series", () => {
  const episodeOnly = buildActivity(playing({ episodeUrl: EPISODE_URL }), NOW);
  assert.deepEqual(episodeOnly.buttons, [{ label: "Watch on Crunchyroll", url: EPISODE_URL }]);

  const seriesOnly = buildActivity(playing({ seriesUrl: SERIES_URL }), NOW);
  assert.deepEqual(seriesOnly.buttons, [{ label: "View Series", url: SERIES_URL }]);
});

test("direct links must be https Crunchyroll URLs and never exceed two buttons", () => {
  const rejected = buildActivity(
    playing({
      episodeUrl: "http://www.crunchyroll.com/watch/G1",
      seriesUrl: "https://evil.example/series/G2",
      pageUrl: null
    }),
    NOW
  );
  assert.equal(rejected.buttons, undefined);

  const mixed = buildActivity(
    playing({ episodeUrl: EPISODE_URL, seriesUrl: "https://evil.example/series/G2", pageUrl: null }),
    NOW
  );
  assert.deepEqual(mixed.buttons, [{ label: "Watch on Crunchyroll", url: EPISODE_URL }]);

  const both = buildActivity(playing({ episodeUrl: EPISODE_URL, seriesUrl: SERIES_URL }), NOW);
  assert.equal(both.buttons.length, 2);
});

test("a synopsis replaces the timer line and adds season/episode to details when opted in", () => {
  const synopsis = "Frieren and Fern continue their journey toward the northern lands.";
  const activity = buildActivity(playing({ synopsis }), NOW, { synopsis: true });
  assert.equal(activity.details, "Frieren: Beyond Journey's End · S1 E5");
  assert.equal(activity.state, synopsis);
  assert.deepEqual(activity.timestamps, {
    start: NOW - 754_000,
    end: NOW + (1440 - 754) * 1000
  });

  const sparse = buildActivity(playing({ synopsis, seasonNumber: null, episodeNumber: null }), NOW, {
    synopsis: true
  });
  assert.equal(sparse.details, "Frieren: Beyond Journey's End");
  assert.equal(sparse.state, synopsis);
});

test("phase-1 layout is preserved when the synopsis is absent or the option is off", () => {
  const absent = buildActivity(playing({ synopsis: null }), NOW);
  assert.equal(absent.details, "Frieren: Beyond Journey's End");
  assert.equal(absent.state, "S1 E5 · 12:34 / 24:00");

  const disabled = buildActivity(playing({ synopsis: "A long synopsis that would otherwise be shown." }), NOW, {
    synopsis: false
  });
  assert.equal(disabled.details, "Frieren: Beyond Journey's End");
  assert.equal(disabled.state, "S1 E5 · 12:34 / 24:00");
});

test("smartTruncate only adds an ellipsis when it cuts at a word boundary", () => {
  assert.equal(smartTruncate("Short text."), "Short text.");

  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const out = smartTruncate(words, 128);
  assert.ok(out.length <= 128);
  assert.ok(out.endsWith("…"));
  const body = out.slice(0, -1);
  assert.equal(words.slice(0, body.length), body);
  assert.equal(words[body.length], " ", "cut lands between words, never inside one");
});

test("smartTruncate prefers the last sentence end and strips a dangling separator", () => {
  const sentences = `This is the end. ${"more words ".repeat(30)}`;
  assert.equal(smartTruncate(sentences, 128), "This is the end.…");

  const separators = `${"A".repeat(100)}· ${"B".repeat(40)}`;
  const out = smartTruncate(separators, 128);
  assert.equal(out, `${"A".repeat(100)}…`);
});

test("mergeFrame and resolveTab carry direct links and synopsis", () => {
  assert.ok(METADATA_FIELDS.includes("seriesUrl"));
  assert.ok(METADATA_FIELDS.includes("episodeUrl"));
  assert.ok(METADATA_FIELDS.includes("synopsis"));

  const entry = { tabId: 11, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };
  mergeFrame(
    entry,
    {
      frameId: 0,
      series: "Frieren",
      seriesUrl: SERIES_URL,
      episodeUrl: EPISODE_URL,
      synopsis: "The journey continues north.",
      hasVideo: false,
      visible: true,
      signals: ["jsonLd"]
    },
    1000
  );
  const merged = resolveTab(entry, 1100);
  assert.equal(merged.seriesUrl, SERIES_URL);
  assert.equal(merged.episodeUrl, EPISODE_URL);
  assert.equal(merged.synopsis, "The journey continues north.");
});

test("a JSON-LD duration keeps the phase-1 state line when no video reports one", () => {
  const state = formatStateLine({ seasonNumber: 1, episodeNumber: 1, duration: 1440.024, position: 0 });
  assert.equal(state, "S1 E1 · 0:00 / 24:00");
});

/* ------------------------------------------------- availability vs bridge */

test("missing Discord is neutral waiting, never an error", () => {
  const verdict = classifyBridgeFailure("no discord ipc pipe found");
  assert.equal(verdict.state, undefined);
  assert.equal(verdict.bridgeState, "waiting");
  assert.equal(verdict.availability, "unavailable");
  assert.equal(verdict.kind, REASON.DISCORD_CLOSED);
  assert.equal(verdict.error, null, "absence is never surfaced as an error");
  assert.equal(verdict.fatal, false);
  assert.match(verdict.reason, /Discord is not running/);
  assert.match(verdict.reason, /resumes automatically/);
  assert.doesNotMatch(verdict.reason, /pipe|ProtocolError|stack|error/i);
});

test("host-missing is waiting with installer guidance", () => {
  const verdict = classifyBridgeFailure("Specified native messaging host not found.");
  assert.equal(verdict.bridgeState, "waiting");
  assert.equal(verdict.kind, REASON.HOST_MISSING);
  assert.equal(verdict.error, null);
  assert.match(verdict.reason, /Native host not installed/);
  assert.match(verdict.reason, /run the installer/);
});

test("only a rejected application ID is a true error needing user action", () => {
  const rejected = classifyBridgeFailure("Invalid Client ID");
  assert.equal(rejected.bridgeState, "error");
  assert.equal(rejected.kind, REASON.REJECTED);
  assert.equal(rejected.fatal, true);
  assert.equal(rejected.retryable, false);
  assert.match(rejected.reason, /rejected this application ID/i);
  assert.doesNotMatch(rejected.reason, /Invalid Client ID/);

  for (const detail of [
    "connect timeout on \\\\.\\pipe\\discord-ipc-0",
    "discord ipc handshake timed out",
    "native host pong timeout"
  ]) {
    const verdict = classifyBridgeFailure(detail);
    assert.equal(verdict.bridgeState, "waiting", `${detail} is transient`);
    assert.equal(verdict.error, null);
  }
});

test("a hung host becomes an error only after bounded retries", () => {
  const first = classifyBridgeFailure("native host pong timeout", { retries: 1 });
  assert.equal(first.bridgeState, "waiting");
  assert.equal(first.error, null);
  const exhausted = classifyBridgeFailure("native host pong timeout", { retries: 3 });
  assert.equal(exhausted.bridgeState, "error");
  assert.match(exhausted.reason, /stopped responding/);
});

test("presentStatus maps absence to Waiting and keeps pipe names out of the UI", () => {
  const waiting = presentStatus({
    bridgeState: "waiting",
    availability: "unavailable",
    reason: "Discord is not running — presence paused, resumes automatically.",
    lastError: "no discord ipc pipe found"
  });
  assert.equal(waiting.label, "Waiting");
  assert.equal(waiting.isError, false);
  assert.match(waiting.reason, /Discord is not running/);
  assert.doesNotMatch(waiting.reason, /pipe/i);

  const connected = presentStatus({ bridgeState: "connected", availability: "available" });
  assert.equal(connected.label, "Connected");
  assert.equal(connected.reason, null);

  const off = presentStatus({ bridgeState: "connected", enabled: false });
  assert.equal(off.label, "Off");
  assert.equal(off.isError, false);

  const error = presentStatus({
    bridgeState: "error",
    reason: "Discord rejected this application ID. Check the application ID in Settings."
  });
  assert.equal(error.label, "Error");
  assert.equal(error.isError, true);
});

test("worker boot with no Discord is waiting; Discord appearing connects and clears the reason", () => {
  const boot = bridgeStatusOf(
    {},
    { t: "status", state: "waiting", reason: "discord-closed", detail: "no discord ipc pipe found" }
  );
  assert.equal(boot.bridgeState, "waiting");
  assert.equal(boot.availability, "unavailable");
  assert.equal(boot.reasonKind, REASON.DISCORD_CLOSED);
  assert.equal(boot.lastError, "no discord ipc pipe found", "raw detail stays for diagnostics");

  const connected = bridgeStatusOf(boot, { t: "status", state: "connected", appName: "Discord" });
  assert.equal(connected.bridgeState, "connected");
  assert.equal(connected.availability, "available");
  assert.equal(connected.reason, null);
  assert.equal(connected.lastError, null);
});

test("worker maps a non-fatal error frame to waiting, and a fatal one to error", () => {
  const transient = bridgeStatusOf(
    {},
    { t: "status", state: "error", detail: "Invalid Client ID", fatal: false }
  );
  assert.equal(transient.bridgeState, "waiting", "fatal:false never latches an error");

  const fatal = bridgeStatusOf(
    {},
    { t: "status", state: "error", detail: "Invalid Client ID", fatal: true }
  );
  assert.equal(fatal.bridgeState, "error");
  assert.equal(fatal.reasonKind, REASON.REJECTED);
});

/* ---------------------------------------------------- payload correctness */

test("an ad break is a playing video far shorter than the known episode", () => {
  assert.equal(isAdBreak({ paused: false, duration: 15 }, 1440), true);
  assert.equal(isAdBreak({ paused: false, duration: 15 }, 30), false, "no known episode length");
  assert.equal(isAdBreak({ paused: false, duration: 90 }, 1440), false, "long clip is ambiguous");
  assert.equal(isAdBreak({ paused: true, duration: 15 }, 1440), false, "paused is not an ad");
  assert.equal(isAdBreak(null, 1440), false);

  const entry = { tabId: 1, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };
  mergeFrame(entry, { frameId: 0, series: "Frieren", hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 2, hasVideo: true, paused: false, duration: 1440, position: 300 }, 1000);
  assert.equal(resolveTab(entry, 1100).adBreak, false);
  mergeFrame(entry, { frameId: 2, hasVideo: true, paused: false, duration: 15, position: 1 }, 2000);
  assert.equal(resolveTab(entry, 2100).adBreak, true);
});

test("a broken artwork key drops assets but keeps a complete card", () => {
  for (const artworkUrl of [
    "http://img.crunchyroll.com/ep.jpg",
    "https://evil.example/ep.jpg",
    "not a url",
    null
  ]) {
    const activity = buildActivity(playing({ artworkUrl }), NOW);
    assert.ok(activity, `card survives ${artworkUrl}`);
    assert.equal(activity.details, "Frieren: Beyond Journey's End");
    assert.equal(activity.assets, undefined, "Discord falls back to the application icon");
    assert.ok(activity.state);
  }
});

test("no account, email or token field can ride along in the payload", () => {
  const activity = buildActivity(
    playing({
      email: "viewer@example.com",
      accountId: "acct_123",
      username: "viewer",
      token: "secret"
    }),
    NOW
  );
  const serialized = JSON.stringify(activity);
  assert.doesNotMatch(serialized, /@|email|account|token|username/i);
  assert.deepEqual(Object.keys(activity).sort(), [
    "assets",
    "buttons",
    "details",
    "state",
    "timestamps",
    "type"
  ]);
});

test("the synopsis is off by default and only appears when opted in", () => {
  const synopsis = "Frieren and Fern continue their journey toward the northern lands.";
  const off = buildActivity(playing({ synopsis }), NOW);
  assert.equal(off.state, "S1 E5 · 12:34 / 24:00");
  assert.doesNotMatch(off.state, /Frieren and Fern/);
  const on = buildActivity(playing({ synopsis }), NOW, { synopsis: true });
  assert.equal(on.state, synopsis);
});
