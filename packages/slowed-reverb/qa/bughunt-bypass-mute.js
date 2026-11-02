// Temp bug-hunt probe (qa/ is gitignored). Uses launchPersistentContext because an
// unpacked extension does NOT load under chromium.launch — the repo's mute tests
// therefore pass even when the extension is entirely absent.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT_PATH = path.resolve(__dirname, '..');

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>BypassMute</title></head><body>
<button id="play">Play</button>
<button id="mutate">Mutate</button>
<audio id="player" controls preload="auto"></audio>
<script>
const p = document.getElementById('player');
const sr = 44100, fc = sr * 2, buf = new ArrayBuffer(44 + fc * 2), v = new DataView(buf);
const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
w(0,'RIFF'); v.setUint32(4,36+fc*2,true); w(8,'WAVE'); w(12,'fmt ');
v.setUint32(16,16,true);
v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,sr,true); v.setUint32(28,sr*2,true);
v.setUint16(32,2,true); v.setUint16(34,16,true); w(36,'data'); v.setUint32(40,fc*2,true);
for (let i=0;i<fc;i++) v.setInt16(44+i*2, Math.sin(2*Math.PI*440*i/sr)*0.2*32767, true);
p.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
document.getElementById('play').onclick = () => p.play();
document.getElementById('mutate').onclick = () => { document.body.appendChild(document.createElement('div')); };
</script></body></html>`;

(async () => {
  const HEADLESS = process.env.HEADLESS !== '0';
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slra-probe-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.PW_CHANNEL || 'chrome',
    headless: HEADLESS,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  const page = context.pages()[0] || await context.newPage();

  const isExtSW = w => w.url().startsWith('chrome-extension://');
  let sw = context.serviceWorkers().find(isExtSW) || null;
  for (let i = 0; !sw && i < 40; i++) {
    try { sw = await context.waitForEvent('serviceworker', { predicate: isExtSW, timeout: 500 }); } catch { /* retry */ }
  }
  if (sw) console.log('extension service worker:', sw.url());
  else console.log('WARNING: no extension service worker found');

  await page.route('https://www.youtube.com/watch*', r => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }));
  await page.goto('https://www.youtube.com/watch?v=slra-bypass', { waitUntil: 'domcontentloaded' });
  await page.locator('#player').waitFor();

  if (!sw) {
    for (let i = 0; !sw && i < 20; i++) {
      try { sw = await context.waitForEvent('serviceworker', { predicate: isExtSW, timeout: 500 }); } catch { /* retry */ }
    }
  }
  if (!sw) { await context.close(); throw new Error('extension service worker never started'); }

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: ['https://www.youtube.com/*'] }))[0]?.id ?? null);
  const extId = new URL(sw.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const send = msg => popup.evaluate(m => chrome.runtime.sendMessage(m), msg);
  const readMuted = () => page.locator('#player').evaluate(el => el.muted);
  const live = () => popup.evaluate(async id => await chrome.tabs.sendMessage(id, { type: 'GET_LIVE_STATUS' }).catch(e => ({ err: String(e) })), tabId);

  await page.locator('#play').click();
  await page.waitForTimeout(300);
  console.log('media state:', JSON.stringify(await page.locator('#player').evaluate(el => ({
    paused: el.paused, ended: el.ended, readyState: el.readyState,
    currentSrc: el.currentSrc, muted: el.muted, volume: el.volume,
    error: el.error && el.error.message, duration: el.duration, currentTime: el.currentTime,
  }))));
  await page.evaluate(() => document.getElementById('player').dispatchEvent(new Event('playing')));
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300);
    const s = await live();
    if (s && s.attachedCount > 0) break;
  }
  console.log('live after play:', JSON.stringify(await live()));
  await page.locator('#player').evaluate(el => { el.muted = true; });
  await page.locator('#mutate').click();
  await page.waitForTimeout(600);
  const activeMuted = await readMuted();

  const bypassRes = await send({ type: 'SET_TAB_BYPASS', tabId, bypass: true });
  await page.waitForTimeout(500);
  const afterBypassMuted = await readMuted();
  console.log('bypass result:', JSON.stringify(bypassRes));
  console.log('live after bypass:', JSON.stringify(await live()));

  await page.locator('#player').evaluate(el => { el.muted = true; });
  const immediatelyAfterUserMute = await readMuted();

  await page.locator('#mutate').click();
  await page.waitForTimeout(700);
  const afterMutationMuted = await readMuted();

  const pass = immediatelyAfterUserMute === true && afterMutationMuted === true;
  console.log(JSON.stringify({
    tabId,
    bypassOk: bypassRes && bypassRes.ok,
    activeMuted,
    powerOffUnmutesPreviouslyAttached: afterBypassMuted === false,
    immediatelyAfterUserMute,
    afterMutationMuted,
    pass,
    verdict: pass
      ? 'FIX VERIFIED: bypass/off sync leaves the page mute untouched'
      : 'FAIL: bypass/off sync still clears the page mute',
  }, null, 2));
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
