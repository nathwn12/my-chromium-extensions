import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildActivity } from "../../activity.js";
import { musicPage, node, video } from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");

function loadExtractor() {
  const context = createContext({});
  runInContext(source, context, { filename: "extract-youtube.js" });
  return context.YoutubeExtract;
}
const api = loadExtractor();

/** The extractor runs in a vm realm; round-trip proves the payload is serializable. */
function read(doc, nav, loc) {
  return JSON.parse(JSON.stringify(api.read(doc, nav, loc)));
}

/** A whole-second instant: a non-1x rate bias cannot shift its floor. */
const SAMPLE_AT = 1_700_000_000_000;

test("the progress bar is authoritative over a stale element and clock, rate from the element", () => {
  const bar = node("div", {
    attrs: { id: "progress-bar", "aria-valuenow": "35", "aria-valuemax": "213" }
  });
  const page = musicPage({
    title: "Slowed Reverb Song",
    byline: [node("a", { attrs: { href: "channel/UCslowed" }, text: "Slowed Artist" })],
    time: "2:34 / 3:32",
    children: [
      video({ currentTime: 154, duration: 212, playbackRate: 0.8, paused: false, muted: true }),
      bar
    ]
  });

  const state = read(page.doc, page.navigator, page.location);
  const detail = `extracted position=${state.position} duration=${state.duration} playbackRate=${state.playbackRate} paused=${state.paused}`;

  assert.equal(state.position, 35, detail);
  assert.equal(state.duration, 213, detail);
  assert.equal(state.playbackRate, 0.8, detail);
  assert.equal(state.paused, false, detail);

  const frame = buildActivity({ ...state, at: SAMPLE_AT }, SAMPLE_AT);
  const start = Math.floor(SAMPLE_AT / 1000) - 35;
  assert.deepEqual(
    frame.timestamps,
    { start, end: start + 213 },
    `worker frame ${JSON.stringify(frame.timestamps)}; ${detail}`
  );
});

test("without a progress bar the existing element/clock path is unchanged", () => {
  const page = musicPage({
    title: "Plain Song",
    byline: [node("a", { attrs: { href: "channel/UCplain" }, text: "Plain Artist" })],
    children: [video({ currentTime: 42, duration: 213, paused: false, playbackRate: 1.25 })]
  });

  const state = read(page.doc, page.navigator, page.location);
  const detail = `position=${state.position} duration=${state.duration} playbackRate=${state.playbackRate}`;
  assert.equal(state.position, 42, detail);
  assert.equal(state.duration, 213, detail);
  assert.equal(state.playbackRate, 1.25, detail);
  assert.equal(state.paused, false, detail);
});

test("a music video page takes timing from the progress bar and rate from the element", () => {
  const bar = node("div", {
    attrs: { id: "progress-bar", "aria-valuenow": "61", "aria-valuemax": "200" }
  });
  const page = musicPage({
    title: "Music Video",
    byline: [node("a", { attrs: { href: "channel/UCvideo" }, text: "Video Artist" })],
    time: "1:01 / 3:20",
    children: [
      video({ currentTime: 120, duration: 199, playbackRate: 1.3, paused: false }),
      bar
    ]
  });

  const state = read(page.doc, page.navigator, page.location);
  const detail = `position=${state.position} duration=${state.duration} playbackRate=${state.playbackRate}`;
  assert.equal(state.position, 61, detail);
  assert.equal(state.duration, 200, detail);
  assert.equal(state.playbackRate, 1.3, detail);
  assert.equal(state.paused, false, detail);
});
