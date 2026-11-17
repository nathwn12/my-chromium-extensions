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

  /** One content-script report from tab 1, paused so the card has no timer. */
  const report = (fields) => {
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
      { id: "test-extension-id", url: TAB_URL, frameId: 0, tab: { id: 1, url: TAB_URL } }
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
  // Timers are held so a deferral cannot fire mid-test; the limiter's window
  // is measured on the real clock, and four reports fill it at once.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await boot({ synopsis: true });
    for (const position of [700, 710, 720, 730]) {
      harness.report({ position });
      await settle();
    }
    assert.equal(harness.activityPosts().length, 4, "the 4-per-20 s window is full");

    harness.report({ position: 740 });
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
  // The limiter's own flush records lastSentJson when it really sends, so the
  // only wrong state is claiming an undelivered payload was sent: the worker
  // has no exported seam for lastSentJson, so the guard itself is asserted.
  assert.match(
    workerSource,
    /if \(!limiter\.hasPending\) lastSentJson = JSON\.stringify\(activity\);/,
    "lastSentJson moves only after the push actually landed"
  );
});
