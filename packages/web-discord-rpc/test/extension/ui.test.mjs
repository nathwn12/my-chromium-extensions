import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createChrome,
  createDocument,
  fireEvent,
  mountSurface,
  readSurface,
} from "../ui/helpers/fake-ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..");
const SURFACES = ["popup", "options"];

const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));

/** What the worker returns for one connected frame: both sources, one playing. */
const CONNECTED = {
  bridgeState: "connected",
  availability: "available",
  reason: null,
  reasonKind: null,
  detail: null,
  transportPreference: "auto",
  transport: "discord-ipc",
  hostSources: { youtube: "connected", "youtube-music": "waiting" },
  activities: {
    youtube: {
      name: "YouTube",
      type: 3,
      details: "Never Gonna Give You Up",
      state: "Rick Astley",
      assets: { large_image: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg" },
    },
    "youtube-music": null,
  },
  updatedAt: 1,
};

const WAITING = {
  ...CONNECTED,
  bridgeState: "waiting",
  availability: "unavailable",
  reason: "Discord is not running — presence paused, resumes automatically.",
  reasonKind: "arrpc-closed",
  detail: "connect ECONNREFUSED 127.0.0.1:6463",
  activities: { youtube: null, "youtube-music": null },
};

const REJECTED = {
  ...CONNECTED,
  bridgeState: "error",
  availability: "unavailable",
  reason: "Discord rejected this application ID. Check the application ID in Settings.",
  reasonKind: "rejected",
  selectedTransport: null,
  transport: null,
  detail: "handshake rejected: invalid client_id 123",
  activities: { youtube: null, "youtube-music": null },
};

/* ------------------------------------------------------------- static ---- */

test("the manifest points at popup and options, and both ship as local files", () => {
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.options_ui.page, "options.html");
  for (const surface of SURFACES) {
    for (const extension of ["html", "css", "js"]) {
      assert.ok(
        existsSync(join(extensionDir, `${surface}.${extension}`)),
        `${surface}.${extension} ships beside the manifest`
      );
    }
  }
});

