const resetBtnEl = /** @type {HTMLButtonElement} */ (document.getElementById('reset-btn'));
const toggle = /** @type {HTMLInputElement} */ (document.getElementById('toggle'));
const gainSlider = /** @type {HTMLInputElement} */ (document.getElementById('gain-slider'));
const gainValueEl = /** @type {HTMLElement} */ (document.getElementById('gain-value'));
const hostnameEl = /** @type {HTMLElement} */ (document.getElementById('hostname'));
const statusPillEl = /** @type {HTMLElement | null} */ (document.getElementById('status-pill'));
const excludeBtnEl = /** @type {HTMLButtonElement | null} */ (document.getElementById('exclude-btn'));
const statusTextEl = /** @type {HTMLElement} */ (document.getElementById('status-text'));
/** @type {NodeListOf<HTMLButtonElement>} */
const presetButtons = document.querySelectorAll('[data-preset]');

const popupShared = globalThis.TabNormalizerShared;

const PRESETS = {
  speech: -3,
  music: 0,
  boost: 3,
};

let hostname = '';
let siteKey = '';
let tabId = null;
let hookWasActiveAt = 0;
let lastHookActive = false;
let statusRequestToken = 0;
let saveInFlight = 0;
// Persist baseline: the last gain value confirmed by the background (or
// freshly read). `change`+`pointerup` both fire on a mouse release; the pair
// persists exactly once because the second sees an unchanged baseline.
// `lastLiveSent` is the newest drag-preview value applied transiently to the
// tab; while it differs from the baseline the 750 ms poll must not snap the
// slider back.
let lastPersistedGain = null;
let lastLiveSent = null;
let livePreviewInFlight = false;
// Value with a persist currently in flight. `change` and `pointerup` fire
// back-to-back on a mouse release while the first persist is still in
// flight (baseline updates only on success), so the baseline alone cannot
// dedupe the pair — the in-flight target can.
let persistTargetGain = null;
let runtimeActivationState = 'idle';
let runtimeActivationMessage = '';
let softWakePromise = null;
// Per-site exclusion, as stored. Outranks `enabled` entirely: while excluded
// the switch and the slider are disabled and nothing runs on the site. Only
// the flag is ever written, so undo restores the previous enabled/gainDb.
let excluded = false;
let excludeInFlight = false;
let statusPollStarted = false;
// Set when the user enables (or un-excludes) a site on this popup: the live
// document is not armed, so the notice replaces the ordinary status line.
let reloadNoticePending = false;
const EXCLUDED_TEXT = 'Excluded. Nothing runs on this site. Reload restores this page.';
// One residual reload case, stated once and quietly: the FIRST-ever enable of a
// host, where no page hook exists in the loaded document to start. A host that
// has been enabled before is applied live, and the popup must not say this.
const RELOAD_NOTICE_TEXT = 'Enabled. Reload applies this.';
// The first-ever enable of a host reloads its tab automatically; this is what
// the popup says while that happens (no control, one line plus the pill).
const RELOADING_TEXT = 'Reloading to activate…';
// A verdict, not silence: the page plays this audio through its own Web Audio
// graph, so the one source per element rule means we can never route it.
const PAGE_OWNED_TEXT = 'This page plays its audio through its own graph, so it cannot be normalized.';
const ACTIVE_STALE_MS = 3000;

// Single owner: the background owns persisted state and applies intents.
// This popup sends field-level intents (`set` with ONLY the changed field)
// with no timestamps and no ordering token. Dispatch is immediate with no
// in-memory queue. Ordering is last-accepted-write-wins: the background
// applies an intent's fields to the live record, writes the whole record
// back in one `set`, bumps the per-site `seq` audit counter (observability
// only, never a gate), and returns the stored truth. Nothing is ever
// rejected on ordering grounds. Accepted trade (deliberate): if two popups
// race the same field and one message is delayed past a newer one, the later
// *arrival* wins rather than the later action; there is no clock-free way to
// distinguish those, the window is milliseconds between two
// simultaneously-open popups, and the wall-clock alternative locked a field
// out until the clock caught up. The popup always renders what the
// background returned, never what it sent; a response missing the stored
// truth is a failure, not a success.
// Gain persistence: a slider drag persists ONCE (on `change`/`pointerup`,
// deduped to one write per value), never per `input` tick — a 30-step drag
// used to cost ~90 storage gets, 30 tab queries and 60 messages. During the
// drag each tick only renders locally and live-applies the latest value to
// the tab as a transient session preview (no storage, no broadcast); the
// release-time persist clears the preview via the storage change it makes.
// No `unload` flush: every change is persisted on its `change`/
// `pointerup` event (RESEARCH §6: the popup document is unloaded on close
// with no flush facility).

