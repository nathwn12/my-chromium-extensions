/**
 * Bridge status vocabulary, shared by the worker and both extension surfaces.
 *
 * Two axes, deliberately separate:
 *
 *  - AVAILABILITY: can presence reach Discord at all?
 *      unknown | available | unavailable
 *      with a reason: discord-closed | host-missing | rejected | hung
 *  - BRIDGE: what is the native port doing?
 *      idle | connecting | connected | disconnected | waiting | error
 *
 * Absence of Discord is never an error. Only a rejected application ID (and a
 * host that stays hung after bounded retries) needs the user to act. The raw
 * diagnostic string is carried in `detail`/`lastError` for logs and the options
 * diagnostics; the UI only ever renders the friendly copy below.
 *
 * This module is pure: no `chrome`, no Node, no timers. The worker imports it
 * directly; the host imports it to label a failure on the wire; popup.js and
 * options.js import the same labels so a new state cannot drift between them.
 */

export const AVAILABILITY = Object.freeze({
  UNKNOWN: "unknown",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

export const BRIDGE = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  WAITING: "waiting",
  ERROR: "error",
});

export const REASON = Object.freeze({
  DISCORD_CLOSED: "discord-closed",
  HOST_MISSING: "host-missing",
  REJECTED: "rejected",
  HUNG: "hung",
});

/** Friendly sentence-case copy. No pipe names, stack traces or protocol text. */
export const REASON_COPY = Object.freeze({
  [REASON.DISCORD_CLOSED]:
    "Discord is not running — presence paused, resumes automatically.",
  [REASON.HOST_MISSING]: "Native host not installed — run the installer.",
  [REASON.REJECTED]:
    "Discord rejected this application ID. Check the application ID in Settings.",
  [REASON.HUNG]: "Waiting for Discord to respond.",
  [REASON.HUNG + ":exhausted"]:
    "Discord stopped responding. Restart Discord, then try again.",
});

export const BRIDGE_LABELS = Object.freeze({
  [BRIDGE.IDLE]: "Idle",
  [BRIDGE.CONNECTING]: "Waiting",
  [BRIDGE.CONNECTED]: "Connected",
  [BRIDGE.DISCONNECTED]: "Waiting",
  [BRIDGE.WAITING]: "Waiting",
  [BRIDGE.ERROR]: "Error",
  unknown: "Not connected",
  unavailable: "Waiting",
});

/** A bounded run of pong timeouts before a hang is worth the user's attention. */
export const HUNG_RETRY_LIMIT = 3;

const PATTERNS = [
  [/no discord ipc pipe found/i, REASON.DISCORD_CLOSED],
  // A missing named pipe surfaces as ENOENT on Windows; a closed Discord
  // listener can surface as ECONNREFUSED/ECONNRESET.
  [/\bENOENT\b|\bECONNREFUSED\b|\bECONNRESET\b|connect ENOENT/i, REASON.DISCORD_CLOSED],
  [/discord ipc connection closed|discord ipc dropped|discord ipc pipe closed/i, REASON.DISCORD_CLOSED],
  [/discord ipc not connected/i, REASON.DISCORD_CLOSED],
  [
    /(specified )?native messaging host not found|access to the specified native messaging host is forbidden|native host not found/i,
    REASON.HOST_MISSING,
  ],
  [/invalid client id|rejected the handshake|handshake rejected|invalid client_id/i, REASON.REJECTED],
  [
    /(connect|handshake|reply) timeout|timed out|pong timeout|pong overdue|native host disconnected|native host crashed/i,
    REASON.HUNG,
  ],
];

const REASON_KINDS = new Set(Object.values(REASON));

export function copyForReason(kind, exhausted = false) {
  if (kind === REASON.HUNG && exhausted) return REASON_COPY[REASON.HUNG + ":exhausted"];
  return REASON_COPY[hasReason(kind) ? kind : REASON.HUNG];
}

function hasReason(kind) {
  return REASON_KINDS.has(kind);
}

/**
 * Classify a raw native/worker diagnostic.
 *
 * @param {unknown} detail raw diagnostic (kept verbatim in `detail`)
 * @param {{ retries?: number, reason?: string, fatal?: boolean }} [options]
 *   `reason` is a hint from the wire; `retries` counts consecutive hangs;
 *   `fatal` is only set for a permanent host rejection.
 */
export function classifyBridgeFailure(detail, options = {}) {
  const text = typeof detail === "string" ? detail : "";
  const retries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0;
  const hint = typeof options.reason === "string" && hasReason(options.reason)
    ? options.reason
    : null;
  const matched = PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  // An explicit fatal flag is a permanent rejection by definition; otherwise a
  // hint wins, then the diagnostic pattern, then a neutral transient hang.
  const kind = options.fatal ? REASON.REJECTED : hint ?? matched ?? REASON.HUNG;
  const exhausted = kind === REASON.HUNG && retries >= HUNG_RETRY_LIMIT;
  const isError = kind === REASON.REJECTED || exhausted;

  return {
    kind,
    availability: AVAILABILITY.UNAVAILABLE,
    bridgeState: isError ? BRIDGE.ERROR : BRIDGE.WAITING,
    reason: copyForReason(kind, exhausted),
    // Never surface an expected absence as an error; `detail` stays raw for logs.
    error: isError ? copyForReason(kind, exhausted) : null,
    detail: text,
    retryable: !isError,
    fatal: kind === REASON.REJECTED || Boolean(options.fatal),
  };
}

/**
 * Resolve the user-facing view of one status payload.
 * `label` is the pill text, `reason` the friendly sentence, `isError` is true
 * only for a rejected application ID or an exhausted hang.
 */
export function presentStatus(status = {}) {
  const enabled = status.enabled !== false;
  const state = typeof status.bridgeState === "string" ? status.bridgeState : "unknown";

  if (!enabled) {
    return {
      label: "Off",
      state: "off",
      reason: "Presence is off. Turn it on with the toggle.",
      isError: false,
      isWaiting: false,
    };
  }

  const isError = state === BRIDGE.ERROR;
  const isWaiting =
    state === BRIDGE.WAITING || state === BRIDGE.CONNECTING || state === BRIDGE.DISCONNECTED;
  const known = Object.prototype.hasOwnProperty.call(BRIDGE_LABELS, state);
  const label = known
    ? BRIDGE_LABELS[state]
    : state.charAt(0).toUpperCase() + state.slice(1);

  let reason = null;
  if (isError) {
    reason =
      typeof status.reason === "string" && status.reason
        ? status.reason
        : REASON_COPY[REASON.REJECTED];
  } else if (isWaiting) {
    reason =
      typeof status.reason === "string" && status.reason
        ? status.reason
        : REASON_COPY[REASON.HUNG];
  }

  return { label, state, reason, isError, isWaiting };
}

/** Status payload fields the worker publishes for the surfaces. */
export function failureStatusFields(verdict) {
  return {
    availability: verdict.availability,
    reason: verdict.reason,
    reasonKind: verdict.kind,
    bridgeState: verdict.bridgeState,
  };
}
