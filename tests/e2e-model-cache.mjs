import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const browser = await chromium.launch({ headless: true });
let passed = 0;
try {
  for (const cacheAvailable of [true, false]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/ai/')) requests.push(request.url()); });
    await page.addInitScript(available => {
      localStorage.setItem('yiqi.settings', JSON.stringify({ mode: 'pvp', boardSize: 9, sound: false }));
      if (!available) Object.defineProperty(window, 'caches', { value: undefined });
    }, cacheAvailable);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.yiqi.ai.setup(() => {}));
    assert.equal(await page.evaluate(() => window.yiqi.ai.ready), true);
    assert.equal(requests.length, 5, 'four human shards + one main model, no duplicate Worker download');
    assert.equal(new Set(requests).size, 5);
    passed++; console.log(`✓ model setup uses exactly five network requests (Cache Storage: ${cacheAvailable})`);
    if (cacheAvailable) {
      const before = requests.length;
      await page.route('**/ai/**', route => route.abort());
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.yiqi.ai.ready, null, { timeout: 30000 });
      assert.equal(requests.length, before, 'cached model setup must not access static model URLs');
      passed++; console.log('✓ cached models initialize after reload with all model network requests blocked');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally { await browser.close(); }
console.log(`Model cache E2E: ${passed} passed`);