test("each surface loads only its own local code: no remote URL, no inline script", () => {
  for (const surface of SURFACES) {
    for (const extension of ["html", "css", "js"]) {
      const text = readSurface(extensionDir, surface, extension);
      assert.ok(!/https?:\/\//i.test(text), `${surface}.${extension} references no remote URL`);
      assert.ok(!/@import/i.test(text), `${surface}.${extension} imports no stylesheet`);
    }

    const doc = createDocument(readSurface(extensionDir, surface, "html"));
    const scripts = doc.querySelectorAll("script");
    assert.equal(scripts.length, 1, `${surface}.html has exactly one script`);
    assert.equal(scripts[0].getAttribute("type"), "module");
    assert.equal(scripts[0].getAttribute("src"), `${surface}.js`);
    assert.equal(scripts[0].textContent.trim(), "", "the script element carries no inline body");

    const styles = doc.querySelectorAll("link[rel=stylesheet]");
    assert.equal(styles.length, 1, `${surface}.html has exactly one stylesheet`);
    assert.equal(styles[0].getAttribute("href"), `${surface}.css`);

    for (const node of doc.querySelectorAll("*")) {
      for (const [name, value] of Object.entries(node.attrs)) {
        assert.ok(!/^on[a-z]+$/i.test(name), `${surface}.html puts no inline handler on <${node.tagName}>`);
        if (name === "src" || name === "href") {
          assert.ok(!/^(https?:)?\/\//i.test(value), `${surface}.html does not load ${value}`);
        }
      }
    }
  }
});

test("every control has an accessible name and every label resolves", () => {
  for (const surface of SURFACES) {
    const doc = createDocument(readSurface(extensionDir, surface, "html"));
    const labels = doc.querySelectorAll("label[for]");
    assert.ok(labels.length >= 1, `${surface} labels its controls`);

    for (const label of labels) {
      const id = label.getAttribute("for");
      const control = doc.getElementById(id);
      assert.ok(control, `${surface}: label for="${id}" resolves to an element`);
      assert.ok(
        ["INPUT", "SELECT", "TEXTAREA"].includes(control.tagName),
        `${surface}: label for="${id}" points at a control`
      );
      assert.ok(!control.getAttribute("aria-label") || label.textContent.trim(), "label text is real");
      const describedBy = control.getAttribute("aria-describedby");
      if (describedBy) {
        for (const target of describedBy.split(/\s+/).filter(Boolean)) {
          assert.ok(doc.getElementById(target), `${surface}: aria-describedby="${target}" resolves`);
        }
      }
    }

    const toggle = doc.getElementById("enabled");
    assert.ok(toggle, `${surface} has the presence toggle`);
    assert.equal(toggle.getAttribute("role"), "switch");
    assert.equal(toggle.getAttribute("tabindex"), null, "the toggle keeps native tab order");
    assert.equal(doc.documentElement.getAttribute("lang"), "en");
    assert.ok(doc.documentElement.querySelectorAll("[aria-live]").length >= 1, `${surface} has a live region`);
  }
});

test("every id the controllers ask for exists in the shipped markup", () => {
  for (const surface of SURFACES) {
    const source = readSurface(extensionDir, surface, "js");
    const doc = createDocument(readSurface(extensionDir, surface, "html"));
    const ids = [
      ...source.matchAll(/(?:getElementById|el)\("([^"]+)"\)/g),
    ].map((match) => match[1]);
    assert.ok(ids.length > 0, `${surface}.js looks elements up by id`);
    for (const id of new Set(ids)) {
      assert.ok(doc.getElementById(id), `${surface}.js looks for #${id}`);
    }
  }
});

/* -------------------------------------------------------------- popup ---- */

test("popup renders the bridge and both source activities", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    const bridge = ui.doc.getElementById("bridge");
    assert.equal(bridge.textContent, "Connected");
    assert.equal(bridge.dataset.state, "connected");
    assert.equal(bridge.dataset.tone, "connected");
    assert.equal(bridge.getAttribute("role"), "status");

    assert.equal(ui.doc.querySelectorAll(".source").length, 2, "one row per source");
    assert.equal(ui.doc.getElementById("youtube-activity").textContent, "Never Gonna Give You Up");
    assert.equal(ui.doc.getElementById("youtube-detail").textContent, "Rick Astley");
    assert.equal(ui.doc.getElementById("youtube-music-activity").textContent, "Nothing playing");
    assert.equal(ui.doc.getElementById("youtube-music-detail").textContent, "");
    assert.equal(ui.doc.getElementById("enabled").checked, true);
    assert.equal(chrome.requests[0].t, "wdr-get-status", "status comes from the worker first");
  } finally {
    ui.unmount();
  }
});

test("popup reads the persisted status when the worker cannot answer", async () => {
  const chrome = createChrome({ local: { enabled: true, wdrStatus: CONNECTED }, status: null });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    assert.equal(ui.doc.getElementById("bridge").textContent, "Connected");
    assert.equal(ui.doc.getElementById("youtube-activity").textContent, "Never Gonna Give You Up");
  } finally {
    ui.unmount();
  }
});

test("popup treats Discord's absence as waiting copy, never an error, and keeps the raw detail off the surface", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: WAITING });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    const bridge = ui.doc.getElementById("bridge");
    const reason = ui.doc.getElementById("reason");
    assert.equal(bridge.textContent, "Waiting");
    assert.equal(bridge.dataset.tone, "waiting");
    assert.equal(reason.hidden, false);
    assert.equal(reason.textContent, WAITING.reason);
    assert.equal(reason.getAttribute("role"), "status");
    assert.equal(reason.getAttribute("aria-live"), "polite");
    assert.ok(
      !ui.doc.body.textContent.includes("ECONNREFUSED"),
      "the raw diagnostic never reaches rendered text"
    );
  } finally {
    ui.unmount();
  }
});

