import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { ENABLED_KEY, STATUS_KEY, SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC } from "../config.js";
import { createChrome, fireEvent, mountSurface } from "./helpers/fake-ui.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url));

/** Count storage reads on the real fake-chrome API without changing the harness. */
function spyReads(chrome) {
  const reads = [];
  const local = chrome.api.storage.local;
  const realGet = local.get.bind(local);
  local.get = async (keys) => {
    reads.push(keys);
    return realGet(keys);
  };
  return reads;
}

function fixture() {
  const status = {
    bridgeState: "connected",
    availability: "available",
    activities: {
      [SOURCE_CRUNCHY]: { details: "Series", state: "S1 E2" },
      [SOURCE_YOUTUBE_MUSIC]: { details: "Track", state: "Artist" },
    },
    hostSources: { [SOURCE_CRUNCHY]: "connected", [SOURCE_YOUTUBE_MUSIC]: "connected" },
    enabled: { [SOURCE_CRUNCHY]: true, [SOURCE_YOUTUBE_MUSIC]: true },
  };
  const chrome = createChrome({
    local: { enabled: { [SOURCE_CRUNCHY]: true, [SOURCE_YOUTUBE_MUSIC]: true }, [STATUS_KEY]: status },
    status,
  });
  return { chrome, status };
}

test("popup shows both sources and both switches default on", async () => {
  const { chrome } = fixture();
  const ui = await mountSurface({ surface: "popup", extensionDir: dir, chrome });
  try {
    const rows = ui.doc.querySelectorAll(".source");
    assert.equal(rows.length, 2);
    const crunchy = ui.doc.getElementById("enabled-" + SOURCE_CRUNCHY);
    const youtube = ui.doc.getElementById("enabled-" + SOURCE_YOUTUBE_MUSIC);
    assert.equal(crunchy.checked, true);
    assert.equal(youtube.checked, true);
    assert.equal(crunchy.getAttribute("switch"), "");
    assert.match(ui.doc.getElementById(SOURCE_CRUNCHY + "-now").textContent, /Series/);
    assert.match(ui.doc.getElementById(SOURCE_YOUTUBE_MUSIC + "-detail").textContent, /Artist/);
    assert.equal(ui.doc.getElementById("bridge").textContent, "Connected");
  } finally {
    ui.unmount();
  }
});

test("a per-source switch writes only that source flag, keeping the other on", async () => {
  const { chrome } = fixture();
  const ui = await mountSurface({ surface: "popup", extensionDir: dir, chrome });
  try {
    const toggle = ui.doc.getElementById("enabled-" + SOURCE_CRUNCHY);
    toggle.checked = false;
    fireEvent(toggle, "change");
    await ui.settle();
    const writes = chrome.writes.filter((write) => write.area === "local" && write.values.enabled);
    assert.ok(writes.length > 0);
    const map = writes.at(-1).values.enabled;
    assert.equal(map[SOURCE_CRUNCHY], false);
    assert.equal(map[SOURCE_YOUTUBE_MUSIC], true);
  } finally {
    ui.unmount();
  }
});

test("popup asks the worker with the new message name", async () => {
  const { chrome } = fixture();
  const ui = await mountSurface({ surface: "popup", extensionDir: dir, chrome });
  try {
    assert.ok(chrome.requests.some((message) => message.t === "presence-get-status"));
    assert.ok(!chrome.requests.some((message) => message.t === "ytmp-get-status"));
  } finally {
    ui.unmount();
  }
});

// Mutation: restore readStatus()'s own get([STATUS_KEY]) when the worker is silent
// -> reads.length is 2, and the single-read budget below goes red. Passing only
// [ENABLED_KEY] from render() also fails the stored-fallback assertions.
test("popup paints from one storage read and one message, falling back to stored status", async () => {
  const status = {
    bridgeState: "connected",
    activities: { [SOURCE_CRUNCHY]: { details: "Series", state: "S1 E2" } },
  };
  const chrome = createChrome({
    local: {
      [ENABLED_KEY]: { [SOURCE_CRUNCHY]: true, [SOURCE_YOUTUBE_MUSIC]: true },
      [STATUS_KEY]: status,
    },
    status: null, // worker is silent: the status read with enabled must carry the paint
  });
  const reads = spyReads(chrome);
  const ui = await mountSurface({ surface: "popup", extensionDir: dir, chrome });
  try {
    assert.equal(reads.length, 1, JSON.stringify(reads));
    assert.deepEqual(reads[0], [ENABLED_KEY, STATUS_KEY]);
    assert.equal(chrome.requests.length, 1);
    assert.equal(chrome.requests[0].t, "presence-get-status");
    assert.equal(ui.doc.getElementById("bridge").textContent, "Connected");
    assert.match(ui.doc.getElementById(SOURCE_CRUNCHY + "-now").textContent, /Series/);
  } finally {
    ui.unmount();
  }
});

// Mutation: let the stored status win over the worker answer -> bridge shows
// "Connected" instead of "Error" and this test goes red.
test("popup keeps the worker answer authoritative over the stored fallback", async () => {
  const chrome = createChrome({
    local: { [STATUS_KEY]: { bridgeState: "connected" } },
    status: { bridgeState: "error", reason: "Live failure" },
  });
  const ui = await mountSurface({ surface: "popup", extensionDir: dir, chrome });
  try {
    assert.equal(ui.doc.getElementById("bridge").textContent, "Error");
    assert.match(ui.doc.getElementById("reason").textContent, /Live failure/);
  } finally {
    ui.unmount();
  }
});
