const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { chromium } = loadPlaywright();

const extensionPath = path.resolve(__dirname, '..');
const profileDir = path.join(os.tmpdir(), `tab-normalizer-responsive-qa-${Date.now()}`);
const headless = process.env.TN_QA_HEADLESS !== '0';

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

async function main() {
  const server = await startServer();
  const baseUrl = `http://www.dev.localhost:${server.port}`;

  let context;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const serviceWorker = await waitFor('extension service worker', async () => {
      return context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 1000 });
    });

    await setSiteState(serviceWorker, 'dev.localhost', true);

    const loudIntro = await runLoudIntroScenario(context, baseUrl, serviceWorker);
    const quietDialogue = await runQuietDialogueScenario(context, baseUrl, serviceWorker);
    const blastGuardBurst = await runBlastGuardBurstScenario(context, baseUrl, serviceWorker);
    const toggleMidPlayback = await runMidPlaybackToggleScenario(context, baseUrl, serviceWorker);

    console.log(JSON.stringify({ loudIntro, quietDialogue, blastGuardBurst, toggleMidPlayback }, null, 2));
  } finally {
    if (context) await context.close();
    await stopServer(server.server);
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function runLoudIntroScenario(context, baseUrl, serviceWorker) {
  const { page, tabId } = await openQaPage(context, serviceWorker, `${baseUrl}/?case=loud`);

  try {
    await page.evaluate(() => window.startQaTone({ amplitude: 0.95, frequency: 220 }));

    const activeStatus = await waitFor('hook active for loud intro', async () => {
      const status = await getDocumentStatus(serviceWorker, tabId);
      return status?.enabled && status?.hookActive ? status : null;
    }, 15000);

    await waitFor('captured worklet for loud intro', () => page.evaluate(() => window.hasQaWorklet()));
    await page.waitForTimeout(120);
    const sample = await page.evaluate(() => window.sampleQaLevels(450));

    assert(sample.preRms > 0.2, 'loud intro pre-RMS should be clearly audible');
    assert(sample.postRms < sample.preRms * 0.82, `expected loud intro cut, got ratio ${sample.rmsRatio}`);
    assert(sample.postPeak <= sample.prePeak + 1e-6, 'processed peak should not exceed input peak on loud intro');

    return {
      activeStatus,
      sample,
      passed: true,
    };
  } finally {
    await page.close();
  }
}

async function runQuietDialogueScenario(context, baseUrl, serviceWorker) {
  const { page, tabId } = await openQaPage(context, serviceWorker, `${baseUrl}/?case=quiet`);

  try {
    await page.evaluate(() => window.startQaTone({ amplitude: 0.028, frequency: 180 }));

    const activeStatus = await waitFor('hook active for quiet dialogue', async () => {
      const status = await getDocumentStatus(serviceWorker, tabId);
      return status?.enabled && status?.hookActive ? status : null;
    }, 15000);

    await waitFor('captured worklet for quiet dialogue', () => page.evaluate(() => window.hasQaWorklet()));
    await page.waitForTimeout(120);
    const earlySample = await page.evaluate(() => window.sampleQaLevels(500));
    await page.waitForTimeout(350);
    const settledSample = await page.evaluate(() => window.sampleQaLevels(600));

    assert(earlySample.preRms > 0.005, 'quiet dialogue pre-RMS should be detectable');
    assert(earlySample.postRms > earlySample.preRms * 1.12, `expected startup lift, got early ratio ${earlySample.rmsRatio}`);
    assert(settledSample.postRms > settledSample.preRms * 1.05, `expected sustained normalization lift, got settled ratio ${settledSample.rmsRatio}`);

    return {
      activeStatus,
      earlySample,
      settledSample,
      passed: true,
    };
  } finally {
    await page.close();
  }
}

async function runBlastGuardBurstScenario(context, baseUrl, serviceWorker) {
  const unguarded = await sampleBurstMode(context, baseUrl, serviceWorker, false);
  const guarded = await sampleBurstMode(context, baseUrl, serviceWorker, true);

  assert(unguarded.burstSample.prePeak > 0.9, 'burst sample should drive a clearly loud pre-peak without Blast Guard');
  assert(guarded.burstSample.prePeak > 0.9, 'burst sample should drive a clearly loud pre-peak with Blast Guard');
  assert(guarded.burstSample.postPeak < unguarded.burstSample.postPeak * 0.96,
    `expected Blast Guard lower burst peak, got ${guarded.burstSample.postPeak} vs ${unguarded.burstSample.postPeak}`);
  assert(guarded.burstSample.postRms < unguarded.burstSample.postRms * 0.9,
    `expected Blast Guard lower burst RMS, got ${guarded.burstSample.postRms} vs ${unguarded.burstSample.postRms}`);

  return {
    unguarded,
    guarded,
    passed: true,
  };
}

async function sampleBurstMode(context, baseUrl, serviceWorker, blastGuard) {
  await setSiteState(serviceWorker, 'dev.localhost', true, { blastGuard });
  const { page, tabId } = await openQaPage(context, serviceWorker, `${baseUrl}/?case=burst-${blastGuard ? 'guarded' : 'plain'}`);

  try {
    await page.evaluate(() => window.startQaTone({ amplitude: 0.05, frequency: 240 }));

    const activeStatus = await waitFor(`hook active for burst mode ${blastGuard}`, async () => {
      const status = await getDocumentStatus(serviceWorker, tabId);
      return status?.enabled && status?.hookActive && status?.blastGuard === blastGuard ? status : null;
    }, 15000);

    await waitFor(`captured worklet for burst mode ${blastGuard}`, () => page.evaluate(() => window.hasQaWorklet()));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.setQaAmplitude(1.25));
    const burstSample = await page.evaluate(() => window.sampleQaLevels(500));

    return {
      activeStatus,
      burstSample,
      blastGuard,
    };
  } finally {
    await page.close();
  }
}

