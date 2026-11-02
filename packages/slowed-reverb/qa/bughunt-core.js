// Temp bug-hunt probe 2 (qa/ is gitignored): exercise the core pipeline + power toggle
// + sticky persistence with a decodable fixture, under a real extension load.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT_PATH = path.resolve(__dirname, '..');

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Core</title></head><body>
<button id="play">Play</button>
<audio id="player" controls preload="auto"></audio>
<script>
const p = document.getElementById('player');
const sr = 44100, fc = sr * 8, buf = new ArrayBuffer(44 + fc * 2), v = new DataView(buf);
const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
w(0,'RIFF'); v.setUint32(4,36+fc*2,true); w(8,'WAVE'); w(12,'fmt ');
v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
w(36,'data'); v.setUint32(40,fc*2,true);
for (let i=0;i<fc;i++) v.setInt16(44+i*2, Math.sin(2*Math.PI*440*i/sr)*0.2*32767, true);
p.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
document.getElementById('play').onclick = () => p.play();
</script></body></html>`;

(async () => {
  const HEADLESS = process.env.HEADLESS !== '0';
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slra-core-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.PW_CHANNEL || 'chromium',
    headless: HEADLESS,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  const page = context.pages()[0] || await context.newPage();
  const isExtSW = w => w.url().startsWith('chrome-extension://');
  let sw = null;
  for (let i = 0; !sw && i < 40; i++) {
    sw = context.serviceWorkers().find(isExtSW) || null;
    if (!sw) { try { sw = await context.waitForEvent('serviceworker', { predicate: isExtSW, timeout: 500 }); } catch { /* retry */ } }
  }
  if (!sw) throw new Error('no extension SW');
  const extId = new URL(sw.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const send = msg => popup.evaluate(m => chrome.runtime.sendMessage(m), msg);

  await page.route('https://www.youtube.com/watch*', r => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }));
  await page.goto('https://www.youtube.com/watch?v=slra-core', { waitUntil: 'domcontentloaded' });
  await page.locator('#player').waitFor();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: ['https://www.youtube.com/*'] }))[0]?.id ?? null);

  const live = () => popup.evaluate(id => chrome.tabs.sendMessage(id, { type: 'GET_LIVE_STATUS' }).catch(e => ({ err: String(e) })), tabId);
  const media = () => page.locator('#player').evaluate(el => ({ muted: el.muted, rate: el.playbackRate, paused: el.paused }));
  const waitAttached = async (want) => {
    for (let i = 0; i < 25; i++) {
      const s = await live();
      if (s && (s.attachedCount > 0) === want) return s;
      await page.waitForTimeout(200);
    }
    return await live();
  };

  const out = {};

  // non-neutral settings
  out.setNonNeutral = await send({ type: 'SET_SITE_SETTINGS', tabId, siteKey: 'www.youtube.com', settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await page.locator('#play').click();
  await page.waitForTimeout(500);
  out.afterPlayLive = await waitAttached(true);
  out.afterPlayMedia = await media();

  // power off
  out.powerOff = await send({ type: 'SET_TAB_BYPASS', tabId, bypass: true });
  out.afterOffLive = await waitAttached(false);
  await page.waitForTimeout(300);
  out.afterOffMedia = await media();

  // power on again
  out.powerOn = await send({ type: 'SET_TAB_BYPASS', tabId, bypass: false });
  out.afterOnLive = await waitAttached(true);
  out.afterOnMedia = await media();

  // reload with stored site settings (sticky)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#player').waitFor();
  await page.locator('#play').click();
  await page.waitForTimeout(500);
  out.afterReloadLive = await waitAttached(true);
  out.afterReloadMedia = await media();

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
