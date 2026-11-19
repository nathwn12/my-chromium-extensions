'use strict';


const { createContentEnv } = require('./stub-env');

(async () => {
  const env = createContentEnv({ capture: 'fail' });
  env.addMedia();
  await env.settle();

  const totals = [];
  for (let cycle = 1; cycle <= 3; cycle++) {
    env.sendRuntime({ type: 'APPLY_LIVE_SETTINGS', settings: { slow: 0.8, reverbIntensity: 0.5 } });
    await env.settle();
    env.runTimers();
    await env.settle();
    totals.push(env.stats.captureCalls);
  }

  console.log('capture attempts after each exhaust-and-resync cycle: ' + JSON.stringify(totals));
  const total = totals[totals.length - 1];
  const ok = total >= 20 && total <= 30;
  console.log(
    ok
      ? 'PASS F6: retry attempts capped across repeated syncAllMedia calls (total=' + total + ')'
      : 'FAIL F6: retry attempts NOT capped (total=' + total + ', expected 20..30)'
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
