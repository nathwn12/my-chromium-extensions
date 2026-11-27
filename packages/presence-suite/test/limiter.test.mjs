import { test } from "node:test";
import assert from "node:assert/strict";

import { createCoalescingLimiter } from "../background.js";

/** Deterministic clock + scheduler: advance() fires due timers in due order. */
function harness(overrides = {}) {
  let clock = 0;
  let nextId = 0;
  const jobs = [];
  const sent = [];
  const limiter = createCoalescingLimiter({
    max: 4,
    windowMs: 1000,
    minGapMs: 100,
    send: (payload) => sent.push(payload),
    now: () => clock,
    schedule: (fn, ms) => {
      const job = { id: ++nextId, fn, delay: ms, at: clock + ms, cancelled: false, fired: false };
      jobs.push(job);
      return job;
    },
    cancel: (handle) => { if (handle) handle.cancelled = true; },
    ...overrides,
  });
  return {
    limiter,
    sent,
    jobs,
    setClock(value) { clock = value; },
    advance(to) {
      clock = to;
      for (;;) {
        const due = jobs
          .filter((job) => !job.cancelled && !job.fired && job.at <= clock)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) return;
        due.fired = true;
        due.fn();
      }
    },
    active() { return jobs.filter((job) => !job.cancelled && !job.fired); },
  };
}

// Mutation: make push keep the first pending payload ("if (!hasPending) pending = payload").
test("limiter: newest payload wins while a send is pending", () => {
  const h = harness();
  h.limiter.push("first"); // t=0: gap is open, immediate send
  h.setClock(10);
  h.limiter.push("second"); // gap blocked: pending + timer
  assert.equal(h.limiter.pending, "second");
  h.setClock(20);
  h.limiter.push("third"); // replaces the pending payload, no second timer
  assert.equal(h.limiter.pending, "third");
  assert.equal(h.jobs.length, 1);
  h.advance(100);
  assert.deepEqual(h.sent, ["first", "third"]);
  assert.equal(h.limiter.hasPending, false);
});

// Mutation: make nextSendAt return 0 instead of lastSentAt + minGapMs.
test("limiter: min gap paces the next send with the injected clock and scheduler", () => {
  const h = harness();
  h.limiter.push("first");
  h.setClock(10);
  h.limiter.push("second");
  assert.deepEqual(h.sent, ["first"]);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].delay, 90, "100ms gap minus 10ms elapsed");
  assert.equal(h.jobs[0].at, 100);
  h.advance(100);
  assert.deepEqual(h.sent, ["first", "second"]);
});

// Mutation: drop the sentAt.length >= max condition from push/nextSendAt (no window throttle).
test("limiter: max per window holds the third payload until the window edge", () => {
  const h = harness({ max: 2, windowMs: 1000, minGapMs: 0 });
  h.limiter.push("a"); // t=0
  h.setClock(1);
  h.limiter.push("b"); // t=1
  assert.deepEqual(h.sent, ["a", "b"]);
  h.setClock(2);
  h.limiter.push("c");
  assert.deepEqual(h.sent, ["a", "b"]);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].delay, 998, "window edge at 0+1000, now 2");
  h.advance(1000);
  assert.deepEqual(h.sent, ["a", "b", "c"]);
});

// Mutation: ignore the force option in push (treat forced pushes as ordinary).
test("limiter: force bypasses both the min gap and the window cap", () => {
  const gap = harness();
  gap.limiter.push("first");
  gap.setClock(10);
  gap.limiter.push("forced", { force: true });
  assert.deepEqual(gap.sent, ["first", "forced"]);
  assert.equal(gap.jobs.length, 0);

  const capped = harness({ max: 1, windowMs: 1000, minGapMs: 0 });
  capped.limiter.push("one");
  capped.setClock(1);
  capped.limiter.push("two", { force: true });
  assert.deepEqual(capped.sent, ["one", "two"]);
  assert.equal(capped.jobs.length, 0);
});

// Mutation: make cancelPending a no-op (leave pending and timer alive).
test("limiter: cancelPending drops the pending payload and cancels its timer", () => {
  const h = harness();
  h.limiter.push("first");
  h.setClock(10);
  h.limiter.push("dropped");
  h.limiter.cancelPending();
  assert.equal(h.limiter.pending, null);
  assert.equal(h.limiter.hasPending, false);
  assert.equal(h.active().length, 0);
  h.advance(100);
  assert.deepEqual(h.sent, ["first"]);
});

// Mutation: make reset leave sentAt/lastSentAt intact (clear only pending).
test("limiter: reset clears history so the next push goes out immediately", () => {
  const h = harness();
  h.limiter.push("first");
  h.setClock(10);
  h.limiter.push("pending");
  h.limiter.reset();
  assert.equal(h.limiter.hasPending, false);
  h.setClock(10);
  h.limiter.push("after-reset");
  assert.deepEqual(h.sent, ["first", "after-reset"]);
  assert.equal(h.active().length, 0, "reset must cancel the old timer");
});
