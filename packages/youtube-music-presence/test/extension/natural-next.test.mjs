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
const PAGE_A = "https://music.youtube.com/watch?v=aaaaaaaaaaa";
const PAGE_B = "https://music.youtube.com/watch?v=bbbbbbbbbbb";
const SRC_A = "https://media.example/a";
const SRC_B = "https://media.example/b";
const A_TOTAL = 200;
const A_POSITION = 198;
const B_TOTAL = 240;
const BASE = 1_700_000_000_000;

function signal() {
  const handlers = new Set();
  return {
    addListener(fn) { handlers.add(fn); },
    removeListener(fn) { handlers.delete(fn); },
    fire(...args) { for (const fn of [...handlers]) fn(...args); },
  };
}

/** Worker and page share one clock; a frame records the instant it went out. */
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
    duration: A_TOTAL,
    currentTime: A_POSITION,
    paused: false,
    currentSrc: SRC_A,
  });
  const page = musicPage({
    href: PAGE_A,
    title: "Song A",
    byline: [node("a", { attrs: { href: "channel/UCa" }, text: "Artist A" })],
    time: clockText(A_POSITION, A_TOTAL),
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
    setTrackB() {
      page.doc.querySelector("ytmusic-player-bar .title").textContent = "Song B";
      page.navigator.mediaSession = { metadata: { title: "Song B" }, playbackState: "playing" };
      page.setHref(PAGE_B);
    },
  };
}

function frames(port) {
  return port.sent.filter((entry) => entry.message.t === "activity" && entry.message.activity);
}

function detail(state) {
  return `title=${state.title} elapsed=${state.position} duration=${state.duration} paused=${state.paused}`;
}

/**
 * The owner's live bug after 1.1.19. Track A plays a coherent 200 s pair at
 * 3:18. It ends naturally, with no user action, and the page auto-advances.
 * The handover reads, in production order:
 *
 *   1. the player bar already says Song B, but the bar clock is still A's
 *      3:20 total at 0:00 while the media element has no duration;
 *   2. the bar clock collapses to its elapsed pair "0:00 / 0:02" while the
 *      element still has no duration, so the extractor falls back to a
 *      clock-only 2 s total;
 *   3. B's real 4:00 total becomes readable with a coherent element.
 *
 * No frame through the worker may publish the collapsed clock as a total, and
 * the last frame must carry the real 240 s span with a live start.
 */
test("natural end-of-track auto-advance never publishes the collapsed bar total", async () => {
  const { chrome, clock, port, worker } = bootWorker();
  await worker.start();
  const env = bootPage(clock);
  const { media, page, handle } = env;

  env.feed(chrome);
  const a = env.states().at(-1);
  assert.equal(a.title, "Song A", detail(a));
  assert.equal(a.duration, A_TOTAL, detail(a));
  assert.equal(a.position, A_POSITION, detail(a));

  // Natural end: the element ends, the page auto-advances, and the first read
  // of B still shows A's total on the bar clock with a duration-less element.
  clock.advance(2000);
  env.setTrackB();
  setBarClock(page, clockText(0, A_TOTAL));
  media.duration = null;
  media.currentTime = 0;
  media.paused = false;
  page.dispatchOnDoc("ended", { target: media });
  env.feed(chrome);
  const b1 = env.states().at(-1);
  assert.equal(b1.title, "Song B", detail(b1));
  assert.equal(b1.duration, null, `A's total must not survive the handover: ${detail(b1)}`);

  // The bar collapses to its own elapsed pair while the element duration is
  // still gone: a clock-only 2 s total at the start of the new track.
  clock.advance(1600);
  setBarClock(page, clockText(0, 2));
  media.duration = null;
  media.currentTime = 0;
  media.paused = false;
  handle.poll();
  env.feed(chrome);
  const b2 = env.states().at(-1);
  assert.equal(b2.title, "Song B", detail(b2));

  // B's real total becomes readable with a coherent element.
  clock.advance(1600);
  setBarClock(page, clockText(1, B_TOTAL));
  media.duration = B_TOTAL;
  media.currentTime = 1;
  media.paused = false;
  media.currentSrc = SRC_B;
  handle.poll();
  env.feed(chrome);
  const b3 = env.states().at(-1);
  assert.equal(b3.title, "Song B", detail(b3));
  assert.equal(b3.duration, B_TOTAL, `the real incoming total must publish: ${detail(b3)}`);
  assert.equal(b3.position, 1, detail(b3));

  const out = frames(port);
  const frameJson = out.map((entry) => entry.message.activity);

  /** No timed frame may be empty or already expired when it reaches the wire. */
  for (let i = 0; i < out.length; i += 1) {
    const activity = out[i].message.activity;
    if (!activity.timestamps) continue;
    const { start, end } = activity.timestamps;
    assert.ok(end > start, `frame ${i} has no span: ${JSON.stringify(activity)}`);
    assert.ok(
      end > Math.floor(out[i].at / 1000),
      `frame ${i} is already expired at its sample instant ` +
      `(end=${end}, now=${Math.floor(out[i].at / 1000)}): ${JSON.stringify(activity)}`
    );
  }

  /** The 240 s track never publishes the collapsed two-second total. */
  for (let i = 0; i < out.length; i += 1) {
    const activity = out[i].message.activity;
    if (!activity.timestamps) continue;
    const span = activity.timestamps.end - activity.timestamps.start;
    assert.ok(
      span >= 5,
      `frame ${i} publishes a ${span}s span for a ${B_TOTAL}s track: ${JSON.stringify(activity)}`
    );
  }

  /** The real total is the last thing on the wire, anchored to its playhead. */
  const last = out.at(-1);
  assert.ok(last.message.activity.timestamps, `the last frame is timed: ${JSON.stringify(frameJson.at(-1))}`);
  assert.equal(last.message.activity.details, "Song B", JSON.stringify(last.message.activity));
  assert.equal(
    last.message.activity.timestamps.end - last.message.activity.timestamps.start,
    B_TOTAL,
    `the last frame carries the real total: ${JSON.stringify(last.message.activity)}`
  );
  assert.equal(
    last.message.activity.timestamps.start,
    Math.floor(b3.at / 1000) - Math.floor(b3.position),
    `the last frame's start follows the live playhead: ${JSON.stringify(last.message.activity)}`
  );
});

