import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const browser = await chromium.launch({ headless: true });
let passed = 0, failed = 0;
const session = { mode: 'pvp', side: 'B', size: 9, moves: [{ x: 1, y: 1 }, { x: -1, y: -1 }, { x: -1, y: -1 }], elapsed: 12, over: false };
async function test(name, run, options = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  try {
    await page.addInitScript(({ settings, save }) => {
      // These are deterministic UI tests, not a substitute for e2e-ai.mjs.
      Object.defineProperty(window, 'WebAssembly', { value: undefined });
      if (!sessionStorage.getItem('fixture-installed')) {
        localStorage.setItem('yiqi.settings', JSON.stringify(settings));
        if (save) localStorage.setItem('yiqi.session', JSON.stringify(save));
        sessionStorage.setItem('fixture-installed', '1');
      }
    }, { settings: options.settings ?? { mode: 'pvp', boardSize: 9, sound: false }, save: options.save });
    await page.goto(BASE);
    await page.waitForFunction(() => window.yiqi, null, { timeout: 5000 });
    await run(page);
    assert.deepEqual(errors, [], 'no uncaught browser exceptions');
    passed++; console.log(`✓ ${name}`);
  } catch (err) {
    failed++; console.error(`✗ ${name}: ${err.message}`);
  } finally { await page.close(); }
}

try {
  await test('malformed settings fall back to supported board and mode', async page => {
    assert.equal(await page.evaluate(() => window.yiqi.game.size), 19);
    assert.equal(await page.evaluate(() => window.yiqi.mode), 'ai-hard');
  }, { settings: { boardSize: 0, mode: '__proto__' } });

  await test('null move in saved JSON cannot crash startup', async page => {
    assert.equal(await page.evaluate(() => window.yiqi.game.moveNumber), 0);
  }, { save: { ...session, moves: [null] } });

  await test('scoring phase and manual dead stones survive reload with timer stopped', async page => {
    await page.evaluate(() => {
      const app = window.yiqi;
      app.humanPlace(1, 1); app.humanPlace(-1, -1); app.humanPlace(-1, -1);
      app.toggleDeadAt(1, 1); app.saveSession();
    });
    await page.reload();
    assert.deepEqual(await page.evaluate(() => ({ phase: window.yiqi.phase, removed: [...window.yiqi.game.removedPoints()], timer: window.yiqi.timerRunning })), { phase: 'scoring', removed: [10], timer: false });
  });

  await test('legacy two-pass save restores scoring', async page => {
    assert.equal(await page.evaluate(() => window.yiqi.phase), 'scoring');
  }, { save: session });

  await test('explicit resumed play phase is not inferred as scoring on reload', async page => {
    await page.evaluate(() => { window.yiqi.resumeFromScoring(); window.yiqi.saveSession(); });
    await page.reload();
    assert.equal(await page.evaluate(() => window.yiqi.phase), 'play');
  }, { save: { ...session, phase: 'scoring' } });

  await test('resuming on AI turn schedules the AI', async page => {
    const calls = await page.evaluate(async () => {
      const app = window.yiqi; app.enterScoring(false);
      app.mode = 'ai-hard'; app.humanColor = 1;
      Object.defineProperty(app.ai, 'ready', { get: () => true });
      let calls = 0;
      app.ai.chooseMove = async () => { calls++; return { x: 3, y: 3, isPass: false }; };
      app.resumeFromScoring();
      await Promise.resolve(); await Promise.resolve();
      return calls;
    });
    assert.equal(calls, 1);
  }, { save: { ...session, phase: 'scoring' } });

  await test('late ownership never overrides manual dead-stone decisions', async page => {
    assert.equal(await page.evaluate(async () => {
      const app = window.yiqi; app.enterScoring(false);
      let resolve;
      app.ai.finalOwnership = () => new Promise(r => { resolve = r; });
      const pending = app.autoMarkDead();
      app.toggleDeadAt(1, 1); app.toggleDeadAt(1, 1);
      resolve(new Float32Array(81).fill(-1)); await pending;
      return app.game.isRemoved(1, 1);
    }), false);
  }, { save: { ...session, phase: 'scoring' } });

  await test('late ownership from an old game cannot mark stones in a new scoring game', async page => {
    assert.equal(await page.evaluate(async () => {
      const app = window.yiqi; app.enterScoring(false);
      let resolve;
      app.ai.finalOwnership = () => new Promise(r => { resolve = r; });
      const pending = app.autoMarkDead();
      app.newGame(); app.humanPlace(1, 1); app.humanPlace(-1, -1); app.humanPlace(-1, -1);
      resolve(new Float32Array(81).fill(-1)); await pending;
      return app.game.isRemoved(1, 1);
    }), false);
  }, { save: { ...session, phase: 'scoring' } });

  await test('new game exits scoring controls and clears out-of-range hover', async page => {
    assert.deepEqual(await page.evaluate(() => {
      const app = window.yiqi; app.enterScoring(false); app.renderer.hover = { x: 18, y: 18 }; app.newGame();
      return { controls: document.getElementById('scoringActions').style.display, hover: app.renderer.hover };
    }), { controls: 'none', hover: null });
    await page.waitForTimeout(50);
  }, { save: { ...session, phase: 'scoring' } });

  await test('resignation stops timer and exports a standard SGF result', async page => {
    assert.deepEqual(await page.evaluate(async () => {
      const app = window.yiqi; app.humanPlace(1, 1); app.confirmResign();
      let output;
      const original = URL.createObjectURL;
      const click = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = blob => { output = blob; return 'blob:test'; };
      HTMLAnchorElement.prototype.click = () => {};
      try { app.exportSGF(); } finally { URL.createObjectURL = original; HTMLAnchorElement.prototype.click = click; }
      return { stopped: !app.timerRunning, result: (await output.text()).includes('RE[B+R]') };
    }), { stopped: true, result: true });
  });

  await test('scored game exports standard numeric SGF result', async page => {
    assert.equal(await page.evaluate(async () => {
      const app = window.yiqi; app.enterScoring(false); app.confirmScore();
      let output;
      const original = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = blob => { output = blob; return 'blob:test'; };
      HTMLAnchorElement.prototype.click = () => {};
      try { app.exportSGF(); } finally { URL.createObjectURL = original; HTMLAnchorElement.prototype.click = click; }
      return /RE\[[BW]\+\d+(?:\.\d+)?\]/.test(await output.text());
    }), true);
  }, { save: { ...session, phase: 'scoring' } });

  await test('delayed game-over dialog cannot pop over a new game', async page => {
    await page.evaluate(() => { const app = window.yiqi; app.humanPlace(1, 1); app.confirmResign(); app.newGame(); });
    await page.waitForTimeout(750);
    assert.equal(await page.evaluate(() => window.yiqi.dialogOpen), false);
  });

  await test('download completion cannot touch or close a replacement dialog', async page => {
    assert.equal(await page.evaluate(async () => {
      const app = window.yiqi;
      app.openDialog('<div id="dlProgress"></div><button id="btnStartDl"></button><span id="dlPercent"></span><span id="dlSpeed"></span><span id="dlBytes"></span><i id="dlBarFill"></i>');
      let release, progress;
      app.ai.setup = cb => { progress = cb; return new Promise(r => { release = r; }); };
      const task = app.startDownload();
      app.showHelp(); progress(1, 2, 1); release(); await task;
      return app.dialogOpen && document.querySelector('.dlg-title').textContent.includes('规则说明');
    }), true);
  });
} finally {
  await browser.close();
}
console.log(`UI regression E2E: ${passed} passed / ${failed} failed`);
process.exitCode = failed ? 1 : 0;
