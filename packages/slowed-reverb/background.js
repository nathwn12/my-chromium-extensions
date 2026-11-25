importScripts('shared.js', 'player-actions.js');

const {
  extractHostname,
  isSupportedUrl,
  normalizeSettings,
} = self.SlowedReverbShared;

const {
  capSaved,
  mergeSavedLists,
  sanitizeSaved,
  upsertSaved,
} = self.SlowedReverbPlayerActions;

const TAB_BYPASS_KEY = 'tabBypassById';
const SITE_SETTINGS_KEY = 'siteSettings';
const SITE_TOGGLES_KEY = 'siteToggles';
const TAB_SESSION_KEY = 'tabSessionById';
const PLAYER_ACTIONS_KEY = 'playerActions';
const PLAYER_SECTIONS_LIMIT = 100;
const DEV_IMPORT_PATH = '.dev/section-import.json';
const DEV_IMPORT_KEY = 'devSectionImport';
const DEV_IMPORT_SUMMARY_KEY = 'devSectionImportSummary';

const tabBypassById = new Map();
const tabSessionById = new Map();

let playerSectionSaveChain = Promise.resolve();
let settingsWriteChain = Promise.resolve();

function normalizeSectionTime(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Mirrors the engine's sanitizer but keeps both-null: that is a forget. */
function normalizeSectionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.videoId !== 'string' || entry.videoId === '') return null;
  const startSeconds = normalizeSectionTime(entry.startSeconds);
  const endSeconds = normalizeSectionTime(entry.endSeconds);
  if (startSeconds === undefined || endSeconds === undefined) return null;
  return { videoId: entry.videoId, startSeconds, endSeconds };
}

function queuePlayerSectionSave(entry) {
  const normalized = normalizeSectionEntry(entry);
  if (normalized === null) return Promise.reject(new Error('Invalid section entry.'));
  playerSectionSaveChain = playerSectionSaveChain
    .catch(() => [])
    .then(async () => {
      const stored = await chrome.storage.local.get(PLAYER_ACTIONS_KEY);
      const raw = stored ? stored[PLAYER_ACTIONS_KEY] : null;
      const current = sanitizeSaved(raw ? raw.sections : undefined);
      const next = capSaved(upsertSaved(current, normalized), PLAYER_SECTIONS_LIMIT);
      const write = {};
      write[PLAYER_ACTIONS_KEY] = { sections: next };
      await chrome.storage.local.set(write);
      return next;
    });
  return playerSectionSaveChain;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The stored schema, minus a forget: both bounds null is a live save action. */
function isValidSectionEntry(entry) {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.videoId !== 'string' || entry.videoId === '') return false;
  const startSeconds = normalizeSectionTime(entry.startSeconds);
  const endSeconds = normalizeSectionTime(entry.endSeconds);
  if (startSeconds === undefined || endSeconds === undefined) return false;
  return startSeconds !== null || endSeconds !== null;
}

function validateSectionImport(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { error: 'invalid_entries' };
  const seen = new Set();
  const batch = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isValidSectionEntry(entry)) return { error: 'invalid_entry', index };
    if (seen.has(entry.videoId)) return { error: 'duplicate_entry', index };
    seen.add(entry.videoId);
    batch.push(normalizeSectionEntry(entry));
  }
  return { batch };
}

/**
 * The destination is merged into and written back, so it has to be clean
 * already: a malformed or duplicated stored entry is refused instead of being
 * sanitized out of the saved list. The list comes back as stored, so fields
 * this path does not know about survive the round trip.
 */
function readStoredSections(raw) {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    return { error: 'invalid_destination' };
  }
  const sections = raw ? raw.sections : undefined;
  if (sections === undefined || sections === null) return { list: [] };
  if (!Array.isArray(sections)) return { error: 'invalid_destination' };
  const seen = new Set();
  for (let index = 0; index < sections.length; index += 1) {
    const entry = sections[index];
    if (!isValidSectionEntry(entry)) return { error: 'invalid_destination', index };
    if (seen.has(entry.videoId)) return { error: 'invalid_destination', index };
    seen.add(entry.videoId);
  }
  return { list: sections };
}

/**
 * Merges saved sections from one local array. All-or-nothing: a single invalid
 * entry, a duplicate id, a malformed saved list, or a merge past
 * PLAYER_SECTIONS_LIMIT returns an error and leaves storage untouched. A
 * videoId already saved keeps its destination entry and counts as skipped, new
 * ids append in source order, and the write carries every other playerActions
 * field through unchanged.
 *
 * The work rides the same `playerSectionSaveChain` as SAVE_PLAYER_SECTION, so an
 * import and a tab's save can never read-modify-write over each other.
 */
