/**
 * Options controller.
 *
 * One job: hold the two stored preferences (application ID, transport) and
 * presence, and show the same bridge view the popup shows. Plain ES modules, no
 * build: `config.js` validates and `bridge-status.js` labels, exactly as the
 * worker does, so a stored value cannot be interpreted two ways.
 *
 * `status.detail` is a raw native diagnostic: it goes into the read-only
 * diagnostics block, never onto the status card.
 */

import {
  DEFAULT_CLIENT_ID,
  ENABLED_KEY,
  SOURCE_META,
  TRANSPORT_KEY,
  clientIdToPersist,
  resolveClientId,
  resolveEnabled,
  resolveTransport,
} from "./config.js";
import {
  CHOSEN_TRANSPORT,
  STATUS_KEY,
  chosenTransportOf,
  presentSources,
  presentStatus,
} from "./bridge-status.js";

const SOURCES = Object.keys(SOURCE_META);

const CHOSEN_LABELS = Object.freeze({
  [CHOSEN_TRANSPORT.IPC]: "Discord desktop app",
  [CHOSEN_TRANSPORT.ARRPC]: "arRPC",
  [CHOSEN_TRANSPORT.MIXED]: "Both (Discord app and arRPC)",
});

const el = (id) => document.getElementById(id);

const clientForm = el("client-form");
const clientInput = el("clientId");
const clientError = el("clientId-error");
const clientSaved = el("clientId-saved");
const transportEl = el("transport");
const transportSaved = el("transport-saved");
const enabledEl = el("enabled");
const presenceSaved = el("presence-saved");
const bridgeEl = el("bridgeState");
const transportUsedEl = el("transportUsed");
const appNameEl = el("appName");
const reasonEl = el("reason");
const refreshEl = el("refresh");
const diagnosticsEl = el("diagnostics");

/** The stored override, or null while the built-in application is in use. */
let storedClientId = null;
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
  const parts = [activity.details, activity.state].filter(
    (part) => typeof part === "string" && part
  );
  return parts.length ? parts.join(" — ") : "Nothing playing";
}

function showError(message) {
  if (!message) {
    clientError.hidden = true;
    clientError.textContent = "";
    clientInput.removeAttribute("aria-invalid");
    return;
  }
  clientError.hidden = false;
  clientError.textContent = message;
  clientInput.setAttribute("aria-invalid", "true");
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

  transportUsedEl.textContent = CHOSEN_LABELS[chosenTransportOf(status.transport)] || "—";
  appNameEl.textContent = storedClientId
    ? `Custom application ${resolveClientId(storedClientId)}`
    : "Built-in application";

  const labels = presentSources(status.hostSources);
  const activities = status.activities || {};
  const hostSources = status.hostSources || {};
  for (const source of SOURCES) {
    const hostEl = el(`${source}-host`);
    const hostState = hostSources[source];
    hostEl.textContent = labels[source] || "";
    if (typeof hostState === "string") hostEl.dataset.state = hostState;
    else delete hostEl.dataset.state;

    el(`${source}-activity`).textContent = enabled
      ? describeActivity(activities[source])
      : "Presence off";
  }

  diagnosticsEl.value = JSON.stringify(
    {
      status: {
        bridgeState: status.bridgeState ?? null,
        availability: status.availability ?? null,
        reasonKind: status.reasonKind ?? null,
        transportPreference: resolveTransport(status.transportPreference),
        transport: status.transport ?? null,
        application: storedClientId ? "custom" : "built-in",
        enabled,
      },
      // Raw diagnostics: bugs need these strings, the card never shows them.
      detail: status.detail ?? null,
      activities,
      hostSources,
    },
    null,
    2
  );
}

async function load() {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get([
      "clientId",
      ENABLED_KEY,
      TRANSPORT_KEY,
      STATUS_KEY,
    ])) || {};
  } catch {
    stored = {};
  }

  storedClientId = clientIdToPersist(stored.clientId) ?? null;
  clientInput.value = resolveClientId(stored.clientId);
  enabledEl.checked = resolveEnabled(stored[ENABLED_KEY]);
  transportEl.value = resolveTransport(stored[TRANSPORT_KEY]);
  if (stored[STATUS_KEY] && typeof stored[STATUS_KEY] === "object") status = stored[STATUS_KEY];

  const live = await ask({ t: "wdr-get-status" });
  if (live) status = live;
  render();
}

clientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = clientIdToPersist(clientInput.value);
  if (next === undefined) {
    showError("An application ID is 17 to 20 digits. Leave the field empty to use the built-in application.");
    clientInput.focus();
    return;
  }
  showError("");
  try {
    if (next) await chrome.storage.local.set({ clientId: next });
    else await chrome.storage.local.remove("clientId");
  } catch {
    showError("Could not save. Reload the extension and try again.");
    return;
  }
  storedClientId = next;
  clientInput.value = resolveClientId(next);
  clientSaved.textContent = next
    ? "Saved. Reconnecting with your application ID."
    : "Saved. Using the built-in application.";
  render();
});

clientInput.addEventListener("input", () => {
  if (clientIdToPersist(clientInput.value) !== undefined) showError("");
});

transportEl.addEventListener("change", async () => {
  const next = resolveTransport(transportEl.value);
  transportEl.value = next;
  try {
    await chrome.storage.local.set({ [TRANSPORT_KEY]: next });
    transportSaved.textContent = "Saved. Reconnecting to Discord.";
  } catch {
    transportSaved.textContent = "Could not save. Reload the extension and try again.";
    return;
  }
  render();
});

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
  if (changes.clientId) void load();
  else if (changes[TRANSPORT_KEY]) {
    transportEl.value = resolveTransport(changes[TRANSPORT_KEY].newValue);
    render();
  } else if (changes[ENABLED_KEY]) {
    enabledEl.checked = resolveEnabled(changes[ENABLED_KEY].newValue);
    render();
  } else if (changes[STATUS_KEY]) {
    const next = changes[STATUS_KEY].newValue;
    if (next && typeof next === "object") status = next;
    render();
  }
});

void load();
