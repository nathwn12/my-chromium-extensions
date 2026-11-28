/**
 * Presence Suite options controller.
 *
 * Per-source switches, one display settings record (clock and two buttons)
 * and application-ID overrides, plus a read-only diagnostics block. Plain ES
 * module; no new permissions. Shared config.js and bridge-status.js keep
 * validation and labels identical to the worker's.
 */

import {
  CLOCK_DETAILED,
  CLOCK_MINIMAL,
  DEFAULT_CLIENT_IDS,
  ENABLED_KEY,
  SETTINGS_KEY,
  SOURCES,
  SOURCE_META,
  STATUS_KEY,
  clientIdKey,
  clientIdToPersist,
  resolveClientId,
  resolveEnabled,
  resolveSettings,
} from "./config.js";
import { presentSources, presentStatus } from "./bridge-status.js";

const el = (id) => document.getElementById(id);
const bridgeEl = el("bridgeState");
const reasonEl = el("reason");
const savedEl = el("presence-saved");
const diagnosticsEl = el("diagnostics");
const toggles = new Map(SOURCES.map((source) => [source, el("enabled-" + source)]));
const clientFields = new Map(SOURCES.map((source) => [source, el("clientId-" + source)]));
const clockToggle = el("clock-detailed");
const listenToggle = el("button-listen");
const albumToggle = el("button-album");

let status = {};
let enabled = {};
let clientIds = {};
let settings = resolveSettings(null);

function ask(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function describeActivity(activity) {
  if (!activity || typeof activity !== "object") return "Nothing playing";
  const title = typeof activity.details === "string" ? activity.details : "";
  const rawState = typeof activity.state === "string" ? activity.state : "";
  const state = rawState && title && rawState.toLowerCase() !== title.toLowerCase() ? rawState : "";
  const parts = [title, state].filter((part) => typeof part === "string" && part);
  return parts.length ? parts.join(" - ") : "Nothing playing";
}

function render() {
  const view = presentStatus(status);
  const anyOn = SOURCES.some((source) => enabled[source] !== false);
  bridgeEl.textContent = anyOn ? view.label : "Off";
  bridgeEl.dataset.state = anyOn ? view.state : "idle";
  bridgeEl.dataset.tone = !anyOn ? "off" : view.isError ? "error" : view.state === "connected" ? "connected" : "waiting";

  const reason = anyOn ? view.reason : null;
  reasonEl.hidden = !reason;
  reasonEl.textContent = reason || "";
  reasonEl.setAttribute("role", view.isError ? "alert" : "status");
  reasonEl.setAttribute("aria-live", view.isError ? "assertive" : "polite");

  if (clockToggle) clockToggle.checked = settings.clock === CLOCK_DETAILED;
  if (listenToggle) listenToggle.checked = settings.listenButton;
  if (albumToggle) albumToggle.checked = settings.albumButton;

  const labels = presentSources(status.hostSources);
  const activities = status.activities || {};
  for (const source of SOURCES) {
    const toggle = toggles.get(source);
    if (toggle) toggle.checked = enabled[source] !== false;
    const field = clientFields.get(source);
    if (field && field.value !== clientIds[source]) field.value = clientIds[source];
    const activityEl = el(source + "-activity");
    if (activityEl) activityEl.textContent = enabled[source] === false ? SOURCE_META[source].name + " off" : describeActivity(activities[source]);
    const hostEl = el(source + "-host");
    const hostState = (status.hostSources || {})[source];
    if (hostEl) {
      if (enabled[source] === false) {
        hostEl.textContent = "Off";
        delete hostEl.dataset.state;
      } else {
        hostEl.textContent = labels[source] || "Not connected";
        if (typeof hostState === "string") hostEl.dataset.state = hostState;
        else delete hostEl.dataset.state;
      }
    }
  }

  diagnosticsEl.value = JSON.stringify(
    {
      status: {
        bridgeState: status.bridgeState ?? null,
        availability: status.availability ?? null,
        reasonKind: status.reasonKind ?? null,
        transportPreference: status.transportPreference ?? "ipc",
        transport: status.transport ?? null,
        bridge: view.state,
      },
      detail: status.detail ?? null,
      enabled: { ...enabled },
      settings: { ...settings },
      applicationIds: { ...clientIds },
      defaults: { ...DEFAULT_CLIENT_IDS },
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
    const keys = [ENABLED_KEY, SETTINGS_KEY, STATUS_KEY, ...SOURCES.map((source) => clientIdKey(source))];
    stored = (await chrome.storage.local.get(keys)) || {};
  } catch (_) {
    stored = {};
  }
  const map = stored[ENABLED_KEY];
  settings = resolveSettings(stored[SETTINGS_KEY]);
  enabled = {};
  clientIds = {};
  for (const source of SOURCES) {
    enabled[source] = resolveEnabled(map, source);
    clientIds[source] = resolveClientId(stored[clientIdKey(source)], source);
  }
  if (stored[STATUS_KEY] && typeof stored[STATUS_KEY] === "object") status = stored[STATUS_KEY];
  const live = await ask({ t: "presence-get-status" });
  if (live) status = live;
  render();
}

for (const [source, toggle] of toggles) {
  if (!toggle) continue;
  toggle.addEventListener("change", async () => {
    const next = toggle.checked;
    try {
      const stored = (await chrome.storage.local.get([ENABLED_KEY])) || {};
      const map = { ...(stored[ENABLED_KEY] || {}) };
      map[source] = next;
      await chrome.storage.local.set({ [ENABLED_KEY]: map });
      savedEl.textContent = SOURCE_META[source].name + (next ? " enabled." : " disabled.");
    } catch (_) {
      toggle.checked = !next;
      savedEl.textContent = "Could not save. Reload and try again.";
    }
    await load();
  });
}

/**
 * All three display switches share one record: a change writes every field,
 * so a partial or corrupt read can never half-apply the display choice.
 */
const displayToggles = [
  [clockToggle, "clock", (checked) => (checked ? CLOCK_DETAILED : CLOCK_MINIMAL)],
  [listenToggle, "listenButton", (checked) => checked],
  [albumToggle, "albumButton", (checked) => checked],
];
for (const [toggle, field, toValue] of displayToggles) {
  if (!toggle) continue;
  toggle.addEventListener("change", async () => {
    const next = { ...settings, [field]: toValue(toggle.checked) };
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: resolveSettings(next) });
      savedEl.textContent = "Display settings saved.";
    } catch (_) {
      toggle.checked = !toggle.checked;
      savedEl.textContent = "Could not save. Reload and try again.";
    }
    await load();
  });
}

for (const [source, field] of clientFields) {
  if (!field) continue;
  field.addEventListener("change", async () => {
    const persist = clientIdToPersist(field.value, source);
    if (persist === undefined) {
      field.value = clientIds[source];
      savedEl.textContent = "Application ID must be 17-20 digits, or empty for the built-in.";
      return;
    }
    try {
      await chrome.storage.local.set({ [clientIdKey(source)]: persist });
      savedEl.textContent = persist === null ? SOURCE_META[source].name + " reset to the built-in ID." : SOURCE_META[source].name + " application ID saved.";
    } catch (_) {
      savedEl.textContent = "Could not save. Reload and try again.";
    }
    await load();
  });
}

const refresh = el("refresh");
if (refresh) refresh.addEventListener("click", () => { void load(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[ENABLED_KEY] || changes[SETTINGS_KEY] || changes[STATUS_KEY] || SOURCES.some((source) => changes[clientIdKey(source)])) void load();
});

void load();
