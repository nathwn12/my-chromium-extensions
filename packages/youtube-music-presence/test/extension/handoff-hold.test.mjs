import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createWorker, wire } from "../../background.js";
import { audio, loadContent, musicPage, node } from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extractSource = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");
const PAGE_A = "https://music.youtube.com/watch?v=aaaaaaaaaaa";
const PAGE_B = "https://music.youtube.com/watch?v=bbbbbbbbbbb";
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

/** One content-script realm with a clock shared by the test and the worker. */
function bootPage({ clock, title = "First Song", media = {}, children } = {}) {
  const mediaNode = audio({ duration: 366, currentTime: 47, paused: false, currentSrc: "https://media.example/a", ...media });
  const page = musicPage({
    href: PAGE_A,
    title,
    byline: [node("a", { attrs: { href: "channel/UCfirst" }, text: "First Artist" })],
    children: children === undefined ? [mediaNode] : children,
  });
  page.win.__ytmpNow = clock ? clock.now : () => BASE;
  const handle = loadContent({
    extractSource,
    contentSource: `Date.now = window.__ytmpNow;\n${contentSource}`,
    page,
  });
  return {
    page,
    handle,
    states: () => handle.messages.filter((message) => message.t === "ytmp-state").map((message) => message.state),
    messagesOfType: (type) => handle.messages.filter((message) => message.t === type),
    advance(ms = 1000) {
      if (clock) clock.advance(ms);
      handle.poll();
    },
    media: () => page.doc.querySelector("audio"),
    setClock(text) {
      const bar = page.doc.querySelector("ytmusic-player-bar");
      const old = bar.querySelector(".time");
      if (old) old.textContent = text;
      else bar.append(node("span", { attrs: { class: "time" }, text }));
    },
    setTitle(text) { page.doc.querySelector("ytmusic-player-bar .title").textContent = text; },
    setSession(text, playbackState = "playing") {
      page.navigator.mediaSession = { metadata: { title: text }, playbackState };
    },
    handoff(text = "Second Song", playbackState = "playing") {
      this.setTitle(text);
      this.setSession(text, playbackState);
      page.setHref(PAGE_B);
      const el = this.media();
      if (el) { el.duration = 0; el.currentTime = 0; }
      this.advance();
    },
  };
}

function detail(state) {
  return `title=${state.title} track=${state.trackUrl} elapsed=${state.position} duration=${state.duration} paused=${state.paused}`;
}

function sendState(chrome, state) {
  chrome.runtime.onMessage.fire(
    { t: "ytmp-state", source: "youtube-music", state },
    { id: "ext-test-id", tab: { id: 1, url: PAGE_B }, frameId: 0 },
    () => {}
  );
}

function frames(port) {
  return port.sent.filter((message) => message.t === "activity" && message.activity);
}

test("a source change alone cannot approve a same-duration handoff", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  assert.equal(env.states()[0].duration, 366);

  env.setTitle("Second Song");
  env.setSession("Second Song");
  env.page.setHref(PAGE_B);
  env.advance();
  assert.equal(env.states().at(-1).duration, null, "the stale 366 is withheld at the handoff");

  const media = env.media();
  media.currentSrc = "https://media.example/b";
  env.setClock("0:48 / 6:06");
  env.page.dispatchOnDoc("play", { target: media });

  const held = env.states().at(-1);
  assert.equal(held.duration, null, `a new source at the old total is not fresh: ${detail(held)}`);
  assert.equal(held.position, null, detail(held));

  env.setClock("0:48 / 2:09");
  media.duration = 129;
  media.currentTime = 48;
  env.advance();
  const mid = env.states().at(-1);
  assert.equal(
    mid.duration,
    129,
    `a coherent incoming total restores the card mid-song: ${detail(mid)}`
  );
  assert.equal(mid.position, 48, detail(mid));

  env.setClock("0:02 / 2:09");
  media.currentTime = 2;
  env.advance();
  const fresh = env.states().at(-1);
  assert.equal(fresh.duration, 129, `a near-zero playhead releases: ${detail(fresh)}`);
  assert.equal(fresh.position, 2, detail(fresh));
});

