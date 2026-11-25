import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createWorker, wire } from "../../background.js";
import { audio, loadContent, musicPage, node } from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extractSource = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");
const BASE = 1_700_000_000_000;
const PAGE_A = "https://music.youtube.com/watch?v=aaaaaaaaaaa";
const PAGE_B = "https://music.youtube.com/watch?v=bbbbbbbbbbb";
const PAGE_C = "https://music.youtube.com/watch?v=ccccccccccc";

function signal() {
  const handlers = new Set();
  return {
    addListener(fn) { handlers.add(fn); },
    removeListener(fn) { handlers.delete(fn); },
    fire(...args) { for (const fn of [...handlers]) fn(...args); },
  };
}

/** Virtual clock whose scheduled callbacks run at their exact due instant. */
function fakeClock(start = BASE) {
  let now = start;
  let seq = 0;
  const meters = new Map();
  return {
    now: () => now,
    schedule(fn, ms) { const id = ++seq; meters.set(id, { at: now + ms, fn }); return id; },
    cancel(id) { meters.delete(id); },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...meters.entries()]
          .filter(([, meter]) => meter.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        meters.delete(due[0]);
        due[1].fn();
      }
    },
    /** Advance one ms at a time until a probe passes; returns elapsed ms. */
    stepUntil(probe, limit = 4000) {
      let elapsed = 0;
      while (!probe() && elapsed < limit) { this.advance(1); elapsed += 1; }
      return elapsed;
    },
  };
}

