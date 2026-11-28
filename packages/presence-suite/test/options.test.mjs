import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  CLOCK_DETAILED,
  CLOCK_MINIMAL,
  DEFAULT_CLIENT_IDS,
  ENABLED_KEY,
  SETTINGS_KEY,
  SOURCE_CRUNCHY,
  SOURCE_YOUTUBE_MUSIC,
  STATUS_KEY,
  clientIdKey,
} from "../config.js";
import { createChrome, fireEvent, mountSurface } from "./helpers/fake-ui.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url));
const OVERRIDE = "123456789012345678";

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

// Mutation: restore options.js load() to get([ENABLED_KEY, STATUS_KEY]) followed by
// one get([clientIdKey(source)]) per source in the loop -> 3 reads instead of 1.
test("options load fetches enabled, display settings, status and every client ID in a single storage read", async () => {
  const chrome = createChrome({
    local: {
      [ENABLED_KEY]: { [SOURCE_CRUNCHY]: true, [SOURCE_YOUTUBE_MUSIC]: true },
      [STATUS_KEY]: { bridgeState: "connected" },
      [clientIdKey(SOURCE_CRUNCHY)]: OVERRIDE,
    },
  });
  const reads = spyReads(chrome);
  const ui = await mountSurface({ surface: "options", extensionDir: dir, chrome });
  try {
    assert.equal(reads.length, 1, JSON.stringify(reads));
    assert.deepEqual(reads[0], [
      ENABLED_KEY,
      SETTINGS_KEY,
      STATUS_KEY,
      clientIdKey(SOURCE_CRUNCHY),
      clientIdKey(SOURCE_YOUTUBE_MUSIC),
    ]);
    // Both values are resolved from that one result, not from later reads.
    assert.equal(ui.doc.getElementById("enabled-" + SOURCE_CRUNCHY).checked, true);
    assert.equal(ui.doc.getElementById("clientId-" + SOURCE_CRUNCHY).value, OVERRIDE);
    assert.equal(
      ui.doc.getElementById("clientId-" + SOURCE_YOUTUBE_MUSIC).value,
      DEFAULT_CLIENT_IDS[SOURCE_YOUTUBE_MUSIC]
    );
  } finally {
    ui.unmount();
  }
});

// Mutation: restore the unconditional host line (labels[source] from status.hostSources)
// -> the switched-off source shows "Connected" with data-state="connected", not "Off".
test("options shows Off and clears the host state for a switched-off source", async () => {
  const status = {
    bridgeState: "connected",
    hostSources: { [SOURCE_CRUNCHY]: "connected", [SOURCE_YOUTUBE_MUSIC]: "connected" },
  };
  const chrome = createChrome({
    local: {
      [ENABLED_KEY]: { [SOURCE_CRUNCHY]: false, [SOURCE_YOUTUBE_MUSIC]: true },
      [STATUS_KEY]: status,
    },
    status,
  });
  const ui = await mountSurface({ surface: "options", extensionDir: dir, chrome });
  try {
    const offHost = ui.doc.getElementById(SOURCE_CRUNCHY + "-host");
    assert.equal(offHost.textContent, "Off");
    assert.equal(offHost.getAttribute("data-state"), null);

    // Enabled sources keep the existing host copy and state.
    const onHost = ui.doc.getElementById(SOURCE_YOUTUBE_MUSIC + "-host");
    assert.equal(onHost.textContent, "Connected");
    assert.equal(onHost.dataset.state, "connected");
  } finally {
    ui.unmount();
  }
});

test("options paints minimal clock and both buttons on when settings are missing or corrupt", async () => {
  for (const stored of [undefined, "junk"]) {
    const chrome = createChrome(stored === undefined ? {} : { local: { [SETTINGS_KEY]: stored } });
    const ui = await mountSurface({ surface: "options", extensionDir: dir, chrome });
    try {
      assert.equal(ui.doc.getElementById("clock-detailed").checked, false, String(stored));
      assert.equal(ui.doc.getElementById("button-listen").checked, true, String(stored));
      assert.equal(ui.doc.getElementById("button-album").checked, true, String(stored));
    } finally {
      ui.unmount();
    }
  }
});

test("options display switches write one settings record and re-read it", async () => {
  const chrome = createChrome({
    local: { [SETTINGS_KEY]: { clock: CLOCK_DETAILED, listenButton: false, albumButton: true } },
  });
  const ui = await mountSurface({ surface: "options", extensionDir: dir, chrome });
  try {
    const clock = ui.doc.getElementById("clock-detailed");
    const listen = ui.doc.getElementById("button-listen");
    const album = ui.doc.getElementById("button-album");
    assert.equal(clock.checked, true);
    assert.equal(listen.checked, false);
    assert.equal(album.checked, true);

    clock.checked = false;
    fireEvent(clock, "change");
    await ui.settle();
    const writes = () => chrome.writes.filter((write) => write.area === "local" && write.values[SETTINGS_KEY]);
    assert.deepEqual(writes().at(-1).values[SETTINGS_KEY], {
      clock: CLOCK_MINIMAL, listenButton: false, albumButton: true,
    });
    assert.equal(clock.checked, false, "the saved value is re-read, not a stale local state");

    listen.checked = true;
    fireEvent(listen, "change");
    await ui.settle();
    assert.deepEqual(writes().at(-1).values[SETTINGS_KEY], {
      clock: CLOCK_MINIMAL, listenButton: true, albumButton: true,
    });

    album.checked = false;
    fireEvent(album, "change");
    await ui.settle();
    assert.deepEqual(writes().at(-1).values[SETTINGS_KEY], {
      clock: CLOCK_MINIMAL, listenButton: true, albumButton: false,
    });

    await chrome.api.storage.local.set({
      [SETTINGS_KEY]: { clock: CLOCK_DETAILED, listenButton: true, albumButton: true },
    });
    await ui.settle();
    assert.equal(clock.checked, true, "an external write is re-read by the options page");
    assert.equal(listen.checked, true);
    assert.equal(album.checked, true);
  } finally {
    ui.unmount();
  }
});