test("popup marks a rejected application ID as an assertive error", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: REJECTED });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    const bridge = ui.doc.getElementById("bridge");
    const reason = ui.doc.getElementById("reason");
    assert.equal(bridge.textContent, "Error");
    assert.equal(bridge.dataset.tone, "error");
    assert.equal(reason.hidden, false);
    assert.equal(reason.textContent, REJECTED.reason);
    assert.equal(reason.getAttribute("role"), "alert");
    assert.equal(reason.getAttribute("aria-live"), "assertive");
    assert.ok(!ui.doc.body.textContent.includes("invalid client_id"));
  } finally {
    ui.unmount();
  }
});

test("popup toggle writes the presence preference and renders presence off", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    const input = ui.doc.getElementById("enabled");
    assert.equal(input.disabled, false, "Discord being absent never blocks the toggle");

    input.checked = false;
    fireEvent(input, "change");
    await ui.settle();

    assert.deepEqual(
      chrome.writes.filter((write) => write.area === "local" && write.method === "set").map((write) => write.values),
      [{ enabled: false }]
    );
    assert.equal(chrome.state.local.enabled, false);
    assert.equal(ui.doc.getElementById("bridge").textContent, "Off");
    assert.equal(ui.doc.getElementById("bridge").dataset.tone, "off");
    assert.equal(ui.doc.getElementById("youtube-activity").textContent, "Presence off");
    assert.equal(ui.doc.getElementById("reason").hidden, true);

    input.checked = true;
    fireEvent(input, "change");
    await ui.settle();
    assert.equal(chrome.state.local.enabled, true);
    assert.equal(ui.doc.getElementById("bridge").textContent, "Connected");
  } finally {
    ui.unmount();
  }
});

test("popup follows worker status changes while it is open", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    // The worker persists a new state, then announces it; the popup re-reads
    // the live status rather than trusting a possibly stale stored object.
    chrome.setStatus(WAITING);
    chrome.emit({ wdrStatus: { newValue: WAITING } }, "local");
    await ui.settle();
    assert.equal(ui.doc.getElementById("bridge").textContent, "Waiting");
    assert.equal(ui.doc.getElementById("reason").textContent, WAITING.reason);
  } finally {
    ui.unmount();
  }
});

test("popup Settings opens the options page instead of leaving the popup", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    const link = ui.doc.getElementById("open-options");
    const event = fireEvent(link, "click");
    assert.equal(event.defaultPrevented, true);
    assert.equal(chrome.optionsOpened, 1);
  } finally {
    ui.unmount();
  }
});

/* ------------------------------------------------------------ options ---- */

test("options renders the bridge, the chosen transport, the application and both activities", async () => {
  const chrome = createChrome({
    local: { enabled: true, clientId: "123456789012345678", transport: "ipc" },
    status: { ...CONNECTED, transport: "arrpc" },
  });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    const bridge = ui.doc.getElementById("bridgeState");
    assert.equal(bridge.textContent, "Connected");
    assert.equal(bridge.dataset.tone, "connected");
    assert.equal(ui.doc.getElementById("transportUsed").textContent, "arRPC");
    assert.equal(ui.doc.getElementById("appName").textContent, "Custom application 123456789012345678");
    assert.equal(ui.doc.getElementById("youtube-activity").textContent, "Never Gonna Give You Up — Rick Astley");
    assert.equal(ui.doc.getElementById("youtube-music-activity").textContent, "Nothing playing");
    assert.equal(ui.doc.getElementById("youtube-host").textContent, "Connected");
    assert.equal(ui.doc.getElementById("youtube-music-host").textContent, "Waiting");
    assert.equal(ui.doc.getElementById("transport").value, "ipc", "the stored preference is selected");
  } finally {
    ui.unmount();
  }
});

