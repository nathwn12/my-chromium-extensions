/**
 * Bridge status vocabulary, shared by the worker, the native host and the
 * extension surfaces.
 *
 * Two axes, deliberately separate:
 *
 *  - AVAILABILITY: can presence reach Discord at all?
 *      unknown | available | unavailable
 *      with a reason: arrpc-closed | host-missing | rejected | hung
 *  - BRIDGE: what is the native port doing?
 *      idle | connecting | connected | waiting | error
 *
 * Absence of arRPC is never an error. Only a rejected application ID (and a
 * host that stays hung after bounded retries) needs the user to act. The raw
 * diagnostic is carried in `lastError` for logs and the options diagnostics;
 * the UI only ever renders the friendly copy below.
 *
 * This module is pure: no `chrome`, no Node, no timers. The worker imports it
 * directly; the native host imports it to label a failure on the wire; the
 * popup and options import the same labels so a state cannot drift.
 */

export const STATUS_KEY = "wdrStatus";
export const TRANSPORT = "arrpc";

export const AVAILABILITY = Object.freeze({
  UNKNOWN: "unknown",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

export const BRIDGE = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  WAITING: "waiting",
  ERROR: "error",
});

export const REASON = Object.freeze({
  ARRPC_CLOSED: "arrpc-closed",
  HOST_MISSING: "host-missing",
  REJECTED: "rejected",
  HUNG: "hung",
});

/** Friendly sentence-case copy. No transport names, stack traces or protocol text. */
export const REASON_COPY = Object.freeze({
  [REASON.ARRPC_CLOSED]:
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
  [BRIDGE.WAITING]: "Waiting",
  [BRIDGE.ERROR]: "Error",
  unknown: "Not connected",
});

/** A bounded run of pong timeouts before a hang is worth the user's attention. */
export const HUNG_RETRY_LIMIT = 3;

const PATTERNS = [
  [/no arrpc|arrpc.*(closed|unreachable|unavailable)|connection closed/i, REASON.ARRPC_CLOSED],
  // Nothing listening on the arRPC ports surfaces as ECONNREFUSED, and a
  // listener that stopped mid-frame as ECONNRESET.
  [/\bECONNREFUSED\b|\bECONNRESET\b|\bEHOSTUNREACH\b/i, REASON.ARRPC_CLOSED],
  [
    /(specified )?native messaging host not found|access to the specified native messaging host is forbidden|native host not found/i,
    REASON.HOST_MISSING,
  ],
  [/invalid client id|rejected the handshake|handshake rejected|invalid client_id|rejected application/i, REASON.REJECTED],
  [
    /(connect|handshake|reply) timeout|timed out|pong timeout|pong overdue|native host disconnected|native host crashed/i,
    REASON.HUNG,
  ],
];

const REASON_KINDS = new Set(Object.values(REASON));

function hasReason(kind) {
  return REASON_KINDS.has(kind);
}

export function copyForReason(kind, exhausted = false) {
  if (kind === REASON.HUNG && exhausted) return REASON_COPY[REASON.HUNG + ":exhausted"];
  return REASON_COPY[hasReason(kind) ? kind : REASON.HUNG];
}

/**
 * Classify a raw native/worker diagnostic.
 *
 * @param {unknown} detail raw diagnostic (kept verbatim in `detail`)
 * @param {{ retries?: number, reason?: string, fatal?: boolean }} [options]
 *   `reason` is a hint from the wire; `retries` counts consecutive hangs;
 *   `fatal` is only set for a permanent rejection.
 */
export function classifyBridgeFailure(detail, options = {}) {
  const text = typeof detail === "string" ? detail : "";
  const retries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0;
  const hint = typeof options.reason === "string" && hasReason(options.reason) ? options.reason : null;
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

/** Friendly labels for the host's per-source map (`{youtube:"connected",...}`). */
export function presentSources(sources = {}) {
  const out = {};
  for (const [source, state] of Object.entries(sources || {})) {
    out[source] =
      typeof state === "string" && Object.prototype.hasOwnProperty.call(BRIDGE_LABELS, state)
        ? BRIDGE_LABELS[state]
        : BRIDGE_LABELS.unknown;
  }
  return out;
}

/**
 * Resolve the user-facing view of one status payload.
 * `label` is the pill text, `reason` the friendly sentence, `isError` is true
 * only for a rejected application ID or an exhausted hang.
 */
export function presentStatus(status = {}) {
  const state = typeof status.bridgeState === "string" ? status.bridgeState : "unknown";
  const isError = state === BRIDGE.ERROR;
  const isWaiting = state === BRIDGE.WAITING || state === BRIDGE.CONNECTING;
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

/**
 * Pure status classifier used by the worker and its tests.
 *
 * Returns the next `{ bridgeState, lastError, availability, reason, reasonKind }`
 * from one native `status` frame. Absence is neutral: a closed arRPC becomes
 * `waiting` with friendly copy, while the raw diagnostic stays in `lastError`
 * for the options diagnostics. Only a fatal rejection or an exhausted hang is
 * allowed to become `error`.
 */
export const STATUS_DEFAULT = Object.freeze({
  bridgeState: BRIDGE.IDLE,
  lastError: null,
  availability: AVAILABILITY.UNKNOWN,
  reason: null,
  reasonKind: null,
});

export function bridgeStatusOf(current, message, retries = 0) {
  const base = { ...STATUS_DEFAULT, ...(current || {}) };
  if (!message || message.t !== "status") return base;

  if (message.state === BRIDGE.CONNECTED) {
    return {
      ...base,
      bridgeState: BRIDGE.CONNECTED,
      lastError: null,
      availability: AVAILABILITY.AVAILABLE,
      reason: null,
      reasonKind: null,
    };
  }

  if (message.state === BRIDGE.WAITING) {
    const verdict = classifyBridgeFailure(message.detail, { reason: message.reason });
    return {
      ...base,
      bridgeState: verdict.bridgeState,
      lastError: message.detail || verdict.detail || null,
      availability: verdict.availability,
      reason: verdict.reason,
      reasonKind: verdict.kind,
    };
  }

  if (message.state === BRIDGE.ERROR) {
    // The host marks every non-permanent failure `fatal: false`; never promote
    // one to an error just because its diagnostic text matched a pattern.
    const verdict =
      message.fatal === false
        ? {
            ...classifyBridgeFailure(message.detail, { reason: message.reason ?? REASON.HUNG }),
            bridgeState: BRIDGE.WAITING,
            error: null,
            fatal: false,
            retryable: true,
          }
        : classifyBridgeFailure(message.detail, {
            retries,
            fatal: message.fatal === true,
          });
    return {
      ...base,
      bridgeState: verdict.bridgeState,
      lastError: message.detail || verdict.detail || null,
      availability: verdict.availability,
      reason: verdict.reason,
      reasonKind: verdict.kind,
    };
  }

  if (message.state === BRIDGE.CONNECTING) {
    return {
      ...base,
      bridgeState: BRIDGE.CONNECTING,
      availability: AVAILABILITY.UNKNOWN,
      reason: null,
      reasonKind: null,
    };
  }

  return { ...base, bridgeState: String(message.state || "unknown") };
}
