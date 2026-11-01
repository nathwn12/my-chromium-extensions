/**
 * Popup controller. Reads status from the worker, toggles `enabled`.
 */

import { DEFAULT_CLIENT_ID, resolveClientId } from "./config.js";

const el = (id) => document.getElementById(id);
const bridge = el("bridge");
const appEl = el("app");
const appOverrideEl = el("app-override");
const nowEl = el("now");
const detailEl = el("detail");
const enabledEl = el("enabled");

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

function describeLine(activity) {
  if (!activity) return "";
  return [activity.state, activity.assets && activity.assets.large_text].filter(Boolean).join(" · ");
}

async function render() {
  const stored = await chrome.storage.local.get(["clientId", "enabled", "crpStatus"]);
  const effective = resolveClientId(stored.clientId);
  const override = effective !== DEFAULT_CLIENT_ID;

  const live = await ask({ kind: "crp-get-status" });
  const status = live || stored.crpStatus || {};
  const state = status.bridgeState || "unknown";

  bridge.textContent = state;
  bridge.dataset.state = state;
  appEl.textContent = override ? `App: custom ${effective}` : "App: Crunchyroll";
  appOverrideEl.hidden = !override;
  enabledEl.checked = stored.enabled !== false;

  if (!status.enabled) {
    nowEl.textContent = "Presence disabled";
    detailEl.textContent = "Turn it back on with the toggle.";
    return;
  }

  const activity = status.lastActivity;
  if (activity && activity.details) {
    nowEl.textContent = activity.details;
    detailEl.textContent = describeLine(activity);
  } else {
    nowEl.textContent = "Nothing playing";
    detailEl.textContent = status.lastError || "Open a Crunchyroll episode to start.";
  }
}

enabledEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: enabledEl.checked });
  await ask({ kind: "crp-refresh" });
  render();
});

const openOptions = el("open-options");
openOptions.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.crpStatus || changes.clientId || changes.enabled)) render();
});

render();
