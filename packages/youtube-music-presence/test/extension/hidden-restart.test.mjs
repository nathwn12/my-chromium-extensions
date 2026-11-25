import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createWorker, wire } from "../../background.js";
import { audio, loadContent, musicPage, node } from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extractSource = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");
const PAGE = "https://music.youtube.com/watch?v=ccccccccccc";
const SRC = "https://media.example/looping";
const TRACK = "Looping Song";
/** 3:32, with the card anchored at 2:34 before the restart. */
const TOTAL = 212;
const START_POSITION = 154;
const BASE = 1_700_000_000_000;

function signal() {
  const handlers = new Set();
  return {
    addListener(fn) { handlers.add(fn); },
    removeListener(fn) { handlers.delete(fn); },
    fire(...args) { for (const fn of [...handlers]) fn(...args); },
  };
}

function bootWorker() {
  let now = BASE;
  const port = {
    sent: [],
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage(message) { this.sent.push({ message, at: now }); },
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
  const clock = {
    now: () => now,
    schedule: () => 1,
    cancel: () => {},
    advance(ms) { now += ms; },
  };
  const worker = createWorker({ chrome, now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  wire(worker, chrome);
  return { chrome, clock, port, worker };
}

function clockText(position, total) {
  return `${Math.floor(position / 60)}:${String(position % 60).padStart(2, "0")} / ` +
    `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function setBarClock(page, text) {
  const bar = page.doc.querySelector("ytmusic-player-bar");
  const old = bar.querySelector(".time");
  if (old) old.textContent = text;
  else bar.append(node("span", { attrs: { class: "time" }, text }));
}

function bootPage(clock) {
  const media = audio({
    duration: TOTAL,
    currentTime: START_POSITION,
    paused: false,
    currentSrc: SRC,
  });
  const page = musicPage({
    href: PAGE,
    title: TRACK,
    byline: [node("a", { attrs: { href: "channel/UCloop" }, text: "Loop Artist" })],
    time: clockText(START_POSITION, TOTAL),
    children: [media],
  });
  page.win.__ytmpNow = clock.now;
  const handle = loadContent({
    extractSource,
    contentSource: `Date.now = window.__ytmpNow;\n${contentSource}`,
    page,
  });
  let fed = 0;
  return {
    page,
    handle,
    media,
    states: () => handle.messages.filter((m) => m.t === "ytmp-state").map((m) => m.state),
    /** Send every content report the worker has not seen yet, stamped at now. */
    feed(chrome) {
      const all = handle.messages.filter((m) => m.t === "ytmp-state");
      for (const m of all.slice(fed)) {
        chrome.runtime.onMessage.fire(
          { t: "ytmp-state", source: "youtube-music", state: { ...m.state, at: clock.now() } },
          { id: "ext-test-id", tab: { id: 1, url: page.location.href }, frameId: 0 },
          () => {}
        );
      }
      fed = all.length;
    },
  };
}

function frames(port) {
  return port.sent.filter((entry) => entry.message.t === "activity" && entry.message.activity);
}

function detail(state) {
  return `title=${state.title} elapsed=${state.position} duration=${state.duration} paused=${state.paused}`;
}

function observed(handle, port) {
  return `messages=${JSON.stringify(handle.messages)} frames=${JSON.stringify(frames(port).map((e) => e.message.activity))}`;
}

/**
 * The owner's live bug after 1.1.20, in production order:
 *
 *   1. a track plays at 2:34 / 3:32 on a hidden tab; the card is timed with
 *      `start = floor(sampleAt/1000) - 154`;
 *   2. with Repeat on, the same track loops at the end. Chrome throttles the
 *      1 s poll and the player emits no `seeking`, `seeked`, `ended` or `play`
 *      event, so the only signal left is a `timeupdate` whose playhead jumps
 *      back to 0 — here the total (212 s) and the bar clock stay coherent;
 *   3. the content script must send on that backward jump so the worker emits
 *      a timed frame with `start = floor(sampleAt/1000) - 0`, reading 0:00 /
 *      3:32 instead of counting on from the previous play at 2:34.
 *
 * Before the fix no listener observes `timeupdate`, so no report is sent and
 * the worker keeps the old anchor; the card catches up only on visibilitychange.
 */
test("a hidden natural restart reported only by timeupdate re-anchors the card to 0:00", async () => {
  const { chrome, clock, port, worker } = bootWorker();
  await worker.start();
  const env = bootPage(clock);
  const { media, page, handle } = env;

  env.feed(chrome);
  const first = env.states().at(-1);
  assert.equal(first.title, TRACK, detail(first));
  assert.equal(first.duration, TOTAL, detail(first));
  assert.equal(first.position, START_POSITION, detail(first));
  assert.equal(frames(port).length, 1, `the first report publishes one frame: ${observed(handle, port)}`);
  const oldStart = frames(port)[0].message.activity.timestamps.start;
  assert.equal(oldStart, Math.floor(clock.now() / 1000) - START_POSITION);

  // The tab is hidden and the 1 s poll is throttled away: no handle.poll() from here.
  page.setVisibility("hidden");

  // The natural restart. Only one `timeupdate` fires, with the playhead at 0.
  clock.advance(2500);
  media.currentTime = 0;
  setBarClock(page, clockText(0, TOTAL));
  const before = handle.messages.length;
  page.dispatchOnDoc("timeupdate", { target: media });

  assert.ok(
    handle.messages.length > before,
    `a timeupdate-only restart must be reported; ${observed(handle, port)}`
  );
  const restart = env.states().at(-1);
  assert.equal(restart.title, TRACK, detail(restart));
  assert.equal(restart.position, 0, `the report carries the restarted playhead: ${detail(restart)}`);
  assert.equal(restart.duration, TOTAL, `the real total survives the restart: ${detail(restart)}`);

  // A second timeupdate at the same playhead is steady, not a new jump.
  const afterFirst = handle.messages.length;
  page.dispatchOnDoc("timeupdate", { target: media });
  assert.equal(
    handle.messages.length,
    afterFirst,
    `a steady timeupdate must not double-send the same jump; ${observed(handle, port)}`
  );

  env.feed(chrome);
  const out = frames(port);
  assert.equal(out.length, 2, `exactly one new frame must go out: ${observed(handle, port)}`);
  const last = out.at(-1).message.activity;
  assert.equal(last.details, TRACK, JSON.stringify(last));
  assert.equal(
    last.timestamps.end - last.timestamps.start,
    TOTAL,
    `the restart frame carries the real total: ${JSON.stringify(last)}`
  );
  assert.equal(
    last.timestamps.start,
    Math.floor(clock.now() / 1000) - Math.floor(restart.position),
    `the restart frame is anchored to the live playhead: ${JSON.stringify(last)}`
  );
  assert.equal(last.timestamps.start, Math.floor(clock.now() / 1000));
  assert.notEqual(
    last.timestamps.start,
    oldStart,
    `the card must not count on from 2:34: ${JSON.stringify(last)}`
  );
});

/**
 * Negative control for the dedicated listener: a steady ~4 Hz `timeupdate`
 * stream over 10 s, and a forward seek, add no reports at all. A backward
 * jump already published through `seeked` also produces no duplicate on the
 * following `timeupdate`. The send budget stays untouched.
 */
test("steady timeupdate and forward seeks never report from the backward-jump listener", () => {
  let now = BASE;
  const clock = { now: () => now, advance(ms) { now += ms; } };
  const env = bootPage(clock);
  const { media, page, handle } = env;
  const initial = handle.messages.length;
  assert.equal(initial, 1, `boot publishes exactly one report: ${JSON.stringify(handle.messages)}`);
  page.setVisibility("hidden");

  // 40 ticks at 250 ms (4 Hz) over 10 s: playhead moves forward with playback.
  for (let i = 1; i <= 40; i += 1) {
    clock.advance(250);
    media.currentTime = START_POSITION + i * 0.25;
    setBarClock(page, clockText(media.currentTime, TOTAL));
    page.dispatchOnDoc("timeupdate", { target: media });
  }
  assert.equal(
    handle.messages.length,
    initial,
    `40 steady timeupdate ticks must stay silent; messages=${JSON.stringify(handle.messages)}`
  );

  // A forward seek (past the 2:34 baseline) remains silent from this listener.
  clock.advance(1000);
  media.currentTime = 190;
  setBarClock(page, clockText(190, TOTAL));
  page.dispatchOnDoc("timeupdate", { target: media });
  assert.equal(
    handle.messages.length,
    initial,
    `a forward seek must not report; messages=${JSON.stringify(handle.messages)}`
  );

  // A backward jump the player announced via `seeked` is already published.
  clock.advance(1000);
  media.currentTime = 0;
  setBarClock(page, clockText(0, TOTAL));
  page.dispatchOnDoc("seeked", { target: media });
  const afterSeek = handle.messages.length;
  assert.ok(afterSeek > initial, "the player-announced seek itself reports");

  // The following timeupdate at the same playhead must not re-send it.
  page.dispatchOnDoc("timeupdate", { target: media });
  assert.equal(
    handle.messages.length,
    afterSeek,
    `no duplicate report after a published seek; messages=${JSON.stringify(handle.messages)}`
  );
});
