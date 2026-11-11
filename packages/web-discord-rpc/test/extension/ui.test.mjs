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

/** What the worker returns for one connected Music frame. */
const CONNECTED = {
  bridgeState: "connected",
  availability: "available",
  reason: null,
  reasonKind: null,
  detail: null,
  transportPreference: "ipc",
  transport: "discord-ipc",
  hostSources: { "youtube-music": "connected" },
  activities: {
    "youtube-music": {
      name: "YouTube Music",
      type: 2,
      details: "A Song",
      state: "An Artist",
      status_display_type: 1,
      assets: { large_image: "https://lh3.googleusercontent.com/cover" },
    },
  },
  updatedAt: 1,
};

const WAITING = {
  ...CONNECTED,
  bridgeState: "waiting",
  availability: "unavailable",
  reason: "Discord is not running — presence paused, resumes automatically.",
  reasonKind: "discord-closed",
  detail: "no Discord IPC pipe answered",
  activities: { "youtube-music": null },
};

const REJECTED = {
  ...CONNECTED,
  bridgeState: "error",
  availability: "unavailable",
  reason: "Discord rejected this application ID. Check the application ID in Settings.",
  reasonKind: "rejected",
  transport: null,
  detail: "handshake rejected: invalid client_id 123",
  activities: { "youtube-music": null },
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

test("popup and options title the extension YouTube Music Presence, never an earlier name", () => {
  for (const surface of SURFACES) {
    const html = readSurface(extensionDir, surface, "html");
    assert.match(html, /<h1>YouTube Music Presence<\/h1>/, `${surface}.html headings the new name`);
    assert.match(html, /<title>YouTube Music Presence/, `${surface}.html titles the new name`);
    assert.ok(!html.includes("Web Discord RPC"), `${surface}.html drops the first name`);
    assert.ok(!html.includes("Discord RPC"), `${surface}.html drops the earlier name`);
    assert.ok(!html.includes("<h1>YouTube Presence</h1>"), `${surface}.html drops the two-source name`);
  }
});

test("both surfaces are Music-only: one row, no YouTube video row, one presence toggle", () => {
  const popup = createDocument(readSurface(extensionDir, "popup", "html"));
  const popupOrder = popup.querySelectorAll(".source-name").map((node) => node.textContent.trim());
  assert.deepEqual(popupOrder, ["YouTube Music"], "popup has exactly the Music row");

  const popupDoc = readSurface(extensionDir, "popup", "html");
  assert.ok(!popupDoc.includes("youtube-activity"), "popup drops the YouTube video row");

  for (const surface of SURFACES) {
    const html = readSurface(extensionDir, surface, "html");
    assert.ok(!html.includes("site-youtube"), `${surface}.html offers no per-site toggle`);
    assert.ok(!html.includes("client-form"), `${surface}.html offers no application-id form`);
    assert.ok(!html.includes('id="transport"'), `${surface}.html offers no transport selector`);
  }

  const options = createDocument(readSurface(extensionDir, "options", "html"));
  assert.ok(options.getElementById("enabled"), "options keeps the one presence toggle");
  assert.ok(options.getElementById("youtube-music-activity"), "options keeps the Music status row");
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

test("popup renders the bridge and the Music activity", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "popup", extensionDir, chrome });
  try {
    const bridge = ui.doc.getElementById("bridge");
    assert.equal(bridge.textContent, "Connected");
    assert.equal(bridge.dataset.state, "connected");
    assert.equal(bridge.dataset.tone, "connected");
    assert.equal(bridge.getAttribute("role"), "status");

    assert.equal(ui.doc.querySelectorAll(".source").length, 1, "one row: Music only");
    assert.equal(ui.doc.getElementById("youtube-music-activity").textContent, "A Song");
    assert.equal(ui.doc.getElementById("youtube-music-detail").textContent, "An Artist");
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
    assert.equal(ui.doc.getElementById("youtube-music-activity").textContent, "A Song");
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
      !ui.doc.body.textContent.includes("no Discord IPC pipe"),
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
    assert.equal(ui.doc.getElementById("youtube-music-activity").textContent, "Presence off");
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

test("options renders the bridge, desktop IPC transport and the Music activity", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    const bridge = ui.doc.getElementById("bridgeState");
    assert.equal(bridge.textContent, "Connected");
    assert.equal(bridge.dataset.tone, "connected");
    assert.equal(ui.doc.getElementById("transportUsed").textContent, "Discord desktop app");
    assert.equal(ui.doc.getElementById("youtube-music-activity").textContent, "A Song — An Artist");
    assert.equal(ui.doc.getElementById("youtube-music-host").textContent, "Connected");
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

test("options offers no alternate configuration: no transport, site or application controls", async () => {
  const chrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const ui = await mountSurface({ surface: "options", extensionDir, chrome });
  try {
    assert.equal(ui.doc.getElementById("transport"), null, "no transport selector");
    assert.equal(ui.doc.getElementById("client-form"), null, "no application-id form");
    assert.equal(ui.doc.getElementById("site-youtube-music"), null, "no per-site toggle");
    assert.equal(ui.doc.getElementById("site-youtube"), null, "no YouTube toggle");
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

test("Music rows show track then artist", async () => {
  const popupChrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const popup = await mountSurface({ surface: "popup", extensionDir, chrome: popupChrome });
  try {
    assert.equal(popup.doc.getElementById("youtube-music-activity").textContent, "A Song");
    assert.equal(popup.doc.getElementById("youtube-music-detail").textContent, "An Artist");
  } finally {
    popup.unmount();
  }

  const optionsChrome = createChrome({ local: { enabled: true }, status: CONNECTED });
  const options = await mountSurface({ surface: "options", extensionDir, chrome: optionsChrome });
  try {
    assert.equal(
      options.doc.getElementById("youtube-music-activity").textContent,
      "A Song — An Artist"
    );
  } finally {
    options.unmount();
  }
});
