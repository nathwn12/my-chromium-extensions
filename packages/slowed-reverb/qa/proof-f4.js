'use strict';

/*
 * qa/proof-f4.js - F4 teardown proof (pure Node stub harness, real content-script.js).
 * Attaches, then drives the bypass path (TOGGLE_CHANGED enabled:false) and asserts
 * every captured track was stopped and the context suspended once zero controllers
 * remain attached. RED: tracks running, context running. GREEN: both released.
 * Exit 0 = holds, 1 = failed, 2 = harness setup problem.
 */

const { createContentEnv } = require('./stub-env');

(async () => {
  const env = createContentEnv();
  const media = env.addMedia();
  await env.settle();
  env.sendRuntime({ type: 'APPLY_LIVE_SETTINGS', settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle();
  env.runTimers();
  await env.settle();

  if (media.playbackRate !== 0.8 || media.tracks.length === 0) {
    console.error('SETUP: media did not attach (rate=' + media.playbackRate + ', tracks=' + media.tracks.length + ')');
    process.exit(2);
  }
  if (env.stats.contexts.length === 0) {
    console.error('SETUP: no AudioContext was created');
    process.exit(2);
  }

  env.sendRuntime({ type: 'TOGGLE_CHANGED', enabled: false });
  await env.settle();

  const stopped = media.tracks.map((t) => t.stopped);
  const ctxStates = env.stats.contexts.map((c) => c.state);
  console.log('tracks stopped after bypass: ' + JSON.stringify(stopped));
  console.log('context states after bypass: ' + JSON.stringify(ctxStates));

  let failures = 0;
  function check(name, ok) {
    console.log((ok ? 'PASS F4: ' : 'FAIL F4: ') + name);
    if (!ok) failures++;
  }
  check('bypass stops all captured tracks', stopped.length > 0 && stopped.every(Boolean));
  check('context suspended with zero controllers attached', ctxStates.length > 0 && ctxStates.every((s) => s === 'suspended'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