test("options saves a valid application ID and clears back to the built-in one", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    const form = ui.doc.getElementById("client-form");
    const input = ui.doc.getElementById("clientId");
    assert.equal(input.value, "1566530911514923188", "the built-in application ID is shown on load");

    input.value = "123456789012345678";
    fireEvent(form, "submit");
    await ui.settle();
    assert.equal(chrome.state.local.clientId, "123456789012345678");
    assert.equal(input.value, "123456789012345678");
    assert.equal(
      ui.doc.getElementById("clientId-saved").textContent,
      "Saved. Reconnecting with your application ID."
    );
    assert.equal(ui.doc.getElementById("appName").textContent, "Custom application 123456789012345678");

    input.value = "";
    fireEvent(form, "submit");
    await ui.settle();
    assert.equal("clientId" in chrome.state.local, false, "an empty field clears the override");
    assert.equal(input.value, "1566530911514923188");
    assert.equal(ui.doc.getElementById("clientId-saved").textContent, "Saved. Using the built-in application.");
    assert.equal(ui.doc.getElementById("appName").textContent, "Built-in application");
  } finally {
    ui.unmount();
  }
});

test("options refuses an application ID that is not 17 to 20 digits and writes nothing", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    const form = ui.doc.getElementById("client-form");
    const input = ui.doc.getElementById("clientId");
    const error = ui.doc.getElementById("clientId-error");
    input.value = "12345";

    fireEvent(form, "submit");
    await ui.settle();

    assert.equal(chrome.writes.length, 0, "an invalid ID never reaches storage");
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /17 to 20 digits/);
    assert.equal(error.getAttribute("role"), "alert");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.focused, true, "focus returns to the field that needs fixing");

    input.value = "12345678901234567";
    fireEvent(input, "input");
    assert.equal(error.hidden, true);
    assert.equal(input.getAttribute("aria-invalid"), null);
  } finally {
    ui.unmount();
  }
});

test("options offers exactly auto, ipc and arrpc, persists a change, and falls back to auto", async () => {
  const chrome = createChrome({ local: { enabled: true, transport: "gateway" }, status: CONNECTED });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    const select = ui.doc.getElementById("transport");
    const values = ui.doc.querySelectorAll("#transport option").map((option) => option.getAttribute("value"));
    assert.deepEqual(values, ["auto", "ipc", "arrpc"]);
    assert.equal(select.value, "auto", "an unrecognised stored value resolves to auto");

    select.value = "arrpc";
    fireEvent(select, "change");
    await ui.settle();
    assert.equal(chrome.state.local.transport, "arrpc");
    assert.equal(ui.doc.getElementById("transport-saved").textContent, "Saved. Reconnecting to Discord.");
  } finally {
    ui.unmount();
  }
});

test("options toggle persists presence", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    const input = ui.doc.getElementById("enabled");
    assert.equal(input.checked, true);
    input.checked = false;
    fireEvent(input, "change");
    await ui.settle();
    assert.equal(chrome.state.local.enabled, false);
    assert.equal(ui.doc.getElementById("presence-saved").textContent, "Saved. Presence off.");
    assert.equal(ui.doc.getElementById("bridgeState").textContent, "Off");
  } finally {
    ui.unmount();
  }
});

test("options shows the install commands and keeps the raw detail in diagnostics only", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: REJECTED });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    assert.equal(
      ui.doc.getElementById("install-command").textContent.trim(),
      "node scripts/install-host.mjs"
    );
    assert.equal(
      ui.doc.getElementById("install-check").textContent.trim(),
      "node scripts/install-host.mjs --check"
    );

    const section = ui.doc.getElementById("status-section");
    assert.ok(section.textContent.includes(REJECTED.reason), "the friendly copy is on the card");
    assert.ok(!section.textContent.includes("invalid client_id"), "the raw detail is not on the card");
    assert.ok(
      ui.doc.getElementById("diagnostics").value.includes("invalid client_id"),
      "the raw detail is available in the diagnostics block"
    );

    const before = chrome.requests.length;
    fireEvent(ui.doc.getElementById("refresh"), "click");
    await ui.settle();
    assert.ok(chrome.requests.length > before, "Refresh asks the worker again");
  } finally {
    ui.unmount();
  }
});
