/**
 * Composition guard.
 *
 * Each behaviour below is covered by its own test elsewhere. This file exists
 * because a change can keep every unit green and still break a neighbour: the
 * volume lane passed 973 unit checks while the wheel stopped moving YouTube
 * Music's own slider, because a background state push re-armed the restore and
 * wrote an older volume over the fresh one.
 *
 * These are cross-feature invariants. They are static on purpose: they assert the
 * wiring that the units cannot see, and they fail loudly when a seam moves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
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
  const calls = contentScript.match(/restoreStoredVolume\(\)/g) || [];
  assert.equal(calls.length, 2, 'one definition call site and one guarded call expected');
  assert.match(
    contentScript,
    /if \(!volumeRestoreSeeded\) \{\s*volumeRestoreSeeded = true;\s*restoreStoredVolume\(\);/,
    'the hand-off must be latched, never re-armed by a later state push',
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
