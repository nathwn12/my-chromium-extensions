'use strict';

/* global require, __dirname */

/*
 * test/composition-invariants.test.js - the cross-feature seams, Node only.
 *
 * Every behaviour below is covered by its own test file. This file exists
 * because a change can keep each unit green and still break its neighbour: the
 * volume lane passed 293 checks while the wheel stopped moving YouTube Music's
 * own slider, because a background state push re-armed the stored-volume
 * restore and wrote an older number over the fresh step.
 *
 * These assertions are static on purpose. They see the wiring the units cannot,
 * and they name the file the symbol must live in, so a move fails loudly
 * instead of passing against the wrong source.
 */

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
  // The user's step must disarm the restore before it applies, or a pending
  // restore can land on top of it.
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
  // Shape only, and it has been wrong before: 1.2.5 latched the hand-off before
  // the controller existed and spent it on a null. The behaviour is proved in
  // injection-lifecycle test H, which fails when this seam is broken.
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
  // restoreVolume is the only path a push can reach, and it must refuse once the
  // document settled or the user has interacted.
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
