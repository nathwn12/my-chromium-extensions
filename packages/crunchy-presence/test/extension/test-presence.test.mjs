/**
 * The options page "Test presence" button, driven through the real worker.
 *
 * The test card must obey the same options as ordinary presence (the synopsis
 * is opt-in) and it must not record an undelivered payload as sent: a deferred
 * limiter push has not reached Discord, so the next identical recompute still
 * has to send.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..");
const workerPath = pathToFileURL(join(extensionDir, "background.js")).href;
const workerSource = readFileSync(join(extensionDir, "background.js"), "utf8");

const TAB_URL = "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning";
const SYNOPSIS = "Frieren and Fern continue their journey toward the northern lands.";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function makeChrome(stored = {}) {
  const posts = [];
  const storage = { enabled: true, ...stored };
  let onMessage = null;
  let port = null;

  const makePort = () => {
    const listeners = { message: null, disconnect: null };
    return {
      listeners,
      onMessage: {
        addListener(fn) {
          listeners.message = fn;
        },
        removeListener() {}
      },
      onDisconnect: {
        addListener(fn) {
          listeners.disconnect = fn;
        },
        removeListener() {}
      },
      postMessage(message) {
        posts.push(message);
      },
      disconnect() {}
    };
  };

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: null,
      connectNative() {
        port = makePort();
        return port;
      },
      onMessage: {
        addListener(fn) {
          onMessage = fn;
        }
      },
      onInstalled: { addListener() {} },
      openOptionsPage() {}
    },
    storage: {
      local: {
        async get() {
          return { ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove() {}
      },
      session: { async set() {} },
      onChanged: { addListener() {} }
    },
    alarms: {
      create() {},
      get(_name, callback) {
        if (typeof callback === "function") callback(undefined);
        return undefined;
      },
      onAlarm: {
        addListener(fn) {
          void fn;
        }
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} }
    }
  };

  /** One content-script report; the caller decides pause state and tab id. */
  const report = (fields, tabId = 1) => {
    onMessage(
      {
        kind: "crp-state",
        series: "Frieren",
        episodeTitle: "The Beginning",
        seasonNumber: 1,
        episodeNumber: 5,
        duration: 1440,
        paused: true,
        hasVideo: true,
        visible: true,
        ...fields
      },
      { id: "test-extension-id", url: TAB_URL, frameId: 0, tab: { id: tabId, url: TAB_URL } }
    );
  };

  const testPresence = () => {
    let response = null;
    onMessage({ kind: "crp-test-presence" }, {}, (value) => {
      response = value;
    });
    return response;
  };

  return {
    chrome,
    posts,
    storage,
    report,
    testPresence,
    get port() {
      return port;
    },
    /** Only the payloads the host would receive. */
    activityPosts() {
      return posts.filter((message) => message.t === "activity");
    }
  };
}

let booted = 0;

/** Import a fresh worker instance over a fresh chrome stub, connected. */
async function boot(stored = {}) {
  const harness = makeChrome(stored);
  globalThis.chrome = harness.chrome;
  booted += 1;
  await import(`${workerPath}?boot=${booted}`);
  await settle();
  harness.port.listeners.message({ t: "status", state: "connected", appName: "Discord" });
  await settle();
  return harness;
}

test("the test presence passes the synopsis option to buildActivity", async () => {
  const harness = await boot({ synopsis: true });
  harness.report({ synopsis: SYNOPSIS, position: 754 });
  await settle();

  const response = harness.testPresence();
  assert.ok(response && response.activity, "the worker answers with the card it built");
  assert.equal(response.activity.state, SYNOPSIS, "the opted-in synopsis is the state line");
  assert.equal(response.activity.details, "Frieren · S1 E5");
  assert.equal(response.activity.timestamps, undefined, "a paused card carries no timer");
});