test("a first coherent read with a new duration and fresh playhead publishes at once", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  assert.equal(env.states()[0].duration, 366);

  env.setTitle("Second Song");
  env.setSession("Second Song");
  env.page.setHref(PAGE_B);
  env.setClock("0:02 / 2:09");
  const media = env.media();
  media.duration = 129;
  media.currentTime = 2;
  media.paused = false;
  env.advance();

  const fresh = env.states().at(-1);
  assert.equal(fresh.title, "Second Song", `the new identity is published: ${detail(fresh)}`);
  assert.equal(fresh.duration, 129, `the genuinely new total must not be held: ${detail(fresh)}`);
  assert.equal(fresh.position, 2, detail(fresh));
  assert.equal(env.states().length, 2, "no suppressed first read: one hold-free publish");
});

test("identity and source changing in one read still withhold timing", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  assert.equal(env.states()[0].duration, 366);

  env.setTitle("Second Song");
  env.setSession("Second Song");
  env.page.setHref(PAGE_B);
  env.media().currentSrc = "https://media.example/b";
  env.advance();

  const held = env.states().at(-1);
  assert.equal(held.title, "Second Song", detail(held));
  assert.equal(held.duration, null, `source and identity together must not stamp 366: ${detail(held)}`);
});

test("a 366 to 129 playlist start never stamps the old total before a coherent read", async () => {
  const { chrome, clock, port, worker } = bootWorker();
  await worker.start();
  const env = bootPage({ clock });
  sendState(chrome, { ...env.states()[0], at: clock.now() });
  assert.equal(frames(port)[0].activity.timestamps.end - frames(port)[0].activity.timestamps.start, 366);

  env.handoff();
  clock.advance(1600);
  sendState(chrome, { ...env.states().at(-1), at: clock.now() });
  assert.equal(frames(port)[1].activity.timestamps, undefined, "no old 366 under the new identity");

  for (let i = 0; i < 10; i += 1) env.advance();
  assert.equal(env.states().length, 2, "an incoherent hold stays metadata-only across polls");

  env.setClock("0:48 / 2:09");
  const media = env.media();
  media.duration = 129;
  media.currentTime = 48;
  media.paused = false;
  env.advance();
  clock.advance(1600);
  sendState(chrome, { ...env.states().at(-1), at: clock.now() });

  const stamped = frames(port).at(-1).activity.timestamps;
  assert.equal(stamped.end - stamped.start, 129, `the real total returns: ${detail(env.states().at(-1))}`);
  assert.equal(stamped.start, Math.floor(clock.now() / 1000) - 48, "elapsed follows the real playhead");
});

test("a stale equal duration at the original source keeps the hold armed", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  env.handoff();

  env.setClock("0:48 / 6:06");
  const media = env.media();
  media.duration = 366;
  media.currentTime = 48;
  media.paused = false;
  env.advance();

  const last = env.states().at(-1);
  assert.equal(env.states().length, 2, `the old 6:06 must not be borrowed: ${detail(last)}`);
  assert.equal(last.duration, null, detail(last));
});

test("a new song sharing the old total fails closed", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  assert.equal(env.states()[0].duration, 366);

  env.setTitle("Second Song");
  env.setSession("Second Song");
  env.page.setHref(PAGE_B);
  env.setClock("0:48 / 6:06");
  const media = env.media();
  media.duration = 366;
  media.currentTime = 48;
  media.paused = false;
  env.advance();

  const held = env.states().at(-1);
  assert.equal(held.title, "Second Song", detail(held));
  assert.equal(held.duration, null, `a new song sharing the old total is indistinguishable from stale: ${detail(held)}`);
  assert.equal(held.position, null, detail(held));
});

