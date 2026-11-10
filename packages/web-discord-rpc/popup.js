/**
 * Popup controller.
 *
 * One job: show the bridge and what each site is publishing, and let presence be
 * switched off without leaving the popup. Plain ES modules, no build: the same
 * `config.js` and `bridge-status.js` the worker imports are imported here, so
 * the vocabulary cannot drift between the worker and this surface.
 *
 * `status.detail` is a raw native diagnostic. It is never rendered: only
 * `presentStatus().reason` (friendly copy) reaches the page.
 */

import {
  SOURCE_YOUTUBE,
  SOURCE_YOUTUBE_MUSIC,
  resolveEnabled,
} from "./config.js";
import { STATUS_KEY, presentStatus } from "./bridge-status.js";

/** YouTube Music first: the owner's order and the worker's processing order. */
const SOURCES = [SOURCE_YOUTUBE_MUSIC, SOURCE_YOUTUBE];

const el = (id) => document.getElementById(id);

const bridgeEl = el("bridge");
const reasonEl = el("reason");
const enabledEl = el("enabled");

/** One `{ title, detail }` pair for a published activity, or the empty state. */
function describeActivity(activity) {
  if (!activity || typeof activity !== "object") return { title: "Nothing playing", detail: "" };
  const title = typeof activity.details === "string" && activity.details ? activity.details : "Watching";
  const detail = typeof activity.state === "string" ? activity.state : "";
  return { title, detail };
}

function renderStatus(status, enabled) {
  const view = presentStatus(status);
  enabledEl.checked = enabled;

  // Turning presence off is a deliberate state, not a bridge failure: say so
  // plainly and leave the pill neutral instead of red.
  bridgeEl.textContent = enabled ? view.label : "Off";
  bridgeEl.dataset.state = enabled ? view.state : "idle";
  bridgeEl.dataset.tone = !enabled
    ? "off"
    : view.isError
      ? "error"
      : view.state === "connected"
        ? "connected"
        : "waiting";

  // The reason has its own live region so a playing activity never hides why
  // presence is paused. Priority is announced, an expected absence is not.
  const reason = enabled ? view.reason : null;
  reasonEl.hidden = !reason;
  reasonEl.textContent = reason || "";
  reasonEl.setAttribute("role", view.isError ? "alert" : "status");
  reasonEl.setAttribute("aria-live", view.isError ? "assertive" : "polite");

  const activities = (status && status.activities) || {};
  const sites = (status && status.sites) || {};
  for (const source of SOURCES) {
    // A site switched off in Settings publishes nothing by design: say that,
    // not "Nothing playing", which would blame the page.
    const { title, detail } = !enabled
      ? { title: "Presence off", detail: "" }
      : sites[source] === false
        ? { title: "Off in Settings", detail: "" }
        : describeActivity(activities[source]);
    const titleEl = el(`${source}-activity`);
    const detailEl = el(`${source}-detail`);
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
  }
}

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

/** The worker's live view, or the last persisted one while it restarts. */
async function readStatus() {
  const live = await ask({ t: "wdr-get-status" });
  if (live) return live;
  try {
    const stored = await chrome.storage.local.get([STATUS_KEY]);
    return (stored && stored[STATUS_KEY]) || {};
  } catch {
    return {};
  }
}

async function render() {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get(["enabled"])) || {};
  } catch {
    stored = {};
  }
  renderStatus((await readStatus()) || {}, resolveEnabled(stored.enabled));
}

enabledEl.addEventListener("change", async () => {
  const next = enabledEl.checked;
  // Optimistic: the pill must not keep claiming the previous state while the
  // worker persists the toggle and tears the port down.
  bridgeEl.textContent = next ? "Waiting" : "Off";
  bridgeEl.dataset.state = next ? "connecting" : "idle";
  bridgeEl.dataset.tone = next ? "waiting" : "off";
  try {
    await chrome.storage.local.set({ enabled: next });
  } catch {
    enabledEl.checked = !next;
  }
  await render();
});

const openOptions = el("open-options");
if (openOptions) {
  openOptions.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATUS_KEY] || changes.enabled) void render();
});

void render();
