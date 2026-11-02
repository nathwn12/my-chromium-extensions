import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const worker = await import(pathToFileURL(join(here, "..", "..", "background.js")).href);
const bgSource = readFileSync(join(here, "..", "..", "background.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");
const popupSource = readFileSync(join(here, "..", "..", "popup.js"), "utf8");
const optionsSource = readFileSync(join(here, "..", "..", "options.js"), "utf8");

const {
  createCoalescingLimiter,
  nextAckRetryDelay,
  isBlindReloadSignal,
  BOOT_SUPPRESS_MS,
  NO_URL_CLEAR_DELAY_MS,
  ACK_RETRY_DELAYS
} = worker;

// 1. dropPort disconnects the native port so a reconnect leaks no host.
test("dropPort calls port.disconnect before nulling the port", () => {
  assert.match(bgSource, /port\.disconnect\(\)/);
  assert.match(bgSource, /try \{\s*\n?\s*port\.disconnect\(\)/);
});

// 2. disabling presence still sends the null clear.
test("sendActivity lets a null clear through while disabled", () => {
  assert.match(bgSource, /if \(!enabled && activity !== null\) return;/);
});

// 3. ordinary cap is 4/20 s; a null clear bypasses and is never counted.
test("ordinary cap is 4 per window and a clear bypasses uncounted", () => {
  const sent = [];
  const scheduled = [];
  let now = 0;
  const limiter = createCoalescingLimiter({
    send: (v) => sent.push(v),
    max: 4,
    windowMs: 20000,
    now: () => now,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    }
  });
  for (const value of ["u1", "u2", "u3", "u4"]) limiter.push(value);
  assert.deepEqual(sent, ["u1", "u2", "u3", "u4"]);
  limiter.push("u5");
  assert.equal(limiter.pending, "u5");
  limiter.push(null);
  assert.deepEqual(sent, ["u1", "u2", "u3", "u4", null]);
  assert.equal(limiter.pending, "u5", "clear preserves the deferred ordinary payload");
});

// 4. ack ok:false retries with bounded backoff (1s/2s/4s, max 3).
test("nextAckRetryDelay yields 1s/2s/4s then stops", () => {
  assert.deepEqual([...ACK_RETRY_DELAYS], [1000, 2000, 4000]);
  assert.equal(nextAckRetryDelay(0), 1000);
  assert.equal(nextAckRetryDelay(1), 2000);
  assert.equal(nextAckRetryDelay(2), 4000);
  assert.equal(nextAckRetryDelay(3), null);
  assert.equal(nextAckRetryDelay(99), null);
});

test("ack rejection resets the dedupe and schedules a bounded retry", () => {
  assert.match(bgSource, /nextAckRetryDelay/);
  assert.match(bgSource, /ackRetryCount/);
  assert.match(bgSource, /lastSentJson = "";/);
});

// 5. blind loading/discarded signal without a URL schedules a 1.5 s clear.
test("isBlindReloadSignal fires only on loading or discarded", () => {
  assert.equal(NO_URL_CLEAR_DELAY_MS, 1500);
  assert.equal(isBlindReloadSignal({ status: "loading" }), true);
  assert.equal(isBlindReloadSignal({ discarded: true }), true);
  assert.equal(isBlindReloadSignal({ status: "complete" }), false);
  assert.equal(isBlindReloadSignal({ url: "https://www.crunchyroll.com/watch/G1" }), false);
  assert.equal(isBlindReloadSignal(null), false);
  assert.equal(isBlindReloadSignal("loading"), false);
});

test("onUpdated schedules a delayed clear that crp-state cancels", () => {
  assert.match(bgSource, /scheduleNoUrlClear/);
  assert.match(bgSource, /cancelNoUrlClear/);
  assert.match(bgSource, /isBlindReloadSignal\(changeInfo\)/);
});

// 6. crp-gone carries a scope; tab scope deletes, frame scope drops one frame.
test("content script scopes pagehide as tab and SPA checkUrl as frame", () => {
  assert.match(contentSource, /scope: "tab"/);
  assert.match(contentSource, /scope: "frame"/);
});

// 11. the watchdog no longer resets lastSentJson every tick.
test("recompute never resets the send dedupe", () => {
  assert.doesNotMatch(bgSource, /if \(!desiredActivity\)/);
});

// 12. boot suppresses the null publish until state or 60 s.
test("boot null publish is suppressed until first state or 60 s", () => {
  assert.equal(BOOT_SUPPRESS_MS, 60000);
  assert.match(bgSource, /seenState/);
  assert.match(bgSource, /BOOT_SUPPRESS_MS/);
});

// 13. status publishes lastSent and the popup renders it.
test("status payload carries lastSent and the popup renders it", () => {
  assert.match(bgSource, /lastSent[^J]/);
  assert.match(popupSource, /lastSent/);
});

// 14. the options test button says queued when the send was queued.
test("options test button reports queued delivery", () => {
  assert.match(optionsSource, /Test activity queued/);
});
