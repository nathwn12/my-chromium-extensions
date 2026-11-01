/**
 * Options page controller. Plain ES module, no framework.
 */

import { clientIdToPersist, resolveClientId } from "./config.js";

const el = (id) => document.getElementById(id);

const clientForm = el("client-form");
const clientInput = el("clientId");
const clientError = el("clientId-error");
const bridgeState = el("bridgeState");
const appNameEl = el("appName");
const currentActivity = el("currentActivity");
const lastErrorEl = el("lastError");
const testButton = el("test");
const testResult = el("test-result");
const refreshButton = el("refresh");
const diagnostics = el("diagnostics");
const copyButton = el("copy");
const copyResult = el("copy-result");

let status = {
  bridgeState: "unknown",
  appName: null,
  lastError: null,
  lastActivity: null,
  clientIdPresent: false,
  enabled: true
};
let lastExtract = null;

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
  if (!activity) return "— (nothing playing)";
  const parts = [activity.details, activity.state].filter(Boolean);
  return parts.join(" — ") || "— (nothing playing)";
}

function render() {
  const state = status.bridgeState || "unknown";
  bridgeState.textContent = state;
  bridgeState.dataset.state = state;
  appNameEl.textContent = status.appName || "—";
  currentActivity.textContent = describeActivity(status.lastActivity);
  lastErrorEl.textContent = status.lastError || "—";
  diagnostics.value = JSON.stringify(
    {
      status: {
        bridgeState: status.bridgeState,
        appName: status.appName,
        lastError: status.lastError,
        enabled: status.enabled,
        clientId: status.clientIdPresent ? "set" : "missing"
      },
      activity: status.lastActivity,
      lastExtract
    },
    null,
    2
  );
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

async function load() {
  const stored = await chrome.storage.local.get(["clientId", "enabled"]);
  clientInput.value = resolveClientId(stored.clientId);
  status.enabled = stored.enabled !== false;
  status.clientIdPresent = true;

  const session = await chrome.storage.session.get(["crpStatus", "crpLastExtract"]);
  const local = await chrome.storage.local.get(["crpStatus"]);
  const saved = session.crpStatus || local.crpStatus;
  if (saved) status = { ...status, ...saved };
  if (session.crpLastExtract) lastExtract = session.crpLastExtract;

  const live = await ask({ kind: "crp-get-status" });
  if (live) status = { ...status, ...live };
  render();
}

clientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = clientIdToPersist(clientInput.value);
  if (next === undefined) {
    showError("That does not look like a Discord application ID. It is 17 to 20 digits.");
    clientInput.focus();
    return;
  }
  showError("");
  try {
    if (next) await chrome.storage.local.set({ clientId: next });
    else await chrome.storage.local.remove("clientId");
    status.clientIdPresent = true;
    clientInput.value = resolveClientId(next);
    await ask({ kind: "crp-refresh" });
    testResult.textContent = next
      ? "Saved. Reconnecting to Discord with your application."
      : "Saved. Using the built-in Crunchyroll application.";
  } catch {
    showError("Could not save. Reload the extension and try again.");
  }
});

clientInput.addEventListener("input", () => {
  if (clientIdToPersist(clientInput.value) !== undefined) showError("");
});

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  testResult.textContent = "Sending…";
  try {
    const response = await ask({ kind: "crp-test-presence" });
    if (!response) {
      testResult.textContent = "No response from the extension worker. Reload the extension.";
    } else if (response.queued) {
      testResult.textContent = "Test activity sent to Discord.";
    } else {
      testResult.textContent = `Test activity built, but the bridge is "${response.bridgeState}". Start the native host, then retry.`;
    }
  } finally {
    testButton.disabled = false;
  }
});

refreshButton.addEventListener("click", load);

copyButton.addEventListener("click", async () => {
  const text = diagnostics.value;
  try {
    await navigator.clipboard.writeText(text);
    copyResult.textContent = "Copied.";
  } catch {
    diagnostics.focus();
    diagnostics.select();
    const ok = document.execCommand && document.execCommand("copy");
    copyResult.textContent = ok ? "Copied." : "Select the text above and copy it manually.";
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (changes.crpStatus) {
    const next = changes.crpStatus.newValue;
    if (next) status = { ...status, ...next };
    render();
  }
  if (changes.crpLastExtract && area === "session") {
    lastExtract = changes.crpLastExtract.newValue || null;
    render();
  }
  if (area === "local" && changes.clientId) {
    status.clientIdPresent = Boolean(resolveClientId(changes.clientId.newValue));
    render();
  }
});

load();
