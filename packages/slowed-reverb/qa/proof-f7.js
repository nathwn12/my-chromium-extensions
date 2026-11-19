'use strict';


const { createContentEnv } = require('./stub-env');

(async () => {
  const env = createContentEnv();
  const media = env.addMedia();
  await env.settle();
  env.sendRuntime({ type: 'APPLY_LIVE_SETTINGS', settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle();
  env.runTimers();
  await env.settle();

  if (media.playbackRate !== 0.8) {
    console.error('SETUP: media did not attach (rate=' + media.playbackRate + ')');
    process.exit(2);
  }

  media.preservesPitch = false;
  media.mozPreservesPitch = false;
  media.webkitPreservesPitch = false;
  const rampedBefore = env.stats.ramped;
  media.dispatchEvent(new Event('volumechange'));
  await env.settle();

  const got = {
    playbackRate: media.playbackRate,
    preservesPitch: media.preservesPitch,
    rampedBefore,
    rampedAfter: env.stats.ramped,
  };
  console.log('after volumechange: ' + JSON.stringify(got));
  let failures = 0;
  function check(name, ok) {
    console.log((ok ? 'PASS F7: ' : 'FAIL F7: ') + name);
    if (!ok) failures++;
  }
  check('volumechange leaves playbackRate untouched', got.playbackRate === 0.8);
  check('volumechange leaves page pitch state untouched', got.preservesPitch === false);
  check('volumechange keeps the gain ramp', got.rampedAfter > got.rampedBefore);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
