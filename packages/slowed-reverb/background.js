importScripts('shared.js');

const {
  extractHostname,
  isSupportedUrl,
  normalizeSettings,
} = self.SlowedReverbShared;

const TAB_BYPASS_KEY = 'tabBypassById';
const SITE_SETTINGS_KEY = 'siteSettings';
const SITE_TOGGLES_KEY = 'siteToggles';
const TAB_SESSION_KEY = 'tabSessionById';

const tabBypassById = new Map();
const tabSessionById = new Map();

function getEligibleTab(tabId) {
  if (tabId == null) return null;
  return chrome.tabs.get(tabId).catch(() => null);
}

function isEligibleTab(tab) {
  return Boolean(tab?.id) && isSupportedUrl(tab.url);
}

async function injectMainWorldScript(tabId, file) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
    world: 'MAIN',
  });
}

async function injectMainWorldHook(tabId) {
  const tab = await getEligibleTab(tabId);
  if (!isEligibleTab(tab)) return { ok: false, error: 'unsupported' };

  try {
    await injectMainWorldScript(tabId, 'page-hook.js');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function getTabBypass(tabId, siteKey) {
  // Storage is authoritative per site: an explicit siteToggles entry wins in
  // both directions (last write wins across tabs). Memory only covers a
  // storage outage within this session, and only for the host it was set on.
  if (siteKey) {
    try {
      const stored = await chrome.storage.local.get({ [SITE_TOGGLES_KEY]: {} });
      const toggles = stored[SITE_TOGGLES_KEY] || {};
      if (siteKey in toggles) return toggles[siteKey] === false;
    } catch {
      // Best effort only; fall through to memory below.
    }
  }
  if (tabBypassById.has(tabId)) {
    if (tabBypassById.get(tabId) === siteKey) return true;
    // Stale entry (tab navigated to another host since): drop it.
    tabBypassById.delete(tabId);
  }
  return false;
}

async function setTabBypass(tabId, bypass) {
  // Resolve the host first: memory records the siteKey the bypass was set
  // for, so a later navigation to another host cannot inherit it.
  let siteKey = '';
  try {
    const tab = await getEligibleTab(tabId);
    siteKey = tab ? extractHostname(tab.url) : '';
  } catch {
    siteKey = '';
  }
  if (bypass) {
    tabBypassById.set(tabId, siteKey);
  } else {
    tabBypassById.delete(tabId);
  }
  if (!siteKey) return;
  try {
    const stored = await chrome.storage.local.get({ [SITE_TOGGLES_KEY]: {} });
    const toggles = stored[SITE_TOGGLES_KEY] || {};
    toggles[siteKey] = !bypass;
    await chrome.storage.local.set({ [SITE_TOGGLES_KEY]: toggles });
  } catch {
    // Best effort only; memory state still applies for this session.
  }
}

async function clearTabBypass(tabId) {
  if (!tabBypassById.has(tabId)) return;
  tabBypassById.delete(tabId);
}

async function getStoredSiteSettings() {
  const stored = await chrome.storage.local.get({ [SITE_SETTINGS_KEY]: {} });
  return stored[SITE_SETTINGS_KEY] || {};
}

async function setStoredSiteSettings(siteKey, settings) {
  const all = await getStoredSiteSettings();
  all[siteKey] = normalizeSettings(settings);
  await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: all });
  return all[siteKey];
}

async function getTabSession(tabId) {
  return tabSessionById.get(tabId) || null;
}

async function setTabSession(tabId, settings) {
  tabSessionById.set(tabId, normalizeSettings(settings));
}

async function clearTabSession(tabId) {
  tabSessionById.delete(tabId);
}

async function resolveSettingsForTab(tabId) {
  const tab = await getEligibleTab(tabId);
  const eligible = isEligibleTab(tab);
  const siteKey = tab ? extractHostname(tab.url) : '';
  const session = await getTabSession(tabId);

  if (session) {
    return { eligible, siteKey, settings: normalizeSettings(session) };
  }

  if (eligible && siteKey) {
    const all = await getStoredSiteSettings();
    const stored = all[siteKey];
    if (stored) {
      return { eligible, siteKey, settings: normalizeSettings(stored) };
    }
  }

  return { eligible, siteKey, settings: normalizeSettings(null) };
}

async function buildTabState(tabId) {
  const tab = await getEligibleTab(tabId);
  const eligible = isEligibleTab(tab);
  const siteKeyForBypass = tab ? extractHostname(tab.url) : '';
  const bypass = eligible ? await getTabBypass(tabId, siteKeyForBypass) : false;
  const { siteKey, settings } = await resolveSettingsForTab(tabId);

  return {
    ok: true,
    eligible,
    bypass,
    settings,
    siteKey,
  };
}

