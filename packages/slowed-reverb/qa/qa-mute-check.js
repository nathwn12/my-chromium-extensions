const { test, chromium } = require('@playwright/test');

const fixtureHtml = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>SLRA QA Fixture</title>
  </head>
  <body>
    <h1>SLRA QA Fixture</h1>
    <button id="play" type="button">Play</button>
    <button id="pause" type="button">Pause</button>
    <audio id="player" controls preload="auto"></audio>
  </body>
</html>`;

// Test 1: Initial play without muting
test('Audio plays without muting on initial load', async ({ page }) => {
  const playButton = page.locator('#play');
  const player = page.locator('#player');

  await page.route('https://www.youtube.com/watch*', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: fixtureHtml,
    });
  });

  console.log('Test 1: Loading YouTube fixture...');
  await page.goto('https://www.youtube.com/watch?v=slra-test', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  console.log('Test 1: Playing audio on initial load...');
  await playButton.click();
  await page.waitForTimeout(800);

  const audioState = await player.evaluate((el) => ({
    muted: el.muted,
    paused: el.paused,
    readyState: el.readyState,
  }));

  console.log('Test 1: Audio state:', audioState);
  expect(audioState.muted).toBe(false);
});

// Test 2: Reload and play
test('Audio does not mute on page refresh', async ({ page }) => {
  const playButton = page.locator('#play');
  const player = page.locator('#player');

  await page.route('https://www.youtube.com/watch*', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: fixtureHtml,
    });
  });

  console.log('Test 2: Loading YouTube fixture...');
  await page.goto('https://www.youtube.com/watch?v=slra-test', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  console.log('Test 2: Reloading page...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  console.log('Test 2: Playing audio after reload...');
  await playButton.click();
  await page.waitForTimeout(800);

  const audioStateAfterRefresh = await player.evaluate((el) => ({
    muted: el.muted,
    paused: el.paused,
  }));

  console.log('Test 2: Audio state after refresh:', audioStateAfterRefresh);
  expect(audioStateAfterRefresh.muted).toBe(false);
});

// Test 3: Pause, reload, then play
test('Audio resumes correctly after pause and reload', async ({ page }) => {
  const playButton = page.locator('#play');
  const pauseButton = page.locator('#pause');
  const player = page.locator('#player');

  await page.route('https://www.youtube.com/watch*', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: fixtureHtml,
    });
  });

  console.log('Test 3: Loading YouTube fixture...');
  await page.goto('https://www.youtube.com/watch?v=slra-test', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Play first
  console.log('Test 3: Playing audio initially...');
  await playButton.click();
  await page.waitForTimeout(800);

  // Pause
  console.log('Test 3: Pausing audio...');
  await pauseButton.click();
  await page.waitForTimeout(500);

  // Reload
  console.log('Test 3: Reloading page...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Play again
  console.log('Test 3: Playing audio after reload...');
  await playButton.click();
  await page.waitForTimeout(800);

  const audioStateAfterPauseReload = await player.evaluate((el) => ({
    muted: el.muted,
    paused: el.paused,
  }));

  console.log('Test 3: Audio state after pause and reload:', audioStateAfterPauseReload);
  expect(audioStateAfterPauseReload.muted).toBe(false);
});
