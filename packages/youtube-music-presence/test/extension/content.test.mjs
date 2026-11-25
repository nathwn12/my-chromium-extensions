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
  page.win.__ytmpNow = clock.now;
  return loadContent({
    extractSource,
    contentSource: `Date.now = window.__ytmpNow;\n${contentSource}`,
    page
  });
}

function states(handle) {
  return handle.messages.filter((message) => message.t === "ytmp-state");
}

function gones(handle) {
  return handle.messages.filter((message) => message.t === "ytmp-gone");
}

/** Reports that repeat the previous title: sends that spend budget on nothing. */
function duplicateTitleCount(messages) {
  let n = 0;
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].state.title === messages[i - 1].state.title) n += 1;
  }
  return n;
}

/**
 * The master presence switch as the content script sees it: one stored key and
 * an onChanged fan-out the test drives.
 */
function fakeStorage(initial) {
  const state = { ...initial };
  const listeners = [];
  return {
    local: {
      get(keys, callback) {
        const out = {};
        for (const key of [].concat(keys)) if (key in state) out[key] = state[key];
        if (typeof callback === "function") callback(out);
      }
    },
    onChanged: {
      addListener(fn) {
        listeners.push(fn);
      }
    },
    emit(changes) {
      for (const fn of listeners) fn(changes, "local");
    }
  };
}

function musicWatch(title = "First Song", props = {}) {
  return musicPage({
    title,
    byline: [node("a", { attrs: { href: "channel/UCartist" }, text: "Artist" })],
    children: [audio({ duration: 200, ...props })]
  });
}

test("a Music page reports one ytmp-state with source, state and at", () => {
  const handle = boot(musicWatch());
  assert.equal(handle.messages.length, 1);
  const message = handle.messages[0];
  assert.equal(message.t, "ytmp-state");
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
  assert.equal(handle.messages[1].t, "ytmp-state");
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

test("the presence switch off holds no poll, reads nothing and sends nothing", () => {
  const page = musicWatch();
  const handle = boot(page, { storage: fakeStorage({ enabled: false }) });
  assert.deepEqual(handle.intervalDelays(), [], "no poll while presence is off");
  assert.deepEqual(handle.messages, [], "nothing to publish while off");
  page.dispatchOnDoc("play", { target: page.doc.querySelector("audio") });
  page.dispatchOnDoc("visibilitychange");
  page.dispatchOnWindow("pagehide");
  assert.deepEqual(handle.messages, [], "no report escapes while off");
  assert.deepEqual(handle.intervalDelays(), [], "still no poll after a pagehide");
});

test("switching presence back on re-arms the poll and reports at once", () => {
  const page = musicWatch();
  const storage = fakeStorage({ enabled: true });
  const handle = boot(page, { storage });
  assert.deepEqual(handle.intervalDelays(), [1000]);
  assert.equal(states(handle).length, 1);

  storage.emit({ enabled: { newValue: false } });
  assert.deepEqual(handle.intervalDelays(), [], "off stops the poll");

  storage.emit({ enabled: { newValue: true } });
  assert.deepEqual(handle.intervalDelays(), [1000], "on restarts the poll");
  assert.equal(states(handle).length, 2, "on republishes without waiting for a tick");
  assert.equal(states(handle)[1].state.title, "First Song");
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

test("at 1.5x every poll tick re-anchors the card", () => {
  const page = musicWatch("First Song", {
    duration: 300,
    currentTime: 10,
    paused: false,
    playbackRate: 1.5
  });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);

  for (let tick = 1; tick <= 3; tick += 1) {
    clock.advance(1000);
    page.doc.querySelector("audio").currentTime = 10 + 1.5 * tick;
    handle.poll();
    assert.equal(states(handle).length, tick + 1, `tick ${tick} reports`);
    assert.equal(states(handle).at(-1).state.position, 10 + 1.5 * tick);
  }
});

test("a paused 1.5x state never forces a tick report", () => {
  const page = musicWatch("First Song", {
    duration: 300,
    currentTime: 10,
    paused: true,
    playbackRate: 1.5
  });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);
  clock.advance(1000);
  page.doc.querySelector("audio").currentTime = 11.5;
  handle.poll();
  assert.equal(states(handle).length, 1, "a paused tab is not drift");
});

test("a non-finite playback rate never forces a tick report", () => {
  const page = musicWatch("First Song", {
    duration: 300,
    currentTime: 10,
    paused: false,
    playbackRate: Number.NaN
  });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);
  clock.advance(1000);
  page.doc.querySelector("audio").currentTime = 11;
  handle.poll();
  assert.equal(states(handle).length, 1, "a junk rate is no reason to send");
});

test("a frozen position while time passes (buffering) never drift-reports", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);
  clock.advance(6000);
  handle.poll();
  assert.equal(handle.messages.length, 1, "a stalled buffer reports nothing");
});