async function pushTabState(tabId) {
  const tab = await getEligibleTab(tabId);
  if (!isEligibleTab(tab)) return { ok: false, error: 'unsupported' };

  const payload = await buildTabState(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'APPLY_TAB_STATE',
      bypass: payload.bypass,
      settings: payload.settings,
    });
    return { ok: true };
  } catch {
    // Best effort only: the MAIN-world hook cannot receive runtime messages,
    // so a retry through it would fail identically. Report unreachable.
    await injectMainWorldHook(tabId);
    return { ok: false, error: 'unreachable' };
  }
}

async function rehydrateAllTabs() {
  const tabs = await chrome.tabs.query({});
  const eligible = tabs.filter(t => isEligibleTab(t));
  const CONCURRENCY = 5;
  let i = 0;

  const next = () => {
    if (i >= eligible.length) return Promise.resolve();
    const tab = eligible[i++];
    return pushTabState(tab.id).then(next, next);
  };

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, eligible.length); w++) {
    workers.push(next());
  }
  await Promise.all(workers);
}

const pendingUpdates = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!tabId || (changeInfo.status !== 'complete' && typeof changeInfo.url !== 'string')) {
    return;
  }

  if (pendingUpdates.has(tabId)) return;
  pendingUpdates.set(tabId, true);

  pushTabState(tabId).finally(() => {
    pendingUpdates.delete(tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  Promise.all([
    clearTabBypass(tabId),
    clearTabSession(tabId),
  ]).catch(() => {});
});

// Note: if onRemoved fires before onReplaced for the same tab, the entries
// below are already gone and there is nothing to migrate; persistent storage
// (siteToggles/siteSettings) remains the fallback, so the tab still hydrates.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (tabBypassById.has(removedTabId)) {
    tabBypassById.set(addedTabId, tabBypassById.get(removedTabId));
    tabBypassById.delete(removedTabId);
  }
  if (tabSessionById.has(removedTabId)) {
    tabSessionById.set(addedTabId, tabSessionById.get(removedTabId));
    tabSessionById.delete(removedTabId);
  }
  pushTabState(addedTabId).catch(() => {});
});

// Concurrent full rehydrates (import + onStartup + onInstalled all fire at
// startup) are deduped behind one in-flight run.
let rehydratePromise = null;
function scheduleRehydrate() {
  if (rehydratePromise) return rehydratePromise;
  rehydratePromise = rehydrateAllTabs().catch(() => {}).finally(() => { rehydratePromise = null; });
  return rehydratePromise;
}

chrome.runtime.onStartup.addListener(() => {
  void scheduleRehydrate();
});

chrome.runtime.onInstalled.addListener(() => {
  void scheduleRehydrate();
});

// onStartup does not fire when the worker wakes from idle, so rehydrate
// best-effort on every SW evaluation. Must never throw at import.
try {
  void scheduleRehydrate().catch(() => {});
} catch {
  // Never throw at import.
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  void (async () => {
    switch (message.type) {
      case 'GET_POPUP_STATE': {
        const tabId = Number(message.tabId);
        await injectMainWorldHook(tabId);
        return buildTabState(message.tabId);
      }
      case 'GET_TAB_RUNTIME_STATE': {
        return buildTabState(sender.tab?.id || message.tabId);
      }
      case 'SET_SITE_SETTINGS': {
        const tabId = Number(message.tabId);
        const settings = normalizeSettings(message.settings);

        if (message.siteKey) {
          await setStoredSiteSettings(message.siteKey, settings);
        }
        await setTabSession(tabId, settings);

        const push = await pushTabState(tabId);
        return { ok: true, settings, pushed: push.ok };
      }
      case 'SET_TAB_BYPASS': {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Missing tabId.');
        if (!isEligibleTab(await getEligibleTab(tabId))) return { ok: false, error: 'unsupported' };
        await setTabBypass(tabId, Boolean(message.bypass));
        const push = await pushTabState(tabId);
        const state = await buildTabState(tabId);
        return { ...state, pushed: push.ok, pushError: push.error || '' };
      }
      case 'ENSURE_TAB_HOOKS': {
        const tabId = Number(message.tabId || sender.tab?.id);
        if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Missing tabId.');
        await injectMainWorldHook(tabId);
        return pushTabState(tabId);
      }
      default:
        return { ok: false, error: 'unknown_message' };
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });

  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.siteToggles) {
    const newToggles = changes.siteToggles.newValue || {};
    const oldToggles = changes.siteToggles.oldValue || {};
    for (const siteKey of Object.keys(newToggles)) {
      if (newToggles[siteKey] !== oldToggles[siteKey]) {
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (tab.url) {
              try {
                const hostname = new URL(tab.url).hostname.toLowerCase();
                if (hostname === siteKey) {
                  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CHANGED', siteKey, enabled: newToggles[siteKey] }).catch(() => {});
                }
              } catch {}
            }
          });
        });
      }
    }
  }
});
