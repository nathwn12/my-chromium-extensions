const resetBtnEl = /** @type {HTMLButtonElement} */ (document.getElementById('reset-btn'));
const toggle = /** @type {HTMLInputElement} */ (document.getElementById('toggle'));
const gainSlider = /** @type {HTMLInputElement} */ (document.getElementById('gain-slider'));
const gainValueEl = /** @type {HTMLElement} */ (document.getElementById('gain-value'));
const hostnameEl = /** @type {HTMLElement} */ (document.getElementById('hostname'));
const statusPillEl = /** @type {HTMLElement | null} */ (document.getElementById('status-pill'));
const excludeBtnEl = /** @type {HTMLButtonElement | null} */ (document.getElementById('exclude-btn'));
const statusTextEl = /** @type {HTMLElement} */ (document.getElementById('status-text'));

const popupShared = globalThis.TabNormalizerShared;

let hostname = '';
let siteKey = '';
/** @type {number | null} */
let tabId = null;
let hookWasActiveAt = 0;
let lastHookActive = false;
let statusRequestToken = 0;
let saveInFlight = 0;
let lastPersistedGain = null;
let lastLiveSent = null;
let livePreviewInFlight = false;
/** @type {number | null} */
let persistTargetGain = null;
let runtimeActivationState = 'idle';
let runtimeActivationMessage = '';
/** @type {Promise<void> | null} */
let softWakePromise = null;
let excluded = false;
let excludeInFlight = false;
let statusPollStarted = false;
let reloadNoticePending = false;
const EXCLUDED_TEXT = 'Excluded. Nothing runs on this site. Reload restores this page.';
const RELOAD_NOTICE_TEXT = 'Enabled. Reload applies this.';
const RELOADING_TEXT = 'Reloading to activate…';
const PAGE_OWNED_TEXT = 'This page plays its audio through its own graph, so it cannot be normalized.';
const ACTIVE_STALE_MS = 3000;


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
  void pumpLivePreview();
});

gainSlider.addEventListener('change', () => {
  if (gainSlider.disabled) return;
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
  void saveResetInner();
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

    toggle.checked = state ? Boolean(state.enabled) : false;
    gainSlider.value = String(popupShared.clampGainDb(state?.gainDb));
    renderGain(gainSlider.value);
    lastPersistedGain = popupShared.clampGainDb(state?.gainDb);
    lastLiveSent = null;
    excluded = Boolean(state?.excluded);
    toggle.disabled = false;
    applyExcludedState();
    syncGainControlState();

    if (excluded) {
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
    excludeBtnEl.textContent = excluded ? 'Stop excluding' : 'Exclude site';
    excludeBtnEl.dataset.excluded = excluded ? 'true' : 'false';
  }
  if (excluded) {
    toggle.disabled = true;
    gainSlider.disabled = true;
    renderStatus({ indicator: 'gray', text: EXCLUDED_TEXT, excluded: true });
    return;
  }
  toggle.disabled = false;
  syncGainControlState();
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
  renderStatus({ indicator: 'gray', text: statusText });
}



async function toggleSite() {
  if (!siteKey) {
    toggle.checked = !toggle.checked;
    return;
  }
  reloadNoticePending = false;
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
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { enabled: wanted },
    });
    requireStoredTruth(res);
    applyControlState({ enabled: res.enabled, gainDb: res.gainDb });

    if (res.enabled) {
      const activation = res.activation && typeof res.activation === 'object'
        ? /** @type {Record<string, unknown>} */ (res.activation)
        : null;
      const activationState = activation ? String(activation.state || '') : '';
      if (activationState === 'reloading') {
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
  }
}



async function saveGainInner(gainDb) {
  if (!toggle.checked) return;
  reloadNoticePending = false;
  saveInFlight += 1;
  const wantedGain = popupShared.clampGainDb(gainDb);
  persistTargetGain = wantedGain;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      siteKey,
      tabId,
      set: { gainDb: wantedGain },
    });
    requireStoredTruth(res);
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

async function persistDragGain() {
  if (!toggle.checked) return;
  const gainDb = popupShared.clampGainDb(gainSlider.value);
  if (gainDb === lastPersistedGain || gainDb === persistTargetGain) return;
  await saveGainInner(gainDb);
}

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
    const doc = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_STATUS' }, { frameId: 0 });
    if (requestToken !== statusRequestToken) return;
    const docSite = typeof doc?.siteKey === 'string' ? popupShared.getSiteKey(doc.siteKey) : '';
    if (!docSite || docSite !== siteKey) return;
    const enabled = Boolean(doc?.enabled);
    const hookAlive = Boolean(doc?.hookAlive);
    const hookActive = Boolean(doc?.hookActive);
    // Armed is not processing. Only a verified receipt paints the pill Active;
    // older documents without the field fall back to their hookActive report.
    const processing = doc?.processing === undefined ? hookActive : Boolean(doc.processing);
    const hookPresent = doc?.hookPresent === false ? false : true;
    const unprocessed = Number(doc?.unprocessed) || 0;
    const activating = Boolean(doc?.activating);
    const lastError = String(doc?.lastError || '');

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
      hookActive: processing,
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
        processing,
        activating,
        lastError,
        hookPresent,
        unprocessed,
      }),
    });
  } catch {
    if (requestToken !== statusRequestToken) return;
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
 * @param {{ enabled: boolean, processing: boolean, activating: boolean, lastError: string, hookPresent?: boolean, unprocessed?: number }} state
 */
function getStatusText({ enabled, processing, activating, lastError, hookPresent, unprocessed }) {
  if (enabled && lastError) return lastError;
  if (enabled && processing) return 'Normalizer active.';
  if (enabled && runtimeActivationState === 'reloading') {
    return runtimeActivationMessage || RELOADING_TEXT;
  }
  if (enabled && runtimeActivationState === 'reload') {
    return RELOAD_NOTICE_TEXT;
  }
  if (enabled && (activating || runtimeActivationState === 'pending')) {
    return runtimeActivationMessage || 'Enabling on this tab…';
  }
  if (enabled && hookPresent === false) return RELOAD_NOTICE_TEXT;
  if (enabled && Number(unprocessed) > 0) return PAGE_OWNED_TEXT;
  if (enabled) return 'Enabled. Waiting for audio.';
  return 'Off for this site.';
}

/**
 * @param {{ indicator: string, text: string, excluded?: boolean }} status
 */
function renderStatus({ indicator, text, excluded: isExcluded }) {
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
}

function syncGainControlState() {
  gainSlider.disabled = toggle.disabled || !toggle.checked;
}
