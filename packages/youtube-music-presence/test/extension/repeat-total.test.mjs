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
const PAGE = "https://music.youtube.com/watch?v=aaaaaaaaaaa";
const BASE = 1_700_000_000_000;
const TRACK = "Repeat Song";
const TOTAL = 167;
const TOTAL_CLOCK = "2:47";

function signal() {
  const handlers = new Set();
  return {
    addListener(fn) { handlers.add(fn); },
    removeListener(fn) { handlers.delete(fn); },
    fire(...args) { for (const fn of [...handlers]) fn(...args); },
  };
}

function bootWorker() {
  const port = {
    sent: [],
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage(message) { this.sent.push(message); },
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
  let now = BASE;
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

/** One content-script realm whose Date.now is the test clock. */
function bootPage(clock) {
  const mediaNode = audio({
    duration: TOTAL,
    currentTime: 0,
    paused: false,
    currentSrc: "https://media.example/repeat",
  });
  const page = musicPage({
    href: PAGE,
    title: TRACK,
    time: `0:00 / ${TOTAL_CLOCK}`,
    byline: [node("a", { attrs: { href: "channel/UCrepeat" }, text: "Repeat Artist" })],
    children: [mediaNode],
  });
  page.win.__ytmpNow = clock.now;
  const handle = loadContent({
    extractSource,
    contentSource: `Date.now = window.__ytmpNow;\n${contentSource}`,
    page,
  });
  return {
    page,
    handle,
    media: () => page.doc.querySelector("audio"),
    states: () => handle.messages.filter((message) => message.t === "ytmp-state").map((message) => message.state),
    setClock(text) {
      page.doc.querySelector("ytmusic-player-bar .time").textContent = text;
    },
    setSession(text, playbackState = "playing") {
      page.navigator.mediaSession = { metadata: { title: text }, playbackState };
    },
    /** A poll at the current clock instant: no time passes inside the read. */
    read() {
      handle.poll();
      return this.states().at(-1);
    },
  };
}

function detail(state) {
  return `title=${state.title} elapsed=${state.position} duration=${state.duration} paused=${state.paused} at=${state.at}`;
}

function sendState(chrome, state) {
  chrome.runtime.onMessage.fire(
    { t: "ytmp-state", source: "youtube-music", state },
    { id: "ext-test-id", tab: { id: 1, url: PAGE }, frameId: 0 },
    () => {}
  );
}

function frames(port) {
  return port.sent.filter((message) => message.t === "activity" && message.activity);
}

/**
 * The owner's loop on a hidden tab. The first sample is honest: 0:00 / 2:47 on
 * a 167 s track, so the card carries a live 167 s pair. At the repeat boundary
 * the player bar momentarily reads its collapsed pair "0:02 / 0:02" while the
 * media element has no duration (the MSE reset), and the extractor therefore
 * falls back to the bar clock. The next poll recovers "0:00 / 2:47" on an
 * element whose duration is 167 again.
 *
 * Nothing the content script publishes here may reach the wire as a 2 s total
 * or as a pair whose end is at or before its own sample instant: Discord reads
 * a past end as "no total" and renders a bare rising elapsed timer.
 */
test("a hidden repeat boundary never publishes an expired or two-second total", async () => {
  const { chrome, clock, port, worker } = bootWorker();
  await worker.start();
  const env = bootPage(clock);

  const first = env.states().at(-1);
  assert.equal(first.duration, TOTAL, detail(first));
  assert.equal(first.position, 0, detail(first));
  sendState(chrome, { ...first, at: clock.now() });
  assert.equal(frames(port).length, 1, "the first report publishes one frame");
  const firstFrame = frames(port)[0].activity;
  assert.equal(
    firstFrame.timestamps.end - firstFrame.timestamps.start,
    TOTAL,
    `the first frame carries the real total: ${JSON.stringify(firstFrame)}`
  );

  /** Alt-tabbed: the page keeps polling while hidden. */
  env.page.setVisibility("hidden");
  env.setSession(TRACK, "playing");

  /** The loop boundary: bar clock collapses to 0:02 / 0:02, element duration is null. */
  clock.advance(1600);
  env.setClock("0:02 / 0:02");
  const media = env.media();
  media.duration = null;
  media.currentTime = 2;
  const boundary = env.read();
  assert.equal(boundary.paused, false, `the boundary read is still playing: ${detail(boundary)}`);
  sendState(chrome, { ...boundary, at: clock.now() });
  assert.equal(frames(port).length, 2, "the boundary report publishes one frame");
  const boundaryFrame = frames(port)[1].activity;

  /** The next poll recovers the real element and the real total. */
  clock.advance(1600);
  env.setClock(`0:00 / ${TOTAL_CLOCK}`);
  media.duration = TOTAL;
  media.currentTime = 0;
  const recovery = env.read();
  assert.equal(recovery.duration, TOTAL, `the element total returns: ${detail(recovery)}`);
  assert.equal(recovery.position, 0, detail(recovery));
  sendState(chrome, { ...recovery, at: clock.now() });
  assert.equal(frames(port).length, 3, "the recovery report publishes one frame");

  const sent = [first, boundary, recovery];
  const out = frames(port);

  /** (i) No timed frame may be empty or already expired at its sample instant. */
  for (let i = 0; i < out.length; i += 1) {
    const activity = out[i].activity;
    if (!activity.timestamps) continue;
    const { start, end } = activity.timestamps;
    const nowSeconds = Math.floor(sent[i].at / 1000);
    assert.ok(end > start, `frame ${i} has no span: ${JSON.stringify(activity)}`);
    assert.ok(
      end > nowSeconds,
      `frame ${i} is already expired at its sample instant (end=${end}, now=${nowSeconds}): ${JSON.stringify(activity)}`
    );
  }

  /** (ii) The 167 s track never publishes a 2 s total. */
  for (let i = 0; i < out.length; i += 1) {
    const activity = out[i].activity;
    if (!activity.timestamps) continue;
    assert.notEqual(
      activity.timestamps.end - activity.timestamps.start,
      2,
      `frame ${i} publishes the collapsed boundary as a total: ${JSON.stringify(activity)}`
    );
  }

  /** The collapsed read itself must be timing-free, never a fresh 2 s sample. */
  assert.equal(
    boundaryFrame.timestamps,
    undefined,
    `the collapsed boundary read must not publish timing: ${JSON.stringify(boundaryFrame)}`
  );

  /** (iii) The recovery frame restores the total and anchors to the live playhead. */
  const last = out[2].activity;
  assert.ok(last.timestamps, `the recovery frame is timed: ${JSON.stringify(last)}`);
  assert.equal(
    last.timestamps.end - last.timestamps.start,
    TOTAL,
    `the recovery frame carries the real total: ${JSON.stringify(last)}`
  );
  assert.equal(
    last.timestamps.start,
    Math.floor(recovery.at / 1000) - Math.floor(recovery.position),
    `the recovery start follows the live playhead: ${JSON.stringify(last)}`
  );
});
