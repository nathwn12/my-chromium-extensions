/**
 * Bridge status vocabulary for presence-suite, shared by the worker, the
 * native host and both extension surfaces. Union of the two source extensions:
 *
 *  - AVAILABILITY: unknown | available | unavailable
 *  - BRIDGE: idle | connecting | connected | disconnected | waiting | error
 *  - TRANSPORT: discord-ipc (desktop IPC, always)
 *  - HOST SOURCES: { crunchy: "...", "youtube-music": "..." }
 *
 * A missing Discord client is waiting, never an error; only a rejected
 * application ID or an exhausted hang needs the user. Raw diagnostics stay in
 * detail/lastError for options; the UI only renders friendly copy here.
 *
 * Pure: no chrome, no Node, no timers.
 */

export const STATUS_KEY = "presenceStatus";

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
  ARRPC_CLOSED: "arrpc-closed",
  DISCORD_CLOSED: "discord-closed",
  HOST_MISSING: "host-missing",
  REJECTED: "rejected",
  HUNG: "hung",
});

/** What the host names for the transport it chose, per the wire contract. */
export const CHOSEN_TRANSPORT = Object.freeze({
  IPC: "discord-ipc",
  ARRPC: "arrpc",
  MIXED: "mixed",
});
export const CHOSEN_TRANSPORTS = Object.freeze(Object.values(CHOSEN_TRANSPORT));

export function chosenTransportOf(value) {
  return CHOSEN_TRANSPORTS.includes(value) ? value : null;
}

export const REASON_COPY = Object.freeze({
  [REASON.ARRPC_CLOSED]: "Discord is not running — presence pauses, then resumes automatically.",
  [REASON.DISCORD_CLOSED]: "Discord is not running — presence pauses, then resumes automatically.",
  [REASON.HOST_MISSING]: "Native host not installed — run the installer.",
  [REASON.REJECTED]: "Discord rejected this application ID. Check the application ID in Settings.",
  [REASON.HUNG]: "Waiting for Discord to respond.",
  [REASON.HUNG + ":exhausted"]: "Discord stopped responding. Restart Discord, then try again.",
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
  off: "Off",
});

export const HUNG_RETRY_LIMIT = 3;

const PATTERNS = [
  [/no arrpc|arrpc.*(closed|unreachable|unavailable)|connection closed/i, REASON.ARRPC_CLOSED],
  [/\bECONNREFUSED\b|\bECONNRESET\b|\bEHOSTUNREACH\b/i, REASON.ARRPC_CLOSED],
  [/no discord ipc pipe found/i, REASON.DISCORD_CLOSED],
  [/discord ipc connection closed|discord ipc dropped|discord ipc pipe closed/i, REASON.DISCORD_CLOSED],
  [/\bENOENT\b|ENOENT[^\n]*discord-ipc|transport-unavailable/i, REASON.DISCORD_CLOSED],
  [/no Discord IPC pipe answered|Discord IPC pipe (?:is )?(?:absent|closed|unavailable)/i, REASON.DISCORD_CLOSED],
  [/(specified )?native messaging host not found|access to the specified native messaging host is forbidden|native host not found/i, REASON.HOST_MISSING],
  [/invalid client id|rejected the handshake|handshake rejected|invalid client_id|rejected application/i, REASON.REJECTED],
  [/(connect|handshake|reply) timeout|timed out|pong timeout|pong overdue|native host disconnected|native host crashed/i, REASON.HUNG],
];

const REASON_KINDS = new Set(Object.values(REASON));
const hasReason = (kind) => REASON_KINDS.has(kind);

export function copyForReason(kind, exhausted = false) {
  if (kind === REASON.HUNG && exhausted) return REASON_COPY[REASON.HUNG + ":exhausted"];
  return REASON_COPY[hasReason(kind) ? kind : REASON.HUNG];
}

