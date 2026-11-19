'use strict';


const { createContentEnv } = require('./stub-env');

(async () => {
  const env = createContentEnv();
  const media = env.addMedia({ muted: true });
  await env.settle();
  env.sendRuntime({ type: 'APPLY_LIVE_SETTINGS', settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle();
  env.runTimers();
  await env.settle();

  if (media.playbackRate !== 0.8) {
    console.error('SETUP: media did not attach (rate=' + media.playbackRate + ')');
    process.exit(2);
  }

  env.sendRuntime({ type: 'TOGGLE_CHANGED', enabled: false });
  await env.settle();

  console.log('muted after attach -> teardown: ' + media.muted + ' (started muted=true)');
  const ok = media.muted === true;
  console.log(ok ? 'PASS F5: original muted state restored' : 'FAIL F5: user-muted video was unmuted on bypass');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