/**
 * Require the background's stored truth. The popup renders what the
 * background returned, never what it sent: a response missing the stored
 * fields is a failure, not a success.
 * @param {unknown} res
 */
function requireStoredTruth(res) {
  if (!res || typeof res !== 'object') throw new Error('save failed: no stored truth');
  const r = /** @type {Record<string, unknown>} */ (res);
  if (r.ok === false) throw new Error(String(r.error || 'save failed'));
  if (typeof r.enabled !== 'boolean'
    || !Number.isFinite(Number(r.gainDb))) {
    throw new Error('save failed: response carries no stored truth');
  }
  return r;
}

/**
 * Re-read the stored truth and apply it to the controls.
 * Rejects when the background does not report ok so callers
 * never mistake a failed read for the stored truth.
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function revertToStoredTruth() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_SITE_STATE', hostname: siteKey });
  if (!state || state.ok !== true) {
    throw new Error(String((state && state.error) || 'read failed'));
  }
  applyControlState({ enabled: state.enabled, gainDb: state.gainDb });
  lastPersistedGain = popupShared.clampGainDb(state.gainDb);
  lastLiveSent = null;
  excluded = Boolean(state.excluded);
  applyExcludedState();
  return state;
}

/**
 * @param {string} text
 */
function reportWriteError(text) {
  renderStatus({ indicator: 'red', text });
}

void init();

toggle.addEventListener('change', () => {
  void toggleSite();
});

gainSlider.addEventListener('input', () => {
  if (gainSlider.disabled) return;
  const gainDb = popupShared.clampGainDb(gainSlider.value);
  gainSlider.value = String(gainDb);
  renderGain(gainDb);
  // Drag preview only: render locally and live-apply the latest value to
  // the tab as a transient session override (no storage read, no write, no
  // broadcast). Persistence waits for `change`/`pointerup` below.
  void pumpLivePreview();
});

gainSlider.addEventListener('change', () => {
  if (gainSlider.disabled) return;
  // The release-time persist: one field-level intent per value. `change`
  // and `pointerup` both fire on a mouse release; the dedupe inside makes
  // the pair exactly one storage write and one broadcast.
  void persistDragGain();
});

gainSlider.addEventListener('pointerup', () => {
  if (gainSlider.disabled) return;
  void persistDragGain();
});

gainSlider.addEventListener('pointerdown', () => {
  void requestSliderSoftWake();
});

resetBtnEl.addEventListener('click', () => {
  if (gainSlider.disabled) return;
  gainSlider.value = '0';
  renderGain(0);
  // Reset is ONE single-field intent — gain 0 in a SINGLE message and a
  // SINGLE per-site storage write.
  void saveResetInner();
});

presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const presetGain = PRESETS[button.dataset.preset];
    if (typeof presetGain !== 'number') return;
    applyPreset(presetGain);
  });
});

