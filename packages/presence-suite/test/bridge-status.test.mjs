import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AVAILABILITY,
  BRIDGE,
  BRIDGE_LABELS,
  CHOSEN_TRANSPORT,
  REASON,
  STATUS_KEY,
  bridgeStatusOf,
  classifyBridgeFailure,
  chosenTransportOf,
  presentSources,
  presentStatus,
} from "../bridge-status.js";

test("union vocabulary: new status key, all bridge states, chosen transports", () => {
  assert.equal(STATUS_KEY, "presenceStatus");
  assert.deepEqual(Object.values(BRIDGE), ["idle", "connecting", "connected", "disconnected", "waiting", "error"]);
  assert.equal(BRIDGE_LABELS[BRIDGE.DISCONNECTED], "Waiting");
  assert.equal(BRIDGE_LABELS[BRIDGE.ERROR], "Error");
  assert.equal(BRIDGE_LABELS.unknown, "Not connected");
  assert.equal(CHOSEN_TRANSPORT.IPC, "discord-ipc");
  assert.equal(chosenTransportOf("arrpc"), "arrpc");
  assert.equal(chosenTransportOf("garbage"), null);
  assert.deepEqual(Object.values(AVAILABILITY), ["unknown", "available", "unavailable"]);
});

test("presentSources labels both source registries from the host map", () => {
  const labels = presentSources({ crunchy: "connected", "youtube-music": "disconnected", other: "idle" });
  assert.equal(labels.crunchy, "Connected");
  assert.equal(labels["youtube-music"], "Waiting");
  assert.equal(labels.other, "Idle");
  assert.deepEqual(presentSources(), {});
});

test("presentStatus is enabled-aware for a boolean or per-source map", () => {
  const connected = { bridgeState: "connected", enabled: { crunchy: true, "youtube-music": false } };
  assert.equal(presentStatus(connected).label, "Connected");
  assert.equal(presentStatus(connected, "crunchy").label, "Connected");
  const off = presentStatus(connected, "youtube-music");
  assert.equal(off.label, "Off");
  assert.equal(off.state, "off");
  assert.equal(off.isError, false);
  assert.equal(presentStatus({ bridgeState: "connected", enabled: false }).label, "Off");
});

test("classifyBridgeFailure recognises both sources diagnostic vocabularies", () => {
  assert.equal(classifyBridgeFailure("no arrpc").kind, REASON.ARRPC_CLOSED);
  assert.equal(classifyBridgeFailure("ECONNREFUSED").kind, REASON.ARRPC_CLOSED);
  assert.equal(classifyBridgeFailure("no discord ipc pipe found").kind, REASON.DISCORD_CLOSED);
  assert.equal(classifyBridgeFailure("transport-unavailable").kind, REASON.DISCORD_CLOSED);
  assert.equal(classifyBridgeFailure("native messaging host not found").kind, REASON.HOST_MISSING);
  assert.equal(classifyBridgeFailure("invalid client id").kind, REASON.REJECTED);
  assert.equal(classifyBridgeFailure("pong timeout").bridgeState, BRIDGE.WAITING);
  assert.equal(classifyBridgeFailure("pong timeout", { retries: 3 }).bridgeState, BRIDGE.ERROR);
  assert.equal(classifyBridgeFailure("x", { fatal: true }).kind, REASON.REJECTED);
});

test("bridgeStatusOf accepts connected, waiting, disconnected and error frames", () => {
  const connected = bridgeStatusOf({}, { t: "status", state: "connected", transport: "discord-ipc" });
  assert.equal(connected.bridgeState, BRIDGE.CONNECTED);
  assert.equal(connected.availability, AVAILABILITY.AVAILABLE);
  assert.equal(connected.transport, "discord-ipc");
  const disconnected = bridgeStatusOf({}, { t: "status", state: "disconnected", detail: "no arrpc" });
  assert.equal(disconnected.bridgeState, BRIDGE.WAITING);
  assert.equal(disconnected.reasonKind, REASON.ARRPC_CLOSED);
  assert.equal(bridgeStatusOf({}, { t: "status", state: "connecting" }).bridgeState, BRIDGE.CONNECTING);
  assert.equal(bridgeStatusOf({}, { t: "nope" }).bridgeState, BRIDGE.IDLE);
});
