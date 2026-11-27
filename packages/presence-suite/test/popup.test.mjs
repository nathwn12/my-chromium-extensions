import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { STATUS_KEY, SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC } from "../config.js";
import { createChrome, fireEvent, mountSurface } from "./helpers/fake-ui.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url));

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