function bootWorker({ clock }) {
  const wireLog = [];
  const port = {
    sent: [],
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage(message) {
      if (message.t === "activity") {
        wireLog.push({
          at: clock.now(),
          details: message.activity && message.activity.details,
          span: message.activity && message.activity.timestamps
            ? message.activity.timestamps.end - message.activity.timestamps.start
            : null,
          hasTimestamps: Boolean(message.activity && message.activity.timestamps),
          start: message.activity && message.activity.timestamps
            ? message.activity.timestamps.start : null,
        });
      }
      this.sent.push(message);
    },
    disconnect() {},
  };
  const chrome = {
    runtime: { id: "ext-test-id", onMessage: signal(), lastError: null, connectNative: () => port },
    storage: {
      local: { get: async () => ({ enabled: true }), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: signal(),
    },
  };
  const worker = createWorker({ chrome, now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  wire(worker, chrome);
  return { chrome, port, wireLog, worker };
}

/** One content realm on the shared clock, with A playing a coherent pair. */
function bootPage(clock) {
  const media = audio({ duration: 366, currentTime: 0, paused: false, currentSrc: "https://media.example/a" });
  const page = musicPage({
    href: PAGE_A,
    title: "Song A",
    byline: [node("a", { attrs: { href: "channel/UCa" }, text: "Artist A" })],
    time: "0:00 / 6:06",
    children: [media],
  });
  page.win.__ytmpNow = clock.now;
  const handle = loadContent({
    extractSource,
    contentSource: `Date.now = window.__ytmpNow;\n${contentSource}`,
    page,
  });
  let fed = 0;
  const states = () => handle.messages.filter((m) => m.t === "ytmp-state");
  return {
    page,
    media,
    handle,
    states: () => states().map((m) => m.state),
    feed(chrome, { keepAt = false } = {}) {
      const all = states();
      for (const m of all.slice(fed)) {
        chrome.runtime.onMessage.fire(
          {
            t: "ytmp-state",
            source: "youtube-music",
            state: keepAt ? m.state : { ...m.state, at: clock.now() },
          },
          { id: "ext-test-id", tab: { id: 1, url: page.location.href }, frameId: 0 },
          () => {}
        );
      }
      fed = all.length;
    },
    next(href, title) {
      page.doc.querySelector("ytmusic-player-bar .title").textContent = title;
      page.navigator.mediaSession = { metadata: { title }, playbackState: "playing" };
      page.setHref(href);
      handle.poll();
    },
    timed(position, total, source) {
      const text = `${Math.floor(position / 60)}:${String(position % 60).padStart(2, "0")} / ` +
        `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
      const bar = page.doc.querySelector("ytmusic-player-bar");
      const old = bar.querySelector(".time");
      if (old) old.textContent = text;
      else bar.append(node("span", { attrs: { class: "time" }, text }));
      media.duration = total;
      media.currentTime = position;
      media.paused = false;
      if (source) media.currentSrc = source;
      handle.poll();
    },
  };
}

async function boot(clock) {
  const env = bootWorker({ clock });
  await env.worker.start();
  const page = bootPage(clock);
  page.feed(env.chrome);
  return { ...env, page };
}

/**
 * Rapid Next A->B->C while A's timing is still readable, then C's first
 * trustworthy pair. The content script releases the total on the first read;
 * the worker must put it on the wire at once, not after the 1.5 s pacing gap.
 */
test("first trustworthy total after a fast Next burst reaches wire without pacing delay", async () => {
  const clock = fakeClock();
  const { chrome, wireLog, page } = await boot(clock);

  // Two rapid Nexts: B and C each publish metadata-only while A's total is stale.
  page.next(PAGE_B, "Song B");
  page.feed(chrome);
  page.next(PAGE_C, "Song C");
  page.feed(chrome);

  const before = wireLog.length;
  const sampleAt = clock.now();
  page.timed(0, 144, "https://media.example/c"); // first trustworthy pair for C
  page.feed(chrome);

  const immediate = wireLog.slice(before).find(
    (f) => f.details === "Song C" && f.span === 144
  );
  assert.ok(
    immediate,
    "the first trustworthy total must be on the wire at the sample instant, " +
    `not deferred behind the pacing floor; wire=${JSON.stringify(wireLog.slice(before))}`
  );
  assert.equal(immediate.at, sampleAt, "latency from trusted sample to wire must be zero");

  // A later ordinary position update is still paced; only the first latch is urgent.
  const countAfterLatch = wireLog.length;
  page.timed(3, 144, "https://media.example/c");
  page.feed(chrome);
  assert.equal(wireLog.length, countAfterLatch, "a later seek stays inside the pacing floor");
  clock.advance(1500);
  assert.equal(wireLog.at(-1).span, 144, "the real total survives the later seek");
});

/**
 * The metadata-only -> timed upgrade is urgent but never force: it still obeys
 * the rolling cap. Fill the window, then prove the upgrade waits for room.
 */
test("a timing latch cannot bypass the rolling send ceiling", async () => {
  const clock = fakeClock();
  const { chrome, wireLog, page } = await boot(clock);

  // Spend the 8-per-20s window on urgent identity changes at t=0.
  for (let i = 0; i < 7; i += 1) {
    page.next(`https://music.youtube.com/watch?v=${String(i).padStart(11, "b")}`, `Burst ${i}`);
    page.feed(chrome);
  }
  assert.equal(wireLog.length, 8, "the window is full: A plus seven urgent changes");

  // A trustworthy total for the newest track is urgent but capped by room.
  const before = wireLog.length;
  page.timed(0, 144, "https://media.example/burst");
  page.feed(chrome);
  assert.equal(wireLog.length, before, "a full window defers even an urgent timing latch");

  const elapsed = clock.stepUntil(() => wireLog.length > before, 25000);
  assert.ok(elapsed >= 20000 - 1, `the upgrade waits for the window to free (waited ${elapsed}ms)`);
  assert.equal(wireLog.at(-1).span, 144, "the newest valid pair wins once room opens");
});

/**
 * Ownership guards stay intact on the final track: a stale same-total read and
 * a clock conflict remain timestamp-free, while pause/resume, loop seek and a
 * speed change keep the credited total without inventing position.
 */
test("ownership guards still hold through pause, loop and rate on the final track", async () => {
  const clock = fakeClock();
  const { chrome, wireLog, page } = await boot(clock);
  page.next(PAGE_B, "Song B");
  page.feed(chrome);
  page.next(PAGE_C, "Song C");
  page.feed(chrome);
  page.timed(0, 144, "https://media.example/c");
  page.feed(chrome);
  assert.equal(wireLog.at(-1).span, 144);

  // An incomplete read for the same confirmed track never re-borrows a total.
  page.media.duration = 0;
  page.media.currentTime = 0;
  page.handle.poll();
  page.feed(chrome);
  assert.equal(page.states().at(-1).title, "Song C");
  assert.equal(wireLog.at(-1).span, 144, "the credited total stays through an incomplete read");

  // A clock conflict cannot fabricate a pair.
  page.page.doc.querySelector("ytmusic-player-bar").append(
    node("span", { attrs: { class: "time-info" }, text: "0:09 / 2:24" })
  );
  page.media.duration = 144;
  page.media.currentTime = 9;
  page.page.dispatchOnDoc("seeked", { target: page.media });
  page.feed(chrome);
  assert.equal(page.states().at(-1).duration, null, "a conflicting clock stays timestamp-free");

  // Clear the conflict by making both clocks agree; then a loop seek at 1.5x.
  page.page.doc.querySelector(".time-info").textContent = "0:06 / 2:24";
  page.page.doc.querySelector("ytmusic-player-bar .time").textContent = "0:06 / 2:24";
  page.media.duration = 144;
  page.media.currentTime = 6;
  page.media.paused = false;
  page.media.playbackRate = 1.5;
  page.page.dispatchOnDoc("seeked", { target: page.media });
  page.feed(chrome);
  assert.equal(page.states().at(-1).duration, 144, "a loop seek keeps the credited total");
  assert.equal(page.states().at(-1).position, 6, "the playhead follows the loop, not a cached value");
  assert.equal(page.states().at(-1).playbackRate, 1.5);
});

/**
 * The urgent latch delivers the total fast without moving its anchor. Sample
 * 900 ms into one epoch second and deliver 800 ms later, across the boundary
 * and well inside the 5 s skew: the timer must start in the sample's second,
 * not the wire's. A delivery-time anchor would fail this by one second.
 */
test("an urgent first-total latch keeps the sample anchor across a second boundary", async () => {
  const clock = fakeClock(BASE + 900);
  const { chrome, wireLog, page } = await boot(clock);
  page.next(PAGE_B, "Song B");
  page.feed(chrome);
  page.next(PAGE_C, "Song C");
  page.feed(chrome);

  // Content samples C's trusted pair 900 ms into the second; delivery is late
  // by 800 ms and lands in the next second, still inside the skew window.
  page.timed(0, 144, "https://media.example/c");
  const sampledAt = clock.now();
  clock.advance(800);
  page.feed(chrome, { keepAt: true });

  const good = wireLog.find((f) => f.details === "Song C" && f.span === 144);
  assert.ok(good, "the trusted pair must reach the wire at delivery time");
  assert.equal(good.at, sampledAt + 800, "wire instant is the delivery time");
  assert.equal(
    Math.floor(good.at / 1000),
    Math.floor(sampledAt / 1000) + 1,
    "the sample and wire instants must straddle an epoch-second boundary"
  );
  assert.equal(good.at - sampledAt, 800, "the delay stays inside the 5 s sample skew");
  assert.equal(good.start, Math.floor(sampledAt / 1000), "start is the sample second, not the wire second");
});

/**
 * Probe for the two paths that put activity on the port without calling
 * deliver(): clearPresence posts null, and reconnect replays desired. After a
 * clear/reconnect cycle the first pair for the same identity must still latch
 * immediately, which proves lastSentTimed tracks the wire, not a stale value.
 */
test("clear and reconnect keep lastSentTimed aligned with the wire", async () => {
  const clock = fakeClock();
  const { chrome, wireLog, page } = await boot(clock);
  page.next(PAGE_B, "Song B");
  page.feed(chrome);
  page.next(PAGE_C, "Song C");
  page.feed(chrome);
  page.timed(0, 144, "https://media.example/c");
  page.feed(chrome);
  assert.equal(wireLog.at(-1).span, 144, "the wire carries a timed C before the clear");

  // Presence off posts null straight down the port, bypassing deliver().
  chrome.storage.onChanged.fire({ enabled: { newValue: false } }, "local");
  assert.equal(wireLog.at(-1).details, null, "an explicit clear went on the wire");

  // While off, content reports C metadata-only: no sendable port, no deliver.
  const metadataC = page.states()[2];
  chrome.runtime.onMessage.fire(
    { t: "ytmp-state", source: "youtube-music", state: { ...metadataC, at: clock.now() } },
    { id: "ext-test-id", tab: { id: 1, url: PAGE_C }, frameId: 0 },
    () => {}
  );
  assert.equal(wireLog.at(-1).details, null, "the off state stays clear");

  // Presence on reconnects and replays desired through deliver().
  chrome.storage.onChanged.fire({ enabled: { newValue: true } }, "local");
  assert.equal(wireLog.at(-1).span, null, "reconnect replays metadata-only C");

  // First trusted pair for the same identity: still urgent after the cycle.
  // Feed the already-timed sample directly; an identical poll would be deduped.
  const before = wireLog.length;
  const sampleAt = clock.now();
  chrome.runtime.onMessage.fire(
    {
      t: "ytmp-state",
      source: "youtube-music",
      state: { ...page.states()[3], at: sampleAt },
    },
    { id: "ext-test-id", tab: { id: 1, url: PAGE_C }, frameId: 0 },
    () => {}
  );
  const immediate = wireLog.slice(before).find((f) => f.details === "Song C" && f.span === 144);
  assert.ok(immediate, "the pair must latch at once after clear/reconnect");
  assert.equal(immediate.at, sampleAt, "the wire instant is the sample instant, not a paced flush");
});
