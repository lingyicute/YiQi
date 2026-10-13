/**
 * YiQi AI 全链路端到端测试：
 * 模型分片下载（Cache Storage）→ Worker 初始化（WASM/WebGPU）→ 人机对局出子。
 * 前置：npm run build && npm run preview。
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:4173';
let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

console.log('AI E2E @', BASE);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/* 1. 下载弹窗 → 开始下载（无 WebGPU 环境会先弹显式提示） */
const dlgVisible = await page.evaluate(() => !document.getElementById('scrim').hidden);
ok(dlgVisible, '首次访问弹出模型下载弹窗');
if (await page.evaluate(() => !!document.querySelector('#dialog [data-cmd="wg-continue"]'))) {
  const wgTitle = await page.locator('.dlg-title').textContent();
  ok(!!wgTitle && wgTitle.includes('WebGPU'), `无 WebGPU 提示弹窗（${wgTitle}）`);
  await page.locator('#dialog [data-cmd="wg-continue"]').click();
  await page.waitForTimeout(250);
}
await page.locator('#dialog [data-cmd="startdl"]').click();
await page.waitForTimeout(600);
const progVisible = await page.evaluate(() => document.getElementById('dlProgress').style.display === 'block');
ok(progVisible, '下载进度条显示');
// 等待下载+初始化完成（弹窗自动关闭；本地服务下模型 103MB 应该很快）
const t0 = Date.now();
let ready = false;
while (Date.now() - t0 < 240000) {
  const aiReady = await page.evaluate(() => window.yiqi && window.yiqi.ai && window.yiqi.ai.ready);
  const dlgStill = await page.evaluate(() => !document.getElementById('scrim').hidden);
  if (aiReady && !dlgStill) { ready = true; break; }
  await page.waitForTimeout(1000);
}
ok(ready, `模型下载并初始化完成（${Math.round((Date.now() - t0) / 1000)}s）`);
if (!ready) {
  const pct = await page.locator('#dlPercent').textContent().catch(() => '?');
  const spd = await page.locator('#dlSpeed').textContent().catch(() => '?');
  console.error('    进度：', pct, spd);
}
const backend = await page.evaluate(() => window.yiqi.ai.backendName);
console.log('  · AI 后端：', backend);
const aiChipsLocked = await page.locator('#modes .chip[data-mode="ai-easy"].locked').count();
ok(aiChipsLocked === 0, '人机 chips 解锁');

/* 2. 9 路人机对局（简单）：人类执黑落子 → AI 应答 */
await page.locator('#sizes .chip[data-size="9"]').click();
await page.waitForTimeout(200);
await page.locator('#modes .chip[data-mode="ai-easy"]').click();
await page.waitForTimeout(300);
ok(await page.evaluate(() => window.yiqi.mode) === 'ai-easy', '选择简单难度');
ok(await page.evaluate(() => window.yiqi.game.size) === 9, '9 路棋盘');

const box = await page.locator('#board').boundingBox();
const cellAt = (gx, gy) => {
  const m = box.width * 0.062, g = (box.width - 2 * m) / 8;
  return { x: box.x + m + gx * g, y: box.y + m + gy * g };
};
await page.mouse.click(cellAt(2, 2).x, cellAt(2, 2).y); // 黑 C7
await page.waitForTimeout(300);
ok(await page.evaluate(() => window.yiqi.aiThinking) === true, 'AI 进入思考状态');
// AI 延迟 1~10s + 引擎时间，等待落子
const t1 = Date.now();
let aiMoved = false;
while (Date.now() - t1 < 180000) {
  if (!(await page.evaluate(() => window.yiqi.aiThinking))) { aiMoved = true; break; }
  await page.waitForTimeout(1000);
}
ok(aiMoved, `AI 应答完成（${Math.round((Date.now() - t1) / 1000)}s）`);
const moves = await page.evaluate(() => window.yiqi.game.moveNumber);
ok(moves >= 2, `AI 已落子（当前 ${moves} 手）`);
const aiMove = await page.evaluate(() => window.yiqi.game.moves[1]);
ok(!!aiMove && aiMove.x >= 0, `AI 着法有效（${aiMove ? `(${aiMove.x},${aiMove.y})` : 'null'}）`);

/* 3. 再下一手：连续对弈稳定 */
await page.waitForTimeout(500);
const toMoveHuman = await page.evaluate(() => window.yiqi.game.playerToMove === 'black');
ok(toMoveHuman, '轮到人类（黑）');
await page.mouse.click(cellAt(3, 3).x, cellAt(3, 3).y);
const t2 = Date.now();
let aiMoved2 = false;
while (Date.now() - t2 < 180000) {
  if (!(await page.evaluate(() => window.yiqi.aiThinking))) { aiMoved2 = true; break; }
  await page.waitForTimeout(1000);
}
ok(aiMoved2, 'AI 第二次应答');
ok(await page.evaluate(() => window.yiqi.game.moveNumber) >= 4, '对局推进到第 4 手');

/* 4. 悔棋撤两手 */
await page.locator('#btnUndo').click();
await page.waitForTimeout(300);
ok(await page.evaluate(() => window.yiqi.game.moveNumber) === 2, '悔棋撤回到第 2 手');

/* 5. 缓存命中：刷新后不再弹下载窗 */
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const dlgAfterReload = await page.evaluate(() => !document.getElementById('scrim').hidden);
ok(!dlgAfterReload, '刷新后模型走缓存，不弹下载窗');
const cached = await page.evaluate(async () => {
  const c = await caches.open('yiqi-models-v2');
  const keys = await c.keys();
  return keys.length;
});
ok(cached >= 5, `Cache Storage 已缓存 ${cached} 个模型文件`);

const realErrors = errors.filter((e) => !e.includes('favicon'));
ok(realErrors.length === 0, `无页面错误（${realErrors.length}）`);
if (realErrors.length) console.error(realErrors.slice(0, 6));

await page.screenshot({ path: path.resolve(__dirname, '../e2e-screenshots/ai-game.png') });
await browser.close();
console.log(`\nAI E2E 结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
