/**
 * Docs contract for web-discord-rpc + crunchy web transport.
 *
 * Fails when prose drifts from the code: every assertion names a file and a
 * value read from the artifact. Run:
 *   node --test packages/web-discord-rpc/test/docs.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLIENT_ID, HOST_NAME, SOURCE_META } from "../config.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const crunchy = (...parts) => readFileSync(
  path.join(root, "..", "crunchy-presence", ...parts), "utf8",
);

const readme = read("README.md");
const arch = read("docs/ARCHITECTURE.md");
const research = read("docs/RESEARCH.md");
const install = read("docs/INSTALL.md");
const changelog = read("CHANGELOG.md");

test("desktop-first setup names the desktop pipe before arRPC", () => {
  for (const [name, doc] of [["README", readme], ["ARCHITECTURE", arch], ["INSTALL", install]]) {
    assert.match(doc, /discord-ipc-0/i, `${name} names the desktop pipe scan`);
  }
  assert.match(readme, /desktop[-\s]first/i, "README says desktop-first");
  assert.match(readme, /6463-6472/, "README names the arRPC port range");
});

test("every doc calls the extension YouTube Presence and defaults to the desktop IPC transport", () => {
  for (const [name, doc] of [
    ["README", readme],
    ["ARCHITECTURE", arch],
    ["RESEARCH", research],
    ["INSTALL", install],
    ["CHANGELOG", changelog],
  ]) {
    assert.ok(!doc.includes("Web Discord RPC"), `${name} drops the first name`);
    assert.ok(!doc.includes("Discord RPC"), `${name} drops the earlier name`);
  }
  assert.match(readme, /^# YouTube Presence$/m, "README titles the extension YouTube Presence");
  assert.match(readme, /`ipc`[^\n]{0,80}default|default[^\n]{0,80}`ipc`/i, "README says desktop IPC is the default");
  assert.match(arch, /`ipc`[^\n]{0,80}default|default[^\n]{0,80}`ipc`/i, "ARCHITECTURE says desktop IPC is the default");
  assert.match(readme, /deferred/i, "README marks the web route deferred");
  assert.match(install, /deferred/i, "INSTALL marks the web route deferred");
});

test("docs promise YouTube Music first and one toggle per site", () => {
  assert.match(readme, /YouTube Music first/i, "README puts YouTube Music first");
  assert.match(readme, /youtubeMusicEnabled/, "README names the Music flag");
  assert.match(readme, /youtubeEnabled/, "README names the YouTube flag");
  assert.match(readme, /independently|independent/i, "README says the sites are independent");
  assert.match(arch, /youtubeMusicEnabled/, "ARCHITECTURE names the per-site flags");
});

test("arRPC/Vencord fallback names the client_id query and the mock user", () => {
  assert.match(readme, /client_id/, "README names the client_id query");
  assert.match(readme, /Vencord/, "README names Vencord");
  assert.match(arch, /\?v=1&client_id/, "ARCHITECTURE names the arRPC URL query");
  assert.match(arch, /1045800378228281345/, "ARCHITECTURE names the arRPC mock user");
});

test("two stacked activities keep their types and name overrides", () => {
  assert.equal(SOURCE_META.youtube.type, 3, "code: YouTube is WATCHING");
  assert.equal(SOURCE_META["youtube-music"].type, 2, "code: Music is LISTENING");
  assert.match(readme, /YouTube Music/, "README names both sources");
  assert.match(readme, /type 3.*type 2|WATCHING.*LISTENING/s, "README keeps both types");
  assert.match(readme, /`name`.*override|name.*override/i, "README explains the name override");
  assert.match(arch, /per source/i, "ARCHITECTURE keeps per-source budgets");
});

test("app-name override names the built-in id and the 17-20 digit rule", () => {
  assert.equal(DEFAULT_CLIENT_ID, "1566530911514923188", "code: built-in id is pinned");
  assert.match(readme, /1566530911514923188/, "README names the built-in application id");
  assert.match(readme, /17[–-]20 digit/, "README states the id rule");
  assert.match(readme, /auto.*ipc.*arrpc/s, "README names the transport preference");
});

test("privacy says local-only and no page modification", () => {
  assert.match(readme, /no network requests of its own/i, "README states the extension makes no network requests");
  assert.match(readme, /never modified|never.*captured|never inspected/i, "README states the page/stream is untouched");
});

test("troubleshooting maps absence to waiting, not error", () => {
  for (const reason of ["discord-closed", "arrpc-closed", "host-missing", "rejected", "hung"]) {
    assert.ok(readme.includes(reason), `README names reason ${reason}`);
  }
  assert.match(readme, /waiting.*never.*error|never.*error/i, "README says absence is waiting");
});

test("crunchy transport rule is amended: IPC primary, arRPC fallback, no third transport", () => {
  const agents = crunchy("AGENTS.md");
  const crReadme = crunchy("README.md");
  const crArch = crunchy("docs/ARCHITECTURE.md");
  assert.match(agents, /arRPC/i, "AGENTS names arRPC");
  assert.match(agents, /primary|first/i, "AGENTS keeps IPC primary");
  assert.match(agents, /no third transport|never.*third|forced.*never.*fall back/i, "AGENTS forbids a third transport");
  assert.ok(!/only Discord transport/i.test(agents) || /arRPC/i.test(agents),
    "AGENTS no longer claims IPC is the only transport");
  assert.match(crReadme, /arRPC/i, "crunchy README names arRPC");
  assert.match(crArch, /arRPC|arrpc/i, "crunchy ARCHITECTURE names arRPC");
});

test("changelogs speak to the reader with dates", () => {
  assert.match(changelog, /2026-11-10/, "wdr CHANGELOG is dated");
  assert.match(changelog, /\[1\.0\.0\]/, "wdr CHANGELOG carries the release");
  const crLog = crunchy("CHANGELOG.md");
  assert.match(crLog, /\[Unreleased\]/, "crunchy CHANGELOG keeps Unreleased");
  assert.match(crLog, /arRPC/i, "crunchy CHANGELOG names the fallback");
});

test("install doc quotes the real host name and extension id", () => {
  assert.equal(HOST_NAME, "com.nathwn12.web_discord_rpc", "code: host name is pinned");
  assert.match(install, /com\.nathwn12\.web_discord_rpc/, "INSTALL names the host");
  assert.match(install, /mnmmfbjinpokfnendlbhbbdmfjidgikf/, "INSTALL names the extension id");
  assert.match(install, /--selftest/, "INSTALL names the selftest");
});
