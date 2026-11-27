/**
 * Presence Suite popup controller.
 *
 * Plain ES module, no build. Shares config.js and bridge-status.js with the
 * worker so the vocabulary cannot drift. Each source row has its own switch;
 * status.detail (a raw native diagnostic) is never rendered, only the
 * friendly reason from presentStatus().
 */

import {
  ENABLED_KEY,
  SOURCES,
  SOURCE_META,
  resolveEnabled,
} from "./config.js";
import { STATUS_KEY, presentStatus } from "./bridge-status.js";

const el = (id) => document.getElementById(id);
const bridgeEl = el("bridge");
const reasonEl = el("reason");
const toggles = new Map(
  SOURCES.map((source) => [source, el("enabled-" + source)])
);

/** One title/detail pair for a source's activity, or the empty state. */
function describeActivity(activity) {
  if (!activity || typeof activity !== "object") return { title: "Nothing playing", detail: "" };
  const title = typeof activity.details === "string" && activity.details ? activity.details : "Playing";
  const rawState = typeof activity.state === "string" ? activity.state : "";
  const detail = rawState && rawState.toLowerCase() !== title.toLowerCase() ? rawState : "";
  return { title, detail };
}

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

/** The worker's live view, or the last persisted one while it restarts. */
async function readStatus() {
  const live = await ask({ t: "presence-get-status" });
  if (live) return live;
  try {
    const stored = await chrome.storage.local.get([STATUS_KEY]);
    return (stored && stored[STATUS_KEY]) || {};
  } catch (_) {
    return {};
  }
}

function renderStatus(status, enabled) {
  const view = presentStatus(status);
  const anyOn = SOURCES.some((source) => enabled[source] !== false);
  bridgeEl.textContent = anyOn ? view.label : "Off";
  bridgeEl.dataset.state = anyOn ? view.state : "idle";
  bridgeEl.dataset.tone = !anyOn
    ? "off"
    : view.isError
      ? "error"
      : view.state === "connected"
        ? "connected"
        : "waiting";

  const reason = anyOn ? view.reason : null;
  reasonEl.hidden = !reason;
  reasonEl.textContent = reason || "";
  reasonEl.setAttribute("role", view.isError ? "alert" : "status");
  reasonEl.setAttribute("aria-live", view.isError ? "assertive" : "polite");

  const activities = (status && status.activities) || {};
  for (const source of SOURCES) {
    const on = enabled[source] !== false;
    const { title, detail } = !on
      ? { title: SOURCE_META[source].name + " off", detail: "" }
      : describeActivity(activities[source]);
    const now = el(source + "-now");
    const line = el(source + "-detail");
    if (now) now.textContent = title;
    if (line) line.textContent = detail;
    const toggle = toggles.get(source);
    if (toggle) toggle.checked = on;
  }
}

async function render() {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get([ENABLED_KEY])) || {};
  } catch (_) {
    stored = {};
  }
  const map = stored[ENABLED_KEY];
  const enabled = {};
  for (const source of SOURCES) enabled[source] = resolveEnabled(map, source);
  renderStatus(await readStatus(), enabled);
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
    } catch (_) {
      toggle.checked = !next;
    }
    await render();
  });
}

const openOptions = el("open-options");
if (openOptions) {
  openOptions.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STATUS_KEY] || changes[ENABLED_KEY])) void render();
});

void render();
