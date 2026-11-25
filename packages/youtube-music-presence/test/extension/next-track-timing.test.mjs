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
const BASE = 1_700_000_000_000;
const SRC = "https://media.example/a";

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

/**
 * One content realm on the shared clock. A=366 s at 0:47 with a coherent media
 * element whose source stays the same across the next track — the shape the
 * 1.1.16 owned-reset gate mishandles when B's real total becomes readable
 * mid-song instead of at 0:00.
 */
function bootPage(clock) {
  const media = audio({ duration: 366, currentTime: 47, paused: false, currentSrc: SRC });
  const page = musicPage({
    href: PAGE_A,
    title: "Song A",
    byline: [node("a", { attrs: { href: "channel/UCa" }, text: "Artist A" })],
    children: [media],
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
    media,
    states: () => handle.messages.filter((m) => m.t === "ytmp-state").map((m) => m.state),
    advance(ms = 1000) { clock.advance(ms); handle.poll(); },
    setB() {
      page.doc.querySelector("ytmusic-player-bar .title").textContent = "Song B";
      page.navigator.mediaSession = { metadata: { title: "Song B" }, playbackState: "playing" };
      page.setHref(PAGE_B);
    },
    setRealTiming(position, total) {
      const bar = page.doc.querySelector("ytmusic-player-bar");
      const old = bar.querySelector(".time");
      const text = `${Math.floor(position / 60)}:${String(position % 60).padStart(2, "0")} / ` +
        `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
      if (old) old.textContent = text;
      else bar.append(node("span", { attrs: { class: "time" }, text }));
      media.duration = total;
      media.currentTime = position;
      media.paused = false;
    },
    event(type) { page.dispatchOnDoc(type, { target: media }); },
  };
}

function sendState(chrome, state, now) {
  chrome.runtime.onMessage.fire(
    { t: "ytmp-state", source: "youtube-music", state },
    { id: "ext-test-id", tab: { id: 1, url: PAGE_B }, frameId: 0 },
    () => {}
  );
  void now;
}

function frames(port) {
  return port.sent.filter((m) => m.t === "activity" && m.activity);
}

function detail(state) {
  return `title=${state.title} elapsed=${state.position} total=${state.duration} paused=${state.paused}`;
}

/**
 * Natural auto-advance: the player swaps the title/URL while the outgoing 366 s
 * timing is still readable, then B's genuine 4:11 (251 s) first becomes
 * coherent at 0:25 with the same media source. The card must end with the real
 * incoming total and playhead, never A's 366 and never no timer at all.
 */
test("natural auto-advance publishes real incoming total when timing arrives mid-song", async () => {
  const { chrome, clock, port, worker } = bootWorker();
  await worker.start();
  const env = bootPage(clock);
  const a = env.states()[0];
  assert.equal(a.duration, 366, detail(a));
  sendState(chrome, { ...a, at: clock.now() });
  assert.equal(frames(port)[0].activity.timestamps.end - frames(port)[0].activity.timestamps.start, 366);

  env.setB();
  env.advance(); // stale 366 still readable under B's identity: hold arms
  assert.equal(env.states().at(-1).duration, null, detail(env.states().at(-1)));

  env.setRealTiming(25, 251); // coherent 4:11 clock + element, same source
  env.advance();
  const b = env.states().at(-1);
  assert.equal(b.title, "Song B", detail(b));
  assert.equal(b.duration, 251, `the real incoming total must publish: ${detail(b)}`);
  assert.equal(b.position, 25, `the real playhead must publish: ${detail(b)}`);

  clock.advance(1600);
  sendState(chrome, { ...b, at: clock.now() });
  const stamped = frames(port).at(-1).activity.timestamps;
  assert.equal(stamped.end - stamped.start, 251, "the card carries B's real total, not A's 366");
  assert.equal(stamped.start, Math.floor(clock.now() / 1000) - 25, "elapsed follows the real playhead");
});

/**
 * Explicit Next: a media event reports the switch before the player bar updates,
 * so the first read is the stale 366 pair; B's real 4:11 becomes coherent at
 * 0:30 under the same source. Same downstream assertion as the natural path.
 */
test("explicit Next publishes real incoming total when timing arrives mid-song", async () => {
  const { chrome, clock, port, worker } = bootWorker();
  await worker.start();
  const env = bootPage(clock);
  const a = env.states()[0];
  assert.equal(a.duration, 366, detail(a));
  sendState(chrome, { ...a, at: clock.now() });

  env.setB();
  env.event("play"); // explicit Next: event reports on the stale pair
  assert.equal(env.states().at(-1).duration, null, detail(env.states().at(-1)));

  env.setRealTiming(30, 251);
  env.event("durationchange");
  const b = env.states().at(-1);
  assert.equal(b.title, "Song B", detail(b));
  assert.equal(b.duration, 251, `the real incoming total must publish: ${detail(b)}`);
  assert.equal(b.position, 30, `the real playhead must publish: ${detail(b)}`);

  clock.advance(1600);
  sendState(chrome, { ...b, at: clock.now() });
  const stamped = frames(port).at(-1).activity.timestamps;
  assert.equal(stamped.end - stamped.start, 251, "the card carries B's real total on explicit Next");
  assert.equal(stamped.start, Math.floor(clock.now() / 1000) - 30, "elapsed follows the real playhead");
});

/**
 * Negative control: the outgoing element carries the new clock's total but an
 * old playhead, while the incoming element is not ready. Duration agreement
 * alone is not ownership, so this read must not unlock a hold armed at A's
 * 366 s. A bare `currentSrc` from that outgoing element is not evidence either.
 */
test("an outgoing element matching the new clock's total cannot unlock the hold", () => {
  const outgoing = audio({ duration: 366, currentTime: 47, paused: false, currentSrc: SRC });
  const incoming = audio({ duration: 0, currentTime: 0, paused: false, currentSrc: "https://media.example/new" });
  const page = musicPage({
    href: PAGE_A,
    title: "Song A",
    byline: [node("a", { attrs: { href: "channel/UCa" }, text: "Artist A" })],
    time: "0:47 / 6:06",
    children: [outgoing, incoming],
  });
  let now = BASE;
  const clock = () => now;
  page.win.__ytmpNow = clock;
  const handle = loadContent({
    extractSource,
    contentSource: `Date.now = window.__ytmpNow;\n${contentSource}`,
    page,
  });
  const states = () => handle.messages.filter((m) => m.t === "ytmp-state").map((m) => m.state);
  const poll = () => { now += 1000; handle.poll(); };

  assert.equal(states()[0].duration, 366, detail(states()[0]));

  // B arrives while the old pair is still readable: the hold arms at 366 s.
  page.doc.querySelector("ytmusic-player-bar .title").textContent = "Song B";
  page.navigator.mediaSession = { metadata: { title: "Song B" }, playbackState: "playing" };
  page.setHref(PAGE_B);
  poll();
  assert.equal(states().at(-1).duration, null, detail(states().at(-1)));

  // New clock 2:09, outgoing media 129 @ 1:40, incoming media 0 @ 0.
  page.doc.querySelector(".time").textContent = "0:00 / 2:09";
  outgoing.duration = 129;
  outgoing.currentTime = 100;
  poll();
  const locked = states().at(-1);
  assert.equal(locked.title, "Song B", detail(locked));
  assert.equal(locked.duration, null, `an outgoing element is not ownership: ${detail(locked)}`);
  assert.equal(locked.position, null, detail(locked));
});
