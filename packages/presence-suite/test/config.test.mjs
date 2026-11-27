import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_IDS,
  DEFAULT_TRANSPORT,
  ENABLED_KEY,
  HOST_NAME,
  SOURCE_CRUNCHY,
  SOURCE_META,
  SOURCE_YOUTUBE_MUSIC,
  SOURCES,
  STATUS_KEY,
  TABS_KEY,
  TRANSPORT_IPC,
  clientIdKey,
  clientIdToPersist,
  enabledMap,
  resolveClientId,
  resolveEnabled,
  resolveTransport,
  sourceForUrl,
} from "../config.js";

const OVERRIDE = "123456789012345678";

test("identity: fresh host name, new storage keys, IPC transport", () => {
  assert.equal(HOST_NAME, "com.nathwn12.presence_suite");
  assert.equal(STATUS_KEY, "presenceStatus");
  assert.equal(TABS_KEY, "presenceTabs");
  assert.equal(ENABLED_KEY, "enabled");
  assert.equal(DEFAULT_TRANSPORT, TRANSPORT_IPC);
  assert.equal(resolveTransport(), "ipc");
});

test("source registry covers both sources with the shipped activity types", () => {
  assert.deepEqual(SOURCES, [SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC]);
  assert.deepEqual(Object.keys(SOURCE_META), [SOURCE_YOUTUBE_MUSIC, SOURCE_CRUNCHY]);
  assert.equal(SOURCE_META[SOURCE_YOUTUBE_MUSIC].type, 2);
  assert.equal(SOURCE_META[SOURCE_YOUTUBE_MUSIC].name, "YouTube Music");
  assert.equal(SOURCE_META[SOURCE_CRUNCHY].type, 3);
  assert.equal(SOURCE_META[SOURCE_CRUNCHY].name, "Crunchyroll");
  assert.ok(Object.isFrozen(SOURCE_META));
  assert.ok(Object.isFrozen(SOURCE_META[SOURCE_CRUNCHY]));
});

test("both existing application IDs are kept per source", () => {
  assert.equal(DEFAULT_CLIENT_IDS[SOURCE_CRUNCHY], "1566530911514923188");
  assert.equal(DEFAULT_CLIENT_IDS[SOURCE_YOUTUBE_MUSIC], "1566530911514923188");
  assert.equal(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_IDS[SOURCE_YOUTUBE_MUSIC]);
  for (const source of SOURCES) {
    assert.match(DEFAULT_CLIENT_IDS[source], /^[0-9]{17,20}$/);
    assert.equal(SOURCE_META[source].clientId, DEFAULT_CLIENT_IDS[source]);
    assert.equal(clientIdKey(source), "clientId:" + source);
  }
});

test("sourceForUrl maps both hosts and rejects everything else", () => {
  assert.equal(sourceForUrl("https://music.youtube.com/watch?v=abc12345678"), SOURCE_YOUTUBE_MUSIC);
  assert.equal(sourceForUrl("https://www.crunchyroll.com/watch/G6VU774M5/x"), SOURCE_CRUNCHY);
  assert.equal(sourceForUrl("https://static.crunchyroll.com/embed/x"), SOURCE_CRUNCHY);
  for (const url of [
    "https://www.youtube.com/watch?v=abc12345678",
    "https://crunchyroll.com.evil.com/watch/x",
    "http://music.youtube.com/watch?v=abc12345678",
    "https://music.youtube.com.evil.com/",
    "not a url", "", null, undefined, 42,
  ]) {
    assert.equal(sourceForUrl(url), null, String(url));
  }
});

test("client ID helpers keep the original validation logic per source", () => {
  for (const source of SOURCES) {
    const builtIn = DEFAULT_CLIENT_IDS[source];
    for (const stored of [undefined, null, "", "   ", "abc", "1234", 123456789012345678]) {
      assert.equal(resolveClientId(stored, source), builtIn, String(stored));
    }
    assert.equal(resolveClientId(OVERRIDE, source), OVERRIDE);
    assert.equal(resolveClientId(" " + OVERRIDE + " ", source), OVERRIDE);
    assert.equal(clientIdToPersist("", source), null);
    assert.equal(clientIdToPersist("  ", source), null);
    assert.equal(clientIdToPersist(builtIn, source), null);
    assert.equal(clientIdToPersist(OVERRIDE, source), OVERRIDE);
    assert.equal(clientIdToPersist("abc", source), undefined);
  }
});

test("enabled flags default true per source and only an explicit false disables", () => {
  assert.deepEqual(enabledMap(null), { crunchy: true, "youtube-music": true });
  assert.deepEqual(enabledMap({ crunchy: false }), { crunchy: false, "youtube-music": true });
  assert.equal(resolveEnabled({ crunchy: false }, SOURCE_CRUNCHY), false);
  assert.equal(resolveEnabled({ crunchy: true }, SOURCE_CRUNCHY), true);
  assert.equal(resolveEnabled({}, SOURCE_CRUNCHY), true);
  assert.equal(resolveEnabled(false), false);
  assert.equal(resolveEnabled(true), true);
});