async function runMidPlaybackToggleScenario(context, baseUrl, serviceWorker) {
  const { page, tabId } = await openQaPage(context, serviceWorker, `${baseUrl}/?case=toggle`);

  try {
    await page.evaluate(() => window.startQaTone({ amplitude: 0.24, frequency: 260 }));

    const activeStatus = await waitFor('hook active before toggle', async () => {
      const status = await getDocumentStatus(serviceWorker, tabId);
      return status?.enabled && status?.hookActive ? status : null;
    }, 15000);

    await waitFor('captured worklet before toggle', () => page.evaluate(() => window.hasQaWorklet()));
    await page.waitForTimeout(150);
    const onSample = await page.evaluate(() => window.sampleQaLevels(350));

    await setSiteState(serviceWorker, 'dev.localhost', false);
    const offStatus = await waitFor('disabled state during playback', async () => {
      const status = await getDocumentStatus(serviceWorker, tabId);
      return status && !status.enabled ? status : null;
    }, 15000);
    await page.waitForTimeout(200);
    const offSample = await page.evaluate(() => window.sampleQaLevels(350));

    await setSiteState(serviceWorker, 'dev.localhost', true);
    const reEnabledStatus = await waitFor('re-enabled state during playback', async () => {
      const status = await getDocumentStatus(serviceWorker, tabId);
      return status?.enabled && status?.hookActive ? status : null;
    }, 15000);
    await page.waitForTimeout(150);
    const reEnabledSample = await page.evaluate(() => window.sampleQaLevels(450));

    assert(onSample.postRms > 0.01, 'expected processed signal before toggle');
    assert(offSample.postRms < onSample.postRms * 0.2, `expected worklet tap to go near-silent when disabled, got ${offSample.postRms}`);
    assert(reEnabledSample.postRms > offSample.postRms * 4, 'expected processed signal to recover after re-enable');

    return {
      activeStatus,
      onSample,
      offStatus,
      offSample,
      reEnabledStatus,
      reEnabledSample,
      passed: true,
    };
  } finally {
    await page.close();
  }
}

