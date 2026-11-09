import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = pathToFileURL(join(here, "..", "..", "background.js")).href;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const TAB_URL = "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning";

function makeChrome() {
  const posts = [];
  const storage = { enabled: true };
  let onMessage = null;
  let onChanged = null;
  let port = null;

  const makePort = () => ({
    messageListener: null,
    disconnectListener: null,
    disconnected: false,
    onMessage: {
      addListener(fn) {
        this.owner.messageListener = fn;
      },
      removeListener() {},
    },
    onDisconnect: {
      addListener(fn) {
        this.owner.disconnectListener = fn;
      },
      removeListener() {},
    },
    postMessage(message) {
      posts.push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
  });

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: null,
      connectNative() {
        port = makePort();
        port.onMessage.owner = port;
        port.onDisconnect.owner = port;
        return port;
      },
      onMessage: {
        addListener(fn) {
          onMessage = fn;
        },
      },
      onInstalled: { addListener() {} },
      openOptionsPage() {},
    },
    storage: {
      local: {
        async get() {
          return { ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove() {},
      },
      session: {
        async set() {},
      },
      onChanged: {
        addListener(fn) {
          onChanged = fn;
        },
      },
    },
    alarms: {
      create() {},
      get(_name, cb) {
        if (typeof cb === "function") cb(undefined);
        return undefined;
      },
      onAlarm: { addListener() {} },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
  };

  const query = () => {
    let status = null;
    onMessage({ kind: "crp-get-status" }, {}, (response) => {
      status = response;
    });
    return status;
  };

  return {
    chrome,
    posts,
    storage,
    query,
    get port() {
      return port;
    },
    get onChanged() {
      return onChanged;
    },
    get onMessage() {
      return onMessage;
    },
  };
}

test("worker boots into Waiting without Discord, connects later, and clears on quit", async () => {
  const harness = makeChrome();
  globalThis.chrome = harness.chrome;

  await import(`${workerPath}?boot=1`);
  await tick(20);

  assert.equal(harness.posts[0].t, "hello", "the worker opens the native port");
  assert.equal(harness.posts[0].clientId, "1566530911514923188");

  // Host reports the expected absence: neutral waiting, raw detail retained.
  harness.port.messageListener({
    t: "status",
    state: "waiting",
    reason: "discord-closed",
    detail: "no discord ipc pipe found",
  });
  let status = harness.query();
  assert.equal(status.bridgeState, "waiting");
  assert.equal(status.availability, "unavailable");
  assert.equal(status.reasonKind, "discord-closed");
  assert.match(status.reason, /Discord is not running/);
  assert.doesNotMatch(status.reason, /pipe/i);
  assert.equal(status.lastError, "no discord ipc pipe found", "raw detail is diagnostics only");

  // A playing tab is recorded while the bridge waits; nothing is posted yet.
  harness.onMessage(
    {
      kind: "crp-state",
      series: "Frieren",
      episodeTitle: "The Beginning",
      seasonNumber: 1,
      episodeNumber: 5,
      duration: 1440,
      position: 10,
      paused: false,
      hasVideo: true,
      visible: true,
    },
    {
      id: "test-extension-id",
      url: TAB_URL,
      frameId: 0,
      tab: { id: 1, url: TAB_URL },
    }
  );
  await tick(10);
  assert.equal(
    harness.posts.filter((message) => message.t === "activity").length,
    0,
    "offline activity is stashed, not sent"
  );

  // Discord appears: connected plus the latest activity republished, no user action.
  harness.port.messageListener({ t: "status", state: "connected", appName: "Discord" });
  await tick(10);
  status = harness.query();
  assert.equal(status.bridgeState, "connected");
  assert.equal(status.availability, "available");
  assert.equal(status.reason, null);
  const republished = harness.posts.filter((message) => message.t === "activity");
  assert.ok(republished.length >= 1, "the stashed payload is republished");
  assert.equal(republished.at(-1).activity.details, "Frieren");

  // Discord quits: waiting again, never a stale Connected.
  harness.port.messageListener({
    t: "status",
    state: "waiting",
    reason: "discord-closed",
    detail: "discord ipc connection closed",
  });
  status = harness.query();
  assert.equal(status.bridgeState, "waiting");
  assert.notEqual(status.bridgeState, "connected");
  assert.match(status.reason, /Discord is not running/);

  // Turning presence off while unavailable still sends the authoritative clear.
  const before = harness.posts.length;
  assert.ok(harness.onChanged, "worker subscribes to storage changes");
  harness.onChanged({ enabled: { newValue: false } }, "local");
  await tick(10);
  const after = harness.posts.slice(before);
  assert.ok(
    after.some((message) => message.t === "activity" && message.activity === null),
    "toggle-off posts a null clear even while waiting"
  );
  assert.equal(harness.query().enabled, false);
});
