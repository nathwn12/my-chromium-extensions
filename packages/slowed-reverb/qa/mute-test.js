// @ts-check
const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>SLRA QA</title></head><body>
<button id="play">Play</button><button id="pause">Pause</button>
<audio id="player" controls preload="auto"></audio>
<script>
const player = document.getElementById('player');
function makeTone(freq) {
  const sr = 44100, sec = 8, fc = sr * sec, buf = new ArrayBuffer(44 + fc * 2);
  const v = new DataView(buf);
  const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
  w(0, 'RIFF'); v.setUint32(4, 36 + fc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, fc * 2, true);
  for (let i = 0; i < fc; i++) {
    const s = Math.sin(2 * Math.PI * freq * i / sr) * 0.2;
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
player.src = makeTone(440);
document.getElementById('play').onclick = () => player.play();
document.getElementById('pause').onclick = () => player.pause();
</script></body></html>`;

  const ctx = browser.newContext();
  const page = await (await ctx).newPage();

  await page.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml })
  );

  console.log('=== MUTE TEST ===\n');

  // Test 1: Fresh load, play audio
  console.log('1. Fresh page load...');
  await page.goto('https://www.youtube.com/watch?v=slra-test', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.locator('#play').click();
  await page.waitForTimeout(800);

  let state = await page.evaluate(() => ({ muted: document.getElementById('player').muted, paused: document.getElementById('player').paused }));
  console.log('   After play: muted=%s paused=%s', state.muted, state.paused);
  console.log(state.muted ? '   ❌ MUTED - BUG' : '   ✅ NOT muted - OK');

  // Test 2: Page refresh, then play
  console.log('\n2. Page refresh...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.locator('#play').click();
  await page.waitForTimeout(800);

  state = await page.evaluate(() => ({ muted: document.getElementById('player').muted, paused: document.getElementById('player').paused }));
  console.log('   After play: muted=%s paused=%s', state.muted, state.paused);
  console.log(state.muted ? '   ❌ MUTED - BUG' : '   ✅ NOT muted - OK');

  // Test 3: Pause, reload, play
  console.log('\n3. Pause, reload, play...');
  await page.locator('#pause').click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.locator('#play').click();
  await page.waitForTimeout(800);

  state = await page.evaluate(() => ({ muted: document.getElementById('player').muted, paused: document.getElementById('player').paused }));
  console.log('   After play: muted=%s paused=%s', state.muted, state.paused);
  console.log(state.muted ? '   ❌ MUTED - BUG' : '   ✅ NOT muted - OK');

  await browser.close();
  console.log('\n=== TEST COMPLETE ===');
  process.exit(0);
})();
