'use strict';


const { createContentEnv } = require('./stub-env');

const SR = 44100;
const TONE_HZ = 440;
const SR_SECONDS = 0.5;

function semitones(ratio) {
  return 12 * Math.log2(ratio);
}

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

  mk(
    'A attach at slow=0.8 forces all three pitch aliases OFF',
    allOff(),
    'rate=' + media.playbackRate + ' flags=' + JSON.stringify(flags()) + ' muted=' + media.muted
  );

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

  media.preservesPitch = true;
  media.mozPreservesPitch = true;
  media.webkitPreservesPitch = true;
  await applySettings({ slow: 0.8, reverbIntensity: 0.5 });
  mk('C sync path re-asserts OFF after a silent clobber', allOff(), 'flags=' + JSON.stringify(flags()));

  const rateRows = [];
  let rateOk = true;
  for (const slow of [0.7, 0.9, 1.1, 1.3]) {
    await applySettings({ slow, reverbIntensity: 0.5 });
    const row = { slow, rate: media.playbackRate, off: allOff(), semitones: +semitones(media.playbackRate).toFixed(2) };
    rateRows.push(row);
    if (row.rate !== slow || !row.off) rateOk = false;
  }
  mk('D every speed step: rate applied + pitch aliases OFF', rateOk, JSON.stringify(rateRows));

  await applySettings({ slow: 1, reverbIntensity: 0 });
  mk(
    'E neutral slow=1 restores original rate and pitch, element stays attached',
    media.playbackRate === original.rate &&
      flags().join() === original.pitch.join() &&
      media.muted === true,
    'rate=' + media.playbackRate + ' flags=' + JSON.stringify(flags()) + ' muted=' + media.muted
  );

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

  env.sendRuntime({ type: 'TOGGLE_CHANGED', enabled: true });
  await env.settle();
  env.runTimers();
  await env.settle();
  await applySettings({ slow: 0.85, reverbIntensity: 0.5 });
  mk('G re-attach at slow=0.85 is coupled again', media.playbackRate === 0.85 && allOff(), 'rate=' + media.playbackRate + ' flags=' + JSON.stringify(flags()));

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