test("an unannounced jump forward reports once with the live position", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  page.doc.querySelector("audio").currentTime = 190;
  clock.advance(1000);
  handle.poll();
  assert.equal(states(handle).length, 2);
  assert.equal(states(handle)[1].state.position, 190);
  handle.poll();
  assert.equal(states(handle).length, 2, "the re-anchor makes the next tick quiet");
});

test("an unannounced jump backward reports once with the live position", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 190, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  page.doc.querySelector("audio").currentTime = 30;
  clock.advance(1000);
  handle.poll();
  assert.equal(states(handle).length, 2);
  assert.equal(states(handle)[1].state.position, 30);
  handle.poll();
  assert.equal(states(handle).length, 2);
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

test("a stale media event re-reads after the settle window instead of waiting for the poll", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);

  page.dispatchOnDoc("play", { target: page.doc.querySelector("audio") });
  assert.equal(states(handle).length, 2);
  assert.equal(states(handle).at(-1).state.title, "First Song");
  const wastedAfterEvent = duplicateTitleCount(states(handle));

  assert.equal(handle.pendingTimeouts(), 1, "one one-shot re-read is armed");
  assert.deepEqual(handle.timeoutDelays(), [250], "re-read lands on the settle window");
  assert.deepEqual(handle.intervalDelays(), [1000], "the original poll is unchanged");

  page.doc.querySelector("ytmusic-player-bar .title").textContent = "Second Song";
  clock.advance(250);
  handle.flush();

  assert.equal(states(handle).at(-1).state.title, "Second Song", "the switch lands within the bound");
  assert.equal(
    duplicateTitleCount(states(handle)),
    wastedAfterEvent,
    "the re-read never republishes the unchanged old title"
  );
});

test("a stale re-read whose DOM never flipped stays silent", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  page.dispatchOnDoc("play", { target: page.doc.querySelector("audio") });
  assert.equal(states(handle).length, 2);

  assert.equal(handle.pendingTimeouts(), 1);
  clock.advance(250);
  handle.flush();
  assert.equal(states(handle).length, 2, "an unchanged re-read spends no second send");
  assert.equal(duplicateTitleCount(states(handle)), 1);
});

