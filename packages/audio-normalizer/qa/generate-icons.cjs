const fs = require('node:fs');
const path = require('node:path');
const { chromium } = loadPlaywright();

// Resolve Playwright normally first; TN_PLAYWRIGHT_PATH is the env override.
// No machine-specific default paths.
function loadPlaywright() {
  const candidates = ['playwright', process.env.TN_PLAYWRIGHT_PATH].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error('Playwright install not found. Set TN_PLAYWRIGHT_PATH or install playwright as a dependency.');
}

const sizes = [16, 32, 48, 128];
const outDir = path.resolve(__dirname, '..', 'audio');

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0a0a0a"/>
  <path d="M ${size * 0.06} 0 L ${size * 0.94} 0 L ${size} ${size * 0.06} L ${size} ${size * 0.94} L ${size * 0.94} ${size} L ${size * 0.06} ${size} L 0 ${size * 0.94} L 0 ${size * 0.06} Z" fill="none" stroke="#00e5ff" stroke-width="${Math.max(1, size * 0.023)}"/>
  <rect x="${size * 0.26}" y="${size * 0.44}" width="${size * 0.11}" height="${size * 0.31}" rx="${size * 0.02}" fill="#00e5ff"/>
  <rect x="${size * 0.445}" y="${size * 0.28}" width="${size * 0.11}" height="${size * 0.47}" rx="${size * 0.02}" fill="#00e5ff"/>
  <rect x="${size * 0.63}" y="${size * 0.38}" width="${size * 0.11}" height="${size * 0.37}" rx="${size * 0.02}" fill="#00e5ff"/>
</svg>`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const size of sizes) {
    const svgContent = svg(size);
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svgContent).toString('base64');
    await page.setContent(`
      <html><body style="margin:0;padding:0;">
        <img src="${dataUrl}" width="${size}" height="${size}">
      </body></html>
    `);
    const img = page.locator('img');
    await img.waitFor();
    await page.waitForTimeout(50);
    const buffer = await img.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buffer);
    console.log(`Generated icon-${size}.png`);
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
