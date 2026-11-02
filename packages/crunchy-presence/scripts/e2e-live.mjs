/**
 * Live end-to-end check: real Chrome (headless), real unpacked extension, real
 * Crunchyroll page. Proves the content script extracts from the live DOM and
 * that Chrome spawns the native host through the registry — with no window.
 *
 *   node scripts/e2e-live.mjs [--url <watchUrl>] [--keep]
 *
 * Exit 0 only when every check passes. Scratch profile is deleted on exit.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EXT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve('docs', 'proof');
const PROFILE = path.join(process.env.TEMP, 'opencode', 'crp-e2e-live', 'profile');
const DEFAULT_URL = 'https://www.crunchyroll.com/watch/GRDKJZ81Y/alone-and-lonesome';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf('--url');
const WATCH = urlIndex >= 0 ? argv[urlIndex + 1] : DEFAULT_URL;
const keep = argv.includes('--keep');

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  userAgent: UA,
  UserAgent: UA,
  viewport: { width: 1280, height: 800 },
  // Crunchyroll serves an empty shell to `navigator.webdriver === true`, which is
  // exactly what Playwright's automation surface sets. The flag below clears it.
  args: ['--disable-blink-features=AutomationControlled'],
  // Playwright disables extensions by default; the whole point here is a live one.
  // --enable-automation is also dropped: Crunchyroll's SPA bounces flagged browsers to /.
  ignoreDefaultArgs: [
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--enable-automation'
  ]
});

let exitCode = 1;
try {
  const browser = context.browser();
  const cdp = browser ? await browser.newBrowserCDPSession() : await context.newCDPSession(await context.newPage());
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT });
  const id = loaded.id;
  check('extension loads unpacked', id === 'afghbfidjjlgnhaacaiiakmknffnmiom', `id=${id}`);

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let title = '';
  let cloudflareCleared = false;
  for (let i = 0; i < 30; i += 1) {
    title = await page.title();
    if (!/Just a moment|Attention Required/i.test(title)) cloudflareCleared = true;
    // The SPA swaps the generic site title for the episode title once the watch page renders.
    if (cloudflareCleared && /Watch on Crunchyroll/i.test(title) && !/^Crunchyroll: Watch Popular Anime/.test(title)) break;
    await page.waitForTimeout(2000);
  }
  check('Cloudflare cleared in headless', cloudflareCleared, title);

  console.log('PAGE-URL ' + page.url());
  console.log('DIAG ' + await page.evaluate(() => JSON.stringify({
    title: document.title,
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
    h1: (document.querySelector('h1') || {}).textContent || null,
    ldBlocks: document.querySelectorAll('script[type="application/ld+json"]').length,
    ogDescription: (document.querySelector('meta[property="og:description"]') || {}).content || null,
    bodyLen: (document.body && document.body.innerText || '').length
  })));

  let extract = null;
  let status = null;
  for (let i = 0; i < 15; i += 1) {
    const sw = context.serviceWorkers().find((w) => w.url().includes(id));
    if (sw) {
      const raw = await sw.evaluate(() => chrome.storage.session.get(null));
      extract = raw.crpLastExtract || null;
      status = raw.crpStatus || null;
      if (extract && extract.synopsis) break;
    }
    await page.waitForTimeout(2000);
  }

  console.log('\nEXTRACT ' + JSON.stringify(extract, null, 1));
  console.log('STATUS  ' + JSON.stringify(status, null, 1) + '\n');

  check('content script reported from the live DOM', Boolean(extract));
  check('series parsed', extract?.series === 'Darling in the FRANXX', extract?.series);
  check('episode parsed', extract?.episodeTitle === 'E1 - Alone and Lonesome', extract?.episodeTitle);
  check('season + episode numbers', extract?.seasonNumber === 1 && extract?.episodeNumber === 1,
    `S${extract?.seasonNumber} E${extract?.episodeNumber}`);
  check('synopsis parsed (150+ chars)', (extract?.synopsis || '').length >= 150,
    `${(extract?.synopsis || '').length} chars`);
  check('series URL parsed', /\/series\/GY8VEQ95Y\//.test(extract?.seriesUrl || ''), extract?.seriesUrl);
  check('episode URL parsed', /\/watch\/GRDKJZ81Y\//.test(extract?.episodeUrl || ''), extract?.episodeUrl);
  check('native host connected (Chrome spawned it)', status?.bridgeState === 'connected', status?.bridgeState);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popup.waitForTimeout(1500);
  const shot = await popup.screenshot({ type: 'png' });
  const shotPath = path.join(OUT, 'phase2-live-popup.png');
  writeFileSync(shotPath, shot);
  check('popup screenshot captured', shot.length > 20000, `${shot.length} B ${shotPath}`);

  writeFileSync(path.join(OUT, 'phase2-live-extract.json'), JSON.stringify({ url: WATCH, title, extract, status }, null, 2));

  exitCode = checks.every((c) => c.ok) ? 0 : 1;
} catch (error) {
  console.log('ERROR ' + String(error && error.message ? error.message : error).slice(0, 400));
  exitCode = 1;
} finally {
  await context.close().catch(() => {});
  if (!keep) rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\nFAILED:${failed}  CHECKS:${checks.length}  E2E-EXIT:${exitCode}`);
}

process.exit(exitCode);