test("wall-clock ticks alone never release the hold", () => {
  let now = BASE;
  const clock = { now: () => now, advance(ms) { now += ms; } };
  const env = bootPage({ clock });
  env.handoff();
  for (let i = 0; i < 60; i += 1) env.advance();
  assert.equal(env.states().length, 2, "time passing is not timing evidence");
  assert.equal(env.states().at(-1).duration, null, `the held total survives 60 real ticks: ${detail(env.states().at(-1))}`);

  env.setClock("0:48 / 2:09");
  const media = env.media();
  media.duration = 129;
  media.currentTime = 48;
  media.paused = false;
  env.advance();
  const fresh = env.states().at(-1);
  assert.equal(fresh.duration, 129, `a different real duration releases: ${detail(fresh)}`);
  assert.equal(fresh.position, 48, detail(fresh));
});

test("repeated handoffs release only once a coherent read arrives", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  env.handoff("Second Song");
  env.handoff("Third Song");
  const held = env.states().at(-1);
  assert.equal(held.duration, null, `the second handoff keeps the hold: ${detail(held)}`);

  env.setClock("0:48 / 2:09");
  const media = env.media();
  media.duration = 129;
  media.currentTime = 48;
  media.paused = false;
  env.advance();
  const fresh = env.states().at(-1);
  assert.equal(fresh.duration, 129, `coherent 129 ends the chain: ${detail(fresh)}`);
});

test("metadata before any media releases when coherent audio appears", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} }, children: [] });
  env.setTitle("First Song");
  env.setSession("First Song");
  env.advance();
  const metadata = env.states().at(-1);
  assert.equal(metadata.duration, null, `no media means no timing: ${detail(metadata)}`);

  env.handoff("Second Song");
  env.setClock("0:48 / 2:09");
  env.page.root.append(audio({ duration: 129, currentTime: 48, paused: false, currentSrc: "https://media.example/b" }));
  env.advance();
  const fresh = env.states().at(-1);
  assert.equal(fresh.duration, 129, `the appearing element releases: ${detail(fresh)}`);
  assert.equal(fresh.position, 48, detail(fresh));
});

test("a resume, a seek and a mid-song total cannot borrow the old duration", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  env.handoff("Second Song", "paused");
  assert.equal(env.states().at(-1).paused, true, "the held card follows the page's pause");

  env.setSession("Second Song", "playing");
  const media = env.media();
  media.duration = 366;
  media.currentTime = 200;
  media.paused = false;
  env.advance();
  const seek = env.states().at(-1);
  assert.equal(seek.duration, null, `a seek inside the stale total stays held: ${detail(seek)}`);

  media.currentSrc = "https://media.example/b";
  env.page.dispatchOnDoc("play", { target: media });
  env.advance();
  assert.equal(env.states().at(-1).duration, null, "a new source at the old total stays held");

  env.setClock("2:00 / 2:09");
  media.duration = 129;
  media.currentTime = 120;
  env.advance();
  const mid = env.states().at(-1);
  assert.equal(mid.duration, 129, `a coherent new total is real incoming timing: ${detail(mid)}`);
  assert.equal(mid.position, 120, detail(mid));

  env.setClock("0:02 / 2:09");
  media.currentTime = 2;
  env.advance();
  const fresh = env.states().at(-1);
  assert.equal(fresh.duration, 129, `a near-zero playhead releases: ${detail(fresh)}`);
  assert.equal(fresh.position, 2, detail(fresh));
});

test("a skipped B with B-era timing leaves C timestamp-free", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  assert.equal(env.states()[0].duration, 366);

  env.setTitle("Second Song");
  env.setSession("Second Song");
  env.page.setHref(PAGE_B);
  env.setClock("0:48 / 2:09");
  const media = env.media();
  media.duration = 129;
  media.currentTime = 48;
  media.paused = false;
  env.advance();
  const b = env.states().at(-1);
  assert.equal(b.title, "Second Song", `B is actually read while on its page: ${detail(b)}`);
  assert.equal(b.duration, null, `B's mid-song 129 is ingested but not published: ${detail(b)}`);
  assert.equal(env.states().length, 2, "B is held, not stamped");

  env.setTitle("Third Song");
  env.setSession("Third Song");
  env.page.setHref("https://music.youtube.com/watch?v=ccccccccccc");
  env.advance();

  const next = env.states().at(-1);
  assert.equal(next.title, "Third Song", `C is the published identity: ${detail(next)}`);
  assert.equal(next.duration, null, `B-era 129 cannot pass as C's total: ${detail(next)}`);
  assert.equal(env.states().length, 3, "B was published, C is metadata-only");
});

