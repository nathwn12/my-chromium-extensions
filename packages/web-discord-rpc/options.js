/**
 * Options controller.
 *
 * Music-only: the single presence toggle plus the Music status and
 * diagnostics. Plain ES modules, no build: `config.js` validates and
 * `bridge-status.js` labels, exactly as the worker does, so a stored value
 * cannot be interpreted two ways.
 *
 * `status.detail` is a raw native diagnostic: it goes into the read-only
 * diagnostics block, never onto the status card. Transport is always desktop
 * IPC and the application is always the built-in one; no alternate
 * configuration is offered.
 */

import { ENABLED_KEY, SOURCE_YOUTUBE_MUSIC, resolveEnabled } from "./config.js";
import { STATUS_KEY, chosenTransportOf, presentSources, presentStatus } from "./bridge-status.js";

const el = (id) => document.getElementById(id);

const enabledEl = el("enabled");
const presenceSaved = el("presence-saved");
const bridgeEl = el("bridgeState");
const transportUsedEl = el("transportUsed");
const reasonEl = el("reason");
const refreshEl = el("refresh");
const diagnosticsEl = el("diagnostics");

let status = {};

function ask(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function describeActivity(activity) {
  if (!activity || typeof activity !== "object") return "Nothing playing";
  const title = typeof activity.details === "string" ? activity.details : "";
  const rawState = typeof activity.state === "string" ? activity.state : "";
  // Header is static; the row is track then artist. Drop a state repeating the track.
  const state =
    rawState && title && rawState.toLowerCase() !== title.toLowerCase() ? rawState : "";
  const parts = [title, state].filter((part) => typeof part === "string" && part);
  return parts.length ? parts.join(" — ") : "Nothing playing";
}

function render() {
  const enabled = enabledEl.checked;
  const view = presentStatus(status);

  bridgeEl.textContent = enabled ? view.label : "Off";
  bridgeEl.dataset.state = enabled ? view.state : "idle";
  bridgeEl.dataset.tone = !enabled
    ? "off"
    : view.isError
      ? "error"
      : view.state === "connected"
        ? "connected"
        : "waiting";

  const reason = enabled ? view.reason : null;
  reasonEl.hidden = !reason;
  reasonEl.textContent = reason || "";
  reasonEl.setAttribute("role", view.isError ? "alert" : "status");
  reasonEl.setAttribute("aria-live", view.isError ? "assertive" : "polite");

  transportUsedEl.textContent = "Discord desktop app";
  void chosenTransportOf;

  const labels = presentSources(status.hostSources);
  const activities = status.activities || {};
  const hostEl = el(`${SOURCE_YOUTUBE_MUSIC}-host`);
  const hostState = (status.hostSources || {})[SOURCE_YOUTUBE_MUSIC];
  hostEl.textContent = labels[SOURCE_YOUTUBE_MUSIC] || "";
  if (typeof hostState === "string") hostEl.dataset.state = hostState;
  else delete hostEl.dataset.state;

  el(`${SOURCE_YOUTUBE_MUSIC}-activity`).textContent = !enabled
    ? "Presence off"
    : describeActivity(activities[SOURCE_YOUTUBE_MUSIC]);

  diagnosticsEl.value = JSON.stringify(
    {
      status: {
        bridgeState: status.bridgeState ?? null,
        availability: status.availability ?? null,
        reasonKind: status.reasonKind ?? null,
        transportPreference: status.transportPreference ?? "ipc",
        transport: status.transport ?? null,
        application: "built-in",
        enabled,
      },
      // Raw diagnostics: bugs need these strings, the card never shows them.
      detail: status.detail ?? null,
      activities,
      hostSources: status.hostSources ?? {},
    },
    null,
    2
  );
}

async function load() {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get([ENABLED_KEY, STATUS_KEY])) || {};
  } catch {
    stored = {};
  }

  enabledEl.checked = resolveEnabled(stored[ENABLED_KEY]);
  if (stored[STATUS_KEY] && typeof stored[STATUS_KEY] === "object") status = stored[STATUS_KEY];

  const live = await ask({ t: "wdr-get-status" });
  if (live) status = live;
  render();
}

enabledEl.addEventListener("change", async () => {
  const next = enabledEl.checked;
  try {
    await chrome.storage.local.set({ [ENABLED_KEY]: next });
    presenceSaved.textContent = next ? "Saved. Presence on." : "Saved. Presence off.";
  } catch {
    enabledEl.checked = !next;
    presenceSaved.textContent = "Could not save. Reload the extension and try again.";
  }
  render();
});

refreshEl.addEventListener("click", () => {
  void load();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[ENABLED_KEY]) {
    enabledEl.checked = resolveEnabled(changes[ENABLED_KEY].newValue);
    render();
  } else if (changes[STATUS_KEY]) {
    const next = changes[STATUS_KEY].newValue;
    if (next && typeof next === "object") status = next;
    render();
  }
  // Legacy keys (clientId, transport, per-site flags) are ignored.
});

void load();
