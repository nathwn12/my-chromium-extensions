const { chromium } = require('playwright');
const path = require('path');
const EXT_PATH = path.resolve('.');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const fixtureHtml = `<!doctype html><html><body>
<audio id="player" controls preload="auto"></audio>
<button id="play">Play</button>
<script>
const p = document.getElementById('player');
const sr = 44100, sec = 1, fc = sr * sec, buf = new ArrayBuffer(44 + fc * 2);
const v = new DataView(buf);
function w(o, t) { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
w(0, 'RIFF'); v.setUint32(4, 36 + fc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
v.setUint16(20, 1, true); v.setUint16(22, 1, true);
v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
v.setUint16(32, 2, true); v.setUint16(34, 16, true);
w(36, 'data'); v.setUint32(40, fc * 2, true);
for (let i = 0; i < fc; i++) {
  const s = Math.sin(2 * Math.PI * 440 * i / sr) * 0.2;
  v.setInt16(44 + i * 2, s * 32767, true);
}
p.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
document.getElementById('play').onclick = () => p.play();
</script></body></html>`;

  await page.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml })
  );

  console.log('=== MUTE VERIFICATION TEST ===\n');

  // Test 1: Fresh load, play audio
  console.log('1. Fresh page load...');
  await page.goto('https://www.youtube.com/watch?v=slra-test', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.locator('#play').click();
  await page.waitForTimeout(1000);

  let muted = await page.evaluate(() => document.getElementById('player').muted);
  console.log('   muted=' + muted + (muted ? ' FAIL' : ' PASS'));
  let t1pass = !muted;

  // Test 2: Page refresh, then play
  console.log('\n2. Page refresh...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.locator('#play').click();
  await page.waitForTimeout(1000);

  muted = await page.evaluate(() => document.getElementById('player').muted);
  console.log('   muted=' + muted + (muted ? ' FAIL' : ' PASS'));
  let t2pass = !muted;

  // Test 3: Pause reload play
  console.log('\n3. Pause, reload, play...');
  try { await page.locator('#pause').click(); } catch {}
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.locator('#play').click();
  await page.waitForTimeout(1000);

  muted = await page.evaluate(() => document.getElementById('player').muted);
  console.log('   muted=' + muted + (muted ? ' FAIL' : ' PASS'));
  let t3pass = !muted;

  await page.close();
  await browser.close();

  console.log('\n=== RESULTS ===');
  console.log('Test 1: ' + (t1pass ? 'PASS' : 'FAIL') + ' (fresh play)');
  console.log('Test 2: ' + (t2pass ? 'PASS' : 'FAIL') + ' (reload play)');
  console.log('Test 3: ' + (t3pass ? 'PASS' : 'FAIL') + ' (pause reload play)');
  process.exit(t1pass && t2pass && t3pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