test("a navigate-away race cannot stamp the old 366 on the next title", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  assert.equal(env.states()[0].duration, 366);

  env.setTitle("");
  env.page.navigator.mediaSession = null;
  env.page.setHref(PAGE_B);
  env.page.dispatchOnDoc("yt-navigate-finish", {});
  assert.equal(env.messagesOfType("ytmp-gone").length, 1, "the blank page clears the tab");

  env.setTitle("Second Song");
  env.setSession("Second Song");
  env.advance();
  const next = env.states().at(-1);
  assert.equal(next.title, "Second Song", `the restored page publishes: ${detail(next)}`);
  assert.equal(next.duration, null, `the old 366 cannot cross the gone race: ${detail(next)}`);
});

test("an artist-only change with a media event withholds the old total", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  assert.equal(env.states()[0].duration, 366);

  env.page.doc.querySelector("ytmusic-player-bar .byline a").textContent = "Second Artist";
  env.page.dispatchOnDoc("durationchange", { target: env.media() });
  const next = env.states().at(-1);
  assert.equal(next.channel, "Second Artist", `the header changed: ${detail(next)}`);
  assert.equal(next.duration, null, `a new artist line is a new track: ${detail(next)}`);
  assert.equal(next.position, null, detail(next));
});

test("a same-track loop seek reconfirms the total held across a blank page", async () => {
  const { chrome, clock, port, worker } = bootWorker();
  await worker.start();
  const env = bootPage({ clock, title: "Second Song" });
  env.setSession("Second Song", "playing");
  env.setClock("2:28 / 4:11");
  const media = env.media();
  media.duration = 251;
  media.currentTime = 148;
  media.currentSrc = "https://media.example/b";
  env.advance();

  const timed = env.states().at(-1);
  assert.equal(timed.duration, 251, `the restored track owns its total: ${detail(timed)}`);
  sendState(chrome, { ...timed, at: clock.now() });
  assert.equal(frames(port)[0].activity.timestamps.end - frames(port)[0].activity.timestamps.start, 251);

  /** A blank page carries one guard across; the first read binds it to B. */
  env.page.dispatchOnWindow("pagehide", {});
  env.setSession("Second Song", "playing");
  media.duration = 251;
  media.currentTime = 148;
  env.advance();
  const held = env.states().at(-1);
  assert.equal(held.duration, null, `the guard binds to B's stale pair: ${detail(held)}`);

  /** Slowed Reverb's loop: same title, URL, id, total and source; playhead back to 1:38. */
  media.currentTime = 98;
  env.setClock("1:38 / 4:11");
  env.page.dispatchOnDoc("seeked", { target: media });

  const after = env.states().at(-1);
  assert.equal(after.title, "Second Song", detail(after));
  assert.equal(after.duration, 251, `a same-track loop seek reconfirms the real total: ${detail(after)}`);
  assert.equal(after.position, 98, `the real playhead follows the loop: ${detail(after)}`);

  clock.advance(1600);
  sendState(chrome, { ...after, at: clock.now() });
  const stamped = frames(port).at(-1).activity.timestamps;
  assert.equal(stamped.end - stamped.start, 251, "the card keeps the real total after the loop");
  assert.equal(stamped.start, Math.floor(clock.now() / 1000) - 98, "elapsed follows the loop playhead");
});

