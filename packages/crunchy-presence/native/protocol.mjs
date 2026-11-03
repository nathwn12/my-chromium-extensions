/**
 * Shared message + activity validation for the native host and the extension bridge.
 *
 * Nothing here touches I/O: every function is pure so both the host and the
 * tests can reason about the exact same rules.
 */

export const ACTIVITY_TYPE_WATCHING = 3;
export const MAX_TEXT_LENGTH = 128;
export const MAX_BUTTONS = 2;
export const MAX_BUTTON_LABEL = 32;
export const MAX_ASSET_KEY = 256;
export const MIN_MS_TIMESTAMP = 1e11; // 1973-03-03, anything smaller is seconds or garbage
export const MAX_MS_TIMESTAMP = 1e14; // year 5138
export const MAX_NATIVE_PAYLOAD = 1024 * 1024;

export const CLIENT_ID_RE = /^[0-9]{17,20}$/;
const ASSET_KEY_RE = /^[A-Za-z0-9_:/.-]+$/;
const MESSAGE_TYPES = new Set(['hello', 'activity', 'ping']);

export const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (error) => ({ ok: false, error });
const pass = (value) => ({ ok: true, value });

export function validateClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
    return fail('clientId must be a string of 17-20 digits');
  }
  return pass(clientId);
}

function validateText(value, field) {
  if (typeof value !== 'string') return fail(`${field} must be a string`);
  if (value.length < 2) {
    return fail(`${field} must be at least 2 characters (got ${value.length})`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    return fail(`${field} must be at most ${MAX_TEXT_LENGTH} characters (got ${value.length})`);
  }
  return pass(value);
}

function validateTimestamp(value, field) {
  if (!Number.isInteger(value)) return fail(`${field} must be an integer (milliseconds)`);
  if (value < MIN_MS_TIMESTAMP || value > MAX_MS_TIMESTAMP) {
    return fail(`${field} must be an epoch timestamp in milliseconds`);
  }
  return pass(value);
}

function validateAsset(value, field) {
  if (typeof value !== 'string' || value.length === 0) return fail(`${field} must be a non-empty string`);
  if (value.startsWith('https://')) return pass(value);
  if (value.length > MAX_ASSET_KEY) return fail(`${field} asset key must be at most ${MAX_ASSET_KEY} characters`);
  if (!ASSET_KEY_RE.test(value)) {
    return fail(`${field} must be an https URL or a Discord asset key`);
  }
  return pass(value);
}

function validateButtons(buttons) {
  if (!Array.isArray(buttons)) return fail('buttons must be an array');
  if (buttons.length > MAX_BUTTONS) return fail(`buttons must hold at most ${MAX_BUTTONS} entries`);
  for (const [i, button] of buttons.entries()) {
    if (!isPlainObject(button)) return fail(`buttons[${i}] must be an object`);
    if (typeof button.label !== 'string' || button.label.length === 0) {
      return fail(`buttons[${i}].label must be a non-empty string`);
    }
    if (button.label.length > MAX_BUTTON_LABEL) {
      return fail(`buttons[${i}].label must be at most ${MAX_BUTTON_LABEL} characters`);
    }
    if (typeof button.url !== 'string') return fail(`buttons[${i}].url must be a string`);
    let url;
    try {
      url = new URL(button.url);
    } catch {
      return fail(`buttons[${i}].url must be an absolute URL`);
    }
    if (url.protocol !== 'https:') {
      return fail(`buttons[${i}].url must be an https Crunchyroll URL`);
    }
    if (!/(^|\.)crunchyroll\.com$/i.test(url.hostname)) {
      return fail(`buttons[${i}].url must be an https Crunchyroll URL`);
    }
  }
  return pass(buttons);
}

/**
 * Validate a Discord activity object as the extension may send it.
 * `null` is the documented "clear presence" value.
 */
export function validateActivity(activity) {
  if (activity === null) return pass(null);
  if (!isPlainObject(activity)) return fail('activity must be an object or null');
  if (activity.type !== ACTIVITY_TYPE_WATCHING) {
    return fail(`activity.type must be ${ACTIVITY_TYPE_WATCHING} (watching)`);
  }
  if (activity.details !== undefined) {
    const r = validateText(activity.details, 'activity.details');
    if (!r.ok) return r;
  }
  if (activity.state !== undefined) {
    const r = validateText(activity.state, 'activity.state');
    if (!r.ok) return r;
  }
  if (activity.timestamps !== undefined) {
    const ts = activity.timestamps;
    if (!isPlainObject(ts)) return fail('activity.timestamps must be an object');
    if (ts.start !== undefined) {
      const r = validateTimestamp(ts.start, 'activity.timestamps.start');
      if (!r.ok) return r;
    }
    if (ts.end !== undefined) {
      const r = validateTimestamp(ts.end, 'activity.timestamps.end');
      if (!r.ok) return r;
    }
    if (Number.isInteger(ts.start) && Number.isInteger(ts.end) && ts.end <= ts.start) {
      return fail('activity.timestamps.end must be after activity.timestamps.start');
    }
  }
  if (activity.assets !== undefined) {
    const assets = activity.assets;
    if (!isPlainObject(assets)) return fail('activity.assets must be an object');
    for (const field of ['large_image', 'small_image']) {
      if (assets[field] !== undefined) {
        const r = validateAsset(assets[field], `activity.assets.${field}`);
        if (!r.ok) return r;
      }
    }
    for (const field of ['large_text', 'small_text']) {
      if (assets[field] !== undefined) {
        const r = validateText(assets[field], `activity.assets.${field}`);
        if (!r.ok) return r;
      }
    }
  }
  if (activity.buttons !== undefined) {
    const r = validateButtons(activity.buttons);
    if (!r.ok) return r;
  }
  return pass(activity);
}

/** Validate one extension -> host message envelope. */
export function validateMessage(message) {
  if (!isPlainObject(message)) return fail('message must be a JSON object');
  if (typeof message.t !== 'string' || !MESSAGE_TYPES.has(message.t)) {
    return fail(`message.t must be one of ${[...MESSAGE_TYPES].join(', ')}`);
  }
  if (message.t === 'hello') {
    const r = validateClientId(message.clientId);
    if (!r.ok) return r;
  }
  if (message.t === 'activity') {
    if (!Object.prototype.hasOwnProperty.call(message, 'activity')) {
      return fail('activity message must carry an "activity" field (null clears)');
    }
    const r = validateActivity(message.activity);
    if (!r.ok) return r;
    if (message.id !== undefined && typeof message.id !== 'string') {
      return fail('activity.id must be a string when present');
    }
  }
  return pass(message);
}

/** Status payload shape, kept next to the validators so both sides agree. */
export function statusMessage(state, extra = {}) {
  if (state === 'error') {
    return {
      t: 'status',
      state: 'error',
      detail: typeof extra.detail === 'string' ? extra.detail : 'unknown error',
      code: Number.isInteger(extra.code) ? extra.code : null,
    };
  }
  return {
    t: 'status',
    state: 'connected',
    appName: typeof extra.appName === 'string' ? extra.appName : '',
    user: typeof extra.user === 'string' ? extra.user : '',
  };
}