if (excludeBtnEl) {
  excludeBtnEl.addEventListener('click', () => {
    void toggleExclusion();
  });
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      hostnameEl.textContent = 'Unsupported';
      disableAll('Not available on this page.');
      return;
    }

    tabId = tab.id ?? null;
    hostname = popupShared.extractHostname(tab.url);
    siteKey = popupShared.getSiteKey(hostname);
    if (!hostname) {
      hostnameEl.textContent = 'Unsupported';
      disableAll('Not available on this page.');
      return;
    }

    if (!/^https?:\/\//i.test(tab.url)) {
      hostnameEl.textContent = 'Unsupported';
      disableAll('Not available on this page.');
      return;
    }

    hostnameEl.textContent = hostname;

    const state = await chrome.runtime.sendMessage({ type: 'GET_SITE_STATE', hostname: siteKey });

    // Authority first: the stored per-site record is the truth.
    toggle.checked = state ? Boolean(state.enabled) : false;
    gainSlider.value = String(popupShared.clampGainDb(state?.gainDb));
    renderGain(gainSlider.value);
    lastPersistedGain = popupShared.clampGainDb(state?.gainDb);
    lastLiveSent = null;
    excluded = Boolean(state?.excluded);
    toggle.disabled = false;
    applyExcludedState();
    syncGainControlState();
    syncPresetControlState();

    if (excluded) {
      // No polling at all while excluded: nothing runs, nothing to poll.
      renderStatus({ indicator: 'gray', text: EXCLUDED_TEXT, excluded: true });
    } else if (toggle.checked) {
      await refreshDocumentStatus();
    } else {
      renderStatus({ indicator: 'gray', text: 'Off for this site.' });
    }

    if (!excluded) startStatusPolling();
  } catch {
    hostnameEl.textContent = 'Unsupported';
    disableAll('Extension status unavailable.');
  }
}

function startStatusPolling() {
  if (statusPollStarted) return;
  statusPollStarted = true;
  setInterval(() => {
    void refreshDocumentStatus();
  }, 750);
}

/**
 * Render the exclusion: the switch and the slider are disabled and the one
 * quiet line says why. The button flips into its "stop excluding" state.
 */
function applyExcludedState() {
  if (excludeBtnEl) {
    excludeBtnEl.setAttribute('aria-pressed', excluded ? 'true' : 'false');
    excludeBtnEl.setAttribute('aria-label', excluded ? 'Stop excluding this site' : 'Exclude this site');
    excludeBtnEl.title = excluded ? 'Stop excluding this site' : 'Exclude this site';
  }
  if (excluded) {
    toggle.disabled = true;
    gainSlider.disabled = true;
    syncPresetControlState();
    renderStatus({ indicator: 'gray', text: EXCLUDED_TEXT, excluded: true });
    return;
  }
  toggle.disabled = false;
  syncGainControlState();
  syncPresetControlState();
}

/**
 * Flip the exclusion. ONE field-level intent: `{ excluded: boolean }`. The
 * background owns the record, so `enabled` and `gainDb` are never sent and
 * never touched — undo restores them exactly.
 */
async function toggleExclusion() {
  if (!siteKey || excludeInFlight) return;
  const wanted = !excluded;
  excludeInFlight = true;
  if (excludeBtnEl) excludeBtnEl.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { excluded: wanted },
    });
    requireStoredTruth(res);
    applyControlState({ enabled: res.enabled, gainDb: res.gainDb });
    excluded = Boolean(res.excluded);
    applyExcludedState();
    if (excluded) {
      reloadNoticePending = false;
      runtimeActivationState = 'idle';
      runtimeActivationMessage = '';
      lastHookActive = false;
      hookWasActiveAt = 0;
      renderStatus({ indicator: 'gray', text: EXCLUDED_TEXT, excluded: true });
    } else {
      // The release on exclusion means this document cannot be re-normalized in
      // place: tell the user once, quietly, that a reload restores it.
      reloadNoticePending = true;
      startStatusPolling();
      await refreshDocumentStatus();
    }
  } catch {
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    reportWriteError(reverted
      ? 'Could not save. Reverted.'
      : 'Could not save. State unknown — reopen the popup and try again.');
  } finally {
    excludeInFlight = false;
    if (excludeBtnEl) excludeBtnEl.disabled = false;
  }
}

function disableAll(statusText) {
  toggle.disabled = true;
  gainSlider.disabled = true;
  syncPresetControlState();
  renderStatus({ indicator: 'gray', text: statusText });
}



