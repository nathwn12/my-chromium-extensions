import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, "..");

const worker = await import(pathToFileURL(join(base, "background.js")).href);
const bgSource = readFileSync(join(base, "background.js"), "utf8");
const contentSource = readFileSync(join(base, "content.js"), "utf8");
const extractSource = readFileSync(join(base, "extract.js"), "utf8");
const readme = readFileSync(join(base, "README.md"), "utf8");
const hostSource = readFileSync(join(base, "native", "host.mjs"), "utf8");
const ipcSource = readFileSync(join(base, "native", "ipc.mjs"), "utf8");

const {
  pickBestTab,
  mergeFrame,
  resolveTab,
  createCoalescingLimiter,
  pickButtonUrl,
  buildActivity,
  clampText,
  isPongOverdue,
  isTrustedFrameUrl,
} = worker;

import {
  DiscordPipeClient,
  NativeMessageDecoder,
  encodeNativeMessage,
} from "../native/ipc.mjs";

function loadExtractor() {
  const context = createContext({});
  runInContext(extractSource, context, { filename: "extract.js" });
  return context.CrunchyrollExtract;
}

// 1. A keepalive must not steal the winner.
test("1: keepalive cannot re-rank the multi-tab winner", () => {
  assert.equal(typeof worker.pickBestTab, "function");
  const mk = (tabId) => ({ tabId, top: null, frames: {}, pageUrl: "https://www.crunchyroll.com/watch/G1", updatedAt: 0, rankAt: 0 });
  const a = mk(1);
  const b = mk(2);
  mergeFrame(a, { frameId: 0, series: "A", hasVideo: true, paused: false, position: 10, duration: 100, visible: true, signals: ["video"] }, 1000);
  mergeFrame(b, { frameId: 0, series: "B", hasVideo: true, paused: false, position: 10, duration: 100, visible: true, signals: ["video"] }, 2000);
  let tabs = { 1: resolveTab(a, 2100), 2: resolveTab(b, 2100) };
  assert.equal(pickBestTab(tabs).tabId, 2, "newer real event wins first");
  // A keepalive from the loser arrives later: liveness advances, rank does not.
  mergeFrame(a, { frameId: 0, series: "A", hasVideo: true, paused: false, position: 10, duration: 100, visible: true, signals: ["video"], keepalive: true }, 3000);
  tabs = { 1: resolveTab(a, 3100), 2: resolveTab(b, 3100) };
  assert.equal(pickBestTab(tabs).tabId, 2, "keepalive must not steal the winner");
  assert.ok((tabs[1].rankAt ?? 0) < (tabs[2].rankAt ?? 0) || (tabs[1].rankAt === tabs[2].rankAt && false), "rankAt unchanged by keepalive");
});