async function importPlayerSections(entries) {
  const validated = validateSectionImport(entries);
  if (validated.error) {
    const rejected = { ok: false, error: validated.error };
    if (validated.index !== undefined) rejected.index = validated.index;
    return rejected;
  }

  playerSectionSaveChain = playerSectionSaveChain
    .catch(() => [])
    .then(async () => {
      try {
        const stored = await chrome.storage.local.get(PLAYER_ACTIONS_KEY);
        const raw = stored ? stored[PLAYER_ACTIONS_KEY] : undefined;
        const existing = readStoredSections(raw);
        if (existing.error) {
          const refused = { ok: false, error: existing.error };
          if (existing.index !== undefined) refused.index = existing.index;
          return refused;
        }
        const merged = mergeSavedLists(existing.list, validated.batch, PLAYER_SECTIONS_LIMIT);
        if (merged.ok !== true) return merged;
        if (merged.imported > 0) {
          const next = isPlainObject(raw) ? { ...raw, sections: merged.sections } : { sections: merged.sections };
          const write = {};
          write[PLAYER_ACTIONS_KEY] = next;
          await chrome.storage.local.set(write);
        }
        return { ok: true, imported: merged.imported, skipped: merged.skipped, sections: merged.sections };
      } catch (error) {
        return {
          ok: false,
          error: 'storage_failed',
          detail: String(error && error.message ? error.message : error),
        };
      }
    });
  return playerSectionSaveChain;
}


async function sha256Hex(text) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error('No SHA-256.');
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A digest of the saved bounds only: the summary never carries song ids. */
async function canonicalSectionsDigest(sections) {
  const canonical = sections
    .map((entry) => [entry.videoId, entry.startSeconds, entry.endSeconds])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return sha256Hex(JSON.stringify(canonical));
}

async function readDevImportText() {
  if (typeof fetch !== 'function') return null;
  try {
    const response = await fetch(chrome.runtime.getURL(DEV_IMPORT_PATH));
    if (!response || response.ok !== true) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Records the outcome where the lead can read it without extension devtools:
 * a hidden attribute on an open YouTube Music document, and the same object in
 * storage for a run that had no eligible tab. Both carry counts and a digest,
 * never ids.
 */
async function reportDevImport(summary) {
  try {
    await chrome.storage.local.set({ [DEV_IMPORT_SUMMARY_KEY]: summary });
  } catch {
  }
  try {
    const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (value) => {
            document.documentElement.dataset.slraImportSummary = value;
          },
          args: [JSON.stringify(summary)],
        });
        return true;
      } catch {
      }
    }
  } catch {
  }
  return false;
}

async function executeDevImport() {
  const text = await readDevImportText();
  if (text === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const summary = { ok: false, error: 'invalid_file' };
    await reportDevImport(summary);
    return summary;
  }
  const entries = parsed && Array.isArray(parsed.sections) ? parsed.sections : null;
  if (entries === null) {
    const summary = { ok: false, error: 'invalid_file' };
    await reportDevImport(summary);
    return summary;
  }

  let hash;
  try {
    hash = await sha256Hex(text);
  } catch {
    const summary = { ok: false, error: 'hash_failed' };
    await reportDevImport(summary);
    return summary;
  }

  try {
    const marker = await chrome.storage.local.get(DEV_IMPORT_KEY);
    const seen = marker ? marker[DEV_IMPORT_KEY] : null;
    if (seen && seen.hash === hash) return null;
  } catch {
  }

  const result = await importPlayerSections(entries);
  const summary = { ok: result.ok === true };
  if (result.ok) {
    summary.imported = result.imported;
    summary.skipped = result.skipped;
    summary.before = result.sections.length - result.imported;
    summary.total = result.sections.length;
    try {
      summary.digest = await canonicalSectionsDigest(result.sections);
    } catch {
    }
  } else {
    summary.error = result.error;
    if (result.index !== undefined) summary.index = result.index;
    if (result.count !== undefined) summary.count = result.count;
    if (result.limit !== undefined) summary.limit = result.limit;
  }
  summary.at = Date.now();

  if (summary.ok) {
    try {
      await chrome.storage.local.set({
        [DEV_IMPORT_KEY]: {
          hash: hash,
          at: summary.at,
          imported: summary.imported,
          skipped: summary.skipped,
          total: summary.total,
        },
      });
    } catch {
    }
  }
  await reportDevImport(summary);
  return summary;
}

let devImportRun = null;

