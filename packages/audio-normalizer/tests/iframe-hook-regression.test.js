const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const cs = fs.readFileSync(path.join(ROOT, 'content-script.js'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'page-hook.js'), 'utf8');

function fnSrc(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return '';
  // crude brace match from the function start
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

test('frame-targeted injection: background targets sender frameId, defaults 0, returns error', () => {
  assert.match(bg, /frameIds:\s*\[frameId\]/, 'executeScript targets frameIds [frameId]');
  assert.match(bg, /_sender\?\.frameId/, 'INJECT_PAGE_HOOK reads sender.frameId');
  assert.match(bg, /frameId[\s\S]{0,120}\?\s*_sender[\s\S]*:\s*0|:\s*0[\s\S]{0,80}frame/, 'defaults to frame 0 for tab-level calls');
  const injectFn = fnSrc(bg, 'injectMainWorldScript');
  assert.ok(injectFn.includes('return { ok: false'), 'a disappearing frame returns an error object');
  assert.ok(injectFn.includes('try'), 'injection is wrapped so it never throws');
});

test('worklet URL comes from START, attribute is pending-start fallback only, fail closed', () => {
  assert.ok(hook.includes('isValidWorkletUrl'), 'hook validates the worklet URL');
  assert.ok(hook.includes('chrome-extension://'), 'only chrome-extension: URLs accepted');
  assert.ok(hook.includes('/audio/normalizer-worklet.js'), 'URL must end at the worklet path');
  const startFn = fnSrc(hook, 'start');
  assert.ok(startFn.includes('workletUrl'), 'START payload carries the URL');
  assert.ok(startFn.includes('Invalid worklet URL'), 'fail closed with a clear status error');
  assert.ok(!hook.includes("new URL(\n      'audio/normalizer-worklet.js'") && !hook.includes("new URL('audio/normalizer-worklet.js'") && !/audio\/normalizer-worklet\.js',\s*\/\*\*[\s\S]{0,80}document\.currentScript/.test(hook), 'no page-relative URL fallback remains');
  assert.ok(cs.includes('workletUrl: getWorkletUrl()'), 'content script sends workletUrl on START');
  assert.ok(cs.includes("chrome.runtime.getURL('audio/normalizer-worklet.js')"), 'content script derives URL via runtime.getURL');
});

test('resume never blocks session creation; gesture listeners register first', () => {
  const helperFn = fnSrc(hook, 'resumeWithTimeout');
  assert.ok(helperFn.length > 0, 'resumeWithTimeout helper exists');
  assert.ok(helperFn.includes('Promise.race'), 'helper races resume with a timeout');
  assert.ok(helperFn.includes('setTimeout'), 'helper has a short timer');
  assert.match(hook, /RESUME_TIMEOUT_MS\s*=\s*(300|400|500)/, 'timeout is short (300-500 ms)');
  const createFn = fnSrc(hook, 'createMediaSession');
  assert.ok(createFn.includes('resumeWithTimeout'), 'createMediaSession uses the bounded helper');
  const clickIdx = createFn.indexOf("addEventListener('click'");
  const resumeIdx = createFn.indexOf('resumeWithTimeout');
  const sessionIdx = createFn.indexOf('createSession(context');
  assert.ok(clickIdx >= 0 && resumeIdx >= 0 && clickIdx < resumeIdx, 'gesture listeners registered before the bounded resume');
  assert.ok(sessionIdx > resumeIdx, 'session is created without waiting on a pending resume');
});

test('bounded resume: no bare await resume() gates work; helper used at every gated site', () => {
  // Every resume that gates work goes through the helper; the only bare
  // await resume() left is the gesture-listener retry, which must stay.
  const bareLines = hook.split('\n').filter((line) => /await\b.*\.resume\(\)/.test(line));
  assert.equal(bareLines.length, 1, `only the gesture retry keeps a bare await resume() (found ${bareLines.length}: ${bareLines.map((s) => s.trim()).join(' | ')})`);
  assert.ok(bareLines[0].includes('await context.resume()'), 'the remaining bare await is the gesture retry');
  for (const name of ['createSession', 'attachMediaElement', 'recoverAudio']) {
    const fn = fnSrc(hook, name);
    assert.ok(fn.includes('resumeWithTimeout'), `${name} uses the bounded helper`);
    const bare = fn.split('\n').filter((line) => /await\b.*\.resume\(\)/.test(line));
    assert.equal(bare.length, 0, `${name} keeps no bare await resume() (found: ${bare.map((s) => s.trim()).join(' | ')})`);
  }
});

test('shadow re-enable: second start re-observes the same root', () => {
  const fn = fnSrc(hook, 'observeShadowRoot');
  assert.ok(fn.includes('__tnObserver'), 'observer instance is stored on the root');
  assert.ok(fn.includes('state.observer'), 'identity is compared against the live observer');
  assert.ok(/__tnObserver\s*!==\s*state\.observer|state\.observer\s*!==/.test(fn), 're-observes when the instance differs from the live observer');
  assert.ok(fn.includes('__tnObserved'), 'legacy observed flag retained for compat');
});

test('liveness: injected-but-dead hook re-syncs via capped retry, no busy loop', () => {
  assert.ok(cs.includes('function scheduleLivenessResync'), 'liveness helper exists');
  assert.ok(cs.includes('state.injected && !state.hookAlive'), 're-sync gated on injected && !hookAlive');
  const helper = fnSrc(cs, 'scheduleLivenessResync');
  assert.ok(helper.includes('scheduleActivationRetry'), 'reuses the existing capped retry/backoff');
  assert.ok(!helper.includes('setInterval') && !helper.includes('while ('), 'no busy loop');
  const probeTimeouts = (cs.match(/scheduleLivenessResync\('/g) || []).length;
  assert.ok(probeTimeouts >= 2, `probe timeouts schedule re-sync (found ${probeTimeouts})`);
});

test('guard restore only while still guard-muted', () => {
  const restoreFn = fnSrc(hook, 'restoreHookGuard');
  assert.ok(restoreFn.includes('muted === true'), 'restore gated on still-guard-muted');
  assert.ok(restoreFn.includes('__tnGuardPrevMuted'), 'restores the pre-guard value when gated');
});

test('re-enable mints a program generation and posts one reset-program; never at attach', () => {
  const startFn = fnSrc(hook, 'start');
  assert.ok(startFn.includes('broadcastProgramReset'), 're-enable path broadcasts a reset');
  assert.ok(startFn.includes('currentProgramGeneration += 1'), 're-enable mints a fresh generation');
  assert.ok(startFn.includes('currentProgramGeneration > 0 || activeProgramElement'), 'cold first start needs no reset');
  for (const name of ['attachMediaElement', 'attachWorklet']) {
    const fn = fnSrc(hook, name);
    assert.ok(!fn.includes('currentProgramGeneration += 1'), `${name} never mints a generation (no reset at attach)`);
  }
});

test('shadow DOM: open roots are walked and attachShadow is patched', () => {
  assert.ok(hook.includes('attachShadow'), 'attachShadow patched for future roots');
  assert.ok(hook.includes('shadowRoot'), 'open shadow roots are walked');
  assert.ok(hook.includes('observeShadowRoot'), 'roots are observed for media');
  const playFn = fnSrc(hook, 'patchPlay');
  assert.ok(playFn.length > 0, 'play() patch retained so closed roots still attach at playback');
});
