import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE,
  HUNG_RETRY_LIMIT,
  REASON,
  REASON_COPY,
  STATUS_KEY,
  TRANSPORT,
  bridgeStatusOf,
  classifyBridgeFailure,
  copyForReason,
  presentStatus,
  presentSources,
} from "../../bridge-status.js";

test("the reason vocabulary is the one the host puts on the wire", () => {
  assert.equal(REASON.ARRPC_CLOSED, "arrpc-closed");
  assert.equal(REASON.HOST_MISSING, "host-missing");
  assert.equal(REASON.REJECTED, "rejected");
  assert.equal(REASON.HUNG, "hung");
  assert.equal(TRANSPORT, "arrpc");
  assert.equal(STATUS_KEY, "wdrStatus");
});

test("a connected status frame is available with no reason", () => {
  const next = bridgeStatusOf({}, { t: "status", state: "connected", transport: "arrpc" }, 0);
  assert.equal(next.bridgeState, BRIDGE.CONNECTED);
  assert.equal(next.availability, "available");
  assert.equal(next.reason, null);
  assert.equal(next.reasonKind, null);
  assert.equal(next.lastError, null);
});

test("an absent arRPC is waiting, never an error, and keeps the raw detail", () => {
  const next = bridgeStatusOf(
    {},
    {
      t: "status",
      state: "waiting",
      transport: "arrpc",
      reason: "arrpc-closed",
      detail: "connect ECONNREFUSED 127.0.0.1:6463",
    },
    0
  );
  assert.equal(next.bridgeState, BRIDGE.WAITING);
  assert.equal(next.availability, "unavailable");
  assert.equal(next.reasonKind, REASON.ARRPC_CLOSED);
  assert.equal(next.reason, REASON_COPY[REASON.ARRPC_CLOSED]);
  assert.equal(next.lastError, "connect ECONNREFUSED 127.0.0.1:6463");
  assert.equal(classifyBridgeFailure("connect ECONNREFUSED").error, null);
});

test("a missing native host is waiting with installer copy", () => {
  const next = bridgeStatusOf(
    {},
    {
      t: "status",
      state: "waiting",
      transport: "arrpc",
      reason: "host-missing",
      detail: "Specified native messaging host not found.",
    },
    0
  );
  assert.equal(next.bridgeState, BRIDGE.WAITING);
  assert.equal(next.reasonKind, REASON.HOST_MISSING);
  assert.equal(next.reason, REASON_COPY[REASON.HOST_MISSING]);
});

test("a rejected application ID is the only plain error", () => {
  const next = bridgeStatusOf(
    {},
    { t: "status", state: "error", transport: "arrpc", reason: "rejected", detail: "invalid client id" },
    0
  );
  assert.equal(next.bridgeState, BRIDGE.ERROR);
  assert.equal(next.availability, "unavailable");
  assert.equal(next.reasonKind, REASON.REJECTED);
  assert.equal(next.reason, REASON_COPY[REASON.REJECTED]);
});

test("an exhausted hang becomes an error, a fresh hang stays waiting", () => {
  const fresh = bridgeStatusOf(
    {},
    { t: "status", state: "error", transport: "arrpc", reason: "hung", detail: "pong timeout" },
    1
  );
  assert.equal(fresh.bridgeState, BRIDGE.WAITING);
  assert.equal(fresh.reason, REASON_COPY[REASON.HUNG]);

  const exhausted = bridgeStatusOf(
    {},
    { t: "status", state: "error", transport: "arrpc", reason: "hung", detail: "pong timeout" },
    HUNG_RETRY_LIMIT
  );
  assert.equal(exhausted.bridgeState, BRIDGE.ERROR);
  assert.equal(exhausted.reason, REASON_COPY[`${REASON.HUNG}:exhausted`]);
});

test("a host-declared transient error is never promoted to a permanent one", () => {
  const next = bridgeStatusOf(
    {},
    { t: "status", state: "error", transport: "arrpc", detail: "arrpc connect timeout", fatal: false },
    9
  );
  assert.equal(next.bridgeState, BRIDGE.WAITING);
  assert.equal(next.availability, "unavailable");
});

test("classifyBridgeFailure recognises raw diagnostics without a reason hint", () => {
  assert.equal(classifyBridgeFailure("Error: listen EADDRINUSE 127.0.0.1:6463").kind, REASON.HUNG);
  assert.equal(classifyBridgeFailure("Specified native messaging host not found.").kind, REASON.HOST_MISSING);
  assert.equal(classifyBridgeFailure("Discord IPC connection closed").kind, REASON.ARRPC_CLOSED);
  assert.equal(classifyBridgeFailure("invalid client_id").kind, REASON.REJECTED);
  assert.equal(classifyBridgeFailure(undefined, { fatal: true }).kind, REASON.REJECTED);
});

test("presentStatus turns a payload into the four things a surface renders", () => {
  assert.deepEqual(presentStatus({ bridgeState: "connected" }), {
    label: "Connected",
    state: "connected",
    reason: null,
    isError: false,
    isWaiting: false,
  });
  assert.deepEqual(presentStatus({ bridgeState: "waiting", reason: "waiting copy" }), {
    label: "Waiting",
    state: "waiting",
    reason: "waiting copy",
    isError: false,
    isWaiting: true,
  });
  assert.equal(presentStatus({ bridgeState: "error", reason: "bad id" }).isError, true);
  assert.equal(presentStatus({}).label, "Not connected");
  assert.equal(presentStatus({ bridgeState: "connecting" }).label, "Waiting");
});

test("copyForReason always returns friendly copy for an unknown kind", () => {
  assert.equal(copyForReason("nonsense"), REASON_COPY[REASON.HUNG]);
  assert.equal(copyForReason("hung", true), REASON_COPY[`${REASON.HUNG}:exhausted`]);
});

test("presentSources labels the host's per-source map and tolerates junk", () => {
  assert.deepEqual(presentSources({ youtube: "connected", "youtube-music": "waiting" }), {
    youtube: "Connected",
    "youtube-music": "Waiting",
  });
  assert.deepEqual(presentSources({ youtube: "exploded" }), { youtube: "Not connected" });
  assert.deepEqual(presentSources(), {});
});