/** One run per service-worker lifetime; repeated startup events share it. */
function runDevSectionImport() {
  if (devImportRun === null) devImportRun = executeDevImport().catch(() => null);
  return devImportRun;
}

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
  if (siteKey) {
    try {
      const stored = await chrome.storage.local.get({ [SITE_TOGGLES_KEY]: {} });
      const toggles = stored[SITE_TOGGLES_KEY] || {};
      if (siteKey in toggles) return toggles[siteKey] === false;
    } catch {
    }
  }
  if (tabBypassById.has(tabId)) {
    if (tabBypassById.get(tabId) === siteKey) return true;
    tabBypassById.delete(tabId);
  }
  return false;
}

async function setTabBypass(tabId, bypass) {
  return serializeSettingsWrite(async () => {
    let tab = null;
    try {
      tab = await getEligibleTab(tabId);
    } catch {
    }
    if (!isEligibleTab(tab)) return { error: 'unsupported' };
    const siteKey = extractHostname(tab.url);
    const toggles = await readWritableContainer(SITE_TOGGLES_KEY);
    await chrome.storage.local.set({ [SITE_TOGGLES_KEY]: { ...toggles, [siteKey]: !bypass } });
    if (bypass) {
      tabBypassById.set(tabId, siteKey);
    } else {
      tabBypassById.delete(tabId);
    }
    return {};
  });
}

async function clearTabBypass(tabId) {
  if (!tabBypassById.has(tabId)) return;
  tabBypassById.delete(tabId);
}

async function getStoredSiteSettings() {
  try {
    const stored = await chrome.storage.local.get({ [SITE_SETTINGS_KEY]: {} });
    return stored[SITE_SETTINGS_KEY] || {};
  } catch {
    return {};
  }
}

/**
 * One queue for the persistent settings containers. Each task reads the
 * freshest container, so a delayed read cannot overwrite a later accepted
 * write or drop another host's key. A failed write settles the queue without
 * rejecting the next one.
 */
function serializeSettingsWrite(task) {
  const result = settingsWriteChain.then(task);
  settingsWriteChain = result.catch(() => {});
  return result;
}

/** Refuse a corrupt container instead of silently losing the write. */
async function readWritableContainer(key) {
  const stored = await chrome.storage.local.get({ [key]: {} });
  const raw = stored ? stored[key] : undefined;
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    throw new Error('Corrupt stored ' + key + '.');
  }
  return raw || {};
}

async function setStoredSiteSettings(siteKey, patch) {
  return serializeSettingsWrite(async () => {
    const all = await readWritableContainer(SITE_SETTINGS_KEY);
    const current = all[siteKey];
    const settings = normalizeSettings({ ...(current || {}), ...patch });
    await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: { ...all, [siteKey]: settings } });
    return settings;
  });
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

  if (session && !siteKey) {
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
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['shared.js', 'content-script.js'],
      });
    } catch {
      await injectMainWorldHook(tabId);
      return { ok: false, error: 'unreachable' };
    }
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'APPLY_TAB_STATE',
        bypass: payload.bypass,
        settings: payload.settings,
      });
      return { ok: true };
    } catch {
      await injectMainWorldHook(tabId);
      return { ok: false, error: 'unreachable' };
    }
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

chrome.runtime.onStartup.addListener(() => {
  void runDevSectionImport();
});

chrome.runtime.onInstalled.addListener(() => {
  void runDevSectionImport();
});

try {
  void runDevSectionImport();
} catch {
}

try {
  void (async () => {
    try {
      const flag = await chrome.storage.session.get({ slowedReverbRehydrated: false });
      if (flag && flag.slowedReverbRehydrated) return;
    } catch {
    }
    await scheduleRehydrate().catch(() => {});
    try {
      await chrome.storage.session.set({ slowedReverbRehydrated: true });
    } catch {
    }
  })().catch(() => {});
} catch {
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
        const tabId = Number(message.tabId ?? sender.tab?.id);
        const patch = message.settings && typeof message.settings === 'object' ? message.settings : {};
        const settings = message.siteKey
          ? await setStoredSiteSettings(message.siteKey, patch)
          : normalizeSettings(patch);
        await setTabSession(tabId, settings);

        const push = await pushTabState(tabId);
        return { ok: true, settings, pushed: push.ok };
      }
      case 'SET_TAB_BYPASS': {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Missing tabId.');
        const result = await setTabBypass(tabId, Boolean(message.bypass));
        if (result.error) return { ok: false, error: result.error };
        const push = await pushTabState(tabId);
        const state = await buildTabState(tabId);
        return { ...state, pushed: push.ok, pushError: push.error || '' };
      }
      case 'SAVE_PLAYER_SECTION': {
        const sections = await queuePlayerSectionSave(message.entry);
        return { ok: true, sections };
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
