/* eslint-disable */

/** Typed interface matching the API returned by shared.js factory function */
interface TabNormalizerSharedApi {
  DEFAULT_GAIN_DB: number;
  clampGainDb: (value: unknown) => number;
  extractHostname: (url: string) => string;
  getSiteKey: (hostname: string) => string;
  getLegacySiteKey: (hostname: string) => string;
  migrateActiveSites: (activeSites: Record<string, boolean>) => Record<string, boolean>;
  migrateSiteSettings: (
    siteSettings: Record<string, unknown>,
    activeSites: Record<string, boolean>
  ) => Record<string, unknown>;
  getSiteConfig: (
    siteSettings: Record<string, unknown>,
    activeSites: Record<string, boolean>,
    hostnameOrSiteKey: string
  ) => { siteKey: string; enabled: boolean; gainDb: number };
  setSiteConfig: (
    siteSettings: Record<string, unknown>,
    activeSites: Record<string, boolean>,
    hostnameOrSiteKey: string,
    updates: Record<string, unknown>
  ) => Record<string, unknown>;
  setSiteEnabled: (
    activeSites: Record<string, boolean>,
    hostnameOrSiteKey: string,
    enabled: boolean
  ) => Record<string, boolean>;
  getContentAction: (state: {
    enabled: boolean;
    injected: boolean;
    hookAlive: boolean;
    seen?: boolean;
  }) => string;
  getPopupIndicator: (state: {
    enabled: boolean;
    hookAlive: boolean;
    hookActive: boolean;
    lastError: string;
  }) => string;
  SITE_KEY_PREFIX: string;
  siteStorageKey: (siteKey: string) => string;
  legacySiteStorageKey: (siteKey: string) => string;
  isSiteStorageKey: (key: string) => boolean;
  siteKeyFromStorageKey: (key: string) => string;
  normalizeSiteRecord: (value: unknown) => { siteKey?: string; enabled: boolean; gainDb: number; seq: number; mirror: boolean; excluded: boolean; seen: boolean };
  migrateLegacyToRecord: (
    siteSettings: Record<string, unknown>,
    activeSites: Record<string, unknown>,
    siteToggles: Record<string, unknown>,
    hostnameOrSiteKey: string
  ) => { enabled: boolean; gainDb: number; seq: number; mirror: boolean; excluded: boolean; seen: boolean } | null;
  hostMatchesSiteKey: (hostname: string, siteKey: string) => boolean;
  isHostExcluded: (hostname: string, excludedKeys: string[] | null | undefined) => boolean;
  ancestorSiteKeys: (hostname: string) => string[];
  siteExcludeMatchPattern: (siteKey: string) => string;
  siteExcludeMatchPatterns: (siteKeys: string[]) => string[];
  siteHostMatchPattern: (siteKey: string) => string;
  siteHostMatchPatterns: (siteKeys: string[]) => string[];

}

interface Window {
  TabNormalizerShared: TabNormalizerSharedApi;
  __tabNormalizerContentScriptV5: { reinject: () => void };
  __tabNormalizerHookV5: { revive: () => void };
  webkitAudioContext?: typeof AudioContext;
}

interface AudioNode {
  __tnConnect?: boolean;
}

interface AudioContextConstructor {
  __tnPatched?: boolean;
}

interface OfflineAudioContextConstructor {
  __tnPatched?: boolean;
}

interface AudioContext {
  __tnMediaSource?: boolean;
}

interface HTMLMediaElement {
  __tnPlay?: boolean;
  __tnWebAudio?: boolean;
  __tnAttached?: boolean;
}


declare function importScripts(...urls: string[]): void;