async function toggleSite() {
  if (!siteKey) {
    toggle.checked = !toggle.checked;
    return;
  }
  // A deliberate action supersedes the quiet reload notice.
  reloadNoticePending = false;
  // Exclusion owns the switch: while excluded it is disabled, and a stale
  // caller must not resurrect audio on the site.
  if (excluded) {
    toggle.checked = false;
    applyExcludedState();
    return;
  }

  if (!toggle.checked) {
    runtimeActivationState = 'idle';
    runtimeActivationMessage = '';
    lastHookActive = false;
    hookWasActiveAt = 0;
  }

  toggle.disabled = true;
  syncGainControlState();

  const wanted = toggle.checked;
  saveInFlight += 1;
  try {
    // Field-level intent: ONLY the toggled field. Never send gainDb
    // from a cache — a concurrent sibling popup may have
    // changed it newer, and a snapshot would revert it. Dispatched
    // immediately with no popup-side chain; the background applies on
    // arrival (last-accepted-write-wins) and returns the stored truth.
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { enabled: wanted },
    });
    requireStoredTruth(res);
    // Render what the background returned, never what was sent.
    applyControlState({ enabled: res.enabled, gainDb: res.gainDb });

    if (res.enabled) {
      // The background decides: a host that has been enabled before loads with
      // the page hook in place, so this enable is live and the popup must not
      // claim otherwise. The one residual reload case is the FIRST-ever enable
      // of a host (no hook in the document to start). A response with no
      // activation field is treated as the conservative case.
      const activation = res.activation && typeof res.activation === 'object'
        ? /** @type {Record<string, unknown>} */ (res.activation)
        : null;
      const activationState = activation ? String(activation.state || '') : '';
      if (activationState === 'reloading') {
        // The background already reloaded (or is about to): say so, once, and
        // never ask the user for an action they do not have to take.
        reloadNoticePending = false;
        runtimeActivationState = 'reloading';
        runtimeActivationMessage = String(activation?.message || RELOADING_TEXT);
        renderStatus({ indicator: 'gray', text: runtimeActivationMessage });
      } else if (activationState !== 'live' && activationState !== 'pending') {
        reloadNoticePending = true;
        runtimeActivationState = 'reload';
        runtimeActivationMessage = RELOAD_NOTICE_TEXT;
        renderStatus({ indicator: 'gray', text: RELOAD_NOTICE_TEXT });
      } else {
        reloadNoticePending = false;
        runtimeActivationState = 'pending';
        runtimeActivationMessage = 'Enabling on this tab…';
        renderStatus({ indicator: 'gray', text: runtimeActivationMessage });
      }
    } else {
      // Immediate apply for the current tab's TOP FRAME ONLY (frameId 0:
      // RESEARCH §5.3). The named siteKey keeps every other frame from
      // acting on this as defence in depth.
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, {
          type: 'SET_DOCUMENT_STATE',
          siteKey,
          enabled: false,
        }, { frameId: 0 }).catch(() => {});
      }
    }
    await refreshDocumentStatus();
  } catch {
    // A failed write must not look like a success: revert the control to
    // the stored truth and surface it on the existing status line. If the
    // recovery read itself failed, the state is UNKNOWN — never claim a
    // revert that never happened.
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    await refreshDocumentStatus();
    reportWriteError(reverted ? 'Could not save. Reverted.' : 'Could not save. State unknown — reopen the popup and try again.');
  } finally {
    saveInFlight -= 1;
    toggle.disabled = false;
    syncGainControlState();
    syncPresetControlState();
  }
}



async function saveGainInner(gainDb) {
  if (!toggle.checked) return;
  // A deliberate action supersedes the quiet reload notice.
  reloadNoticePending = false;
  saveInFlight += 1;
  const wantedGain = popupShared.clampGainDb(gainDb);
  persistTargetGain = wantedGain;
  try {
    // Field-level intent: ONLY gainDb. Never send enabled
    // from this popup's cache — a sibling popup may own a newer value.
    // The background applies on arrival and returns the stored truth.
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { gainDb: wantedGain },
    });
    requireStoredTruth(res);
    // Render the returned truth, never the sent value.
    const nextGain = popupShared.clampGainDb(res.gainDb);
    gainSlider.value = String(nextGain);
    renderGain(nextGain);
    lastPersistedGain = nextGain;
    lastLiveSent = null;
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SET_DOCUMENT_STATE',
        siteKey,
        enabled: toggle.checked,
        gainDb: nextGain,
      }, { frameId: 0 }).catch(() => {});
    }
  } catch {
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    reportWriteError(reverted ? 'Could not save gain. Reverted.' : 'Could not save gain. State unknown — reopen the popup and try again.');
  } finally {
    saveInFlight -= 1;
    if (saveInFlight === 0) persistTargetGain = null;
  }
}

