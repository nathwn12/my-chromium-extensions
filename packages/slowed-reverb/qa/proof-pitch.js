'use strict';

/*
 * qa/proof-pitch.js - "speed and pitch move together" proof (pure Node stub harness).
 *
 * Scratch artifact for session ses_ec9c91713ffePHOn6o2dmsFmWo.
 *
 * SAFETY (repo AGENTS.md ## Verification safety): plain Node only. No browser is
 * launched, no AudioContext with a device is created, no audio plays. The REAL
 * content-script.js is evaluated with browser globals stubbed (qa/stub-env.js)
 * and driven through its real seams (chrome runtime messages, media events).
 *
 * Mechanism (source: MDN HTMLMediaElement.preservesPitch, verified 2026-10-14):
 * the property defaults to `true`; when it is `false` the browser does NOT
 * compensate the pitch for playbackRate changes, so pitch follows speed. The
 * extension therefore has to force it OFF on every non-neutral rate write.
 *
 * Supersedes qa/proof-f1.js, which asserts the pre-fix intent
 * (preservesPitch === true at slow=0.8) and is expected to FAIL now.
 *
 * Exit 0 = every check passed, 1 = a check failed, 2 = harness setup problem.
 */

const { createContentEnv } = require('./stub-env');

const SR = 44100;
const TONE_HZ = 440;
const SR_SECONDS = 0.5;

function semitones(ratio) {
  return 12 * Math.log2(ratio);
}

// Linear-interpolation resampler: y[n] = x(n * rate) is exactly "play the
// source at `rate` with pitch not compensated" (no phase vocoder). Returns the
// measured output frequency by zero-crossing count.
function measureResampledHz(rate) {
  const n = Math.round(SR * SR_SECONDS);
  const src = new Float64Array(n * 2);
  for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * TONE_HZ * i) / SR);
  let crossings = 0;
  let prev = src[0];
  for (let i = 0; i < n; i++) {
    const pos = i * rate;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const y = src[i0] * (1 - frac) + src[i0 + 1] * frac;
    if (i > 0 && ((prev < 0 && y >= 0) || (prev >= 0 && y < 0))) crossings++;
    prev = y;
  }
  return crossings / 2 / SR_SECONDS;
}

