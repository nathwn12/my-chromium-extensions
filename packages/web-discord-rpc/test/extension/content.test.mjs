import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { audio, loadContent, makePage, musicPage, node } from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extractSource = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");

function boot(page, options = {}) {
  return loadContent({ extractSource, contentSource, page, ...options });
}

/**
 * content.js runs inside the fake page's vm realm, which owns its own `Date`.
 * The page helper exposes no clock, so the test installs one through `window`
 * before the script body runs.
 */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    }
  };
}

function bootWithClock(page, clock) {
  page.win.__wdrNow = clock.now;
  return loadContent({
    extractSource,
    contentSource: `Date.now = window.__wdrNow;\n${contentSource}`,
    page
  });
}

function states(handle) {
  return handle.messages.filter((message) => message.t === "wdr-state");
}

function gones(handle) {
  return handle.messages.filter((message) => message.t === "wdr-gone");
}

function musicWatch(title = "First Song", props = {}) {
  return musicPage({
    title,
    byline: [node("a", { attrs: { href: "channel/UCartist" }, text: "Artist" })],
    children: [audio({ duration: 200, ...props })]
  });
}

test("a Music page reports one wdr-state with source, state and at", () => {
  const handle = boot(musicWatch());
  assert.equal(handle.messages.length, 1);
  const message = handle.messages[0];
  assert.equal(message.t, "wdr-state");
  assert.equal(message.source, "youtube-music");
  assert.equal(message.state.title, "First Song");
  assert.equal(message.state.channel, "Artist");
  assert.equal(typeof message.state.at, "number");
  assert.equal(Number.isFinite(message.state.at), true);
});

test("audio media events report; timeupdate is never listened to", () => {
  const page = musicWatch();
  const handle = boot(page);
  const target = page.doc.querySelector("audio");
  page.dispatchOnDoc("timeupdate", { target });
  assert.equal(handle.messages.length, 1);
  page.dispatchOnDoc("play", { target });
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].t, "wdr-state");
});

test("the 1 s poll reports a title or pause change once, then stays quiet", () => {
  const page = musicWatch();
  const handle = boot(page);
  assert.deepEqual(handle.intervalDelays(), [1000]);
  handle.poll();
  assert.equal(handle.messages.length, 1);
  page.doc.querySelector("ytmusic-player-bar .title").textContent = "Second Song";
  handle.poll();
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].state.title, "Second Song");
  handle.poll();
  assert.equal(handle.messages.length, 2);
  page.doc.querySelector("audio").paused = false;
  handle.poll();
  assert.equal(handle.messages.length, 3);
  assert.equal(handle.messages[2].state.paused, false);
});

test("the poll reports a seek no media event announced", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);
  assert.equal(states(handle)[0].state.position, 10);
  page.doc.querySelector("audio").currentTime = 190;
  clock.advance(1000);
  handle.poll();
  assert.equal(states(handle).length, 2);
  assert.equal(states(handle)[1].state.position, 190);
});

test("steady playback drifts by rounding only, so the poll stays quiet", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(handle.messages.length, 1);
  clock.advance(1000);
  page.doc.querySelector("audio").currentTime = 11;
  handle.poll();
  assert.equal(handle.messages.length, 1);
});

test("a paused page whose position jumps never drift-reports", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10 });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.paused, true);
  page.doc.querySelector("audio").currentTime = 190;
  clock.advance(1000);
  handle.poll();
  assert.equal(handle.messages.length, 1);
});

test("a title change still reports on the next poll", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  page.doc.querySelector("ytmusic-player-bar .title").textContent = "Second Song";
  clock.advance(1000);
  page.doc.querySelector("audio").currentTime = 11;
  handle.poll();
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].state.title, "Second Song");
});

test("same-URL SPA updates report immediately", () => {
  const page = musicWatch();
  const handle = boot(page);
  page.doc.querySelector("ytmusic-player-bar .title").textContent = "Re-rendered";
  page.dispatchOnDoc("yt-page-data-updated");
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].state.title, "Re-rendered");
});

test("a Music-to-Music SPA navigation reports once the page settles", () => {
  const page = musicWatch();
  const handle = boot(page);
  page.setHref("https://music.youtube.com/playlist?list=PL1");
  page.dispatchOnDoc("yt-navigate-finish");
  page.doc.querySelector("ytmusic-player-bar .title").textContent = "Next Song";
  assert.equal(handle.messages.length, 1);
  assert.equal(handle.pendingTimeouts(), 1);
  handle.flush();
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].t, "wdr-state");
  assert.equal(handle.messages[1].state.title, "Next Song");
});

test("navigating off Music sends one tab-scoped wdr-gone", () => {
  const page = musicWatch();
  const handle = boot(page);
  page.setHref("https://www.youtube.com/");
  page.dispatchOnDoc("yt-navigate-finish");
  assert.deepEqual(gones(handle), [{ t: "wdr-gone", source: "youtube-music", scope: "tab" }]);
  handle.poll();
  assert.equal(gones(handle).length, 1);
  assert.equal(states(handle).length, 1);
});

test("pagehide sends wdr-gone with scope tab", () => {
  const handle = boot(musicWatch());
  handle.page.dispatchOnWindow("pagehide");
  assert.deepEqual(gones(handle), [{ t: "wdr-gone", source: "youtube-music", scope: "tab" }]);
});

test("visibilitychange republishes the state with the new visible flag", () => {
  const page = musicWatch();
  const handle = boot(page);
  page.setVisibility("hidden");
  page.dispatchOnDoc("visibilitychange");
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].state.visible, false);
});

test("a throwing chrome.runtime.sendMessage never escapes the script", () => {
  const page = musicWatch();
  let handle;
  assert.doesNotThrow(() => { handle = boot(page, { sendMessage() { throw new Error("no receiver"); } }); });
  assert.doesNotThrow(() => {
    page.dispatchOnDoc("play", { target: page.doc.querySelector("audio") });
    handle.poll();
    page.dispatchOnWindow("pagehide");
  });
});

test("content without the extractor does nothing and schedules no poll", () => {
  const page = musicWatch();
  const handle = loadContent({ extractSource: "", contentSource, page });
  assert.deepEqual(handle.messages, []);
  assert.deepEqual(handle.intervalDelays(), []);
});

test("a subframe no-ops: only the top frame may report", () => {
  const page = musicWatch();
  const handle = boot(page, { top: {} });
  assert.deepEqual(handle.messages, []);
  assert.deepEqual(handle.intervalDelays(), []);
  page.dispatchOnDoc("play", { target: page.doc.querySelector("audio") });
  page.dispatchOnDoc("yt-navigate-finish");
  page.dispatchOnWindow("pagehide");
  assert.deepEqual(handle.messages, []);
});

test("non-Music pages report nothing", () => {
  const page = makePage({ href: "https://www.youtube.com/", title: "YouTube" });
  const handle = boot(page);
  assert.deepEqual(handle.messages, []);
  handle.poll();
  assert.deepEqual(handle.messages, []);
});
