async page => {
  const context = page.context();
  const fixtureHtml = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>SLRA QA Fixture</title>
      <style>
        body { font-family: sans-serif; margin: 24px; }
        button { margin-right: 12px; }
      </style>
    </head>
    <body>
      <h1>SLRA QA Fixture</h1>
      <button id="play" type="button">Play</button>
      <button id="pause" type="button">Pause</button>
      <button id="next" type="button">Next</button>
      <audio id="player" controls preload="auto"></audio>
      <script>
        const player = document.getElementById('player');
        function makeToneUrl(freq) {
          const sampleRate = 44100;
          const seconds = 8;
          const frameCount = Math.floor(sampleRate * seconds);
          const dataSize = frameCount * 2;
          const buffer = new ArrayBuffer(44 + dataSize);
          const view = new DataView(buffer);

          function writeAscii(offset, text) {
            for (let index = 0; index < text.length; index += 1) {
              view.setUint8(offset + index, text.charCodeAt(index));
            }
          }

          writeAscii(0, 'RIFF');
          view.setUint32(4, 36 + dataSize, true);
          writeAscii(8, 'WAVE');
          writeAscii(12, 'fmt ');
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, sampleRate, true);
          view.setUint32(28, sampleRate * 2, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          writeAscii(36, 'data');
          view.setUint32(40, dataSize, true);

          for (let index = 0; index < frameCount; index += 1) {
            const time = index / sampleRate;
            const amplitude = Math.sin(2 * Math.PI * freq * time) * 0.2;
            view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, amplitude)) * 32767, true);
          }

          return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
        }

        const toneA = makeToneUrl(440);
        const toneB = makeToneUrl(660);
        player.src = toneA;

        document.getElementById('play').addEventListener('click', () => {
          void player.play();
        });

        document.getElementById('pause').addEventListener('click', () => {
          player.pause();
        });

        document.getElementById('next').addEventListener('click', () => {
          player.src = player.src === toneA ? toneB : toneA;
          player.load();
        });
      </script>
    </body>
  </html>`;

  await page.route('https://www.youtube.com/watch*', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: fixtureHtml,
  }));

  await page.goto('https://www.youtube.com/watch?v=slra-fixture', { waitUntil: 'domcontentloaded' });
  await page.locator('#player').waitFor();

  const ensureServiceWorker = async () => {
    const existing = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'));
    if (existing) return existing;
    return await context.waitForEvent('serviceworker', worker => worker.url().startsWith('chrome-extension://'), { timeout: 15000 });
  };

  const serviceWorker = await ensureServiceWorker();
  const extensionId = serviceWorker.url().replace(/^chrome-extension:\/\//, '').split('/')[0];
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popup.locator('#slow-slider').waitFor();

  const tabId = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*'] });
    return tabs[0]?.id ?? null;
  });

  if (!tabId) {
    throw new Error('Could not locate the YouTube fixture tab.');
  }

  const popupState = await popup.evaluate(async targetTabId => {
    return await chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE', tabId: targetTabId });
  }, tabId);

  await popup.evaluate(async ({ targetTabId, siteKey, settings }) => {
    return await chrome.runtime.sendMessage({
      type: 'SET_SITE_SETTINGS',
      tabId: targetTabId,
      siteKey,
      settings,
      persist: false,
    });
  }, {
    targetTabId: tabId,
    siteKey: popupState.siteKey,
    settings: { ...popupState.settings, slow: 0.8 },
  });

  const getLive = async () => {
    return await popup.evaluate(async targetTabId => {
      return await chrome.tabs.sendMessage(targetTabId, { type: 'GET_LIVE_STATUS' });
    }, tabId);
  };

  const getStatus = async label => {
    await popup.waitForTimeout(1200);
    const live = await getLive();
    const media = await page.locator('#player').evaluate(element => ({
      muted: element.muted,
      paused: element.paused,
      readyState: element.readyState,
      currentSrc: element.currentSrc,
      currentTime: element.currentTime,
    }));
    return { label, live, media };
  };

  const beforePlay = await getStatus('beforePlay');

  await page.locator('#play').click();
  await page.waitForTimeout(800);
  const afterPlay = await getStatus('afterPlay');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#player').waitFor();
  const afterRefresh = await getStatus('afterRefreshBeforePlay');

  await page.locator('#play').click();
  await page.waitForTimeout(500);
  await page.locator('#next').click();
  await page.waitForTimeout(300);
  const afterNext = await getStatus('afterNextBeforePlay');

  const result = {
    extensionId,
    tabId,
    beforePlay,
    afterPlay,
    afterRefresh,
    afterNext,
    failingChecks: {
      attachedBeforePlay: beforePlay.live?.attachedCount !== 0,
      attachedAfterRefreshBeforePlay: afterRefresh.live?.attachedCount !== 0,
      attachedAfterNextBeforePlay: afterNext.live?.attachedCount !== 0,
      didNotAttachAfterPlay: afterPlay.live?.attachedCount !== 1,
    },
  };

  await popup.close();
  return result;
}