(async () => {
  const env = createContentEnv({
    runtimeState: { eligible: true, bypass: false, settings: { slow: 0.8, reverbIntensity: 0.5 } },
  });
  const media = env.addMedia();
  const flags = () => [media.preservesPitch, media.mozPreservesPitch, media.webkitPreservesPitch];
  const allOff = () => flags().every((v) => v === false);
  const checks = [];
  const mk = (name, ok, detail) => checks.push({ name, ok, detail });

  async function applySettings(settings) {
    env.sendRuntime({ type: 'APPLY_LIVE_SETTINGS', settings });
    await env.settle();
    env.runTimers();
    await env.settle();
  }

  await env.settle();
  await applySettings({ slow: 0.8, reverbIntensity: 0.5 });

  if (media.playbackRate !== 0.8) {
    console.error('SETUP: media did not attach (playbackRate=' + media.playbackRate + ')');
    process.exit(2);
  }
  const original = { rate: 1, pitch: [true, true, true], muted: false };

  // A. the slow rate itself must stop compensating pitch.
  mk(
    'A attach at slow=0.8 forces all three pitch aliases OFF',
    allOff(),
    'rate=' + media.playbackRate + ' flags=' + JSON.stringify(flags()) + ' muted=' + media.muted
  );

  // B. the page player writes the aliases back (the chipmunk-clobber inverse):
  //    our re-assert must win on the ratechange path, rate included.
  const CYCLES = 12;
  let corrected = 0;
  for (let i = 0; i < CYCLES; i++) {
    media.preservesPitch = true;
    media.mozPreservesPitch = true;
    media.webkitPreservesPitch = true;
    if (i % 2 === 1) media.playbackRate = 1; // page also forces its own rate
    media.dispatchEvent(new Event('ratechange'));
    await env.settle(4);
    if (allOff() && media.playbackRate === 0.8) corrected++;
  }
  mk(
    'B ratechange path re-asserts OFF + rate after page clobber',
    corrected === CYCLES,
    'corrected=' + corrected + '/' + CYCLES + ' flags=' + JSON.stringify(flags()) + ' rate=' + media.playbackRate
  );

  // C. a clobber with NO event still gets corrected by the next sync.
  media.preservesPitch = true;
  media.mozPreservesPitch = true;
  media.webkitPreservesPitch = true;
  await applySettings({ slow: 0.8, reverbIntensity: 0.5 });
  mk('C sync path re-asserts OFF after a silent clobber', allOff(), 'flags=' + JSON.stringify(flags()));

  // D. speed slider moves -> pitch follows at every supported rate.
  const rateRows = [];
  let rateOk = true;
  for (const slow of [0.7, 0.9, 1.1, 1.3]) {
    await applySettings({ slow, reverbIntensity: 0.5 });
    const row = { slow, rate: media.playbackRate, off: allOff(), semitones: +semitones(media.playbackRate).toFixed(2) };
    rateRows.push(row);
    if (row.rate !== slow || !row.off) rateOk = false;
  }
  mk('D every speed step: rate applied + pitch aliases OFF', rateOk, JSON.stringify(rateRows));

  // E. neutral restores the element's own state (rate + pitch), still attached.
  await applySettings({ slow: 1, reverbIntensity: 0 });
  mk(
    'E neutral slow=1 restores original rate and pitch, element stays attached',
    media.playbackRate === original.rate &&
      flags().join() === original.pitch.join() &&
      media.muted === true,
    'rate=' + media.playbackRate + ' flags=' + JSON.stringify(flags()) + ' muted=' + media.muted
  );

  // F. bypass teardown restores rate/pitch/mute and stops the captured track.
  env.sendRuntime({ type: 'TOGGLE_CHANGED', enabled: false });
  await env.settle();
  env.runTimers();
  await env.settle();
  const track = media.tracks[0];
  mk(
    'F bypass restore: original rate/pitch/mute + captured track stopped',
    media.playbackRate === original.rate &&
      flags().join() === original.pitch.join() &&
      media.muted === original.muted &&
      Boolean(track && track.stopped),
    'rate=' + media.playbackRate +
      ' flags=' + JSON.stringify(flags()) +
      ' muted=' + media.muted +
      ' trackStopped=' + Boolean(track && track.stopped)
  );

  // G. re-enable after teardown: still coupled.
  env.sendRuntime({ type: 'TOGGLE_CHANGED', enabled: true });
  await env.settle();
  env.runTimers();
  await env.settle();
  await applySettings({ slow: 0.85, reverbIntensity: 0.5 });
  mk('G re-attach at slow=0.85 is coupled again', media.playbackRate === 0.85 && allOff(), 'rate=' + media.playbackRate + ' flags=' + JSON.stringify(flags()));

  // H. numeric: the resampler fed with the REAL element rate, both flag branches.
  const measured = {};
  let hOk = true;
  for (const slow of [0.7, 0.85, 1.3]) {
    await applySettings({ slow, reverbIntensity: 0.5 });
    const rate = media.playbackRate;
    const follows = measureResampledHz(rate); // the branch preservesPitch === false selects
    const expected = TONE_HZ * rate;
    const relErr = Math.abs(follows - expected) / expected;
    measured['rate=' + rate] = {
      inputHz: TONE_HZ,
      pitchHz: +follows.toFixed(1),
      expectedHz: +expected.toFixed(1),
      relErr: +relErr.toFixed(4),
      semitones: +semitones(rate).toFixed(2),
      ifPreservedHz: TONE_HZ,
      aliasesOff: allOff(),
    };
    if (relErr > 0.01 || !allOff()) hOk = false;
  }
  mk(
    'H numeric: measured pitch = 440 Hz x rate under the OFF branch (pitch follows speed)',
    hOk,
    JSON.stringify(measured)
  );

  env.restoreTimers();

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + '\n      ' + c.detail);
  }
  console.log('summary: ' + (checks.length - failed) + '/' + checks.length + ' checks passed');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
