'use strict';

/*
 * qa/shared-unit.js - pure-Node unit tests for the REAL shared.js.
 *
 * SAFETY: no browser, no audio device, no network. shared.js is a UMD that assigns
 * globalThis.SlowedReverbShared; it is evaluated here unmodified with vm.runInThisContext.
 * No `chrome` stub is needed: every helper under test is storage-free. (loadSiteState /
 * saveSiteState do need chrome but are out of scope and never called.)
 *
 * Note: clampSlow / clampIntensity are module-private in shared.js - they are NOT part of
 * the exported API. Their clamping/rounding bounds are asserted through normalizeSettings,
 * their only public seam, plus directly through formatRate / formatPercent which both apply
 * the same clamps.
 *
 * Exit code 0 = all assertions pass, 1 = one or more failed, 2 = harness setup problem.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { isDeepStrictEqual } = require('node:util');

const sharedPath = path.join(__dirname, '..', 'shared.js');
vm.runInThisContext(fs.readFileSync(sharedPath, 'utf8'), { filename: sharedPath });
const shared = globalThis.SlowedReverbShared;

if (!shared) {
  console.error('FATAL: shared.js did not assign globalThis.SlowedReverbShared');
  process.exit(2);
}

let passed = 0;
let failed = 0;

function show(value) {
  return JSON.stringify(value);
}

function check(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) {
    passed++;
    console.log('PASS  ' + name);
  } else {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      expected: ' + show(expected));
    console.log('      actual:   ' + show(actual));
  }
}

const DEFAULTS = { slow: 1, reverbIntensity: 0 };

console.log('=== shared.js unit tests (pure Node; real shared.js: ' + sharedPath + ') ===');
console.log('INFO  clampSlow/clampIntensity are not exported; their bounds are asserted via normalizeSettings and formatRate/formatPercent.');
console.log('');

// ---------- normalizeSettings: defaults ----------
check('normalizeSettings() fills defaults', shared.normalizeSettings(), DEFAULTS);
check('normalizeSettings(undefined) fills defaults', shared.normalizeSettings(undefined), DEFAULTS);
check('normalizeSettings(null) fills defaults', shared.normalizeSettings(null), DEFAULTS);
check('normalizeSettings({}) fills defaults', shared.normalizeSettings({}), DEFAULTS);
check('normalizeSettings(non-object number) fills defaults', shared.normalizeSettings(42), DEFAULTS);
check('normalizeSettings(non-object string) fills defaults', shared.normalizeSettings('nope'), DEFAULTS);
check('normalizeSettings(non-object boolean) fills defaults', shared.normalizeSettings(true), DEFAULTS);
check(
  'normalizeSettings drops unknown keys',
  Object.keys(shared.normalizeSettings({ slow: 1, reverbIntensity: 0, foo: 1 })).sort(),
  ['reverbIntensity', 'slow']
);

// ---------- normalizeSettings: clamping + rounding (clampSlow / clampIntensity bounds) ----------
check('slow clamps to lower bound 0.7', shared.normalizeSettings({ slow: 0.1 }).slow, 0.7);
check('slow clamps to lower bound 0.7 (zero)', shared.normalizeSettings({ slow: 0 }).slow, 0.7);
check('slow clamps to lower bound 0.7 (negative)', shared.normalizeSettings({ slow: -5 }).slow, 0.7);
check('slow clamps to upper bound 1.3', shared.normalizeSettings({ slow: 2 }).slow, 1.3);
check('slow clamps to upper bound 1.3 (far over)', shared.normalizeSettings({ slow: 99 }).slow, 1.3);
check('slow keeps exact lower bound 0.7', shared.normalizeSettings({ slow: 0.7 }).slow, 0.7);
check('slow keeps exact upper bound 1.3', shared.normalizeSettings({ slow: 1.3 }).slow, 1.3);
check('slow rounds to 2 decimals (round down)', shared.normalizeSettings({ slow: 0.744 }).slow, 0.74);
check('slow rounds to 2 decimals (round up)', shared.normalizeSettings({ slow: 1.236 }).slow, 1.24);
check('slow accepts numeric strings', shared.normalizeSettings({ slow: '0.75' }).slow, 0.75);
check('slow: non-finite value falls back to lower bound', shared.normalizeSettings({ slow: NaN }).slow, 0.7);
check('slow: null value falls back to lower bound', shared.normalizeSettings({ slow: null }).slow, 0.7);
check('intensity clamps to lower bound 0', shared.normalizeSettings({ reverbIntensity: -1 }).reverbIntensity, 0);
check('intensity clamps to upper bound 1', shared.normalizeSettings({ reverbIntensity: 2 }).reverbIntensity, 1);
check('intensity keeps exact bounds 0 and 1', [
  shared.normalizeSettings({ reverbIntensity: 0 }).reverbIntensity,
  shared.normalizeSettings({ reverbIntensity: 1 }).reverbIntensity,
], [0, 1]);
check('intensity rounds to 2 decimals (round up)', shared.normalizeSettings({ reverbIntensity: 0.567 }).reverbIntensity, 0.57);
check('intensity rounds to 2 decimals (round down)', shared.normalizeSettings({ reverbIntensity: 0.333 }).reverbIntensity, 0.33);
check('intensity accepts numeric strings', shared.normalizeSettings({ reverbIntensity: '0.5' }).reverbIntensity, 0.5);
check('intensity: non-finite value falls back to lower bound', shared.normalizeSettings({ reverbIntensity: NaN }).reverbIntensity, 0);
check('defaults are exactly slow=1 / reverbIntensity=0', shared.getDefaultSettings(), DEFAULTS);

// ---------- isNeutral ----------
check('isNeutral is true for slow=1 & reverbIntensity=0', shared.isNeutral({ slow: 1, reverbIntensity: 0 }), true);
check('isNeutral is true when both are omitted (defaults)', shared.isNeutral({}), true);
check('isNeutral is true for no argument', shared.isNeutral(), true);
check('isNeutral is true for null', shared.isNeutral(null), true);
check('isNeutral is true when values round to neutral (1.004 / 0.004)', shared.isNeutral({ slow: 1.004, reverbIntensity: 0.004 }), true);
check('isNeutral is true for numeric strings "1" / "0"', shared.isNeutral({ slow: '1', reverbIntensity: '0' }), true);
check('isNeutral is false for slow=1.01', shared.isNeutral({ slow: 1.01 }), false);
check('isNeutral is false for slow=0.99', shared.isNeutral({ slow: 0.99 }), false);
check('isNeutral is false for reverbIntensity=0.01', shared.isNeutral({ reverbIntensity: 0.01 }), false);
check('isNeutral is false when only reverbIntensity is non-neutral', shared.isNeutral({ slow: 1, reverbIntensity: 0.5 }), false);
check('isNeutral is false when only slow is non-neutral', shared.isNeutral({ slow: 1.3, reverbIntensity: 0 }), false);
check('isNeutral is false at reverbIntensity=1', shared.isNeutral({ slow: 1, reverbIntensity: 1 }), false);

// ---------- formatRate ----------
check('formatRate(1) = "1.00x"', shared.formatRate(1), '1.00x');
check('formatRate(0.7) = "0.70x"', shared.formatRate(0.7), '0.70x');
check('formatRate(1.3) = "1.30x"', shared.formatRate(1.3), '1.30x');
check('formatRate(0.744) rounds to "0.74x"', shared.formatRate(0.744), '0.74x');
check('formatRate(0) clamps to "0.70x"', shared.formatRate(0), '0.70x');
check('formatRate(5) clamps to "1.30x"', shared.formatRate(5), '1.30x');
check('formatRate(NaN) clamps to "0.70x"', shared.formatRate(NaN), '0.70x');

// ---------- formatPercent ----------
check('formatPercent(0) = "0%"', shared.formatPercent(0), '0%');
check('formatPercent(0.5) = "50%"', shared.formatPercent(0.5), '50%');
check('formatPercent(0.567) rounds to "57%"', shared.formatPercent(0.567), '57%');
check('formatPercent(0.004) rounds to "0%"', shared.formatPercent(0.004), '0%');
check('formatPercent(1) = "100%"', shared.formatPercent(1), '100%');
check('formatPercent(2) clamps to "100%"', shared.formatPercent(2), '100%');
check('formatPercent(-1) clamps to "0%"', shared.formatPercent(-1), '0%');
check('formatPercent(NaN) clamps to "0%"', shared.formatPercent(NaN), '0%');

// ---------- isSupportedHost: exactly youtube.com / www.youtube.com / music.youtube.com ----------
check('isSupportedHost accepts youtube.com', shared.isSupportedHost('youtube.com'), true);
check('isSupportedHost accepts www.youtube.com', shared.isSupportedHost('www.youtube.com'), true);
check('isSupportedHost accepts music.youtube.com', shared.isSupportedHost('music.youtube.com'), true);
check('isSupportedHost is case-insensitive (YouTube.COM)', shared.isSupportedHost('YouTube.COM'), true);
check('isSupportedHost rejects m.youtube.com (deliberate, documented exclusion)', shared.isSupportedHost('m.youtube.com'), false);
check('isSupportedHost rejects M.YOUTUBE.COM', shared.isSupportedHost('M.YOUTUBE.COM'), false);
check('isSupportedHost rejects youtu.be', shared.isSupportedHost('youtu.be'), false);
check('isSupportedHost rejects www.youtu.be', shared.isSupportedHost('www.youtu.be'), false);
check('isSupportedHost rejects notyoutube.com', shared.isSupportedHost('notyoutube.com'), false);
check('isSupportedHost rejects youtube.com.evil.com', shared.isSupportedHost('youtube.com.evil.com'), false);
check('isSupportedHost rejects music.youtube.com.evil.com', shared.isSupportedHost('music.youtube.com.evil.com'), false);
check('isSupportedHost rejects empty/null/undefined', [
  shared.isSupportedHost(''),
  shared.isSupportedHost(null),
  shared.isSupportedHost(undefined),
], [false, false, false]);

// ---------- isSupportedUrl: https + the supported host set ----------
check('isSupportedUrl accepts https://youtube.com/watch?v=1', shared.isSupportedUrl('https://youtube.com/watch?v=1'), true);
check('isSupportedUrl accepts https://www.youtube.com/', shared.isSupportedUrl('https://www.youtube.com/'), true);
check('isSupportedUrl accepts https://music.youtube.com/watch?v=x', shared.isSupportedUrl('https://music.youtube.com/watch?v=x'), true);
check('isSupportedUrl is host-case-insensitive', shared.isSupportedUrl('https://YouTube.com/watch?v=1'), true);
check('isSupportedUrl ignores the port (hostname-only check)', shared.isSupportedUrl('https://youtube.com:8443/watch?v=1'), true);
check('isSupportedUrl rejects m.youtube.com', shared.isSupportedUrl('https://m.youtube.com/watch?v=1'), false);
check('isSupportedUrl rejects https://m.youtube.com (root)', shared.isSupportedUrl('https://m.youtube.com/'), false);
check('isSupportedUrl requires https: http://youtube.com is rejected', shared.isSupportedUrl('http://youtube.com/watch?v=1'), false);
check('isSupportedUrl requires https: http://www.youtube.com is rejected', shared.isSupportedUrl('http://www.youtube.com/'), false);
check('isSupportedUrl rejects youtu.be', shared.isSupportedUrl('https://youtu.be/abc'), false);
check('isSupportedUrl rejects subdomains other than www/music', shared.isSupportedUrl('https://sub.youtube.com/watch'), false);
check('isSupportedUrl rejects youtube.com.evil.com', shared.isSupportedUrl('https://youtube.com.evil.com/watch'), false);
check('isSupportedUrl rejects youtube.com in a query string', shared.isSupportedUrl('https://evil.com/?next=youtube.com'), false);
check('isSupportedUrl rejects ftp://youtube.com', shared.isSupportedUrl('ftp://youtube.com/'), false);
check('isSupportedUrl rejects unparseable input', [
  shared.isSupportedUrl('not a url'),
  shared.isSupportedUrl(''),
  shared.isSupportedUrl(null),
  shared.isSupportedUrl(undefined),
], [false, false, false, false]);

// ---------- export surface (documents the seam used above) ----------
check('clampSlow is not part of the exported API', typeof shared.clampSlow, 'undefined');
check('clampIntensity is not part of the exported API', typeof shared.clampIntensity, 'undefined');

console.log('');
console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed.');
process.exitCode = failed === 0 ? 0 : 1;
