import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadContent, makePage, musicPage, video, youtubePage } from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extractSource = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");

const WATCH = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const NEXT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function boot(page, options = {}) {
  return loadContent({ extractSource, contentSource, page, ...options });
}

function states(handle) {
  return handle.messages.filter((message) => message.t === "wdr-state");
}

function gones(handle) {
  return handle.messages.filter((message) => message.t === "wdr-gone");
}

function watchPage(title = "First Video", props = {}) {
  const page = youtubePage({ title, children: [video({ duration: 200, ...props })] });
  page.setHref(WATCH);
  return page;
}

test("a watch page reports one wdr-state with source, state and at", () => {
  const handle = boot(watchPage());
  assert.equal(handle.messages.length, 1);

  const message = handle.messages[0];
  assert.equal(message.t, "wdr-state");
  assert.equal(message.source, "youtube");
  assert.equal(message.state.title, "First Video");
  assert.equal(message.state.channel, "Rick Astley");
  assert.equal(message.state.mediaId, "aqz-KE-bpKQ");
  assert.equal(typeof message.state.at, "number");
  assert.equal(Number.isFinite(message.state.at), true);
});

test("YouTube Music reports its own source", () => {
  const page = musicPage({
    title: "Song",
    byline: ["Artist • Album"],
    artwork: "https://lh3.googleusercontent.com/cover"
  });
  const handle = boot(page);
  assert.equal(handle.messages.length, 1);
  assert.equal(handle.messages[0].source, "youtube-music");
  assert.equal(handle.messages[0].state.title, "Song");
});

test("a non-watch page reports nothing", () => {
  const page = makePage({ href: "https://www.youtube.com/", title: "YouTube" });
  const handle = boot(page);
  assert.deepEqual(handle.messages, []);
  handle.poll();
  assert.deepEqual(handle.messages, []);
});

test("media events report; timeupdate is never listened to", () => {
  const page = watchPage();
  const handle = boot(page);
  const target = page.doc.querySelector("video");

  page.dispatchOnDoc("timeupdate", { target });
  assert.equal(handle.messages.length, 1);

  page.dispatchOnDoc("play", { target });
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].t, "wdr-state");
});

test("the 1 s poll reports a title or pause change once, then stays quiet", () => {
  const page = watchPage();
  const handle = boot(page);
  assert.deepEqual(handle.intervalDelays(), [1000]);
  assert.equal(handle.messages.length, 1);

  handle.poll();
  assert.equal(handle.messages.length, 1);

  page.doc.querySelector("h1 yt-formatted-string").textContent = "Second Video";
  handle.poll();
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].state.title, "Second Video");

  handle.poll();
  assert.equal(handle.messages.length, 2);

  page.doc.querySelector("video").paused = false;
  handle.poll();
  assert.equal(handle.messages.length, 3);
  assert.equal(handle.messages[2].state.paused, false);
});

test("same-URL SPA updates report immediately", () => {
  const page = watchPage();
  const handle = boot(page);
  page.doc.querySelector("h1 yt-formatted-string").textContent = "Re-rendered";

  page.dispatchOnDoc("yt-page-data-updated");
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].state.title, "Re-rendered");
});

test("a watch-to-watch SPA navigation reports once the page settles", () => {
  const page = watchPage();
  const handle = boot(page);

  page.setHref(NEXT);
  page.dispatchOnDoc("yt-navigate-finish");
  page.doc.querySelector("h1 yt-formatted-string").textContent = "Next Video";

  assert.equal(handle.messages.length, 1);
  assert.equal(handle.pendingTimeouts(), 1);

  handle.flush();
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].t, "wdr-state");
  assert.equal(handle.messages[1].state.title, "Next Video");
  assert.equal(handle.messages[1].state.mediaId, "dQw4w9WgXcQ");
});

test("navigating to a non-watch page sends one wdr-gone with scope tab", () => {
  const page = watchPage();
  const handle = boot(page);

  page.setHref("https://www.youtube.com/");
  page.dispatchOnDoc("yt-navigate-finish");
  assert.deepEqual(gones(handle), [{ t: "wdr-gone", source: "youtube", scope: "tab" }]);

  handle.poll();
  assert.equal(gones(handle).length, 1);
  assert.equal(states(handle).length, 1);
});

test("pagehide sends wdr-gone with scope tab", () => {
  const page = watchPage();
  const handle = boot(page);

  page.dispatchOnWindow("pagehide");
  assert.deepEqual(gones(handle), [{ t: "wdr-gone", source: "youtube", scope: "tab" }]);
});

test("visibilitychange republishes the state with the new visible flag", () => {
  const page = watchPage();
  const handle = boot(page);

  page.setVisibility("hidden");
  page.dispatchOnDoc("visibilitychange");
  assert.equal(handle.messages.length, 2);
  assert.equal(handle.messages[1].state.visible, false);
});

test("a throwing chrome.runtime.sendMessage never escapes the script", () => {
  const page = watchPage();
  let handle;
  assert.doesNotThrow(() => {
    handle = boot(page, {
      sendMessage() {
        throw new Error("no receiver");
      }
    });
  });
  assert.doesNotThrow(() => {
    page.dispatchOnDoc("play", { target: page.doc.querySelector("video") });
    handle.poll();
    page.dispatchOnWindow("pagehide");
  });
});

test("content without the extractor does nothing and schedules no poll", () => {
  const page = watchPage();
  let handle;
  assert.doesNotThrow(() => {
    handle = loadContent({ extractSource: "", contentSource, page });
  });
  assert.deepEqual(handle.messages, []);
  assert.deepEqual(handle.intervalDelays(), []);
});

test("a subframe no-ops: only the top frame may report", () => {
  const page = watchPage();
  let handle;
  assert.doesNotThrow(() => {
    handle = boot(page, { top: {} });
  });
  assert.deepEqual(handle.messages, []);
  assert.deepEqual(handle.intervalDelays(), []);

  assert.doesNotThrow(() => {
    page.dispatchOnDoc("play", { target: page.doc.querySelector("video") });
    page.dispatchOnDoc("yt-navigate-finish");
    page.dispatchOnWindow("pagehide");
  });
  assert.deepEqual(handle.messages, []);
});