test("the test presence keeps the timer line while the synopsis option is off", async () => {
  const harness = await boot();
  harness.report({ synopsis: SYNOPSIS, position: 754 });
  await settle();

  const response = harness.testPresence();
  assert.equal(response.activity.state, "S1 E5 · 12:34 / 24:00", "off is the default");
});

test("a deferred test presence never reaches the host", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await boot({ synopsis: true });
    for (const position of [700, 710, 720, 730]) {
      harness.report({ position, paused: false });
      await settle();
    }
    assert.equal(harness.activityPosts().length, 4, "the 4-per-20 s window is full");

    harness.report({ position: 740, paused: false });
    await settle();
    const beforeTest = harness.activityPosts().length;
    assert.equal(beforeTest, 4, "a fifth ordinary report is deferred, not sent");

    const response = harness.testPresence();
    assert.equal(response.queued, true, "the options page is told the push is queued");
    assert.equal(
      harness.activityPosts().length,
      beforeTest,
      "a deferred test presence has not reached the host"
    );
  } finally {
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

test("a deferred limiter push does not record the activity as sent", () => {
  assert.match(
    workerSource,
    /if \(!limiter\.hasPending\) lastSentJson = JSON\.stringify\(activity\);/,
    "lastSentJson moves only after the push actually landed"
  );
});

test("pause clears presence and resume republishes the live card", async () => {
  const harness = await boot();
  harness.report({ paused: false, position: 754 });
  await settle();

  const playing = harness.activityPosts().at(-1);
  assert.equal(playing.activity.type, 3, "active playback publishes a watching card");
  assert.ok(playing.activity.timestamps, "the playing card carries a timer");

  harness.report({ paused: true, position: 760 });
  await settle();
  assert.equal(
    harness.activityPosts().at(-1).activity,
    null,
    "pausing clears this extension's own presence"
  );

  harness.report({ paused: false, position: 770 });
  await settle();
  const resumed = harness.activityPosts().at(-1);
  assert.equal(resumed.activity.type, 3, "resuming republishes a watching card");
  assert.ok(resumed.activity.timestamps, "the resumed card carries a timer");
});

test("a deferred playing payload never flushes after a pause clear", async () => {
  // Date is mocked as well as the timer so the rolling window ages out when
  // the clock steps; otherwise the deferred payload would just reschedule.
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const harness = await boot();
    for (const position of [700, 710, 720, 730]) {
      harness.report({ position, paused: false });
      await settle();
    }
    assert.equal(harness.activityPosts().length, 4, "the window is full");

    harness.report({ position: 740, paused: false });
    await settle();
    assert.equal(harness.activityPosts().length, 4, "the fifth playing report is deferred");

    harness.report({ position: 750, paused: true });
    await settle();
    const afterPause = harness.activityPosts();
    assert.equal(afterPause.length, 5, "the pause posts one immediate clear");
    assert.equal(afterPause.at(-1).activity, null, "the clear is the last post");

    mock.timers.tick(20001);
    await settle();
    assert.equal(
      harness.activityPosts().length,
      5,
      "the deferred playing payload never follows the clear"
    );

    harness.report({ position: 760, paused: false });
    await settle();
    const resumed = harness.activityPosts();
    assert.equal(resumed.at(-1).activity.type, 3, "a fresh resume publishes again");
    assert.ok(resumed.at(-1).activity.timestamps, "the resumed card is live");
  } finally {
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

test("a playing tab wins over a paused tab and stays published", async () => {
  const harness = await boot();
  harness.report({ series: "Paused Show", paused: true, visible: true }, 1);
  await settle();
  assert.equal(harness.activityPosts().at(-1).activity, null, "a paused tab alone clears");

  harness.report(
    { series: "Playing Show", paused: false, position: 30, duration: 1440, visible: false },
    2
  );
  await settle();
  const published = harness.activityPosts().at(-1).activity;
  assert.equal(published.details, "Playing Show", "the playing candidate wins over the paused one");
  assert.ok(published.timestamps, "the winning card is the live one");
});
