#!/usr/bin/env node
/**
 * End-to-end proof of the Discord desktop IPC path.
 *
 * A real Windows named pipe (`\\.\pipe\wdr-e2e-*`, never a `discord-ipc-*`
 * name) plays Discord. The real native host is spawned with
 * `WDR_DISCORD_PIPES` pointed at that pipe, receives one hello plus one
 * Music activity, and must answer its ack over one connection and handshake.
 * The captured SET_ACTIVITY verifies artist display and timestamps at IPC.
 *
 *   node scripts/e2e-ipc.mjs
 */

import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLIENT_ID } from "../config.js";
import { DiscordFrameDecoder, OP, encodeDiscordFrame } from "../native/ipc.mjs";
import { createDecoder, encodeMessage } from "../native/native-framing.mjs";

const HOST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "host.mjs");
const TIMEOUT_MS = 10_000;

const waitFor = (predicate, label, timeoutMs = TIMEOUT_MS) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    let ok = false;
    try {
      ok = predicate();
    } catch {
      ok = false;
    }
    if (ok) {
      resolve();
      return;
    }
    if (Date.now() - started > timeoutMs) {
      reject(new Error(`timed out waiting for ${label}`));
      return;
    }
    setTimeout(tick, 10);
  };
  tick();
});

async function startDiscordPipe(pipePath, state) {
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.push(socket);
    socket.on("error", () => {});

    const decoder = new DiscordFrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.op === OP.HANDSHAKE) {
          state.handshakes += 1;
          state.clientIds.push(frame.payload?.client_id);
          socket.write(encodeDiscordFrame(OP.FRAME, {
            cmd: "DISPATCH",
            evt: "READY",
            nonce: null,
            data: { v: 1, user: { id: "0", username: "e2e" } },
          }));
          continue;
        }
        if (frame.op === OP.FRAME) {
          state.frames.push(frame.payload);
          socket.write(encodeDiscordFrame(OP.FRAME, {
            cmd: "SET_ACTIVITY",
            evt: null,
            nonce: frame.payload?.nonce,
            data: { name: "WDR E2E", activity: frame.payload?.args?.activity ?? null },
          }));
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

async function main() {
  if (process.platform !== "win32") {
    process.stdout.write("SKIP  e2e-ipc: Discord desktop IPC on Windows is the tested transport\n");
    return 0;
  }

  const pipePath = `\\\\.\\pipe\\wdr-e2e-${process.pid}-${Date.now().toString(36)}`;
  const state = { connections: 0, handshakes: 0, clientIds: [], frames: [], sockets: [] };
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

  const server = await startDiscordPipe(pipePath, state);
  const child = spawn(process.execPath, [HOST_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WDR_DISCORD_PIPES: pipePath },
  });

  const frames = [];
  const decoder = createDecoder();
  let stderr = "";
  let stdoutError = null;
  child.stdout.on("data", (chunk) => {
    try {
      frames.push(...decoder.push(chunk));
    } catch (error) {
      stdoutError = error;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const activities = [{
    source: "youtube-music",
    id: "e2e-music",
    activity: {
      name: "YouTube Music", type: 2, details: "Album Track", state: "Artist",
      status_display_type: 1,
      timestamps: { start: 1_700_000_000_000, end: 1_700_000_184_000 },
    },
  }];

  try {
    child.stdin.write(encodeMessage({
      t: "hello",
      clientId: DEFAULT_CLIENT_ID,
      version: 1,
      transport: "auto",
    }));
    for (const { source, id, activity } of activities) {
      child.stdin.write(encodeMessage({ t: "activity", source, id, activity }));
    }

    const acked = () => activities.every(({ id }) => frames.some((message) => message.t === "ack" && message.id === id));
    await waitFor(acked, "Music ack (pipe wire, handshake, SET_ACTIVITY, reply)");

    const acks = activities.map(({ id }) => frames.find((message) => message.t === "ack" && message.id === id));
    check("Music activity acks over Discord IPC", acks.length === 1 && acks[0]?.ok === true, JSON.stringify(acks));

    const connected = frames.filter((message) => message.t === "status" && message.state === "connected").at(-1);
    check(
      "status reports connected on discord-ipc with a null reason and Music",
      connected?.transport === "discord-ipc"
        && connected?.reason === null
        && connected?.sources?.["youtube-music"] === "connected",
      JSON.stringify(connected ?? null),
    );

    check(
      "a real named pipe saw one connection and handshake",
      state.connections === 1
        && state.handshakes === 1
        && state.clientIds.every((clientId) => clientId === DEFAULT_CLIENT_ID),
      JSON.stringify({ connections: state.connections, handshakes: state.handshakes, clientIds: state.clientIds }),
    );

    const sent = state.frames[0]?.args?.activity;
    check(
      "Music activity reaches Discord with artist display and timestamps",
      state.frames.length === 1
        && sent?.name === "YouTube Music"
        && sent?.details === "Album Track"
        && sent?.state === "Artist"
        && sent?.status_display_type === 1
        && sent?.timestamps?.start === 1_700_000_000_000
        && sent?.timestamps?.end === 1_700_000_184_000,
      JSON.stringify(sent ?? null),
    );
    check(
      "every SET_ACTIVITY names the host's pid",
      state.frames.length === 1 && state.frames.every((frame) => frame?.args?.pid === child.pid),
      JSON.stringify(state.frames.map((frame) => frame?.args?.pid ?? null)),
    );
  } catch (error) {
    check("the run completed", false, error?.message ?? String(error));
  } finally {
    child.stdin.end();
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    if (code === "timeout") child.kill();
    check("the host exits 0 when stdin closes", code === 0, `exit ${String(code)}; stderr: ${stderr.trim()}`);

    for (const socket of state.sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  check("stdout stayed decodable", stdoutError === null, String(stdoutError ?? ""));

  const failed = checks.filter((entry) => !entry.ok).length;
  for (const entry of checks) {
    process.stdout.write(
      `${entry.ok ? "PASS" : "FAIL"}  e2e-ipc: ${entry.name}${entry.ok ? "" : `  (${entry.detail})`}\n`,
    );
  }
  process.stdout.write(`e2e-ipc: ${failed === 0 ? "PASS" : "FAIL"} (${checks.length - failed}/${checks.length})\n`);
  if (failed > 0) process.stderr.write(`${stderr.trim()}\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`e2e-ipc: fatal: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