// Release-time persist for a slider drag: one field-level intent per value.
// Called by both `change` and `pointerup` (both fire on a mouse release);
// the baseline + in-flight-target dedupe makes the pair exactly one storage
// write and — via the background's single broadcast per write — one broadcast.
async function persistDragGain() {
  if (!toggle.checked) return;
  const gainDb = popupShared.clampGainDb(gainSlider.value);
  if (gainDb === lastPersistedGain || gainDb === persistTargetGain) return;
  await saveGainInner(gainDb);
}

// Drag preview: live-apply the slider's latest value to the tab as a
// transient session override (no storage read, no write, no broadcast), at
// most one send outstanding; a tick that lands mid-send re-pumps once so
// the release-time persist always carries the final value.
async function pumpLivePreview() {
  if (livePreviewInFlight || !tabId || !siteKey || !toggle.checked) return;
  livePreviewInFlight = true;
  try {
    const gainDb = popupShared.clampGainDb(gainSlider.value);
    lastLiveSent = gainDb;
    await chrome.tabs.sendMessage(tabId, {
      type: 'SET_DOCUMENT_STATE',
      siteKey,
      enabled: true,
      gainDb,
      transient: true,
    }, { frameId: 0 }).catch(() => {});
  } finally {
    livePreviewInFlight = false;
  }
  if (toggle.checked && popupShared.clampGainDb(gainSlider.value) !== lastLiveSent) {
    void pumpLivePreview();
  }
}

function hasUnsavedPreview() {
  return lastLiveSent !== null && lastLiveSent !== lastPersistedGain;
}

/**
 * Reset gain in ONE message / ONE storage write.
 * Field-level: ONLY the field the reset touches — never `enabled`.
 * The field applies and the popup renders the returned truth,
 * never the sent 0.
 */
async function saveResetInner() {
  if (!toggle.checked) return;
  saveInFlight += 1;
  persistTargetGain = 0;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { gainDb: 0 },
    });
    requireStoredTruth(res);
    // Render the returned truth, never the sent value: if the background
    // stored something else, acknowledging 0 would claim a change
    // that never happened.
    const nextGain = popupShared.clampGainDb(res.gainDb);
    gainSlider.value = String(nextGain);
    renderGain(nextGain);
    lastPersistedGain = nextGain;
    lastLiveSent = null;
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SET_DOCUMENT_STATE',
        siteKey,
        enabled: toggle.checked,
        gainDb: nextGain,
      }, { frameId: 0 }).catch(() => {});
    }
  } catch {
    let reverted = false;
    try {
      await revertToStoredTruth();
      reverted = true;
    } catch {}
    reportWriteError(reverted ? 'Could not save. Reverted.' : 'Could not save. State unknown — reopen the popup and try again.');
  } finally {
    saveInFlight -= 1;
    if (saveInFlight === 0) persistTargetGain = null;
  }
}

async function requestSliderSoftWake() {
  if (softWakePromise || !siteKey || !tabId) return;
  if (!toggle.checked && runtimeActivationState !== 'pending' && runtimeActivationState !== 'active') return;

  softWakePromise = (async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'SOFT_RECHECK_DOCUMENT',
        siteKey,
        tabId,
      });
      if (res?.activation?.state) {
        runtimeActivationState = String(res.activation.state);
        runtimeActivationMessage = String(res.activation.message || '');
      }
    } catch {
      // Restricted or unreachable tabs can fail quietly here.
    } finally {
      try {
        await refreshDocumentStatus();
      } finally {
        softWakePromise = null;
      }
    }
  })();

  await softWakePromise;
}

function applyPreset(gainDb) {
  if (gainSlider.disabled) return;

  const nextGain = popupShared.clampGainDb(gainDb);
  gainSlider.value = String(nextGain);
  renderGain(nextGain);
  // Immediate persist (no debounce, no chain): the preset click IS the
  // user's change event and dispatches its own field-level intent at once.
  void saveGainInner(nextGain);
}

