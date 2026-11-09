/**
 * Popup controller. Reads status from the worker, toggles `enabled`.
 */

import { DEFAULT_CLIENT_ID, resolveClientId } from "./config.js";
import { presentStatus } from "./bridge-status.js";

const el = (id) => document.getElementById(id);
const bridge = el("bridge");
const appEl = el("app");
const appOverrideEl = el("app-override");
const nowEl = el("now");
const detailEl = el("detail");
const reasonEl = el("reason");
const buttonsEl = el("buttons");
const enabledEl = el("enabled");
// Single vocabulary across popups: the toggle reads "Active".
const toggleLabel = document.querySelector(".toggle span");
if (toggleLabel) toggleLabel.textContent = "Active";

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

  const enabled = stored.enabled !== false;
  const live = await ask({ kind: "crp-get-status" });
  const status = live || stored.crpStatus || {};
  const state = status.bridgeState || "unknown";
  const view = presentStatus({ ...status, enabled });

  bridge.textContent = view.label;
  bridge.dataset.state = state;
  bridge.dataset.tone =
    view.isError ? "error" : state === "connected" ? "connected" : view.state === "off" ? "off" : "waiting";
  appEl.textContent = override ? `App: custom ${effective}` : "App: Crunchyroll";
  appOverrideEl.hidden = !override;
  enabledEl.checked = enabled;
  // The toggle stays operable in every state: turning presence OFF must never
  // be blocked by Discord being absent.
  enabledEl.disabled = false;

  reasonEl.hidden = !view.reason;
  reasonEl.textContent = view.reason || "";
  reasonEl.setAttribute("role", view.isError ? "alert" : "status");
  reasonEl.setAttribute("aria-live", view.isError ? "assertive" : "polite");

  buttonsEl.textContent = "";
  buttonsEl.hidden = true;

  if (!enabled) {
    nowEl.textContent = "Presence off";
    detailEl.textContent = "Turn it on with the toggle above.";
    return;
  }

  const activity = "lastSent" in status ? status.lastSent : status.lastActivity;
  if (activity && activity.details) {
    nowEl.textContent = activity.details;
    detailEl.textContent = describeLine(activity);
    const buttons = Array.isArray(activity.buttons) ? activity.buttons : [];
    for (const button of buttons) {
      const item = document.createElement("li");
      item.textContent = `${button.label} — ${button.url}`;
      buttonsEl.append(item);
    }
    buttonsEl.hidden = buttons.length === 0;
  } else {
    nowEl.textContent = "Nothing playing";
    // The reason lives in its own live region so a playing activity never
    // hides why presence is paused. Raw diagnostics never reach this text.
    detailEl.textContent = "Open a Crunchyroll episode to start.";
  }
}

enabledEl.addEventListener("change", async () => {
  // Optimistic: the pill never claims the pre-toggle state while the worker
  // persists. Turning off always sends the clear; turning on waits.
  if (enabledEl.checked) {
    bridge.textContent = "Waiting";
    bridge.dataset.state = "connecting";
    bridge.dataset.tone = "waiting";
  } else {
    bridge.textContent = "Off";
    bridge.dataset.state = "idle";
    bridge.dataset.tone = "off";
  }
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