test("a media event whose DOM already flipped reports at once with no re-read", () => {
  const page = musicWatch("First Song", { duration: 300, currentTime: 10, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  page.doc.querySelector("ytmusic-player-bar .title").textContent = "Second Song";
  page.dispatchOnDoc("play", { target: page.doc.querySelector("audio") });

  assert.equal(states(handle).length, 2);
  assert.equal(states(handle).at(-1).state.title, "Second Song", "no settle wait when the DOM is current");
  assert.equal(handle.pendingTimeouts(), 0, "no redundant re-read");
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
  assert.equal(handle.messages[1].t, "ytmp-state");
  assert.equal(handle.messages[1].state.title, "Next Song");
});

test("navigating off Music sends one tab-scoped ytmp-gone", () => {
  const page = musicWatch();
  const handle = boot(page);
  page.setHref("https://www.youtube.com/");
  page.dispatchOnDoc("yt-navigate-finish");
  assert.deepEqual(gones(handle), [{ t: "ytmp-gone", source: "youtube-music", scope: "tab" }]);
  handle.poll();
  assert.equal(gones(handle).length, 1);
  assert.equal(states(handle).length, 1);
});

test("pagehide sends ytmp-gone with scope tab", () => {
  const handle = boot(musicWatch());
  handle.page.dispatchOnWindow("pagehide");
  assert.deepEqual(gones(handle), [{ t: "ytmp-gone", source: "youtube-music", scope: "tab" }]);
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

test("a duration change reports even when title and pause are unchanged", () => {
  const page = musicWatch("Same Title", { duration: 366, currentTime: 47, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);
  assert.equal(states(handle)[0].state.duration, 366);

  const media = page.doc.querySelector("audio");
  media.duration = 129;
  media.currentTime = 48;
  clock.advance(1000);
  handle.poll();

  const next = states(handle)[1] && states(handle)[1].state;
  const detail = next && `title=${next.title} track=${next.trackUrl} elapsed=${next.position} duration=${next.duration} paused=${next.paused}`;
  assert.equal(states(handle).length, 2, `a new duration is a new sample, not silence: ${detail}`);
  assert.equal(states(handle)[1].state.duration, 129, detail);
  assert.equal(states(handle)[1].state.position, 48, detail);
  handle.poll();
  assert.equal(states(handle).length, 2, "the re-anchored sample makes the next tick quiet");
});

test("a normal no-clock startup still stamps timestamps", () => {
  const page = musicWatch("First Song", { duration: 200, currentTime: 12, paused: false });
  const handle = bootWithClock(page, fakeClock());
  const state = states(handle)[0].state;
  assert.equal(state.duration, 200, `title=${state.title} elapsed=${state.position} duration=${state.duration}`);
  assert.equal(state.position, 12);
});

test("a new identity with stale bar clock and stale playing media withholds timing", () => {
  const page = musicWatch("First Song", { duration: 366, currentTime: 47, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, 366);

  page.doc.querySelector("ytmusic-player-bar").append(
    node("span", { attrs: { class: "time" }, text: "0:47 / 6:06" })
  );
  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  clock.advance(1000);
  handle.poll();

  const next = states(handle)[1].state;
  const detail = `title=${next.title} track=${next.trackUrl} elapsed=${next.position} duration=${next.duration} paused=${next.paused}`;
  assert.equal(next.title, "Second Song", detail);
  assert.equal(next.duration, null, `stale clock and stale media agree on the old song: ${detail}`);
  assert.equal(next.position, null, detail);
});

test("a new identity with stale playing media and no bar clock withholds timing", () => {
  const page = musicWatch("First Song", { duration: 366, currentTime: 47, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, 366);

  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  clock.advance(1000);
  handle.poll();

  const next = states(handle)[1].state;
  const detail = `title=${next.title} track=${next.trackUrl} elapsed=${next.position} duration=${next.duration} paused=${next.paused}`;
  assert.equal(next.title, "Second Song", detail);
  assert.equal(next.duration, null, `lone playing fallback is stale at a new identity: ${detail}`);
  assert.equal(next.position, null, detail);
});

test("an outgoing element's loadedmetadata cannot approve a stale clock pair", () => {
  const page = musicWatch("First Song", { duration: 366, currentTime: 47, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, 366);

  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  clock.advance(1000);
  handle.poll();
  assert.equal(states(handle)[1].state.duration, null, "both sources still say the old song");

  page.dispatchOnDoc("loadedmetadata", { target: page.doc.querySelector("audio") });
  clock.advance(1000);
  handle.poll();
  const next = states(handle)[states(handle).length - 1].state;
  assert.equal(next.title, "Second Song");
  assert.equal(
    next.duration,
    null,
    `an unassociated load event must not approve the stale pair: title=${next.title} track=${next.trackUrl} elapsed=${next.position} duration=${next.duration}`
  );
});

test("a same-duration handoff stays held when only the media source changes", () => {
  const page = musicWatch("First Song", {
    duration: 366,
    currentTime: 47,
    paused: false,
    currentSrc: "https://media.example/a"
  });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, 366);

  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  clock.advance(1000);
  handle.poll();
  assert.equal(states(handle)[1].state.duration, null, "same duration with the old source stays withheld");

  page.doc.querySelector("audio").currentSrc = "https://media.example/b";
  clock.advance(1000);
  handle.poll();
  const held = states(handle)[states(handle).length - 1].state;
  assert.equal(held.duration, null, `a new source at the old total is not fresh: title=${held.title} elapsed=${held.position} duration=${held.duration}`);
  assert.equal(held.position, null);
});

test("a source change plus a fresh coherent duration releases the hold", () => {
  const page = musicWatch("First Song", {
    duration: 366,
    currentTime: 47,
    paused: false,
    currentSrc: "https://media.example/a"
  });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);

  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  clock.advance(1000);
  handle.poll();
  assert.equal(states(handle)[1].state.duration, null);

  const bar = page.doc.querySelector("ytmusic-player-bar");
  bar.append(node("span", { attrs: { class: "time" }, text: "0:48 / 2:09" }));
  const media = page.doc.querySelector("audio");
  media.currentSrc = "https://media.example/b";
  media.duration = 129;
  media.currentTime = 48;
  clock.advance(1000);
  handle.poll();
  const next = states(handle)[states(handle).length - 1].state;
  assert.equal(next.duration, 129, `the real total is restored: title=${next.title} elapsed=${next.position} duration=${next.duration}`);
  assert.equal(next.position, 48);
});

test("an unchanged media source cannot approve a stale same-duration pair", () => {
  const page = musicWatch("First Song", {
    duration: 366,
    currentTime: 47,
    paused: false,
    currentSrc: "https://media.example/a"
  });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);

  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  clock.advance(1000);
  handle.poll();
  clock.advance(1000);
  handle.poll();
  const next = states(handle)[states(handle).length - 1].state;
  assert.equal(
    next.duration,
    null,
    `same source and same duration are indistinguishable: title=${next.title} track=${next.trackUrl} elapsed=${next.position} duration=${next.duration}`
  );
});

test("a fractional media duration and integer bar clock hold across an emptied handoff", () => {
  const page = musicWatch("First Song", { duration: 366.4, currentTime: 47, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, 366.4);

  const media = page.doc.querySelector("audio");
  const bar = page.doc.querySelector("ytmusic-player-bar");
  bar.append(node("span", { attrs: { class: "time" }, text: "0:47 / 6:06" }));
  media.duration = 0;
  media.currentTime = 0;
  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  page.dispatchOnDoc("emptied", { target: media });

  const stale = states(handle)[states(handle).length - 1].state;
  assert.equal(
    stale.duration,
    null,
    `integer clock and fractional media are the same rendered second: title=${stale.title} track=${stale.trackUrl} elapsed=${stale.position} duration=${stale.duration}`
  );

  bar.querySelector(".time").textContent = "0:48 / 2:09";
  media.duration = 129;
  media.currentTime = 48;
  clock.advance(1000);
  handle.poll();
  const mid = states(handle)[states(handle).length - 1].state;
  assert.equal(
    mid.duration,
    null,
    `mid-song 129 under the same source fails closed: elapsed=${mid.position} duration=${mid.duration}`
  );

  bar.querySelector(".time").textContent = "0:02 / 2:09";
  media.currentTime = 2;
  clock.advance(1000);
  handle.poll();
  const fresh = states(handle)[states(handle).length - 1].state;
  assert.equal(fresh.duration, 129, `a near-zero playhead restores: elapsed=${fresh.position} duration=${fresh.duration}`);
  assert.equal(fresh.position, 2, `the real playhead follows: elapsed=${fresh.position}`);
});

test("a null timing gap does not make a returning stale duration fresh", () => {
  const page = musicWatch("First Song", { duration: 366, currentTime: 47, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, 366);

  const media = page.doc.querySelector("audio");
  media.duration = 0;
  media.currentTime = 0;
  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  clock.advance(1000);
  handle.poll();
  assert.equal(states(handle)[1].state.title, "Second Song");
  assert.equal(states(handle)[1].state.duration, null, "identity changed with no timing evidence");

  media.duration = 366;
  media.currentTime = 47;
  clock.advance(1000);
  handle.poll();
  const stale = states(handle)[states(handle).length - 1].state;
  assert.equal(
    stale.duration,
    null,
    `a returning stale duration is not fresh: title=${stale.title} track=${stale.trackUrl} elapsed=${stale.position} duration=${stale.duration}`
  );

  media.duration = 129;
  media.currentTime = 48;
  clock.advance(1000);
  handle.poll();
  const mid = states(handle)[states(handle).length - 1].state;
  assert.equal(
    mid.duration,
    null,
    `mid-song 129 under the same source fails closed: elapsed=${mid.position} duration=${mid.duration}`
  );

  media.currentTime = 2;
  clock.advance(1000);
  handle.poll();
  const fresh = states(handle)[states(handle).length - 1].state;
  assert.equal(fresh.duration, 129, `a near-zero playhead restores: elapsed=${fresh.position} duration=${fresh.duration}`);
  assert.equal(fresh.position, 2, `the real playhead follows: elapsed=${fresh.position}`);
});

test("a duration appearing after a metadata-only state reports on the next poll", () => {
  const page = musicWatch("First Song", { duration: 0, currentTime: 0, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, null);

  page.doc.querySelector("audio").duration = 200;
  clock.advance(1000);
  handle.poll();
  const next = states(handle)[1].state;
  assert.equal(next.duration, 200, `title=${next.title} elapsed=${next.position} duration=${next.duration}`);
});

test("a position appearing at the same duration reports on the next poll", () => {
  const page = musicWatch("First Song", { duration: 200, currentTime: null, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle)[0].state.duration, 200);
  assert.equal(states(handle)[0].state.position, null);

  page.doc.querySelector("audio").currentTime = 48;
  clock.advance(1000);
  handle.poll();
  const next = states(handle)[1].state;
  assert.equal(
    next.position,
    48,
    `title=${next.title} track=${next.trackUrl} elapsed=${next.position} duration=${next.duration}`
  );
  assert.equal(next.duration, 200);
});

test("a handoff reports metadata first and refreshes timing once it is coherent", () => {
  const page = musicWatch("Same Title", { duration: 366, currentTime: 47, paused: false });
  const clock = fakeClock();
  const handle = bootWithClock(page, clock);
  assert.equal(states(handle).length, 1);
  assert.equal(states(handle)[0].state.duration, 366);

  const media = page.doc.querySelector("audio");
  page.navigator.mediaSession = { metadata: { title: "Same Title" }, playbackState: "playing" };
  media.duration = 0;
  media.currentTime = 0;
  media.paused = true;
  page.dispatchOnDoc("durationchange", { target: media });

  const handoff = states(handle)[1].state;
  const handoffDetail = `title=${handoff.title} track=${handoff.trackUrl} elapsed=${handoff.position} duration=${handoff.duration} paused=${handoff.paused}`;
  assert.equal(states(handle).length, 2, `the handoff reports promptly: ${handoffDetail}`);
  assert.equal(handoff.paused, false, `playing metadata, not a paused media element: ${handoffDetail}`);
  assert.equal(handoff.duration, null, `no borrowed 366 timing: ${handoffDetail}`);
  assert.equal(handoff.position, null, handoffDetail);

  page.doc.querySelector("ytmusic-player-bar").append(
    node("span", { attrs: { class: "time" }, text: "0:48 / 2:09" })
  );
  media.duration = 129;
  media.currentTime = 48;
  media.paused = false;
  page.dispatchOnDoc("durationchange", { target: media });

  const refreshed = states(handle)[2].state;
  const refreshedDetail = `title=${refreshed.title} track=${refreshed.trackUrl} elapsed=${refreshed.position} duration=${refreshed.duration} paused=${refreshed.paused}`;
  assert.equal(states(handle).length, 3, refreshedDetail);
  assert.equal(refreshed.duration, 129, `the correct total arrives as soon as it is coherent: ${refreshedDetail}`);
  assert.equal(refreshed.position, 48, refreshedDetail);
  assert.equal(refreshed.paused, false, refreshedDetail);
});
