'use strict';

/* global require, __dirname */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
vm.runInThisContext(readFileSync(join(root, 'shared.js'), 'utf8'), { filename: 'shared.js' });
const shared = globalThis.SlowedReverbShared;
assert.ok(shared, 'shared.js loaded');

const contentSrc = readFileSync(join(root, 'content-script.js'), 'utf8');
const backgroundSrc = readFileSync(join(root, 'background.js'), 'utf8');
const actionsSrc = readFileSync(join(root, 'player-actions.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

function loadRate() {
  const names = [
    'pitchStateMatches',
    'readMaybe',
    'writeMaybe',
    'readPitchState',
    'applyPitchState',
    'setPreservesPitch',
    'intendedPlaybackState',
    'writeIntendedRate',
  ];
  const pieces = names.map((name) => extractFunction(contentSrc, name));
  assert.ok(pieces.every(Boolean), 'pitch functions are readable');
  return new Function(
    pieces.join('\n') +
    '\nreturn { intendedPlaybackState, writeIntendedRate, pitchStateMatches, readPitchState, applyPitchState };'
  )();
}

const rate = loadRate();
const flags = (media) => [media.preservesPitch, media.mozPreservesPitch, media.webkitPreservesPitch];

function stubMedia() {
  return { playbackRate: 1, preservesPitch: true, mozPreservesPitch: true, webkitPreservesPitch: true };
}

function controller(media) {
  return {
    media,
    originalRate: 1,
    originalPitch: { preservesPitch: true, mozPreservesPitch: true, webkitPreservesPitch: true },
    internalRateWrite: false,
  };
}

test('settings: lockPitch defaults to false and only a real true enables it', () => {
  assert.equal(shared.getDefaultSettings().lockPitch, false, 'default is off');
  assert.equal(shared.normalizeSettings(null).lockPitch, false, 'missing settings migrate to off');
  assert.equal(shared.normalizeSettings({ slow: 0.6 }).lockPitch, false, 'a stored site without the flag migrates');
  assert.equal(shared.normalizeSettings({ lockPitch: true }).lockPitch, true, 'true is kept');
  assert.equal(shared.normalizeSettings({ lockPitch: 'false' }).lockPitch, false, 'a string is never true');
  assert.equal(shared.normalizeSettings({ lockPitch: 1 }).lockPitch, false, 'a number is never true');
});

test('settings: a missing flag migrates on a patch write without reordering or rewriting other hosts', () => {
  const all = {
    'music.youtube.com': { slow: 0.6, reverbIntensity: 1, volume: 20 },
    'other.example.com': { slow: 1.2, reverbIntensity: 0.4, volume: 60, lockPitch: true },
  };
  const siteKey = 'music.youtube.com';
  all[siteKey] = shared.normalizeSettings({ ...(all[siteKey] || {}), ...{ volume: 30 } });
  assert.equal(all[siteKey].lockPitch, false, 'the absent flag is added as false');
  assert.equal(all[siteKey].slow, 0.6);
  assert.equal(all[siteKey].reverbIntensity, 1);
  assert.equal(all[siteKey].volume, 30, 'the patch wins');
  assert.deepEqual(all['other.example.com'], { slow: 1.2, reverbIntensity: 0.4, volume: 60, lockPitch: true }, 'another host is untouched');
  assert.ok(
    backgroundSrc.includes('normalizeSettings({ ...(current || {}), ...patch })'),
    'the persisted patch merge is unchanged'
  );
  assert.match(
    backgroundSrc,
    /async function setStoredSiteSettings\(siteKey, patch\) \{\s*return serializeSettingsWrite\(/,
    'settings writes stay serialized'
  );
});

test('endpoints: 0.60x and 1.30x respect the toggle on all three pitch aliases', () => {
  for (const slow of [0.6, 1.3]) {
    for (const lockPitch of [false, true]) {
      const media = stubMedia();
      const ctl = controller(media);
      const intended = rate.intendedPlaybackState(ctl, slow, lockPitch);
      assert.equal(intended.neutral, false);
      assert.equal(intended.intendedRate, slow);
      assert.deepEqual(intended.intendedPitch, {
        preservesPitch: lockPitch,
        mozPreservesPitch: lockPitch,
        webkitPreservesPitch: lockPitch,
      });
      assert.equal(rate.writeIntendedRate(ctl, slow, lockPitch), true, 'rate write landed at ' + slow);
      assert.equal(media.playbackRate, slow);
      assert.deepEqual(flags(media), [lockPitch, lockPitch, lockPitch]);
    }
  }
});

test('default call shape stays off; 1.00x restores original pitch with either toggle state', () => {
  const off = stubMedia();
  const offCtl = controller(off);
  assert.equal(rate.writeIntendedRate(offCtl, 0.6), true);
  assert.deepEqual(flags(off), [false, false, false], 'a two-argument write keeps the old pitch-off behavior');

  for (const lockPitch of [false, true]) {
    const media = stubMedia();
    const ctl = controller(media);
    assert.equal(rate.writeIntendedRate(ctl, 0.6, lockPitch), true);
    assert.equal(rate.writeIntendedRate(ctl, 1, lockPitch), true);
    assert.equal(media.playbackRate, 1, 'normal speed restores the original rate');
    assert.deepEqual(flags(media), [true, true, true], 'normal speed restores the original pitch');
    const intended = rate.intendedPlaybackState(ctl, 1, lockPitch);
    assert.equal(intended.neutral, true);
    assert.deepEqual(intended.intendedPitch, ctl.originalPitch);
  }
  assert.equal(rate.intendedPlaybackState.length, 2, 'the toggle is an optional third input');
  assert.equal(rate.writeIntendedRate.length, 2, 'the toggle is an optional third input');
});

test('external pitch is still saved, applied and restored through the same aliases', () => {
  const media = stubMedia();
  media.preservesPitch = false;
  media.mozPreservesPitch = false;
  media.webkitPreservesPitch = false;
  const external = rate.readPitchState(media);
  assert.deepEqual(external, { preservesPitch: false, mozPreservesPitch: false, webkitPreservesPitch: false });
  const ctl = controller(media);
  ctl.originalPitch = external;

  assert.equal(rate.writeIntendedRate(ctl, 1.3, true), true);
  assert.deepEqual(flags(media), [true, true, true], 'lock pitch overrides the aliases while sped up');
  rate.applyPitchState(media, ctl.originalPitch);
  assert.deepEqual(flags(media), [false, false, false], 'the saved external aliases apply unchanged');
  assert.equal(rate.writeIntendedRate(ctl, 1, true), true, 'neutral restores them');
  assert.deepEqual(flags(media), [false, false, false], 'the external pitch survives a sped-up round trip');

  const restore = (contentSrc.match(/function restoreMediaPlaybackState\(controller\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  assert.match(restore, /applyPitchState\(media, controller\.originalPitch\)/, 'detach restores the saved aliases');
  assert.doesNotMatch(restore, /lockPitch/, 'detach does not consult the toggle');
});

test('invariants: the toggle lives on the existing in-player surface, never the popup or the mix', () => {
  const popupHtml = readFileSync(join(root, 'popup.html'), 'utf8');
  const popupJs = readFileSync(join(root, 'popup.js'), 'utf8');
  assert.doesNotMatch(popupHtml, /lock/i, 'the four-control popup is unchanged');
  assert.doesNotMatch(popupJs, /lock/i, 'the four-control popup script is unchanged');

  assert.match(actionsSrc, /aria-label', 'Lock pitch'/, 'a labelled checkbox is added to the in-player panel');
  assert.match(actionsSrc, /function currentLockPitch\(\)/, 'the panel reads the persisted flag');
  assert.match(actionsSrc, /storage\.saveLockPitch\(lock\.checked\)/, 'the panel writes the persisted flag');

  const rateFn = extractFunction(contentSrc, 'intendedPlaybackState');
  assert.doesNotMatch(rateFn, /reverbIntensity/, 'pitch intent is independent of reverb');
  assert.doesNotMatch(rateFn, /section|startSeconds|endSeconds/, 'pitch intent is independent of the A-B loop');
  assert.match(contentSrc, /function saveLockPitch\(enabled\)/, 'the toggle persists via the shared settings path');
  assert.match(contentSrc, /getLockPitch: \(\) => state\.settings\.lockPitch === true/, 'the panel reads live settings');
  assert.doesNotMatch(contentSrc, /function [A-Za-z]*[Ll]ock[A-Za-z]*Engine/, 'no second engine is introduced');
});
