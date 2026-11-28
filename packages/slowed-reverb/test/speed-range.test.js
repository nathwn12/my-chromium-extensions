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

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
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
  assert.ok(pieces.every(Boolean), 'rate functions are readable');
  const factory = new Function(
    pieces.join('\n') +
    '\nreturn { intendedPlaybackState, writeIntendedRate, pitchStateMatches };'
  );
  return factory();
}

const rate = loadRate();

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

const flags = (media) => [media.preservesPitch, media.mozPreservesPitch, media.webkitPreservesPitch];

test('speed range is 0.60x through 1.30x with 1.00x normal', () => {
  assert.equal(shared.normalizeSettings({ slow: 0.6 }).slow, 0.6, '0.60x is accepted');
  assert.equal(shared.normalizeSettings({ slow: 1.3 }).slow, 1.3, '1.30x is accepted');
  assert.equal(shared.normalizeSettings({ slow: 1 }).slow, 1, '1.00x is normal');
  assert.equal(shared.normalizeSettings({ slow: 0.5 }).slow, 1, 'below the lower bound falls back to normal');
  assert.equal(shared.normalizeSettings({ slow: 1.4 }).slow, 1, 'above the upper bound falls back to normal');
  assert.equal(shared.formatRate(0.6), '0.60x');
  assert.equal(shared.formatRate(1.3), '1.30x');
  assert.equal(shared.formatRate(1), '1.00x');
  assert.equal(shared.isNeutral({ slow: 1, reverbIntensity: 0 }), true);
  assert.equal(
    shared.normalizeSettings({ slow: 0.6, reverbIntensity: 1 }).slow,
    0.6,
    'speed is independent of reverb'
  );
});

test('shipped popup exposes 0.60x to 1.30x and resets to 1.00x', () => {
  const html = readFileSync(join(root, 'popup.html'), 'utf8');
  const slider = (html.match(/<input[^>]*id="slow-slider"[^>]*>/) || [])[0] || '';
  assert.ok(slider, 'speed slider markup exists');
  assert.match(slider, /min="0\.6"/, 'the shipped lower bound is 0.60x');
  assert.match(slider, /max="1\.3"/, 'the upper bound stays 1.30x');
  assert.match(slider, /step="0\.01"/, 'the step stays 0.01x');
  const reset = readFileSync(join(root, 'popup.js'), 'utf8');
  assert.match(
    reset,
    /applySettingsToUi\(defaultSettings\);[\s\S]{0,120}applySettings\(defaultSettings\);/,
    'reset restores the default settings'
  );
  assert.equal(shared.getDefaultSettings().slow, 1, 'the default reset speed is 1.00x');
  assert.equal(shared.formatRate(shared.getDefaultSettings().slow), '1.00x');
});

test('endpoints write playbackRate with all three pitch aliases off', () => {
  for (const slow of [0.6, 1.3]) {
    const media = stubMedia();
    const ctl = controller(media);
    const intended = rate.intendedPlaybackState(ctl, slow);
    assert.equal(intended.neutral, false);
    assert.equal(intended.intendedRate, slow);
    assert.deepEqual(intended.intendedPitch, {
      preservesPitch: false,
      mozPreservesPitch: false,
      webkitPreservesPitch: false,
    });
    assert.equal(rate.writeIntendedRate(ctl, slow), true, 'rate write landed at ' + slow);
    assert.equal(media.playbackRate, slow);
    assert.deepEqual(flags(media), [false, false, false]);
  }
});

test('1.00x restores the original rate and pitch; reverb cannot change them', () => {
  const media = stubMedia();
  const ctl = controller(media);
  assert.equal(rate.writeIntendedRate(ctl, 0.6), true);
  assert.deepEqual(flags(media), [false, false, false]);
  assert.equal(rate.writeIntendedRate(ctl, 1), true);
  assert.equal(media.playbackRate, 1, '1.00x restores the original rate');
  assert.deepEqual(flags(media), [true, true, true], '1.00x restores the original pitch aliases');
  const intended = rate.intendedPlaybackState(ctl, 1);
  assert.equal(intended.neutral, true);
  assert.equal(intended.intendedRate, 1);
  assert.deepEqual(intended.intendedPitch, ctl.originalPitch);
  assert.equal(rate.intendedPlaybackState.length, 2, 'rate state does not depend on intensity');
  assert.equal(rate.writeIntendedRate.length, 2, 'rate writes do not depend on intensity');
});