// 2. Disabled: single clear then silence + content media-event gate.
test("2: disabled sends one clear then stays silent; content gates media events", () => {
  assert.match(contentSource, /function onMediaEvent[\s\S]*?if \(!enabled\) return;/, "media events gated while disabled");
  assert.match(bgSource, /lastSentJson !== "null"/, "disabled clear sent once");
  // Limiter bypass still dedupes via the worker guard; content never reports while disabled.
  assert.match(contentSource, /report\(isKeepalive/, "report carries keepalive flag");
});

// 3. Pause/resume bypass the limiter like clears.
test("3: pause after a full window sends immediately", () => {
  const sent = [];
  const scheduled = [];
  let now = 0;
  const limiter = createCoalescingLimiter({
    send: (v) => sent.push(v),
    max: 4,
    windowMs: 20000,
    now: () => now,
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
  });
  const playing = (i) => ({ details: `p${i}`, timestamps: { start: 1, end: 2 } });
  for (let i = 0; i < 4; i += 1) limiter.push(playing(i));
  assert.deepEqual(sent.length, 4);
  limiter.push({ details: "paused", state: "S1 E1" });
  assert.deepEqual(sent.length, 5, "pause bypasses a full window");
  assert.equal(sent.at(-1).details, "paused");
  // Resume (timestamps return) also bypasses.
  now = 1000;
  limiter.push(playing(99));
  assert.equal(sent.at(-1).details, "p99", "resume bypasses too");
});

// 4. Handshake ERROR surfaces the real reason and stops retrying.
test("4: handshake ERROR rejects with the real reason and is fatal", async () => {
  const client = new DiscordPipeClient({
    clientId: "123456789012345678",
    pipes: ["unused"],
    logger: { info() {}, warn() {}, error() {}, status() {} },
  });
  let err = null;
  client._readyWaiter = { resolve: () => {}, reject: (e) => { err = e; } };
  client.socket = { destroy() {} };
  client._decoder = { push: () => { throw new Error("unused"); } };
  // Call _onFrame directly with a handshake ERROR (no nonce).
  client._onFrame({ op: 1, payload: { evt: "ERROR", data: { code: 4000, message: "Invalid client ID" } } });
  assert.ok(err, "handshake ERROR must reject the waiter");
  assert.match(err.message, /Invalid client ID/);
  assert.equal(err.code, 4000);
  assert.equal(err.fatal, true);
  assert.match(hostSource, /error\.fatal/, "host holds permanent failures instead of retrying");
  client.close();
});

// 5. Missing pong marks the bridge disconnected.
test("5: pong overdue is bounded and pure", () => {
  assert.equal(typeof isPongOverdue, "function");
  const now = 1_700_000_000_000;
  assert.equal(isPongOverdue(0, 0, now), false, "no ping yet");
  assert.equal(isPongOverdue(now - 5000, 0, now), false, "within window");
  assert.equal(isPongOverdue(now - 11000, 0, now), true, "overdue marks disconnected");
  assert.equal(isPongOverdue(now - 30000, now - 1000, now), false, "pong arrived");
  assert.match(bgSource, /PONG_TIMEOUT_MS/, "bounded pong window");
  assert.match(bgSource, /pong timeout/i, "overdue triggers reconnect");
});

// 6. Framing error resets so the next chunk decodes.
test("6: bad length resets; the next good frame still decodes", () => {
  const decoder = new NativeMessageDecoder();
  const bad = Buffer.alloc(4);
  bad.writeUInt32LE(10 * 1024 * 1024, 0);
  assert.throws(() => decoder.push(bad), /too large/);
  const good = encodeNativeMessage({ t: "ping" });
  const out = decoder.push(good);
  assert.equal(out.length, 1, "decoder resynced after the bad length");
  assert.equal(out[0].t, "ping");
});

// 7. Bidi/zero-width stripped before capping.
test("7: clean strips bidi controls and zero-width chars", () => {
  assert.match(extractSource, /202E/, "bidi strip present");
  const api = loadExtractor();
  const doc = {
    location: { href: "https://www.crunchyroll.com/watch/G12345678/x" },
    title: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const nav = { mediaSession: { metadata: { title: "A‪b‬c‏d", artist: "S‮e‬‍r⁦i⁧e⁩s" } } };
  const out = JSON.parse(JSON.stringify(api.extract(doc, nav)));
  const joined = `${out.series ?? ""}${out.episodeTitle ?? ""}`;
  assert.doesNotMatch(joined, /[‪-‮⁦-⁩​-‏﻿]/, "no bidi/zero-width survives");
});

// 8. Button URLs capped at 512 with fallback.
test("8: long button URLs rejected with fallback", () => {
  const longPath = `https://www.crunchyroll.com/watch/G123/${"a".repeat(600)}`;
  assert.equal(pickButtonUrl(longPath), null);
  const activity = buildActivity(
    {
      series: "Frieren",
      episodeTitle: "Ep",
      episodeUrl: longPath,
      seriesUrl: "https://www.crunchyroll.com/series/G123/frieren",
      pageUrl: "https://www.crunchyroll.com/watch/G123/x",
    },
    1_700_000_000_000
  );
  assert.ok(activity.buttons, "falls back to the next candidate");
  for (const b of activity.buttons) assert.ok(b.url.length <= 512);
});

// 9. Only the top frame (or same-origin watch frame) supplies metadata.
test("9: subdomain frame cannot forge metadata", () => {
  assert.equal(typeof isTrustedFrameUrl, "function");
  assert.equal(isTrustedFrameUrl("https://evil.crunchyroll.com/x", "https://www.crunchyroll.com/watch/G123/x"), false);
  assert.equal(isTrustedFrameUrl("https://www.crunchyroll.com/watch/G123/x", "https://www.crunchyroll.com/watch/G123/y"), true);
  const entry = { tabId: 1, top: null, frames: {}, pageUrl: "https://www.crunchyroll.com/watch/G1", updatedAt: 0, rankAt: 0 };
  mergeFrame(entry, { frameId: 0, series: null, episodeTitle: null, hasVideo: false, visible: true, signals: [] }, 1000);
  mergeFrame(entry, { frameId: 5, series: "Forged", episodeTitle: "Forged Ep", hasVideo: true, paused: false, position: 1, duration: 10, visible: true, signals: ["video"] }, 1100);
  const resolved = resolveTab(entry, 1200);
  assert.notEqual(resolved.series, "Forged", "non-top metadata ignored");
  assert.equal(resolved.hasVideo, true, "video truth still merges");
});

// 10. Details/state enforce 2-char minimum with fallback.
test("10: single-char details fall back instead of sending invalid", () => {
  assert.equal(clampText("A"), null);
  assert.equal(clampText("AB"), "AB");
  const activity = buildActivity({ series: "A", episodeTitle: "B" }, 1_700_000_000_000);
  assert.equal(activity, null, "no invalid 1-char card");
  const fallback = buildActivity({ series: "A", episodeTitle: "Valid Title" }, 1_700_000_000_000);
  assert.equal(fallback.details, "Valid Title");
});

// 11. URL changes via events/observer; interval only with video.
test("11: hashchange + observer replace the always-on poll", () => {
  assert.match(contentSource, /hashchange/, "hashchange covered");
  assert.match(contentSource, /MutationObserver/, "observer watches the player container");
  assert.match(contentSource, /#player-container/, "observes the player container");
  assert.match(contentSource, /if \(!video\)/, "interval stops without a video");
});

// 12. README no longer claims clears during ads.
test("12: README states ad breaks keep the card", () => {
  assert.doesNotMatch(readme, /Presence clears while the ad runs/);
  assert.match(readme, /keep.*episode card|ad break keeps/i);
});