export function classifyBridgeFailure(detail, options = {}) {
  const text = typeof detail === "string" ? detail : "";
  const retries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0;
  const hint = typeof options.reason === "string" && hasReason(options.reason) ? options.reason : null;
  const matched = PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  const kind = options.fatal ? REASON.REJECTED : hint ?? matched ?? REASON.HUNG;
  const exhausted = kind === REASON.HUNG && retries >= HUNG_RETRY_LIMIT;
  const isError = kind === REASON.REJECTED || exhausted;
  return {
    kind,
    availability: AVAILABILITY.UNAVAILABLE,
    bridgeState: isError ? BRIDGE.ERROR : BRIDGE.WAITING,
    reason: copyForReason(kind, exhausted),
    error: isError ? copyForReason(kind, exhausted) : null,
    detail: text,
    retryable: !isError,
    fatal: kind === REASON.REJECTED || Boolean(options.fatal),
  };
}

/** Friendly labels for the host's per-source map. */
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

function enabledOf(status, source) {
  if (!status || typeof status !== "object") return true;
  const value = status.enabled;
  if (source !== undefined && value && typeof value === "object" && !Array.isArray(value)) {
    return value[source] !== false;
  }
  if (value === false) return false;
  return true;
}

/**
 * User-facing view of one status payload. The enabled flag (boolean or
 * per-source map) can force the Off pill; source selects from that map.
 */
export function presentStatus(status = {}, source) {
  if (!enabledOf(status, source)) {
    return {
      label: "Off",
      state: "off",
      reason: "Presence is off. Turn it on with the toggle.",
      isError: false,
      isWaiting: false,
    };
  }
  const state = typeof status.bridgeState === "string" ? status.bridgeState : "unknown";
  const isError = state === BRIDGE.ERROR;
  const isWaiting =
    state === BRIDGE.WAITING || state === BRIDGE.CONNECTING || state === BRIDGE.DISCONNECTED;
  const known = Object.prototype.hasOwnProperty.call(BRIDGE_LABELS, state);
  const label = known ? BRIDGE_LABELS[state] : state.charAt(0).toUpperCase() + state.slice(1);
  let reason = null;
  if (isError) {
    reason = typeof status.reason === "string" && status.reason ? status.reason : REASON_COPY[REASON.REJECTED];
  } else if (isWaiting) {
    reason = typeof status.reason === "string" && status.reason ? status.reason : REASON_COPY[REASON.HUNG];
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

export const STATUS_DEFAULT = Object.freeze({
  bridgeState: BRIDGE.IDLE,
  lastError: null,
  availability: AVAILABILITY.UNKNOWN,
  reason: null,
  reasonKind: null,
  transport: null,
});

export function bridgeStatusOf(current, message, retries = 0) {
  const carried = { ...STATUS_DEFAULT, ...(current || {}) };
  if (!message || message.t !== "status") return carried;
  const base = {
    ...carried,
    transport: chosenTransportOf(message.transport) ?? chosenTransportOf(carried.transport),
  };
  if (message.state === BRIDGE.CONNECTED) {
    return { ...base, bridgeState: BRIDGE.CONNECTED, lastError: null, availability: AVAILABILITY.AVAILABLE, reason: null, reasonKind: null };
  }
  if (message.state === BRIDGE.WAITING || message.state === BRIDGE.DISCONNECTED) {
    const verdict = classifyBridgeFailure(message.detail, { reason: message.reason });
    return { ...base, bridgeState: verdict.bridgeState, lastError: message.detail || verdict.detail || null, availability: verdict.availability, reason: verdict.reason, reasonKind: verdict.kind };
  }
  if (message.state === BRIDGE.ERROR) {
    const verdict = message.fatal === false
      ? { ...classifyBridgeFailure(message.detail, { reason: message.reason ?? REASON.HUNG }), bridgeState: BRIDGE.WAITING, error: null, fatal: false, retryable: true }
      : classifyBridgeFailure(message.detail, { retries, fatal: message.fatal === true });
    return { ...base, bridgeState: verdict.bridgeState, lastError: message.detail || verdict.detail || null, availability: verdict.availability, reason: verdict.reason, reasonKind: verdict.kind };
  }
  if (message.state === BRIDGE.CONNECTING) {
    return { ...base, bridgeState: BRIDGE.CONNECTING, availability: AVAILABILITY.UNKNOWN, reason: null, reasonKind: null };
  }
  return { ...base, bridgeState: String(message.state || "unknown") };
}
