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
// Local operator gate: a packaged, gitignored file dropped into the unpacked
// extension. Nothing on the page, in the popup or in another extension can
// reach it; only someone who can write this extension's own files can use it.
const DEV_IMPORT_PATH = '.dev/section-import.json';
const DEV_IMPORT_KEY = 'devSectionImport';
const DEV_IMPORT_SUMMARY_KEY = 'devSectionImportSummary';

const tabBypassById = new Map();
const tabSessionById = new Map();

// One writer for the saved section list across every tab. Each save is a full
// read-modify-write, so running two of them concurrently would let the second
// overwrite the first; the chain makes the pair sequential and lossless.
let playerSectionSaveChain = Promise.resolve();

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

// Bulk import for the owner, run from the service-worker devtools console:
//   await importPlayerSections(sections)
// It is a worker-global function on purpose, not a message type: the popup, the
// content script and any page have no route to it. The batch is validated whole
// before the save chain is touched, and the saved list must already be well
// formed, so a bad entry on either side writes nothing.
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
    // One id twice in one batch is ambiguous; the source is malformed.
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
          // Only `sections` belongs to this path; every other field is kept.
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

// ---------------------------------------------------------------------------
// Local section import gate
// ---------------------------------------------------------------------------

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
    // Best effort: the page marker is the primary read.
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
        // Try the next eligible tab.
      }
    }
  } catch {
    // No tabs permission or no tab: the stored summary remains.
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
    // An unreadable marker is not a reason to write again or to stop: fall
    // through and let the import decide from the saved list itself.
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
      // Counts still describe the write; the digest is an extra receipt.
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
      // The import already landed; a lost marker only means a retry next start.
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
  try {
    const stored = await chrome.storage.local.get({ [SITE_SETTINGS_KEY]: {} });
    return stored[SITE_SETTINGS_KEY] || {};
  } catch {
    return {};
  }
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
    // No receiver: after an extension reload/update the old content script is an
    // orphan and a new service worker cannot message it. Re-install the ISOLATED
    // content script (content-script.js re-enters through its adoption guard),
    // then retry once. A dead MAIN-world hook cannot receive runtime messages.
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

// The local import gate reads its file at every worker start; the stored hash
// makes a repeat a no-op. onStartup/onInstalled are extra chances for a reload
// that does not keep the worker alive long enough for the fetch.
chrome.runtime.onStartup.addListener(() => {
  void runDevSectionImport();
});

chrome.runtime.onInstalled.addListener(() => {
  void runDevSectionImport();
});

try {
  void runDevSectionImport();
} catch {
  // Never throw at import.
}

// onStartup does not fire when the worker wakes from idle, so rehydrate
// best-effort once, gated by a session flag so idle wakes do not reflood
// every tab. Must never throw at import.
try {
  void (async () => {
    try {
      const flag = await chrome.storage.session.get({ slowedReverbRehydrated: false });
      if (flag && flag.slowedReverbRehydrated) return;
    } catch {
      // No session storage: fall through to a single rehydrate.
    }
    await scheduleRehydrate().catch(() => {});
    try {
      await chrome.storage.session.set({ slowedReverbRehydrated: true });
    } catch {
      // Best effort only.
    }
  })().catch(() => {});
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
        // The content script's sticky-volume write is a field-level patch
        // (`{ volume }`), so it merges over the stored object before the shared
        // normalizer fills the rest. The popup still sends every field.
        const tabId = Number(message.tabId ?? sender.tab?.id);
        const patch = message.settings && typeof message.settings === 'object' ? message.settings : {};
        const current = message.siteKey ? (await getStoredSiteSettings())[message.siteKey] : null;
        const settings = normalizeSettings({ ...(current || {}), ...patch });

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
