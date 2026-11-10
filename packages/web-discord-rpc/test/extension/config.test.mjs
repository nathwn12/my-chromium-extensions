import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CLIENT_ID,
  ENABLED_KEY,
  HOST_NAME,
  SOURCE_META,
  SOURCE_YOUTUBE,
  SOURCE_YOUTUBE_MUSIC,
  TRANSPORTS,
  TRANSPORT_ARRPC,
  TRANSPORT_AUTO,
  TRANSPORT_IPC,
  TRANSPORT_KEY,
  clientIdToPersist,
  resolveClientId,
  resolveEnabled,
  resolveTransport,
  sourceForUrl,
} from "../../config.js";

const OVERRIDE = "123456789012345678";

test("the built-in application ID is a real ID the native host accepts", () => {
  assert.equal(DEFAULT_CLIENT_ID, "1566530911514923188");
  assert.match(DEFAULT_CLIENT_ID, /^[0-9]{17,20}$/);
  assert.match(DEFAULT_CLIENT_ID, /^[0-9]{17,19}$/);
});

test("HOST_NAME is the native messaging host the installer registers", () => {
  assert.equal(HOST_NAME, "com.nathwn12.web_discord_rpc");
});

test("source constants and metadata cover YouTube and YouTube Music only", () => {
  assert.equal(SOURCE_YOUTUBE, "youtube");
  assert.equal(SOURCE_YOUTUBE_MUSIC, "youtube-music");
  assert.deepEqual(Object.keys(SOURCE_META).sort(), ["youtube", "youtube-music"]);
  assert.equal(SOURCE_META.youtube.type, 3);
  assert.equal(SOURCE_META.youtube.name, "YouTube");
  assert.equal(SOURCE_META.youtube.buttonLabel, "Watch on YouTube");
  assert.equal(SOURCE_META["youtube-music"].type, 2);
  assert.equal(SOURCE_META["youtube-music"].name, "YouTube Music");
  assert.equal(SOURCE_META["youtube-music"].buttonLabel, "Listen on YouTube Music");
  assert.ok(Object.isFrozen(SOURCE_META));
});

test("sourceForUrl maps YouTube hosts and rejects everything else", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc12345678",
    "https://youtube.com/watch?v=abc12345678",
    "https://m.youtube.com/watch?v=abc12345678",
  ]) {
    assert.equal(sourceForUrl(url), "youtube", url);
  }
  assert.equal(sourceForUrl("https://music.youtube.com/watch?v=abc12345678"), "youtube-music");
  for (const url of [
    "https://www.crunchyroll.com/watch/abc",
    "https://youtu.be/abc12345678",
    "https://www.youtube.com.evil.com/watch",
    "http://www.youtube.com/watch?v=abc12345678",
    "not a url",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(sourceForUrl(url), null, String(url));
  }
});

test("resolveClientId falls back to the built-in for missing or malformed values", () => {
  for (const stored of [undefined, null, "", "   ", "abc", "1234", 123456789012345678]) {
    assert.equal(resolveClientId(stored), DEFAULT_CLIENT_ID, `stored=${String(stored)}`);
  }
});

test("resolveClientId keeps a valid stored override, trimmed", () => {
  assert.equal(resolveClientId(OVERRIDE), OVERRIDE);
  assert.equal(resolveClientId(` ${OVERRIDE} `), OVERRIDE);
  assert.equal(resolveClientId(DEFAULT_CLIENT_ID), DEFAULT_CLIENT_ID);
});

test("the transport preference vocabulary is exactly auto, ipc and arrpc", () => {
  assert.equal(TRANSPORT_AUTO, "auto");
  assert.equal(TRANSPORT_IPC, "ipc");
  assert.equal(TRANSPORT_ARRPC, "arrpc");
  assert.deepEqual([...TRANSPORTS], ["auto", "ipc", "arrpc"]);
  assert.ok(Object.isFrozen(TRANSPORTS));
  assert.equal(TRANSPORT_KEY, "transport");
  assert.equal(ENABLED_KEY, "enabled");
});

test("resolveTransport keeps a stored preference and otherwise defaults to auto", () => {
  for (const stored of [undefined, null, "", "   ", "junk", "discord-ipc", "AUTO?", "auto ", 42]) {
    assert.equal(resolveTransport(stored), "auto", `stored=${String(stored)}`);
  }
  assert.equal(resolveTransport("auto"), "auto");
  assert.equal(resolveTransport("ipc"), "ipc");
  assert.equal(resolveTransport("IPC"), "ipc");
  assert.equal(resolveTransport(" arrpc "), "arrpc");
});

test("resolveEnabled only turns presence off on a real false", () => {
  assert.equal(resolveEnabled(false), false);
  for (const stored of [true, undefined, null, "false", 0, "", {}]) {
    assert.equal(resolveEnabled(stored), true, `stored=${String(stored)}`);
  }
});

test("clientIdToPersist saves an override, clears for empty/built-in, rejects junk", () => {
  assert.equal(clientIdToPersist(""), null);
  assert.equal(clientIdToPersist("   "), null);
  assert.equal(clientIdToPersist(null), null);
  assert.equal(clientIdToPersist(DEFAULT_CLIENT_ID), null);
  assert.equal(clientIdToPersist(` ${DEFAULT_CLIENT_ID} `), null);
  assert.equal(clientIdToPersist(OVERRIDE), OVERRIDE);
  assert.equal(clientIdToPersist(` ${OVERRIDE} `), OVERRIDE);
  assert.equal(clientIdToPersist("abc"), undefined);
  assert.equal(clientIdToPersist("1234"), undefined);
});