async function openQaPage(context, serviceWorker, url) {
  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[page] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.startQaTone === 'function');

  const tabId = await waitFor('qa tab id', () => findTabId(serviceWorker, url));
  return { page, tabId };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderQaPage(req.headers.host || 'qa-host'));
    });

    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function renderQaPage(host) {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Responsive Normalizer QA</title>
      <style>
        body { font-family: system-ui, sans-serif; padding: 24px; }
        pre { background: #111827; color: #e5e7eb; padding: 12px; border-radius: 8px; min-height: 160px; white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <h1>${host}</h1>
      <p id="status">idle</p>
      <pre id="log"></pre>
      <script>
        let ctx;
        let oscillator;
        let sourceGain;
        let preAnalyser;
        let postAnalyser;
        let analyserBuffer;
        let workletCapturePatched = false;
        const capturedWorklets = [];

        const logEl = document.getElementById('log');
        const statusEl = document.getElementById('status');

        function log(message) {
          logEl.textContent += message + '\\n';
          console.log(message);
        }

        function updateStatus(next) {
          statusEl.textContent = next;
          log('status=' + next);
        }

        function patchWorkletCapture() {
          if (workletCapturePatched || typeof window.AudioWorkletNode !== 'function') return;
          const NativeAudioWorkletNode = window.AudioWorkletNode;
          window.AudioWorkletNode = class QaAudioWorkletNode extends NativeAudioWorkletNode {
            constructor(...args) {
              super(...args);
              capturedWorklets.push(this);
              if (!postAnalyser && this.context) {
                postAnalyser = this.context.createAnalyser();
                postAnalyser.fftSize = 2048;
              }
              if (postAnalyser) {
                try { this.connect(postAnalyser); } catch {}
              }
            }
          };
          workletCapturePatched = true;
        }

        patchWorkletCapture();
        setInterval(patchWorkletCapture, 50);

        function ensureGraph() {
          if (ctx) return;

          ctx = new AudioContext({ latencyHint: 'interactive' });
          oscillator = ctx.createOscillator();
          oscillator.type = 'sine';
          sourceGain = ctx.createGain();
          preAnalyser = ctx.createAnalyser();
          preAnalyser.fftSize = 2048;
          analyserBuffer = new Float32Array(preAnalyser.fftSize);

          oscillator.connect(sourceGain);
          sourceGain.connect(preAnalyser);
          preAnalyser.connect(ctx.destination);
          oscillator.start();
          sourceGain.gain.value = 0;
        }

        async function startQaTone({ amplitude, frequency }) {
          ensureGraph();
          oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
          sourceGain.gain.setValueAtTime(amplitude, ctx.currentTime);
          await ctx.resume();
          updateStatus('playing amplitude=' + amplitude.toFixed(3));
          return true;
        }

        function setQaAmplitude(amplitude) {
          if (!ctx || !sourceGain) return false;
          sourceGain.gain.setValueAtTime(amplitude, ctx.currentTime);
          updateStatus('amplitude=' + amplitude.toFixed(3));
          return true;
        }

        function resetQaState() {
          if (!ctx) return;
          sourceGain.gain.setValueAtTime(0, ctx.currentTime);
          updateStatus('reset');
        }

        function hasQaWorklet() {
          return capturedWorklets.length > 0 && Boolean(postAnalyser);
        }

        function measureAnalyser(analyser) {
          const buffer = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(buffer);
          let sumSq = 0;
          let peak = 0;
          for (const sample of buffer) {
            const abs = Math.abs(sample);
            if (abs > peak) peak = abs;
            sumSq += sample * sample;
          }
          return {
            rms: Math.sqrt(sumSq / buffer.length),
            peak,
          };
        }

        async function sampleQaLevels(durationMs) {
          const deadline = performance.now() + durationMs;
          let count = 0;
          let preRmsSum = 0;
          let postRmsSum = 0;
          let prePeak = 0;
          let postPeak = 0;

          while (performance.now() < deadline) {
            const pre = measureAnalyser(preAnalyser);
            const post = postAnalyser ? measureAnalyser(postAnalyser) : { rms: 0, peak: 0 };
            preRmsSum += pre.rms;
            postRmsSum += post.rms;
            prePeak = Math.max(prePeak, pre.peak);
            postPeak = Math.max(postPeak, post.peak);
            count += 1;
            await new Promise((resolve) => setTimeout(resolve, 40));
          }

          const preRms = count ? preRmsSum / count : 0;
          const postRms = count ? postRmsSum / count : 0;
          return {
            count,
            preRms,
            postRms,
            prePeak,
            postPeak,
            rmsRatio: preRms > 0 ? postRms / preRms : 0,
          };
        }

        window.startQaTone = startQaTone;
        window.setQaAmplitude = setQaAmplitude;
        window.resetQaState = resetQaState;
        window.hasQaWorklet = hasQaWorklet;
        window.sampleQaLevels = sampleQaLevels;
      </script>
    </body>
  </html>`;
}

async function findTabId(serviceWorker, url) {
  const pattern = `${new URL(url).origin}/*`;
  return serviceWorker.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({ url: targetUrl });
    return tabs[0]?.id || null;
  }, pattern);
}

async function getDocumentStatus(serviceWorker, tabId) {
  return serviceWorker.evaluate(async (targetTabId) => {
    try {
      return await chrome.tabs.sendMessage(targetTabId, { type: 'GET_DOCUMENT_STATUS' });
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }, tabId);
}

async function setSiteState(serviceWorker, siteKey, enabled, options = {}) {
  return serviceWorker.evaluate(async ({ targetSiteKey, nextEnabled, blastGuard }) => {
    try {
      return await chrome.runtime.sendMessage({
        type: 'SET_SITE_STATE',
        siteKey: targetSiteKey,
        enabled: nextEnabled,
        ...(typeof blastGuard === 'boolean' ? { blastGuard } : {}),
      });
    } catch {
      const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {} });
      const siteSettings = { ...stored.siteSettings };
      const current = siteSettings[targetSiteKey] && typeof siteSettings[targetSiteKey] === 'object'
        ? siteSettings[targetSiteKey]
        : {};
      siteSettings[targetSiteKey] = {
        enabled: nextEnabled,
        gainDb: Number.isFinite(current.gainDb) ? current.gainDb : 0,
        blastGuard: typeof blastGuard === 'boolean' ? blastGuard : Boolean(current.blastGuard),
      };
      await chrome.storage.local.set({ activeSites: {}, siteSettings });
      return {
        ok: true,
        enabled: nextEnabled,
        blastGuard: siteSettings[targetSiteKey].blastGuard,
        siteKey: targetSiteKey,
      };
    }
  }, {
    targetSiteKey: siteKey,
    nextEnabled: enabled,
    blastGuard: Object.prototype.hasOwnProperty.call(options, 'blastGuard') ? options.blastGuard : undefined,
  });
}

async function waitFor(label, fn, timeoutMs = 10000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
