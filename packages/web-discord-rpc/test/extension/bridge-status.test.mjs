import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE,
  CHOSEN_TRANSPORT,
  CHOSEN_TRANSPORTS,
  HUNG_RETRY_LIMIT,
  REASON,
  REASON_COPY,
  STATUS_KEY,
  bridgeStatusOf,
  chosenTransportOf,
  classifyBridgeFailure,
  copyForReason,
  presentStatus,
  presentSources,
} from "../../bridge-status.js";

test("the reason vocabulary is the one the host puts on the wire", () => {
  assert.equal(REASON.ARRPC_CLOSED, "arrpc-closed");
  assert.equal(REASON.DISCORD_CLOSED, "discord-closed");
  assert.equal(REASON.HOST_MISSING, "host-missing");
  assert.equal(REASON.REJECTED, "rejected");
  assert.equal(REASON.HUNG, "hung");
  assert.equal(STATUS_KEY, "wdrStatus");
});

test("the reported transport vocabulary is the host's, not the stored preference's", () => {
  assert.equal(CHOSEN_TRANSPORT.IPC, "discord-ipc");
  assert.equal(CHOSEN_TRANSPORT.ARRPC, "arrpc");
  assert.equal(CHOSEN_TRANSPORT.MIXED, "mixed");
  assert.deepEqual([...CHOSEN_TRANSPORTS], ["discord-ipc", "arrpc", "mixed"]);
  assert.equal(chosenTransportOf("discord-ipc"), "discord-ipc");
  assert.equal(chosenTransportOf("arrpc"), "arrpc");
  assert.equal(chosenTransportOf("auto"), null, "a preference is not a chosen transport");
  assert.equal(chosenTransportOf(undefined), null);
  assert.equal(chosenTransportOf(null), null);
});

test("a status frame carries the transport the host chose", () => {
  const connected = bridgeStatusOf(
    {},
    { t: "status", state: "connected", transport: "discord-ipc" },
    0
  );
  assert.equal(connected.transport, "discord-ipc");

  const waiting = bridgeStatusOf(
    { transport: "discord-ipc" },
    { t: "status", state: "waiting", transport: "arrpc", reason: "arrpc-closed" },
    0
  );
  assert.equal(waiting.transport, "arrpc", "the newer frame wins");

  const stale = bridgeStatusOf(
    { transport: "arrpc" },
    { t: "status", state: "connected" },
    0
  );
  assert.equal(stale.transport, "arrpc", "a frame without one keeps the last known");

  const junk = bridgeStatusOf(
    { transport: "arrpc" },
    { t: "status", state: "connected", transport: "carrier-pigeon" },
    0
  );
  assert.equal(junk.transport, "arrpc", "an unknown transport never reaches a surface");

  assert.equal(bridgeStatusOf({}, { t: "pong" }, 0).transport, null);
});

test("a connected status frame is available with no reason", () => {
  const next = bridgeStatusOf({}, { t: "status", state: "connected", transport: "arrpc" }, 0);
  assert.equal(next.bridgeState, BRIDGE.CONNECTED);
  assert.equal(next.availability, "available");
  assert.equal(next.reason, null);
  assert.equal(next.reasonKind, null);
  assert.equal(next.lastError, null);
});

test("a connecting status frame names the transport the host will use", () => {
  const next = bridgeStatusOf({}, { t: "status", state: "connecting", transport: "discord-ipc" }, 0);
  assert.equal(next.bridgeState, BRIDGE.CONNECTING);
  assert.equal(next.transport, "discord-ipc");
  assert.equal(next.reason, null);
  assert.equal(next.reasonKind, null);
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

test("a Discord pipe nothing answers is not running, not silent", () => {
  const absent = "no Discord IPC pipe answered on 10 path(s)";

  const plain = classifyBridgeFailure(absent);
  assert.equal(plain.kind, REASON.DISCORD_CLOSED, "an absent pipe is a known kind, not a hang");
  assert.equal(plain.bridgeState, BRIDGE.WAITING);
  assert.equal(plain.reason, REASON_COPY[REASON.ARRPC_CLOSED]);
  assert.equal(plain.error, null, "absence is never an error");

  const enoent = classifyBridgeFailure("connect ENOENT \\\\.\\pipe\\discord-ipc-0");
  assert.equal(enoent.kind, REASON.DISCORD_CLOSED);

  const hinted = classifyBridgeFailure("whatever the pipe said", { reason: "discord-closed" });
  assert.equal(hinted.kind, REASON.DISCORD_CLOSED, "the host's own reason hint is honoured");

  // The ack for a failed IPC connect carries no reason field, only this code;
  // without it the frame before the status would read as a silent Discord.
  assert.equal(classifyBridgeFailure("transport-unavailable").kind, REASON.DISCORD_CLOSED);

  const frame = bridgeStatusOf(
    {},
    {
      t: "status",
      state: "waiting",
      transport: "discord-ipc",
      reason: "discord-closed",
      detail: absent,
    },
    0
  );
  assert.equal(frame.reasonKind, REASON.DISCORD_CLOSED);
  assert.equal(frame.reason, REASON_COPY[REASON.ARRPC_CLOSED]);
  assert.equal(frame.bridgeState, BRIDGE.WAITING);

  // Discord running but silent is a hang, and keeps the hang's copy.
  assert.equal(classifyBridgeFailure("discord ipc handshake timed out").kind, REASON.HUNG);
  assert.equal(classifyBridgeFailure("discord ipc reply timed out").kind, REASON.HUNG);
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
