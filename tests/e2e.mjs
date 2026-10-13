/**
 * YiQi 浏览器端到端测试（零构建，直接跑 dist 产物）。
 * 前置：npm run build && npm run preview（或任意静态服务器，需 COOP/COEP）。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:4173';
let passed = 0;
let failed = 0;
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

console.log('E2E @', BASE);

/* 1. 页面加载 */
await page.goto(BASE, { waitUntil: 'networkidle' });
ok(await page.title().then((t) => t.includes('YiQi')), '标题包含 YiQi');
ok(await page.locator('header .brand-name').textContent().then((t) => t?.trim() === 'YiQi'), '顶栏品牌名');
ok(await page.locator('#board').isVisible(), '棋盘画布可见');
ok(await page.locator('#modes .chip[data-mode="ai-easy"]').isVisible(), '四个难度 chips');
ok(await page.locator('#modes .chip[data-mode="pvp"]').isVisible(), '双人 chip');
ok(await page.locator('#sizes .chip[data-size="9"]').isVisible(), '9/13/19 路 chips');
ok(await page.locator('#sides .chip[data-side="B"]').isVisible(), '执子 chips');
ok(await page.locator('#btnPass').isVisible(), '停一手按钮');

/* 2. 防闪烁脚本与主题 */
const theme = await page.evaluate(() => document.documentElement.dataset.theme);
ok(theme === 'dark' || theme === 'light', `主题已设置（${theme}）`);

/* 3. 初始状态：AI 未就绪时 chips 锁定或就绪（无模型缓存时弹下载窗） */
await page.waitForTimeout(1200);
const dlgVisible = await page.evaluate(() => !document.getElementById('scrim').hidden);
console.log(dlgVisible ? '  · 下载弹窗已自动弹出（无模型缓存）' : '  · 无下载弹窗（AI 已就绪或缓存命中）');
if (dlgVisible) {
  const hasWgNotice = await page.evaluate(() => !!document.querySelector('#dialog [data-cmd="wg-continue"]'));
  ok(await page.locator('#dialog .dlg-title').textContent()
    .then((t) => (hasWgNotice ? t?.includes('WebGPU') : t?.includes('AI 模型'))),
    hasWgNotice ? '首访弹 WebGPU 提示弹窗' : '下载弹窗标题');
  // 跳过下载 → 自动切双人 + AI chips 置灰
  await page.locator('#dialog [data-cmd="skipdl"]').click();
  await page.waitForTimeout(200);
  const locked = await page.locator('#modes .chip[data-mode="ai-easy"].locked').count();
  ok(locked === 1, '跳过后人机 chips 置灰');
  ok(await page.evaluate(() => window.yiqi.mode) === 'pvp', '跳过后自动切换到双人模式');
  ok(await page.locator('#modes .chip[data-mode="pvp"]').getAttribute('class').then((c) => c?.includes('sel')), '跳过后双人 chip 选中');
  ok(await page.evaluate(() => document.getElementById('sides').style.display === 'none'), '跳过后执子选择区隐藏');
}

/* 4. 双人对战：落子、提子显示、停一手、悔棋 */
await page.locator('#modes .chip[data-mode="pvp"]').click();
await page.waitForTimeout(300);
ok(await page.locator('#modes .chip[data-mode="pvp"]').getAttribute('class').then((c) => c?.includes('sel')), '双人模式选中');
const subtitle = await page.locator('#subtitle').textContent();
ok(subtitle?.includes('双人') || subtitle?.includes('同屏'), `副标题更新（${subtitle}）`);

