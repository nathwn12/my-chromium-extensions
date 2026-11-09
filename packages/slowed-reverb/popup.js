const pageTitleEl = document.getElementById('page-title');
const resetBtnEl = document.getElementById('reset-btn');
const statusPillEl = document.getElementById('status-pill');
const statusTextEl = document.getElementById('status-text');
const powerToggleEl = document.getElementById('power-toggle');
const slowSliderEl = document.getElementById('slow-slider');
const slowReadoutEl = document.getElementById('slow-readout');
const intensitySliderEl = document.getElementById('intensity-slider');
const intensityReadoutEl = document.getElementById('intensity-readout');

const {
  formatPercent,
  formatRate,
  friendlyStatus,
  getDefaultSettings,
  normalizeSettings,
  loadSiteState,
  saveSiteState,
} = globalThis.SlowedReverbShared;
const defaultSettings = getDefaultSettings();

const APPLY_THROTTLE_MS = 40;

let activeTabId = null;
let siteKey = '';
let popupState = {
  eligible: false,
  bypass: false,
  settings: normalizeSettings(),
};
let pollTimer = null;
let lastApplyTime = 0;

void init();

powerToggleEl.addEventListener('change', () => {
  void updateTabBypass(!powerToggleEl.checked);
});

slowSliderEl.addEventListener('input', () => {
  const settings = { ...popupState.settings, slow: Number(slowSliderEl.value) };
  applySettingsToUi(settings);
  throttledApply(settings);
});

slowSliderEl.addEventListener('pointerup', () => {
  const settings = { ...popupState.settings, slow: Number(slowSliderEl.value) };
  applySettingsToUi(settings);
  void applySettings(settings);
});

slowSliderEl.addEventListener('change', () => {
  const settings = { ...popupState.settings, slow: Number(slowSliderEl.value) };
  applySettingsToUi(settings);
  void applySettings(settings);
});

intensitySliderEl.addEventListener('input', () => {
  const settings = { ...popupState.settings, reverbIntensity: Number(intensitySliderEl.value) };
  applySettingsToUi(settings);
  throttledApply(settings);
});

intensitySliderEl.addEventListener('pointerup', () => {
  const settings = { ...popupState.settings, reverbIntensity: Number(intensitySliderEl.value) };
  applySettingsToUi(settings);
  void applySettings(settings);
});

intensitySliderEl.addEventListener('change', () => {
  const settings = { ...popupState.settings, reverbIntensity: Number(intensitySliderEl.value) };
  applySettingsToUi(settings);
  void applySettings(settings);
});

resetBtnEl.addEventListener('click', () => {
  applySettingsToUi(defaultSettings);
  void applySettings(defaultSettings);
});

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    pageTitleEl.textContent = getPageLabel(tab?.url || '');

    if (!activeTabId) {
      setSupportedUi(false);
      renderStatus('gray', 'No active tab.');
      return;
    }

    const state = await chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE', tabId: activeTabId });
    siteKey = state?.siteKey || '';

    const savedToggle = siteKey ? await loadSiteState(siteKey) : null;

    popupState = {
      eligible: Boolean(state?.eligible),
      bypass: savedToggle !== null ? !savedToggle : Boolean(state?.bypass),
      settings: normalizeSettings(state?.settings),
    };

    powerToggleEl.checked = !popupState.bypass;
    applySettingsToUi(popupState.settings);
    setSupportedUi(popupState.eligible);
    await refreshLiveStatus();

    if (popupState.eligible) {
      pollTimer = setInterval(() => {
        void refreshLiveStatus();
      }, 1000);
    }
  } catch {
    setSupportedUi(false);
    renderStatus('gray', 'Waiting for tab');
  }
}

function getPageLabel(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'music.youtube.com') return 'YouTube Music';
  } catch {}
  return 'Unsupported';
}

function setSupportedUi(supported) {
  slowSliderEl.disabled = !supported;
  intensitySliderEl.disabled = !supported;
  powerToggleEl.disabled = !supported;
}

function applySettingsToUi(settings) {
  const normalized = normalizeSettings(settings);
  popupState.settings = normalized;
  slowSliderEl.value = String(normalized.slow);
  intensitySliderEl.value = String(normalized.reverbIntensity);
  slowReadoutEl.textContent = formatRate(normalized.slow);
  intensityReadoutEl.textContent = formatPercent(normalized.reverbIntensity);
}

function throttledApply(settings) {
  const now = Date.now();
  if (now - lastApplyTime >= APPLY_THROTTLE_MS) {
    lastApplyTime = now;
    void applyLiveSettings(settings);
  }
}

async function applyLiveSettings(settings) {
  const normalized = normalizeSettings(settings);
  popupState.settings = normalized;
  if (activeTabId && popupState.eligible) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'APPLY_LIVE_SETTINGS', settings: normalized });
    } catch {
      // Best effort only: the tab may not have a content script yet.
    }
  }
}

async function applySettings(settings) {
  const normalized = normalizeSettings(settings);
  popupState.settings = normalized;

  await Promise.all([
    chrome.runtime.sendMessage({
      type: 'SET_SITE_SETTINGS',
      tabId: activeTabId,
      siteKey,
      settings: normalized,
      persist: true,
    }),
    ...(activeTabId && popupState.eligible
      ? [chrome.tabs.sendMessage(activeTabId, { type: 'APPLY_LIVE_SETTINGS', settings: normalized }).catch(() => {})]
      : []),
  ]);

  await refreshLiveStatus();
}

async function updateTabBypass(bypass) {
  if (!activeTabId) return;
  try {
    const state = await chrome.runtime.sendMessage({
      type: 'SET_TAB_BYPASS',
      tabId: activeTabId,
      bypass,
    });
    popupState.bypass = Boolean(state?.bypass);
    powerToggleEl.checked = !popupState.bypass;

    await refreshLiveStatus();
  } catch {
    powerToggleEl.checked = !popupState.bypass;
    renderStatus('gray', 'Waiting for tab');
  }
}

async function refreshLiveStatus() {
  if (!popupState.eligible || !activeTabId) {
    renderStatus('gray', 'Waiting for tab');
    return;
  }

  try {
    const live = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_LIVE_STATUS' });
    if (!live?.ok) {
      renderStatus('gray', 'Waiting for tab');
      return;
    }

    // Details stay in the console; the popup shows only the four friendly
    // states. A neutral graph is Active, never an error.
    if (live.error) console.debug('[Slowed Reverb]', live.error);
    const dotColor = live.bypass ? 'gray' : live.attachedCount ? 'green' : 'gray';
    renderStatus(dotColor, buildStatusText(live));
  } catch {
    renderStatus('gray', 'Waiting for tab');
  }
}

function buildStatusText(live) {
  return friendlyStatus(live);
}

function renderStatus(indicator, text) {
  statusTextEl.textContent = text;
  if (!statusPillEl) return;
  if (indicator === 'green') {
    statusPillEl.textContent = 'Active';
    statusPillEl.dataset.state = 'connected';
  } else if (indicator === 'red') {
    statusPillEl.textContent = 'Error';
    statusPillEl.dataset.state = 'error';
  } else if (/power off|off for/i.test(text)) {
    statusPillEl.textContent = 'Off';
    statusPillEl.dataset.state = 'off';
  } else {
    statusPillEl.textContent = 'Waiting';
    statusPillEl.dataset.state = 'idle';
  }
}
