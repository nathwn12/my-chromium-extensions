'use strict';

/* global require, __dirname */


const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const pkg = join(__dirname, '..');
const read = (name) => readFileSync(join(pkg, name), 'utf8');

const playerActions = read('player-actions.js');
const contentScript = read('content-script.js');
const shared = read('shared.js');

test('invariant: a wheel step writes the page player, so YTM own slider moves', () => {
  const applyVolume = playerActions.slice(
    playerActions.indexOf('function applyVolume('),
    playerActions.indexOf('// -- sticky volume'),
  );
  assert.match(applyVolume, /pageHook\.setVolume\(percent\)/);
  const wheel = playerActions.slice(
    playerActions.indexOf('function onWheel('),
    playerActions.indexOf('function applyVolume('),
  );
  assert.ok(
    wheel.indexOf('cancelPendingVolumeRestore()') < wheel.indexOf('applyVolume(step.volume)'),
    'onWheel must cancel a pending restore before applying its own value',
  );
});

test('invariant: the stored volume is handed over exactly once per document', () => {
  const restore = contentScript.slice(
    contentScript.indexOf('function restoreStoredVolume('),
    contentScript.indexOf('// Mute invariant'),
  );
  assert.match(restore, /if \(volumeRestoreSeeded\) return;/, 'the hand-off must latch itself');
  assert.match(
    restore,
    /volumeRestoreSeeded = true;[\s\S]{0,200}restoreVolume\(stored\)/,
    'the latch is set where the controller takes the value, never before',
  );
  assert.doesNotMatch(
    restore,
    /volumeRestoreSeeded = true;[\s\S]{0,200}if \(!playerActions\) return;/,
    'a missing controller must leave the hand-off unspent',
  );

  const apply = contentScript.slice(
    contentScript.indexOf('function applyRuntimeState('),
    contentScript.indexOf('function restoreStoredVolume('),
  );
  assert.match(apply, /restoreStoredVolume\(\);/, 'applyRuntimeState must still hand the value over');
  assert.ok(
    apply.indexOf('syncAllMedia();') < apply.indexOf('restoreStoredVolume();'),
    'the hand-off must run after syncAllMedia created the controller',
  );
  assert.match(contentScript, /let volumeRestoreSeeded = false;/);
});

test('invariant: a state push cannot write a volume the user did not ask for', () => {
  const restore = playerActions.slice(
    playerActions.indexOf('function restoreVolume('),
    playerActions.indexOf('function attemptVolumeRestore('),
  );
  assert.match(restore, /volumeRestoreSettled\) return/);
  assert.match(playerActions, /function cancelPendingVolumeRestore\(\)[\s\S]{0,400}volumeRestoreSettled = true/);
});

test('invariant: the readout is permanent and sits beside Repeat', () => {
  assert.match(playerActions, /\.slra-bar\{display:flex/);
  assert.match(playerActions, /bar\.append\(volumeHud, pill\)/);
  assert.doesNotMatch(playerActions, /\.slra-volume\{[^}]*position:absolute/);
  assert.doesNotMatch(playerActions, /\.slra-volume\{[^}]*opacity:0/);
  const show = playerActions.slice(
    playerActions.indexOf('function showVolumeHud('),
    playerActions.indexOf('function destroyUi('),
  );
  assert.doesNotMatch(show, /setTimeout/, 'the readout must not schedule a hide');
});

test('invariant: the latch is enforced on the element, not only on a timer', () => {
  assert.match(playerActions, /bindMediaListener\('timeupdate', handleProgress\)/);
  assert.match(playerActions, /bindMediaListener\('seeked', handleProgress\)/);
  assert.match(playerActions, /function handleProgress\(/);
});

test('invariant: level compensation scales the whole mix, so flatness survives', () => {
  assert.match(contentScript, /MIX_HEADROOM/);
  const levels = contentScript.slice(
    contentScript.indexOf('function computeMixLevels('),
    contentScript.indexOf('function applyMixLevels('),
  );
  const headroomUses = (levels.match(/MIX_HEADROOM/g) || []).length;
  assert.ok(headroomUses >= 2, 'the constant must reach both the dry and the wet path');
});

test('invariant: volume lives in the settings shape and is optional', () => {
  assert.match(shared, /volume/);
  assert.match(shared, /never set|DEFAULT_SETTINGS[\s\S]{0,200}volume/);
});
