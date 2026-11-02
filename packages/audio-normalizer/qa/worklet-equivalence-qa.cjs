'use strict';
/*
 * worklet-equivalence-qa.cjs
 * Local-only QA harness (qa/ is gitignored). Session scratch id: ses_f07d8d804ffePLpg7UON9NAcAF
 *
 * Renders three worklet variants offline and measures:
 *   (a) baseline vs opt equivalence (B3/B4/B5 + dead-code must be <= 1 f32 ULP)
 *   (b) quiet->loud / loud->quiet transition trajectories (B1 behavior)
 *   (c) steady-state music ripple (B1 behavior)
 *
 * Variants:
 *   baseline = git show HEAD:audio/normalizer-worklet.js (written from git, not hand-edited)
 *   opt      = current worklet with ONLY the B1 band anchor reverted (programDb)
 *   patched  = current worklet (B1 + B3/B4/B5)
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { chromium } = loadPlaywright();

const repoRoot = path.resolve(__dirname, '..');
const SESSION_ID = 'ses_f07d8d804ffePLpg7UON9NAcAF';
const sessionDir = process.env.TN_GAUNTLET_DIR || path.join(os.tmpdir(), 'opencode', `loudness-${SESSION_ID}`);
const variantsDir = path.join(sessionDir, `worklet-variants-${SESSION_ID}`);
const jsonPath = path.join(sessionDir, 'equivalence.json');
const transcriptPath = path.join(sessionDir, 'equivalence-transcript.txt');

const THRESHOLDS = {
  equivalenceMaxUlp: 1,
  settleTimeSeconds: 3.5,
  settleOvershootDb: 0.3,
  releaseTimeSeconds: 3.5,
  musicRippleDb: 0.25,
};

function loadPlaywright() {
  // Resolve Playwright normally first; TN_PLAYWRIGHT_PATH is the env
  // override. No machine-specific default paths.
  const candidates = ['playwright', process.env.TN_PLAYWRIGHT_PATH].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error('Playwright install not found. Set TN_PLAYWRIGHT_PATH or install playwright as a dependency.');
}

function buildVariants() {
  fs.mkdirSync(variantsDir, { recursive: true });
  const baseline = execFileSync(
    'git',
    ['show', 'HEAD:audio/normalizer-worklet.js'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  ).replace(/\r\n/g, '\n');
  const patched = fs.readFileSync(path.join(repoRoot, 'audio', 'normalizer-worklet.js'), 'utf8').replace(/\r\n/g, '\n');
  const opt = revertB1(patched);

  if (!baseline.includes('const SOFT_KNEE_DB = 3;')) throw new Error('baseline sanity failed: expected HEAD worklet');
  if (baseline.includes('SOFT_KNEE_RATIO')) throw new Error('baseline sanity failed: HEAD unexpectedly already has B3');
  if (opt.includes('const bandDb = shortDb;')) throw new Error('opt sanity failed: B1 anchor still present');
  if (!opt.includes('programDb < quietFloorDb')) throw new Error('opt sanity failed: B1 revert did not apply');
  if (!patched.includes('const bandDb = shortDb;')) throw new Error('patched sanity failed: B1 anchor missing');

  fs.writeFileSync(path.join(variantsDir, 'baseline.js'), baseline);
  fs.writeFileSync(path.join(variantsDir, 'opt.js'), opt);
  fs.writeFileSync(path.join(variantsDir, 'patched.js'), patched);

  return {
    baseline,
    opt,
    patched,
    optOnlyChangesFromBaselineReported: 'B3 (SOFT_KNEE_RATIO + hoisted ceiling) + B4 (multiplicative exp ramp) + B5 (wrapped index decrement / hoisted readIndex) + dead hop/gainToDb removal',
  };
}

function revertB1(src) {
  const oldBlock = [
    '    const bandDb = shortDb;',
    '',
    '    if (bandDb < quietFloorDb) {',
    '      desiredDb += (quietFloorDb - bandDb) * BAND_STRENGTH;',
    '    } else if (bandDb > loudCeilingDb) {',
    '      desiredDb -= (bandDb - loudCeilingDb) * BAND_STRENGTH;',
    '    }',
  ].join('\n');
  const newBlock = [
    '    if (programDb < quietFloorDb) {',
    '      desiredDb += (quietFloorDb - programDb) * BAND_STRENGTH;',
    '    } else if (programDb > loudCeilingDb) {',
    '      desiredDb -= (programDb - loudCeilingDb) * BAND_STRENGTH;',
    '    }',
  ].join('\n');
  if (!src.includes(oldBlock)) throw new Error('B1 revert anchor not found in current worklet');
  return src.replace(oldBlock, newBlock);
}

// Runs inside the page. Self-contained; only browser globals.
function pageMain(config) {
  const SR = 48000;

  function fillSine(x, sr, t0, t1, amp, freq) {
    const i0 = Math.max(0, Math.round(t0 * sr));
    const i1 = Math.min(x.length, Math.round(t1 * sr));
    for (let i = i0; i < i1; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * (i / sr));
  }

  function buildEquivalence(sr) {
    const x = new Float32Array(Math.round(sr * 3.0));
    fillSine(x, sr, 0.00, 0.50, 0.02, 220); // quiet
    fillSine(x, sr, 0.50, 1.2, 0.9, 300);   // loud
    fillSine(x, sr, 1.2, 1.5, 0.02, 220);   // quiet
    fillSine(x, sr, 1.5, 2.1, 0.02, 220);   // quiet bed under hits
    for (const t of [1.55, 1.75, 1.95]) fillSine(x, sr, t, t + 0.025, 0.7, 450); // transient hits
    fillSine(x, sr, 2.1, 2.6, 0.02, 220);   // quiet
    fillSine(x, sr, 2.6, 3.0, 1.2, 180);    // burst
    return x;
  }

  function buildTransition(sr) {
    const x = new Float32Array(Math.round(sr * 16.0));
    fillSine(x, sr, 0, 2, 0.02, 220);  // quiet 2s
    fillSine(x, sr, 2, 10, 0.5, 300);  // loud 8s
    fillSine(x, sr, 10, 16, 0.02, 220); // quiet 6s
    return x;
  }

  function buildMusic(sr) {
    const n = Math.round(sr * 15.0);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const db = 5 * Math.sin(2 * Math.PI * 1.5 * t); // +/-5 dB at 1.5 Hz
      const amp = 0.2 * Math.pow(10, db / 20);
      x[i] = amp * Math.sin(2 * Math.PI * 200 * t);
    }
    return x;
  }

  const SPECS = {
    equivalence: { durationSec: 3.0, build: buildEquivalence, description: '3s: quiet 0.02@220Hz (0-0.5s), loud 0.9@300Hz (0.5-1.2s), quiet (1.2-1.5s), quiet bed + 25ms transient hits 0.7@450Hz at 1.55/1.75/1.95s (1.5-2.1s), quiet (2.1-2.6s), burst 1.2@180Hz (2.6-3.0s); mono duplicated to both channels' },
    transition: { durationSec: 16.0, build: buildTransition, description: '16s: quiet 0.02@220Hz (0-2s) -> loud 0.5@300Hz (2-10s) -> quiet 0.02@220Hz (10-16s); hard segment boundaries; mono duplicated' },
    music: { durationSec: 15.0, build: buildMusic, description: '15s: 200Hz sine, instantaneous amplitude 0.2*10^(5*sin(2*pi*1.5*t)/20), i.e. +/-5 dB AM at 1.5 Hz; mono duplicated' },
  };

  async function renderVariant(url, specName, blastGuard) {
    const spec = SPECS[specName];
    const n = Math.round(SR * spec.durationSec);
    const ctx = new OfflineAudioContext(2, n, SR);
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'loudness-normalizer', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
    });
    node.port.postMessage({ type: 'set-gain-db', gainDb: 0 });
    node.port.postMessage({ type: 'set-blast-guard', blastGuard: !!blastGuard });
    const mono = spec.build(SR);
    const buf = ctx.createBuffer(2, n, SR);
    buf.copyToChannel(mono, 0);
    buf.copyToChannel(mono, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(node);
    node.connect(ctx.destination);
    src.start(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rendered = await ctx.startRendering();
    return { input: mono, left: rendered.getChannelData(0), right: rendered.getChannelData(1) };
  }

  const _f32 = new Float32Array(1);
  const _u32 = new Uint32Array(_f32.buffer);
  function f32Key(x) {
    _f32[0] = x;
    const b = _u32[0];
    return (b & 0x80000000) ? ((b ^ 0xffffffff) >>> 0) : (b + 0x80000000);
  }

  function compareF32(a, b) {
    let maxAbs = 0;
    let maxUlp = 0;
    let over1 = 0;
    const total = Math.min(a.length, b.length);
    for (let i = 0; i < total; i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      const d = Math.abs(x - y);
      if (d > maxAbs) maxAbs = d;
      const kd = Math.abs(f32Key(x) - f32Key(y));
      if (kd > maxUlp) maxUlp = kd;
      if (kd > 1) over1++;
    }
    return { total, maxAbs, maxUlp, over1, exactMatch: maxAbs === 0 };
  }

  function comparePair(A, B) {
    const l = compareF32(A.left, B.left);
    const r = compareF32(A.right, B.right);
    return {
      total: l.total + r.total,
      maxAbs: Math.max(l.maxAbs, r.maxAbs),
      maxUlp: Math.max(l.maxUlp, r.maxUlp),
      over1: l.over1 + r.over1,
      exactMatch: l.exactMatch && r.exactMatch,
    };
  }

  function series(input, output, winSec) {
    const w = Math.max(1, Math.round(SR * winSec));
    const n = Math.min(input.length, output.length);
    const out = [];
    for (let i = 0; i + w <= n; i += w) {
      let si = 0;
      let so = 0;
      for (let j = 0; j < w; j++) {
        const a = input[i + j];
        const b = output[i + j];
        si += a * a;
        so += b * b;
      }
      const ri = Math.sqrt(si / w);
      const ro = Math.sqrt(so / w);
      out.push({ t: (i + w / 2) / SR, gainDb: 20 * Math.log10((ro + 1e-12) / (ri + 1e-12)) });
    }
    return out;
  }

  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function inRange(s, a, b) {
    return s.filter((p) => p.t >= a && p.t < b).map((p) => p.gainDb);
  }
  function lastViolationTime(s, a, b, ref, tol) {
    let last = null;
    for (const p of s) {
      if (p.t < a || p.t >= b) continue;
      if (Math.abs(p.gainDb - ref) > tol) last = p.t;
    }
    return last;
  }

  function transitionMetrics(input, output) {
    const s = series(input, output, 0.1);
    const finalGain = median(inRange(s, 9, 10));
    const lastV = lastViolationTime(s, 2, 10, finalGain, 0.5);
    const settleTime = lastV === null ? 0 : (lastV - 2 + 0.1);
    const loudGains = inRange(s, 2, 10);
    const finalQuiet = median(inRange(s, 15, 16));
    const lastVR = lastViolationTime(s, 10, 16, finalQuiet, 0.5);
    const releaseTime = lastVR === null ? 0 : (lastVR - 10 + 0.1);
    const early = median(inRange(s, 10, 10.5));
    const late = median(inRange(s, 14.5, 15.5));
    return {
      finalGainDb: finalGain,
      settleTimeSeconds: settleTime,
      overshootDb: Math.max(0, finalGain - Math.min(...loudGains)),
      overBoostDb: Math.max(0, Math.max(...loudGains) - finalGain),
      finalQuietDb: finalQuiet,
      releaseTimeSeconds: releaseTime,
      releaseDeltaDb: late - early,
      series: s,
    };
  }

  function musicMetrics(input, output) {
    const s = series(input, output, 0.1);
    const last8 = s.filter((p) => p.t >= 7 && p.t <= 15).map((p) => p.gainDb);
    return { rippleDb: Math.max(...last8) - Math.min(...last8), series: s };
  }

  return (async () => {
    const V = config.variants;
    const renders = {};
    const results = {
      stimulusConfig: {
        sampleRate: SR,
        windowsSeconds: 0.1,
        equivalence: SPECS.equivalence.description,
        transition: SPECS.transition.description,
        music: SPECS.music.description,
      },
      equivalence: {},
      transition: {},
      music: {},
      sanity: {},
    };

    for (const guard of [false, true]) {
      renders[`baseline_${guard}`] = await renderVariant(V.baseline, 'equivalence', guard);
      renders[`opt_${guard}`] = await renderVariant(V.opt, 'equivalence', guard);
      renders[`patched_${guard}`] = await renderVariant(V.patched, 'equivalence', guard);
    }
    for (const guard of [false, true]) {
      const b = renders[`baseline_${guard}`];
      const o = renders[`opt_${guard}`];
      const p = renders[`patched_${guard}`];
      results.equivalence[guard ? 'guardTrue' : 'guardFalse'] = {
        baselineVsOpt: comparePair(b, o),
        baselineVsPatchedInformational: comparePair(b, p),
      };
    }
    results.sanity.blastGuardEffectPatched = comparePair(renders.patched_false, renders.patched_true);

    const tBase = await renderVariant(V.baseline, 'transition', false);
    const tPatched = await renderVariant(V.patched, 'transition', false);
    results.transition = {
      analysis: 'output/input RMS ratio per 100ms window on left channel',
      baseline: transitionMetrics(tBase.input, tBase.left),
      patched: transitionMetrics(tPatched.input, tPatched.left),
    };

    const mBase = await renderVariant(V.baseline, 'music', false);
    const mPatched = await renderVariant(V.patched, 'music', false);
    results.music = {
      analysis: 'peak-to-peak output/input RMS ratio (dB) over 100ms windows, t in [7,15]s',
      baseline: { rippleDb: musicMetrics(mBase.input, mBase.left).rippleDb, series: musicMetrics(mBase.input, mBase.left).series },
      patched: { rippleDb: musicMetrics(mPatched.input, mPatched.left).rippleDb, series: musicMetrics(mPatched.input, mPatched.left).series },
    };

    return results;
  })();
}

function startServer(variantFiles) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>worklet equivalence QA</title></head><body>ready</body></html>');
        return;
      }
      const m = /^\/variants\/([a-z]+)\.js$/.exec(url.pathname);
      if (m && Object.prototype.hasOwnProperty.call(variantFiles, m[1])) {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        res.end(variantFiles[m[1]]);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function fmt(n, digits = 6) {
  if (!Number.isFinite(n)) return String(n);
  return Number(n.toFixed(digits)).toString();
}

function trajectory(series, times) {
  return times.map((t) => {
    let best = series[0];
    let bestD = Infinity;
    for (const p of series) {
      const d = Math.abs(p.t - t);
      if (d < bestD) { bestD = d; best = p; }
    }
    return { t: Number(t.toFixed(2)), gainDb: Number(best.gainDb.toFixed(3)) };
  });
}

function evaluatePass(json) {
  const eq = json.behavior.equivalence;
  const pass = {};
  for (const mode of ['guardFalse', 'guardTrue']) {
    const c = eq[mode].baselineVsOpt;
    pass[`equivalence_${mode}`] = {
      pass: c.maxUlp <= THRESHOLDS.equivalenceMaxUlp && c.over1 === 0,
      maxAbsDelta: c.maxAbs,
      maxUlpDistance: c.maxUlp,
      ulpExceedanceCount: c.over1,
      exactMatch: c.exactMatch,
      totalSamples: c.total,
    };
  }
  const tp = json.behavior.transition.patched;
  const tb = json.behavior.transition.baseline;
  pass.transition_quietToLoud = {
    pass: tp.settleTimeSeconds <= THRESHOLDS.settleTimeSeconds && tp.overshootDb <= THRESHOLDS.settleOvershootDb,
    settleTimeSeconds: tp.settleTimeSeconds,
    overshootDb: tp.overshootDb,
    finalGainDb: tp.finalGainDb,
  };
  pass.transition_loudToQuiet = {
    pass: tp.releaseTimeSeconds <= THRESHOLDS.releaseTimeSeconds,
    releaseTimeSeconds: tp.releaseTimeSeconds,
    finalQuietDb: tp.finalQuietDb,
    releaseDeltaDb: tp.releaseDeltaDb,
  };
  pass.transition_baselineLongDrift = {
    expectation: 'baseline must show >5s drift (settleTimeSeconds > 5)',
    observedSettleTimeSeconds: tb.settleTimeSeconds,
    observed: tb.settleTimeSeconds > 5 ? 'long drift' : 'settled within 5s',
    pass: tb.settleTimeSeconds > 5,
  };
  const mp = json.behavior.music.patched.rippleDb;
  pass.musicRipple = {
    pass: mp <= THRESHOLDS.musicRippleDb,
    patchedRippleDb: mp,
    baselineRippleDb: json.behavior.music.baseline.rippleDb,
  };
  json.pass = pass;
  json.allPass = Object.values(pass).every((p) => p.pass);
  return json;
}

function buildTranscript(json, variants) {
  const L = [];
  const push = (s = '') => L.push(s);

  push('WORKLET EQUIVALENCE / BEHAVIOR QA');
  push(`session: ${SESSION_ID}`);
  push(`date: ${new Date().toISOString()}`);
  push('');
  push('VARIANTS');
  push(`  baseline = git show HEAD:audio/normalizer-worklet.js`);
  push(`  opt      = current worklet with B1 band anchor reverted to programDb`);
  push(`             (differs from baseline ONLY by: ${variants.optOnlyChangesFromBaselineReported})`);
  push(`  patched  = current worklet (B1 + B3/B4/B5 + dead-code removal)`);
  push('');
  push('STIMULI (48 kHz, mono duplicated to both channels)');
  push(`  equivalence: ${json.behavior.stimulusConfig.equivalence}`);
  push(`  transition : ${json.behavior.stimulusConfig.transition}`);
  push(`  music      : ${json.behavior.stimulusConfig.music}`);
  push(`  render: create OfflineAudioContext(2, 48000*duration, 48000); addModule(url);`);
  push(`          new AudioWorkletNode(ctx,'loudness-normalizer',{numberOfInputs:1,numberOfOutputs:1,channelCountMode:'max',channelInterpretation:'speakers'});`);
  push(`          post set-gain-db gainDb=0; post set-blast-guard as noted; source -> node -> destination; startRendering.`);
  push('');
  push('(a) EQUIVALENCE  baseline vs opt  (B3/B4/B5 + dead-code; pass = max ULP distance <= 1, 0 exceedances)');
  for (const mode of ['guardFalse', 'guardTrue']) {
    const c = json.behavior.equivalence[mode].baselineVsOpt;
    const cl = json.behavior.equivalence[mode].baselineVsPatchedInformational;
    push(`  blastGuard=${mode === 'guardTrue'}`);
    push(`    baseline vs opt : max|delta|=${c.maxAbs.toExponential(3)}  maxUlpDistance=${c.maxUlp}  samples>1ULP=${c.over1}/${c.total}  exactMatch=${c.exactMatch}`);
    push(`    baseline vs patched (informational, B1 audio change expected): max|delta|=${cl.maxAbs.toExponential(3)}  maxUlpDistance=${cl.maxUlp}`);
  }
  push(`  sanity: patched blastGuard=false vs true max|delta|=${json.behavior.sanity.blastGuardEffectPatched.maxAbs.toExponential(3)} (should be >0)`);
  push('');
  push('(b) TRANSITION  quiet 0.02 (0-2s) -> loud 0.5 (2-10s) -> quiet 0.02 (10-16s)   [left channel, 100ms windows]');
  const tb = json.behavior.transition.baseline;
  const tp = json.behavior.transition.patched;
  push(`  patched: finalGain(loud)=${fmt(tp.finalGainDb, 3)} dB  settle(<=0.5dB)=${fmt(tp.settleTimeSeconds, 3)} s  overshoot=${fmt(tp.overshootDb, 3)} dB  overBoost=${fmt(tp.overBoostDb, 3)} dB`);
  push(`           finalGain(quiet)=${fmt(tp.finalQuietDb, 3)} dB  release(<=0.5dB)=${fmt(tp.releaseTimeSeconds, 3)} s  releaseDelta(10-10.5s -> 14.5-15.5s)=${fmt(tp.releaseDeltaDb, 3)} dB`);
  push(`  baseline: finalGain(loud)=${fmt(tb.finalGainDb, 3)} dB  settle(<=0.5dB)=${fmt(tb.settleTimeSeconds, 3)} s  overshoot=${fmt(tb.overshootDb, 3)} dB  overBoost=${fmt(tb.overBoostDb, 3)} dB`);
  push(`           finalGain(quiet)=${fmt(tb.finalQuietDb, 3)} dB  release(<=0.5dB)=${fmt(tb.releaseTimeSeconds, 3)} s  releaseDelta=${fmt(tb.releaseDeltaDb, 3)} dB`);
  const times = [0.5, 1.0, 1.9, 2.0, 2.1, 2.3, 2.6, 3.0, 3.5, 4.5, 6.0, 7.5, 9.0, 9.9, 10.1, 10.5, 11.0, 12.0, 13.5, 15.5];
  push('  trajectory (t s -> gain dB):');
  for (const row of trajectory(tb.series, times)) {
    const p = trajectory(tp.series, [row.t])[0];
    push(`    t=${row.t.toFixed(2)}  baseline=${row.gainDb.toFixed(3)}  patched=${p.gainDb.toFixed(3)}`);
  }
  push('');
  push('(c) MUSIC DYNAMICS  +/-5 dB @1.5 Hz, 15 s; steady-state ripple over last 8 s (t in [7,15])');
  push(`  patched ripple = ${fmt(json.behavior.music.patched.rippleDb, 4)} dB  (pass <= ${THRESHOLDS.musicRippleDb})`);
  push(`  baseline ripple = ${fmt(json.behavior.music.baseline.rippleDb, 4)} dB`);
  push('');
  push('PASS CONDITIONS');
  for (const [k, v] of Object.entries(json.pass)) {
    push(`  ${v.pass ? 'PASS' : 'FAIL'}  ${k}  ${JSON.stringify(v)}`);
  }
  push('');
  push(`OVERALL: ${json.allPass ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  return L.join('\n');
}

async function main() {
  fs.mkdirSync(sessionDir, { recursive: true });
  const variants = buildVariants();
  const { server, port } = await startServer({
    baseline: variants.baseline,
    opt: variants.opt,
    patched: variants.patched,
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage();
    page.on('console', (msg) => console.log(`[page] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });

    const raw = await page.evaluate(pageMain, {
      variants: {
        baseline: `${baseUrl}/variants/baseline.js`,
        opt: `${baseUrl}/variants/opt.js`,
        patched: `${baseUrl}/variants/patched.js`,
      },
    });

    const json = {
      sessionId: SESSION_ID,
      generatedAt: new Date().toISOString(),
      thresholds: THRESHOLDS,
      variants: {
        baseline: 'git show HEAD:audio/normalizer-worklet.js',
        opt: 'current worklet with B1 band anchor reverted to programDb',
        patched: 'current worklet (B1+B3/B4/B5)',
        optOnlyChangesFromBaseline: variants.optOnlyChangesFromBaselineReported,
      },
      behavior: raw,
    };
    evaluatePass(json);
    const transcript = buildTranscript(json, variants);

    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
    fs.writeFileSync(transcriptPath, transcript);
    console.log(transcript);
    console.log('');
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${transcriptPath}`);
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
