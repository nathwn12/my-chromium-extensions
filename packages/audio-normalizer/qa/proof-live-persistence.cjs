'use strict';
// proof-live-persistence.cjs — Phase 1 live loop for the persistence bug.
// User symptom: "whatever I set per site, should be persistent"; the extension
// used to "auto-enable" sites that had been turned off.
//
// AUDIO SAFETY: this loop is incapable of producing sound. It launches a
// headless Chromium with --mute-audio and serves its own fixture pages that
// contain NO audio whatsoever — no <audio>/<video>, no AudioContext, no
// oscillator, no media element, no startTone. A startup guard below refuses
// to run if the fixture ever gains an audio path. Never add one.
//
// Usage: node qa/proof-live-persistence.cjs
// Exit 0 when the symptom is absent (all five hold), non-zero when present.
// Prints one clear line per assertion; a failure names which of the five broke.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { chromium } = loadPlaywright();

const extensionPath = path.resolve(__dirname, '..');
const profileDir = path.join(os.tmpdir(), `tab-normalizer-persist-${Date.now()}`);

const SITE_KEY = 'dev.localhost';
const GAIN_DB = 6;

// Silent fixture. Static HTML only: no script, no media elements, no audio path.
const FIXTURE_HTML =
  '<!doctype html>\n' +
  '<html lang="en">\n' +
  '<head><meta charset="utf-8"><title>persist-fixture</title></head>\n' +
  '<body><h1 id="host">fixture</h1><p id="status">idle</p></body>\n' +
  '</html>\n';

// Startup guard: refuse to run if the fixture ever gains an audio path.
for (const needle of ['<audio', '<video', 'AudioContext', 'Oscillator', 'startTone', 'stopTone', '.play(']) {
  if (FIXTURE_HTML.includes(needle)) {
    console.error(`REFUSED: fixture contains audio path ${JSON.stringify(needle)}`);
    process.exit(2);
  }
}

function loadPlaywright() {
  const candidates = ['playwright', process.env.TN_PLAYWRIGHT_PATH].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error('Playwright install not found. Install it locally: npm install --save-dev playwright');
}

