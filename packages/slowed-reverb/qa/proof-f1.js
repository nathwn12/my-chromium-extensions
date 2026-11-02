'use strict';

/*
 * qa/proof-f1.js - F1 pitch-preservation proof (pure Node stub harness).
 * Drives the REAL content-script.js: attach at slow=0.8, then assert the element
 * preserves pitch. RED (before fix): preservesPitch === false. GREEN: true.
 * Exit 0 = assertion holds, 1 = assertion failed, 2 = harness setup problem.
 */

const { createContentEnv } = require('./stub-env');

(async () => {
  const env = createContentEnv({
    runtimeState: { eligible: true, bypass: false, settings: { slow: 0.8, reverbIntensity: 0.5 } },
  });
  const media = env.addMedia();
  await env.settle();
  env.sendRuntime({ type: 'APPLY_LIVE_SETTINGS', settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle();
  env.runTimers();
  await env.settle();

  if (media.playbackRate !== 0.8) {
    console.error('SETUP: media did not attach (playbackRate=' + media.playbackRate + ')');
    process.exit(2);
  }
  const got = {
    playbackRate: media.playbackRate,
    preservesPitch: media.preservesPitch,
    mozPreservesPitch: media.mozPreservesPitch,
    webkitPreservesPitch: media.webkitPreservesPitch,
  };
  console.log('media state after syncMediaController at slow=0.8: ' + JSON.stringify(got));
  const ok =
    got.playbackRate === 0.8 &&
    got.preservesPitch === true &&
    got.mozPreservesPitch === true &&
    got.webkitPreservesPitch === true;
  console.log(ok ? 'PASS F1: pitch is preserved at slow=0.8' : 'FAIL F1: pitch was NOT preserved at slow=0.8');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