async function refreshDocumentStatus() {
  const requestToken = ++statusRequestToken;

  if (excluded) {
    renderStatus({ indicator: 'gray', text: EXCLUDED_TEXT, excluded: true });
    return;
  }

  if (!toggle.checked && runtimeActivationState !== 'pending' && runtimeActivationState !== 'active') {
    renderStatus({ indicator: 'gray', text: 'Off for this site.' });
    return;
  }

  const fallbackIndicator = popupShared.getPopupIndicator({
    enabled: toggle.checked,
    hookAlive: false,
    hookActive: false,
    lastError: '',
  });

  if (!tabId) {
    renderStatus({ indicator: fallbackIndicator, text: toggle.checked ? 'Waiting for tab status…' : 'Off for this site.' });
    return;
  }

  try {
    // Defect 1: target the TOP FRAME ONLY. Without frameId the message fires
    // in every frame (RESEARCH §5.1) and the sender gets one arbitrary answer
    // (RESEARCH §5.2: "one of answers"), so an embedded cross-origin iframe's
    // state could overwrite the selected site's controls. frameId 0 is the
    // documented main-frame id (RESEARCH §5.3) and needs no new permission.
    const doc = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_STATUS' }, { frameId: 0 });
    if (requestToken !== statusRequestToken) return;
    // Defence in depth: the content script names its siteKey; a reply that
    // does not name THIS site (a non-top frame's answer, a stale tab) must
    // never overwrite the popup's controls.
    const docSite = typeof doc?.siteKey === 'string' ? popupShared.getSiteKey(doc.siteKey) : '';
    if (!docSite || docSite !== siteKey) return;
    const enabled = Boolean(doc?.enabled);
    const hookAlive = Boolean(doc?.hookAlive);
    const hookActive = Boolean(doc?.hookActive);
    // Explicitly reported only: an older document that does not answer the
    // field must not be described as needing a reload.
    const hookPresent = doc?.hookPresent === false ? false : true;
    const unprocessed = Number(doc?.unprocessed) || 0;
    const activating = Boolean(doc?.activating);
    const lastError = String(doc?.lastError || '');

    // A save in flight owns the controls: the 750ms poll must not snap
    // them back to pre-save document state mid-write. A drag preview owns
    // them too: while the transient preview differs from the persisted
    // baseline the poll reports status without touching the slider.
    if (saveInFlight === 0 && !hasUnsavedPreview()) {
      applyControlState({
        enabled,
        gainDb: doc?.gainDb,
      });
    }

    if (hookActive) {
      hookWasActiveAt = Date.now();
      lastHookActive = true;
    }

    const recentlyActive = hookActive || (lastHookActive && enabled && hookAlive && (Date.now() - hookWasActiveAt) < ACTIVE_STALE_MS);

    const nextIndicator = popupShared.getPopupIndicator({
      enabled,
      hookAlive,
      hookActive: recentlyActive,
      lastError,
    });

    if (!enabled) {
      runtimeActivationState = 'idle';
      runtimeActivationMessage = '';
    } else if (lastError) {
      runtimeActivationState = 'idle';
      runtimeActivationMessage = '';
    } else if (hookAlive || recentlyActive) {
      runtimeActivationState = 'active';
      runtimeActivationMessage = '';
    } else if (activating || runtimeActivationState === 'pending') {
      runtimeActivationState = 'pending';
    } else {
      runtimeActivationState = 'idle';
      runtimeActivationMessage = '';
    }

    renderStatus({
      indicator: nextIndicator,
      text: getStatusText({
        enabled,
        hookActive: recentlyActive,
        activating,
        lastError,
        hookPresent,
        unprocessed,
      }),
    });
  } catch {
    if (requestToken !== statusRequestToken) return;
    if (toggle.checked && runtimeActivationState === 'restricted') {
      renderStatus({ indicator: 'gray', text: runtimeActivationMessage || 'Enabled. Reload on a supported page.' });
      return;
    }
    // No content script in this document: either the tab is reloading right now
    // (a first-ever enable), or there was no hook to start and the notice is
    // the honest answer.
    if (toggle.checked && runtimeActivationState === 'reloading') {
      renderStatus({ indicator: 'gray', text: runtimeActivationMessage || RELOADING_TEXT });
      return;
    }
    if (toggle.checked && runtimeActivationState === 'reload') {
      renderStatus({ indicator: 'gray', text: RELOAD_NOTICE_TEXT });
      return;
    }

    renderStatus({
      indicator: fallbackIndicator,
      text: toggle.checked
        ? (runtimeActivationMessage || 'Enabled. Waiting for this page.')
        : 'Off for this site.',
    });
  }
}

