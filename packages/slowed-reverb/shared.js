(function (root, factory) {
  const api = factory();

  root.SlowedReverbShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SUPPORTED_HOSTS = new Set(['music.youtube.com']);
  const DEFAULT_SETTINGS = {
    slow: 1,
    reverbIntensity: 0,
    volume: null,
  };

  function clampSlow(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.slow;
    if (numeric < 0.7 || numeric > 1.3) return DEFAULT_SETTINGS.slow;
    return Math.round(numeric * 100) / 100;
  }

  function clampIntensity(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.reverbIntensity;
    if (numeric < 0 || numeric > 1) return DEFAULT_SETTINGS.reverbIntensity;
    return Math.round(numeric * 100) / 100;
  }

  /**
   * A wheel volume is a whole percentage in player scale, so it clamps instead
   * of falling back to a default: 120 -> 100, -5 -> 0. Anything that is not a
   * number (or a numeric string) is "never set", not zero.
   */
  function clampVolume(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.min(100, Math.max(0, Math.round(numeric)));
  }

  function normalizeSettings(raw) {
    const next = raw && typeof raw === 'object' ? raw : {};
    return {
      slow: clampSlow(Object.prototype.hasOwnProperty.call(next, 'slow') ? next.slow : DEFAULT_SETTINGS.slow),
      reverbIntensity: clampIntensity(
        Object.prototype.hasOwnProperty.call(next, 'reverbIntensity') ? next.reverbIntensity : DEFAULT_SETTINGS.reverbIntensity
      ),
      volume: clampVolume(Object.prototype.hasOwnProperty.call(next, 'volume') ? next.volume : DEFAULT_SETTINGS.volume),
    };
  }

  function getDefaultSettings() {
    return normalizeSettings(DEFAULT_SETTINGS);
  }

  function extractHostname(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  function isSupportedHost(hostname) {
    return SUPPORTED_HOSTS.has(String(hostname || '').toLowerCase());
  }

  function isSupportedUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && isSupportedHost(parsed.hostname);
    } catch {
      return false;
    }
  }

  function formatRate(value) {
    return clampSlow(value).toFixed(2) + 'x';
  }

  function formatPercent(value) {
    return Math.round(clampIntensity(value) * 100) + '%';
  }

  function isNeutral(settings) {
    const normalized = normalizeSettings(settings);
    return normalized.slow === 1 && normalized.reverbIntensity === 0;
  }

  function friendlyStatus(live) {
    if (!live || typeof live !== 'object') return 'Waiting for tab';
    if (!live.eligible) return 'Waiting for tab';
    if (live.bypass) return 'Off';
    if (live.attachedCount > 0) return 'Active';
    return 'Waiting for media';
  }

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  function storageSet(items) {
    return chrome.storage.local.set(items);
  }

  async function loadSiteState(siteKey) {
    const result = await storageGet('siteToggles');
    const toggles = result.siteToggles || {};
    return siteKey in toggles ? toggles[siteKey] : null;
  }

  async function saveSiteState(siteKey, enabled) {
    const result = await storageGet('siteToggles');
    const toggles = result.siteToggles || {};
    toggles[siteKey] = enabled;
    await storageSet({ siteToggles: toggles });
  }

  return {
    extractHostname,
    formatPercent,
    formatRate,
    friendlyStatus,
    getDefaultSettings,
    isNeutral,
    isSupportedHost,
    isSupportedUrl,
    normalizeSettings,
    loadSiteState,
    saveSiteState,
  };
});