/**
 * Narrow guard, negative control: a genuinely short incoming track whose
 * element is coherent still publishes its real total on the first read. The
 * withheld clock-only read is not a floor on every short duration.
 */
test("a genuinely short coherent new track still publishes after a handover", () => {
  let now = BASE;
  const clock = { now: () => now, advance(ms) { now += ms; } };
  const env = bootPage(clock);
  const { media, page, handle } = env;
  const a = env.states().at(-1);
  assert.equal(a.duration, A_TOTAL, detail(a));

  env.setTrackB();
  setBarClock(page, clockText(0, 7));
  media.duration = 7;
  media.currentTime = 0;
  media.paused = false;
  media.currentSrc = "https://media.example/short";
  handle.poll();

  const short = env.states().at(-1);
  assert.equal(short.title, "Song B", detail(short));
  assert.equal(short.duration, 7, `a coherent 7 s track is not a collapsed clock: ${detail(short)}`);
  assert.equal(short.position, 0, detail(short));
});

/**
 * The withheld collapsed read arms no hold of its own. When B's real total
 * first becomes readable mid-song on the same media source A used, a differing
 * total must still release: the guard cannot leave the card timer-free.
 */
test("the collapsed-total guard cannot block a mid-song real total on the reused source", () => {
  let now = BASE;
  const clock = { now: () => now, advance(ms) { now += ms; } };
  const env = bootPage(clock);
  const { media, page, handle } = env;
  assert.equal(env.states().at(-1).duration, A_TOTAL);

  // Handover: B identity with A's bar total and a duration-less element.
  env.setTrackB();
  setBarClock(page, clockText(0, A_TOTAL));
  media.duration = null;
  media.currentTime = 0;
  media.paused = false;
  handle.poll();
  const held = env.states().at(-1);
  assert.equal(held.duration, null, `A's total stays withheld: ${detail(held)}`);

  // The collapsed elapsed pair is read next and must be withheld.
  now += 1000;
  setBarClock(page, clockText(0, 2));
  media.duration = null;
  media.currentTime = 0;
  media.paused = false;
  handle.poll();
  const collapsed = env.states().at(-1);
  assert.equal(collapsed.duration, null, `the collapsed total is withheld: ${detail(collapsed)}`);

  // B's real 240 s arrives at 0:08 on the reused element source (same as A).
  now += 1000;
  setBarClock(page, clockText(8, B_TOTAL));
  media.duration = B_TOTAL;
  media.currentTime = 8;
  media.paused = false;
  media.currentSrc = SRC_A;
  handle.poll();

  const real = env.states().at(-1);
  assert.equal(real.title, "Song B", detail(real));
  assert.equal(real.duration, B_TOTAL, `a differing real total releases mid-song: ${detail(real)}`);
  assert.equal(real.position, 8, detail(real));
});