// 点星位 (4,4)：棋盘中心。canvas 逻辑坐标换算
const boardBox = await page.locator('#board').boundingBox();
const cellAt = (gx, gy) => {
  const m = boardBox.width * 0.062;
  const g = (boardBox.width - 2 * m) / 18;
  return { x: boardBox.x + m + gx * g, y: boardBox.y + m + gy * g };
};
await page.mouse.click(cellAt(4, 4).x, cellAt(4, 4).y);
await page.waitForTimeout(100);
let moveLabel = await page.locator('#moveLabel').textContent();
ok(moveLabel?.includes('第 2 手'), `黑棋落子后手数推进（${moveLabel}）`);
await page.mouse.click(cellAt(4, 5).x, cellAt(4, 5).y);
await page.waitForTimeout(100);
moveLabel = await page.locator('#moveLabel').textContent();
ok(moveLabel?.includes('第 3 手'), `白棋落子后手数推进（${moveLabel}）`);

// 悔棋
await page.locator('#btnUndo').click();
await page.waitForTimeout(100);
moveLabel = await page.locator('#moveLabel').textContent();
ok(moveLabel?.includes('第 2 手'), `悔棋回退一手（${moveLabel}）`);
// 回归：GoGame.undo 内部重建引擎并更换 board 数组引用，渲染器必须重新同步，
// 否则棋子残留在画面上而逻辑认为已撤销（幽灵棋子，无法继续落子）
ok(await page.evaluate(() => window.yiqi.renderer.state.board === window.yiqi.game.board), '悔棋后渲染器与逻辑棋盘同一引用');
ok(await page.evaluate(() => window.yiqi.renderer.state.board.flat().filter((v) => v !== 0).length) === 1, '悔棋后画面棋子数与逻辑一致');

// 停一手（白）
await page.locator('#btnPass').click();
await page.waitForTimeout(100);
moveLabel = await page.locator('#moveLabel').textContent();
ok(moveLabel?.includes('第 3 手'), `停一手后手数推进（${moveLabel}）`);
ok(await page.evaluate(() => document.getElementById('scoringActions').style.display === 'none'), '单次停一手不进入计分');

/* 5. 双人完整终局：黑也停一手 → 计分 → 确认结果 */
await page.locator('#btnPass').click();
await page.waitForTimeout(200);
const scoringVisible = await page.evaluate(() => document.getElementById('scoringActions').style.display !== 'none');
ok(scoringVisible, '双方连续停一手进入计分');
// 继续对局 → 再停一手（棋谱仍以两手停一手结尾，故立即再次进入计分）→ 确认
await page.locator('#btnResume').click();
await page.waitForTimeout(150);
ok(await page.evaluate(() => document.getElementById('scoringActions').style.display === 'none'), '继续对局回到对局状态');
await page.locator('#btnPass').click();
await page.waitForTimeout(200);
ok(await page.evaluate(() => document.getElementById('scoringActions').style.display !== 'none'), '恢复后再次进入计分');
const scoreInfo = await page.locator('#scoreInfo').textContent();
ok(!!scoreInfo && scoreInfo.includes('黑'), `实时数子显示（${scoreInfo}）`);
await page.locator('#btnConfirmScore').click();
await page.waitForTimeout(900);
const dlgTitle = await page.locator('#dialog .dlg-title').textContent();
ok(!!dlgTitle && dlgTitle.length > 0, `终局对话框弹出（${dlgTitle}）`);
await page.screenshot({ path: path.resolve(__dirname, '../e2e-screenshots/game-over.png') });
await page.locator('#dialog [data-cmd="ok"]').click();

/* 6. 菜单与对话框 */
await page.locator('#btnMenu').click();
await page.locator('.menu-item[data-act="help"]').click();
ok(await page.locator('#dialog .dlg-title').textContent().then((t) => t?.includes('规则说明')), '规则说明对话框');
await page.keyboard.press('Escape');
await page.locator('#btnMenu').click();
await page.locator('.menu-item[data-act="records"]').click();
ok(await page.locator('#dialog .dlg-title').textContent().then((t) => t?.includes('战绩')), '战绩对话框');
{
  const body = await page.locator('.dlg-body').textContent();
  const recBody = await page.locator('#dialog .dlg-body').textContent();
  ok(!!recBody && !recBody.includes('你执黑') && !recBody.includes('你执白'), '战绩不再按执黑/执白分栏');
}
await page.locator('#dialog [data-cmd="ok"]').click();
await page.keyboard.press('Escape');