/**
 * @param {{ enabled: boolean, hookActive: boolean, activating: boolean, lastError: string, hookPresent?: boolean, unprocessed?: number }} state
 */
function getStatusText({ enabled, hookActive, activating, lastError, hookPresent, unprocessed }) {
  if (enabled && lastError) return lastError;
  if (enabled && hookActive) return 'Normalizer active.';
  if (enabled && runtimeActivationState === 'restricted') {
    return runtimeActivationMessage || 'Enabled. Reload on a supported page.';
  }
  if (enabled && runtimeActivationState === 'reloading') {
    return runtimeActivationMessage || RELOADING_TEXT;
  }
  if (enabled && runtimeActivationState === 'reload') {
    return RELOAD_NOTICE_TEXT;
  }
  if (enabled && (activating || runtimeActivationState === 'pending')) {
    return runtimeActivationMessage || 'Enabling on this tab…';
  }
  // The document answered and says it has no page hook: this tab loaded before
  // the hook existed, so this is the one case that really needs a reload.
  if (enabled && hookPresent === false) return RELOAD_NOTICE_TEXT;
  // The page wires this audio through its own Web Audio graph. We can never
  // take it over (one MediaElementSource per element), so say so instead of
  // claiming the page is normalized or forcing silence.
  if (enabled && Number(unprocessed) > 0) return PAGE_OWNED_TEXT;
  if (enabled) return 'Enabled. Waiting for audio.';
  return 'Off for this site.';
}

/**
 * @param {{ indicator: string, text: string, excluded?: boolean }} status
 */
function renderStatus({ indicator, text, excluded: isExcluded }) {
  // One quiet line, no control: while the reload notice is pending it replaces
  // the ordinary status text (the excluded state already carries its own).
  const shown = !isExcluded && reloadNoticePending && toggle.checked ? RELOAD_NOTICE_TEXT : text;
  statusTextEl.textContent = shown;
  if (!statusPillEl) return;
  if (isExcluded) {
    statusPillEl.textContent = 'Excluded';
    statusPillEl.dataset.state = 'off';
    return;
  }
  if (shown === RELOAD_NOTICE_TEXT) {
    statusPillEl.textContent = 'Reload';
    statusPillEl.dataset.state = 'off';
    return;
  }
  if (shown === RELOADING_TEXT) {
    statusPillEl.textContent = 'Reloading';
    statusPillEl.dataset.state = 'off';
    return;
  }
  if (shown === PAGE_OWNED_TEXT) {
    statusPillEl.textContent = 'Limited';
    statusPillEl.dataset.state = 'off';
    return;
  }
  if (indicator === 'green') {
    statusPillEl.textContent = 'Active';
    statusPillEl.dataset.state = 'connected';
  } else if (indicator === 'red') {
    statusPillEl.textContent = 'Error';
    statusPillEl.dataset.state = 'error';
  } else if (/off for this site/i.test(text)) {
    statusPillEl.textContent = 'Off';
    statusPillEl.dataset.state = 'off';
  } else {
    statusPillEl.textContent = 'Waiting';
    statusPillEl.dataset.state = 'off';
  }
}

function renderGain(gainDb) {
  const numeric = popupShared.clampGainDb(gainDb);
  const prefix = numeric > 0 ? '+' : '';
  gainValueEl.textContent = `${prefix}${numeric.toFixed(1)} dB`;
}

function applyControlState({ enabled, gainDb }) {
  toggle.checked = Boolean(enabled);
  gainSlider.value = String(popupShared.clampGainDb(gainDb));
  renderGain(gainSlider.value);
  lastPersistedGain = popupShared.clampGainDb(gainDb);
  syncGainControlState();
  syncPresetControlState();
}

function syncGainControlState() {
  gainSlider.disabled = toggle.disabled || !toggle.checked;
}

function syncPresetControlState() {
  const disabled = toggle.disabled || !toggle.checked;
  for (const button of presetButtons) {
    button.disabled = disabled;
  }
}

// No `unload` handler by design (defect 3): every user change is persisted
// immediately on its `change`/`input` event, so there is never pending work
// for teardown to flush. RESEARCH §6 documents no flush-on-teardown facility
// and warns async teardown work is not guaranteed to complete.
