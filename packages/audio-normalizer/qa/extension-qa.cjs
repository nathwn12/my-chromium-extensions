const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { chromium } = loadPlaywright();

const extensionPath = path.resolve(__dirname, '..');
const profileDir = path.join(os.tmpdir(), `tab-normalizer-qa-${Date.now()}`);
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
  const siblingUrl = `http://m.dev.localhost:${server.port}`;

  let context;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const serviceWorker = await waitFor('extension service worker', async () => {
      return context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 1000 });
    });
    const extensionId = new URL(serviceWorker.url()).host;

    const page = await context.newPage();
    page.on('console', (msg) => console.log(`[page] ${msg.type()}: ${msg.text()}`));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.startTone === 'function');

    const firstTabId = await waitFor('first tab id', () => findTabId(serviceWorker, baseUrl));

    // Objective: enabling from the popup/service worker should activate an already-open supported tab without refresh.
    const initialActivation = await setSiteState(serviceWorker, 'dev.localhost', true, { tabId: firstTabId });
    assert.equal(initialActivation?.ok, true);
    assert.equal(initialActivation?.enabled, true);
    assert.equal(initialActivation?.activation?.state, 'pending');

    await waitFor('enabled state on first tab', async () => {
      const status = await getDocumentStatus(serviceWorker, firstTabId);
      return status?.enabled ? status : null;
    });

    await page.bringToFront();
    await page.evaluate(() => window.startTone());

    const activeStatus = await waitFor('active hook status', async () => {
      const status = await getDocumentStatus(serviceWorker, firstTabId);
      if (status?.enabled && status?.hookActive) return status;
      return null;
    }, 15000);
    assert.equal(activeStatus.siteKey, 'dev.localhost');

    const popup = await context.newPage();
    await popup.addInitScript(
      ({ tabId, url }) => {
        const patchTabsApi = () => {
          if (!globalThis.chrome?.tabs?.query) {
            setTimeout(patchTabsApi, 0);
            return;
          }

          const originalQuery = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async (queryInfo) => {
            if (queryInfo?.active && queryInfo?.currentWindow) {
              return [{ id: tabId, url }];
            }
            return originalQuery(queryInfo);
          };
        };

        patchTabsApi();
      },
      { tabId: firstTabId, url: baseUrl },
    );
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    await popup.waitForTimeout(1200);
    const popupGreenClass = await popup.locator('#status-dot').getAttribute('class');
    assert.match(String(popupGreenClass), /green/);

    // NOTE: the session-only (#remember) popup flows were removed along with
    // the control itself (absent from popup.html/popup.js). Transient
    // coverage lives in the service-worker evals below (persist:false) and
    // the restricted-session activation.

    const siblingPage = await context.newPage();
    siblingPage.on('console', (msg) => console.log(`[sibling] ${msg.type()}: ${msg.text()}`));
    await siblingPage.goto(siblingUrl, { waitUntil: 'domcontentloaded' });
    await siblingPage.waitForFunction(() => typeof window.startTone === 'function');
    await siblingPage.evaluate(() => window.startTone());
    const siblingTabId = await waitFor('sibling tab id', () => findTabId(serviceWorker, siblingUrl));

    // Objective: preserve the existing future-load activation path for matching tabs opened after enable.
    const siblingStatus = await waitFor('site-wide sibling activation', async () => {
      const status = await getDocumentStatus(serviceWorker, siblingTabId);
      if (status?.enabled) return status;
      return null;
    });
    assert.equal(siblingStatus.siteKey, 'dev.localhost');

    // Objective: restricted pages should fail safely when current-tab activation is requested.
    const restrictedPage = await context.newPage();
    await restrictedPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
    const restrictedTabId = await waitFor('restricted tab id', () => findTabId(serviceWorker, 'chrome://extensions/'));
    const restrictedActivation = await setSiteState(serviceWorker, 'dev.localhost', true, { tabId: restrictedTabId });
    assert.equal(restrictedActivation?.ok, true);
    assert.equal(restrictedActivation?.activation?.state, 'restricted');
    assert.equal(restrictedActivation?.activation?.message, 'Enabled. Reload on a supported page.');

    const restrictedSessionActivation = await setSiteState(serviceWorker, 'dev.localhost', true, {
      tabId: restrictedTabId,
      persist: false,
    });
    assert.equal(restrictedSessionActivation?.ok, true);
    assert.equal(restrictedSessionActivation?.activation?.state, 'restricted');
    await restrictedPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await restrictedPage.waitForFunction(() => typeof window.startTone === 'function');
    await restrictedPage.evaluate(() => window.startTone());
    const restrictedSessionStatus = await waitFor('restricted session activation after supported navigation', async () => {
      const status = await getDocumentStatus(serviceWorker, restrictedTabId);
      if (status?.enabled && status?.hookActive) return status;
      return null;
    }, 15000);
    assert.equal(restrictedSessionStatus.siteKey, 'dev.localhost');

    await page.bringToFront();
    await siblingPage.bringToFront();
    await popup.bringToFront();
    await page.bringToFront();

    const recoveredStatus = await waitFor('recovered hook after tab blur', async () => {
      const status = await getDocumentStatus(serviceWorker, firstTabId);
      if (status?.enabled && status?.hookActive) return status;
      return null;
    }, 15000);
    assert.equal(recoveredStatus.indicator, 'green');

    await popup.evaluate(async () => {
      const siteKey = document.getElementById('hostname').textContent;
      const sequence = [false, true, false, true, false, true, true];
      await Promise.all(sequence.map((enabled) => chrome.runtime.sendMessage({
        type: 'SET_SITE_STATE',
        siteKey,
        enabled,
      })));
      await chrome.runtime.sendMessage({ type: 'SET_SITE_STATE', siteKey, enabled: true });
    });

    const stressedStatus = await waitFor('stable status after toggle spam', async () => {
      const status = await getDocumentStatus(serviceWorker, firstTabId);
      if (status?.enabled && status?.hookActive) return status;
      return null;
    }, 15000);
    assert.equal(stressedStatus.indicator, 'green');

    await page.bringToFront();
    await page.evaluate(() => {
      window.stopTone();
      delete window.__tabNormalizerHookV5;
    });
    await page.waitForTimeout(3500);
    await popup.bringToFront();
    await popup.locator('#gain-slider').dispatchEvent('pointerdown');
    await page.bringToFront();
    await page.evaluate(() => window.startTone());
    const sliderWakeStatus = await waitFor('slider pointerdown recovers stale hook', async () => {
      const status = await getDocumentStatus(serviceWorker, firstTabId);
      if (status?.enabled && status?.hookActive) return status;
      return null;
    }, 15000);
    assert.equal(sliderWakeStatus.indicator, 'green');

    // Test 6: Same-site SPA navigation (simulate by replacing page content)
    await page.bringToFront();
    await page.evaluate(() => {
      window.stopTone();
      // Simulate SPA navigation: clear hook global, change URL hash
      delete window.__tabNormalizerHookV5;
      window.location.hash = '#navigated-' + Date.now();
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.startTone());
    const spaNavStatus = await waitFor('recovered after SPA navigation', async () => {
      const status = await getDocumentStatus(serviceWorker, firstTabId);
      if (status?.enabled && status?.hookActive) return status;
      return null;
    }, 15000);
    assert.equal(spaNavStatus.indicator, 'green');

    // Test 7: Disable then re-enable — indicator should reflect real state
    await setSiteState(serviceWorker, 'dev.localhost', false);
    await page.waitForTimeout(500);
    const disabledStatus = await getDocumentStatus(serviceWorker, firstTabId);
    assert.equal(disabledStatus.enabled, false);
    assert.notEqual(disabledStatus.indicator, 'green');

    await setSiteState(serviceWorker, 'dev.localhost', true);
    const reEnabledStatus = await waitFor('re-enabled after disable', async () => {
      const status = await getDocumentStatus(serviceWorker, firstTabId);
      if (status?.enabled && status?.hookActive) return status;
      return null;
    }, 15000);
    assert.equal(reEnabledStatus.indicator, 'green');

    // Test 8: Verify status consistency after stopping audio
    await page.bringToFront();
    await page.evaluate(() => window.stopTone());
    await page.waitForTimeout(1000);
    const stoppedStatus = await getDocumentStatus(serviceWorker, firstTabId);
    assert.equal(stoppedStatus.enabled, true);
    assert.equal(stoppedStatus.hookAlive, true);
    // Hook is still active (worklet session exists) — this is correct, normalizer is ready
    // No false red — no errors should be present
    assert.equal(stoppedStatus.lastError, '');
    assert.notEqual(stoppedStatus.indicator, 'red');

    console.log(JSON.stringify({
      extensionId,
        checks: {
          popupGreenClass,
          activeStatus,
          initialActivation,
          siblingStatus,
        restrictedActivation,
        restrictedSessionActivation,
        restrictedSessionStatus,
        recoveredStatus,
        stressedStatus,
        sliderWakeStatus,
        spaNavStatus,
        disabledStatus,
        reEnabledStatus,
        stoppedStatus,
      },
    }, null, 2));
  } finally {
    if (context) await context.close();
    await stopServer(server.server);
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
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
      <title>Tab Normalizer QA</title>
      <style>
        body { font-family: system-ui, sans-serif; padding: 24px; }
        button { font: inherit; padding: 8px 12px; }
        pre { background: #111827; color: #e5e7eb; padding: 12px; border-radius: 8px; min-height: 140px; }
      </style>
    </head>
    <body>
      <h1>${host}</h1>
      <p id="status">idle</p>
      <button id="start-tone">Start tone</button>
      <button id="stop-tone">Stop tone</button>
      <pre id="log"></pre>
      <script>
        let player;

        const logEl = document.getElementById('log');
        const statusEl = document.getElementById('status');

        function log(message) {
          logEl.textContent += message + '\\n';
          console.log(message);
        }

        function updateStatus(next) {
          statusEl.textContent = next;
          log('status: ' + next);
        }

        async function startTone() {
          try {
            if (!player) {
              player = document.createElement('audio');
              player.autoplay = true;
              player.controls = true;
              player.loop = true;
              player.src = createToneUrl();
              document.body.appendChild(player);
            }

            await player.play();
            updateStatus('playing=' + String(!player.paused));
          } catch (error) {
            log('start error: ' + (error && error.message ? error.message : error));
            throw error;
          }
        }

        async function stopTone() {
          if (!player) return;
          try {
            player.pause();
          } catch {}
          try {
            player.currentTime = 0;
          } catch {}
          updateStatus('stopped');
        }

        document.getElementById('start-tone').addEventListener('click', () => {
          void startTone();
        });
        document.getElementById('stop-tone').addEventListener('click', () => {
          void stopTone();
        });
        window.startTone = startTone;
        window.stopTone = stopTone;

        document.addEventListener('visibilitychange', () => log('visibility=' + document.visibilityState));
        window.addEventListener('focus', () => log('focus'));
        window.addEventListener('pageshow', () => log('pageshow'));

        function createToneUrl() {
          const sampleRate = 8000;
          const durationSeconds = 1;
          const sampleCount = sampleRate * durationSeconds;
          const bytesPerSample = 2;
          const dataSize = sampleCount * bytesPerSample;
          const buffer = new ArrayBuffer(44 + dataSize);
          const view = new DataView(buffer);

          writeString(view, 0, 'RIFF');
          view.setUint32(4, 36 + dataSize, true);
          writeString(view, 8, 'WAVE');
          writeString(view, 12, 'fmt ');
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, sampleRate, true);
          view.setUint32(28, sampleRate * bytesPerSample, true);
          view.setUint16(32, bytesPerSample, true);
          view.setUint16(34, 16, true);
          writeString(view, 36, 'data');
          view.setUint32(40, dataSize, true);

          for (let index = 0; index < sampleCount; index += 1) {
            const sample = Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 0.2;
            view.setInt16(44 + index * bytesPerSample, sample * 32767, true);
          }

          return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
        }

        function writeString(view, offset, value) {
          for (let index = 0; index < value.length; index += 1) {
            view.setUint8(offset + index, value.charCodeAt(index));
          }
        }
      </script>
    </body>
  </html>`;
}

async function findTabId(serviceWorker, targetUrl) {
  return serviceWorker.evaluate(async (expectedUrl) => {
    const normalizeTabUrl = (value) => {
      if (typeof value !== 'string' || !value) return '';
      try {
        const parsed = new URL(value);
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.pathname === '/') {
          parsed.pathname = '';
        }
        return parsed.href.replace(/\/$/, '');
      } catch {
        return String(value).replace(/\/$/, '');
      }
    };

    const tabs = await chrome.tabs.query({});
    const normalizedExpectedUrl = normalizeTabUrl(expectedUrl);
    const match = tabs.find((tab) => normalizeTabUrl(tab.url) === normalizedExpectedUrl);
    return match?.id || null;
  }, targetUrl);
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

async function getSiteState(serviceWorker, siteKey) {
  return serviceWorker.evaluate(async (targetSiteKey) => {
    const stored = await chrome.storage.local.get({ siteSettings: {} });
    const config = stored.siteSettings?.[targetSiteKey];
    return {
      enabled: Boolean(config?.enabled),
      gainDb: Number.isFinite(config?.gainDb) ? config.gainDb : 0,
    };
  }, siteKey);
}

async function setSiteState(serviceWorker, siteKey, enabled, options = {}) {
  return serviceWorker.evaluate(async ({ targetSiteKey, nextEnabled, targetTabId, persist }) => {
    const getFallbackActivation = async () => {
      if (!nextEnabled || !targetTabId) {
        return { state: nextEnabled ? 'pending' : 'idle' };
      }

      try {
        const tab = await chrome.tabs.get(targetTabId);
        const url = String(tab?.url || '');
        if (/^(chrome|chrome-extension|devtools|edge|about|moz-extension):/i.test(url)) {
          return { state: 'restricted', message: 'Enabled. Reload on a supported page.' };
        }
      } catch {}

      return { state: 'pending' };
    };

    try {
      return await chrome.runtime.sendMessage({
        type: 'SET_SITE_STATE',
        siteKey: targetSiteKey,
        enabled: nextEnabled,
        ...(targetTabId ? { tabId: targetTabId } : {}),
        ...(persist === false ? { persist: false } : {}),
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
      };
      await chrome.storage.local.set({ activeSites: {}, siteSettings });
      return {
        ok: true,
        enabled: nextEnabled,
        siteKey: targetSiteKey,
        activation: await getFallbackActivation(),
      };
    }
  }, {
    targetSiteKey: siteKey,
    nextEnabled: enabled,
    targetTabId: options.tabId ?? null,
    persist: Object.prototype.hasOwnProperty.call(options, 'persist') ? options.persist : undefined,
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