/* 7. 配色 */
await page.locator('#btnPalette').click();
await page.locator('.swatch[data-accent="teal"]').click();
await page.waitForTimeout(150);
ok(await page.evaluate(() => document.documentElement.dataset.accent === 'teal'), '切换配色 teal');
await page.keyboard.press('Escape');

/* 8. 棋盘尺寸切换（9 路） */
await page.locator('#sizes .chip[data-size="9"]').click();
await page.waitForTimeout(300);
const sizeLabel = await page.locator('#moveLabel').textContent();
ok(!!sizeLabel, `9 路新对局（${sizeLabel}）`);
const sizeSel = await page.locator('#sizes .chip[data-size="9"]').getAttribute('class');
ok(sizeSel?.includes('sel'), '9 路选中');

/* 9. 窄视口自适应 */
await page.setViewportSize({ width: 390, height: 760 });
await page.waitForTimeout(400);
const bw = await page.locator('#board').boundingBox();
ok(!!bw && bw.width <= 390 && bw.width > 240, `窄屏棋盘缩放（${Math.round(bw?.width || 0)}px）`);
ok(await page.evaluate(() => document.querySelector('main').clientWidth <= 420), '窄屏单列布局');
await page.screenshot({ path: path.resolve(__dirname, '../e2e-screenshots/mobile.png') });
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(400);
const bw2 = await page.locator('#board').boundingBox();
ok(!!bw2 && bw2.width > 400, `宽屏两栏布局（棋盘 ${Math.round(bw2?.width || 0)}px）`);
await page.screenshot({ path: path.resolve(__dirname, '../e2e-screenshots/desktop.png') });

/* 10. 认输（新对局：黑落一子后白认输） */
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(300);
await page.locator('#btnRestart').click();
await page.waitForTimeout(300);
ok(await page.locator('#capB').isVisible() && await page.locator('#capW').isVisible(), '提子卡片显示');
ok(await page.locator('#capB').textContent() === '0' && await page.locator('#capW').textContent() === '0', '提子初始 0 · 0');
const rb = await page.locator('#board').boundingBox();
const cell9 = (gx, gy) => {
  const m = rb.width * 0.062, g = (rb.width - 2 * m) / 8;
  return { x: rb.x + m + gx * g, y: rb.y + m + gy * g };
};
await page.mouse.click(cell9(3, 3).x, cell9(3, 3).y);
await page.waitForTimeout(200);
await page.locator('#btnResign').click();
await page.waitForTimeout(150);
ok(await page.evaluate(() => !document.getElementById('scrim').hidden), '认输确认弹窗弹出');
const resignBody = await page.locator('.dlg-body').textContent();
ok(!!resignBody && !resignBody.includes('战绩'), `双人认输文案不提战绩（${resignBody}）`);
await page.locator('#dialog [data-cmd="ok"]').click();
await page.waitForTimeout(250);
ok(await page.evaluate(() => !window.yiqi.over && document.getElementById('scrim').hidden), '「继续比赛」取消认输');
await page.locator('#btnResign').click();
await page.waitForTimeout(150);
await page.locator('#dialog [data-cmd="resign-confirm"]').click();
await page.waitForTimeout(900);
const resignTitle = await page.locator('.dlg-title').textContent();
ok(!!resignTitle && resignTitle.includes('获胜'), `认输后终局弹窗（${resignTitle}）`);
ok(await page.evaluate(() => window.yiqi.resultText) === '黑中盘胜', '认输结果为中盘胜');
await page.locator('#dialog [data-cmd="again"]').click();
await page.waitForTimeout(250);
ok(await page.evaluate(() => !window.yiqi.over && window.yiqi.game.moveNumber === 0), '再来一局重置认输');

/* 11. JS 错误 */
const realErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('Download the React DevTools'));
ok(realErrors.length === 0, `无页面错误（${realErrors.length}）`);
if (realErrors.length) console.error(realErrors.slice(0, 5));

await browser.close();
console.log(`\nE2E 结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