for (const seekEvent of ["seeked", "seeking"]) {
  test(`a loop playhead read before ${seekEvent} reopens the hold`, () => {
    const env = bootPage({ clock: { now: () => BASE, advance() {} }, title: "Second Song" });
    env.setSession("Second Song", "playing");
    env.setClock("2:28 / 4:11");
    const media = env.media();
    media.duration = 251;
    media.currentTime = 148;
    media.currentSrc = "https://media.example/b";
    env.advance();
    assert.equal(env.states().at(-1).duration, 251, `the track owns its total: ${detail(env.states().at(-1))}`);

    /** A blank page arms one guard; the first read binds it to this track. */
    env.page.dispatchOnWindow("pagehide", {});
    env.setSession("Second Song", "playing");
    media.duration = 251;
    media.currentTime = 148;
    env.advance();
    assert.equal(env.states().at(-1).duration, null, "the hold is armed");

    /** A non-seek media event reads the loop playhead before the seek flag. */
    media.currentTime = 98;
    env.setClock("1:38 / 4:11");
    env.page.dispatchOnDoc("play", { target: media });
    assert.equal(env.states().at(-1).duration, null, "the early loop read stays held");

    env.page.dispatchOnDoc(seekEvent, { target: media });
    const after = env.states().at(-1);
    assert.equal(after.duration, 251, `the ${seekEvent} loop reopens the hold: ${detail(after)}`);
    assert.equal(after.position, 98, `the playhead follows the loop: ${detail(after)}`);
  });
}

test("a conflicting player-bar clock at a loop seek stays timestamp-free", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  const media = env.media();
  media.duration = 251;
  media.currentTime = 148;
  env.setClock("2:28 / 4:11");
  env.advance();
  assert.equal(env.states().at(-1).duration, 251);

  env.setClock("1:38 / 4:11");
  env.page.doc.querySelector("ytmusic-player-bar").append(
    node("span", { attrs: { class: "time-info" }, text: "1:59 / 4:11" })
  );
  media.currentTime = 98;
  env.page.dispatchOnDoc("seeked", { target: media });

  const after = env.states().at(-1);
  assert.equal(after.duration, null, `a clock conflict is not resolved by a loop seek: ${detail(after)}`);
  assert.equal(after.position, null, detail(after));
});

test("a loop seek cannot release a hold when paused, sourceless or at a changed total", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} }, title: "Second Song" });
  env.setSession("Second Song", "playing");
  const media = env.media();
  media.duration = 251;
  media.currentTime = 148;
  env.advance();
  assert.equal(env.states().at(-1).duration, 251);

  env.page.dispatchOnWindow("pagehide", {});
  media.currentTime = 148;
  env.advance();
  assert.equal(env.states().at(-1).duration, null, "the hold is armed");

  media.paused = true;
  media.currentTime = 98;
  env.page.dispatchOnDoc("seeked", { target: media });
  assert.equal(env.states().at(-1).duration, null, "a paused loop seek is not fresh evidence");

  media.paused = false;
  media.duration = 366;
  media.currentTime = 148;
  env.advance();
  media.currentTime = 98;
  env.page.dispatchOnDoc("seeked", { target: media });
  assert.equal(env.states().at(-1).duration, null, "a changed total is not the held track's total");

  media.duration = 251;
  media.currentTime = 148;
  env.advance();
  env.page.doc.querySelector("ytmusic-player-bar").append(
    node("span", { attrs: { class: "time-info" }, text: "1:59 / 4:11" })
  );
  env.setClock("1:38 / 4:11");
  media.currentTime = 98;
  env.page.dispatchOnDoc("seeked", { target: media });
  assert.equal(env.states().at(-1).duration, null, "a sourceless clock conflict is not fresh evidence");
});

test("a rate change with a new duration releases and keeps the real total", () => {
  const env = bootPage({ clock: { now: () => BASE, advance() {} } });
  env.handoff();

  env.setClock("0:48 / 2:09");
  const media = env.media();
  media.duration = 129;
  media.currentTime = 48;
  media.paused = false;
  media.playbackRate = 1.5;
  env.advance();
  const fresh = env.states().at(-1);
  assert.equal(fresh.duration, 129, `rate does not stretch the total: ${detail(fresh)}`);
  assert.equal(fresh.playbackRate, 1.5, detail(fresh));
});