async function main() {
  const { server, port } = await startServer();
  const baseUrl = `http://www.dev.localhost:${port}`;
  const siblingUrl = `http://m.dev.localhost:${port}`;
  console.log(`launch: headless=true mute-audio fixture=no-audio base=${baseUrl}`);

  let context;
  const passed = [];
  const pass = (id, label) => {
    console.log(`${id} ${label}: PASS`);
    passed.push(id);
  };
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: true, // hard-coded: this loop never runs headed (audio safety).
      args: [
        '--mute-audio', // belt: the fixture has no audio path regardless.
        '--autoplay-policy=user-gesture-required',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const serviceWorker = await waitFor('extension service worker', async () => {
      return context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 1000 });
    });

    await swEvalLive(context, () => chrome.storage.local.clear());

    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const firstTabId = await waitFor('first tab id', () => findTabId(context, baseUrl));
    assert.ok(firstTabId, 'first tab id resolvable');

    // Setup through the REAL popup UI (enable toggle) plus ONE combined
    // background intent from a popup context (enable + gain + Blast Guard in
    // a single write — one logical update, no crash window between fields),
    // each popup abandoned at once: no close/flush is required for a write
    // to land. Progress is gated on STORAGE (the write path), never on the
    // popup's re-render (a read path under test), so a read-side break goes
    // RED at its assertion instead of stalling setup.
    await drivePopup(context, firstTabId, baseUrl, async (popup) => {
      if (!(await popup.locator('#toggle').isChecked())) {
        await popup.locator('#toggle').click();
      }
    });
    await drivePopup(context, firstTabId, baseUrl, async (popup) => {
      await popup.evaluate(({ gainDb }) => chrome.runtime.sendMessage({
        type: 'SET_SITE_STATE', siteKey: 'dev.localhost', set: { enabled: true, gainDb, blastGuard: true },
      }), { gainDb: GAIN_DB });
    });
    await waitFor('setup writes land after popup close', async () => {
      const rec = await readStoredRecord(context);
      if (rec && rec.enabled === true && rec.gainDb === GAIN_DB && rec.blastGuard === true) return rec;
      return null;
    });
    pass('A5', 'popup-close-not-required (enable+gain+guard landed after popup abandoned)');

    // A2: setting persists across reload (product read path: GET_SITE_STATE).
    // The read is issued from a real popup (extension) context — the exact
    // route the shipped popup uses on init. It must NOT be issued from the
    // service worker itself: the worker cannot message itself
    // (sender-excluded delivery, "Receiving end does not exist"), so a
    // worker-side sendMessage can never observe the product and would time
    // out even when the stored truth is correct.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const probe = await openPopup(context, firstTabId, baseUrl);
    let reloaded;
    try {
      reloaded = await waitFor(
        `A2 setting-persists (want enabled=true gainDb=${GAIN_DB} blastGuard=true after reload)`,
        async () => {
          const s = await tolerant(() => probe.evaluate(
            (siteKey) => chrome.runtime.sendMessage({ type: 'GET_SITE_STATE', hostname: siteKey }),
            SITE_KEY,
          ));
          if (s && s.enabled === true && s.gainDb === GAIN_DB && s.blastGuard === true) return s;
          return null;
        },
      );
      // A2-rendered: the popup's RENDERED controls — the literal user symptom
      // ("the popup shows it off again"). The message response above can hold
      // while the drawn controls show stale state, so assert what is drawn:
      // the toggle's `checked` and the gain readout text. The readout carries
      // renderGain's '+' prefix for positive gain, asserted EXACTLY (strict
      // equality): a substring match would also accept the old buggy "6.0 dB".
      const wantGainText = `+${GAIN_DB.toFixed(1)} dB`;
      const rendered = await waitFor(
        `A2 popup-rendered (want #toggle checked + gain text exactly ${JSON.stringify(wantGainText)} after reload)`,
        async () => {
          const r = await tolerant(() => probe.evaluate(() => ({
            checked: document.getElementById('toggle').checked,
            gainText: document.getElementById('gain-value').textContent,
          })));
          if (r && r.checked === true && r.gainText === wantGainText) return r;
          return null;
        },
      );
      reloaded.renderedChecked = rendered.checked;
      reloaded.renderedGainText = rendered.gainText;
    } finally {
      await probe.close();
    }
    pass('A2', `setting-persists gainDb=${reloaded.gainDb} blastGuard=${reloaded.blastGuard} renderedChecked=${reloaded.renderedChecked} renderedGainText=${JSON.stringify(reloaded.renderedGainText)}`);

    // A3: second tab of the same site agrees with the first.
    const page2 = await context.newPage();
    await page2.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const secondTabId = await waitFor('second tab id', () => findTabId(context, baseUrl, firstTabId));
    const firstDoc = await getDocumentStatus(context, firstTabId);
    const secondDoc = await waitFor('A3 second-tab-agrees (want enabled=true gainDb=6 blastGuard=true)', async () => {
      const s = await tolerant(() => getDocumentStatus(context, secondTabId));
      if (s && s.enabled === true && s.gainDb === GAIN_DB && s.blastGuard === true) return s;
      return null;
    });
    assert.ok(
      firstDoc.enabled === secondDoc.enabled
      && firstDoc.gainDb === secondDoc.gainDb
      && firstDoc.blastGuard === secondDoc.blastGuard,
      `tabs disagree: first=${JSON.stringify({ e: firstDoc.enabled, g: firstDoc.gainDb, b: firstDoc.blastGuard })}`,
    );
    pass('A3', `second-tab-agrees gainDb=${secondDoc.gainDb} blastGuard=${secondDoc.blastGuard}`);

    // A4: sibling subdomain shares the site key (getSiteKey collapses).
    const siblingPage = await context.newPage();
    await siblingPage.goto(siblingUrl, { waitUntil: 'domcontentloaded' });
    const siblingTabId = await waitFor('sibling tab id', () => findTabId(context, siblingUrl));
    const siblingDoc = await waitFor('A4 sibling-shares (want siteKey=dev.localhost enabled=true gainDb=6)', async () => {
      const s = await tolerant(() => getDocumentStatus(context, siblingTabId));
      if (s && s.siteKey === SITE_KEY && s.enabled === true && s.gainDb === GAIN_DB) return s;
      return null;
    });
    pass('A4', `sibling-shares siteKey=${siblingDoc.siteKey} gainDb=${siblingDoc.gainDb}`);

    // A1: disable persists — through the real popup disable path (the named
    // root cause), popup abandoned at once, then the stored record read from
    // the extension context, then a reload read.
    await drivePopup(context, firstTabId, baseUrl, async (popup) => {
      // Drive toward OFF: click only when the popup shows ON. (When the
      // product read path is broken the popup can show OFF while storage
      // says ON — then there is nothing to click and the storage assert
      // below reports the incoherence as the RED.)
      if (await popup.locator('#toggle').isChecked()) {
        await popup.locator('#toggle').click();
      }
    });
    const storedAfterDisable = await waitFor('A1 disable-persists (want stored.enabled=false)', async () => {
      const rec = await tolerant(() => readStoredRecord(context));
      if (rec && rec.enabled === false) return rec;
      return null;
    });
    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const disabledDoc = await waitFor('A1 disable-persists (want enabled=false after reload)', async () => {
      const s = await tolerant(() => getDocumentStatus(context, firstTabId));
      if (s && s.enabled === false) return s;
      return null;
    });
    pass('A1', `disable-persists stored.enabled=${storedAfterDisable.enabled} afterReload.enabled=${disabledDoc.enabled}`);

    console.log('GREEN: all five persistence assertions held — symptom absent');
  } catch (error) {
    console.error(`RED: ${error.message}`);
    try {
      const lastSeen = await swEvalLive(context, async () => {
        const all = await chrome.storage.local.get(null);
        // Product-pattern read (background readSiteRecord / content-script
        // readStoredConfig shape): diagnostic only, never a gate.
        const viaProductPattern = await chrome.storage.local.get({ 'site:dev.localhost': undefined });
        return { stored: all['site:dev.localhost'] || null, viaProductPattern };
      });
      console.error(`last-seen: ${JSON.stringify(lastSeen)}`);
    } catch {}
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    await stopServer(server);
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

// Open the real popup for tabId, run fn, then CLOSE the popup page at once:
// persistence must not depend on the popup staying open. Returns fn's value.
async function drivePopup(context, tabId, tabUrl, fn) {
  const popup = await openPopup(context, tabId, tabUrl);
  try {
    return await fn(popup);
  } finally {
    await popup.close(); // abandoned on purpose: the write must already be on its way.
  }
}

// Open the real popup for tabId and leave it open for the caller to close.
// Split out so a poll can reuse one popup across iterations instead of
// reopening it per attempt.
async function openPopup(context, tabId, tabUrl) {
  const extensionId = new URL(context.serviceWorkers()[0].url()).host;
  const popup = await context.newPage();
  await popup.addInitScript(
    ({ targetTabId, targetUrl }) => {
      const patch = () => {
        if (!globalThis.chrome?.tabs?.query) {
          setTimeout(patch, 0);
          return;
        }
        const originalQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (queryInfo) => {
          if (queryInfo?.active && queryInfo?.currentWindow) {
            return [{ id: targetTabId, url: targetUrl }];
          }
          return originalQuery(queryInfo);
        };
      };
      patch();
    },
    { targetTabId: tabId, targetUrl: tabUrl },
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popup.locator('#toggle').waitFor({ state: 'visible' });
  await popup.waitForFunction(() => document.getElementById('hostname')?.textContent?.includes('dev.localhost'));
  // Init sets #hostname BEFORE the async state load; wait for init to finish
  // (status leaves 'Checking…') so the toggle click hits a live siteKey.
  await popup.waitForFunction(() => document.getElementById('status-text')?.textContent !== 'Checking…');
  return popup;
}

// Robust observation read: get(null) + index. (Deliberately NOT the
// `{ [perKey]: undefined }` get-pattern — see report §5.)
async function readStoredRecord(context) {
  return swEvalLive(context, async () => {
    const all = await chrome.storage.local.get(null);
    return all['site:dev.localhost'] || null;
  });
}

// NOTE: there is deliberately no worker-side GET_SITE_STATE helper. The
// service worker cannot message itself (sender-excluded delivery), so
// `swEvalLive(context, () => chrome.runtime.sendMessage(...))` always throws
// "Receiving end does not exist" and can never observe the product. A2 reads
// GET_SITE_STATE from a real popup context instead (openPopup + evaluate).

async function getDocumentStatus(context, tabId) {
  return swEvalLive(
    context,
    async (targetTabId) => {
      try {
        return await chrome.tabs.sendMessage(targetTabId, { type: 'GET_DOCUMENT_STATUS' }, { frameId: 0 });
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    tabId,
  );
}

async function findTabId(context, targetUrl, excludeTabId) {
  return swEvalLive(
    context,
    async ({ expectedUrl, excluded }) => {
      const tabs = await chrome.tabs.query({});
      const match = tabs.find((tab) => {
        if (excluded && tab.id === excluded) return false;
        try {
          const parsed = new URL(tab.url);
          const expected = new URL(expectedUrl);
          return parsed.hostname === expected.hostname && parsed.port === expected.port;
        } catch {
          return false;
        }
      });
      return match?.id || null;
    },
    { expectedUrl: targetUrl, excluded: excludeTabId || null },
  );
}

// Re-acquire a live service worker per call: MV3 idles the worker and a
// cached handle goes stale ("Receiving end does not exist").
async function swEvalLive(context, fn, arg) {
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 10000 });
  return worker.evaluate(fn, arg);
}

// A dead worker mid-poll is a retry, not a verdict.
async function tolerant(fn) {
  try {
    return await fn();
  } catch (error) {
    if (/Receiving end does not exist|Target crashed|Target closed|Session closed/i.test(String(error))) return null;
    throw error;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(label, fn, timeoutMs = 10000, intervalMs = 100) {
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
  console.error(`RED: ${error.stack || error}`);
  process.exitCode = 1;
});
