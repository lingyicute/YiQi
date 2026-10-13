/**
 * YiQi 入口：装配 UI、绑定事件。
 */
import { App } from './ui/app';
import { BLACK } from './ui/board';
import { playStoneSound } from './ui/sounds';

const app = new App();
(window as unknown as { yiqi: App }).yiqi = app;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $('board') as HTMLCanvasElement;
const menu = $('menu');

/* ================= 顶栏 ================= */
$('btnTheme').addEventListener('click', () => app.toggleTheme());
$('btnPalette').addEventListener('click', () => app.showPalette());
$('btnMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.classList.toggle('open');
  $('btnMenu').classList.toggle('active', menu.classList.contains('open'));
});
document.addEventListener('click', (e) => {
  if (menu.classList.contains('open') && !(e.target as HTMLElement).closest('.menu-wrap')) {
    menu.classList.remove('open');
    $('btnMenu').classList.remove('active');
  }
});

function closeMenu(): void {
  menu.classList.remove('open');
  $('btnMenu').classList.remove('active');
}

menu.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.menu-item');
  if (!item) return;
  closeMenu();
  const act = (item as HTMLElement).dataset.act;
  if (act === 'what') app.showWhatIsGo();
  else if (act === 'help') app.showHelp();
  else if (act === 'records') app.showRecords();
  else if (act === 'sgf') app.exportSGF();
  else if (act === 'models') app.showDownloadDialog();
  else if (act === 'sound') {
    app.settings.sound = !app.settings.sound;
    app.updateSoundUI();
    app.saveSettings();
    if (app.settings.sound) playStoneSound(false, true);
  } else if (act === 'coords') {
    app.settings.coords = !app.settings.coords;
    app.updateCoordsUI();
    app.saveSettings();
  } else if (act === 'clear') app.showClearConfirm();
});

/* ================= 对话框 ================= */
const scrim = $('scrim');
scrim.addEventListener('click', (e) => {
  if (e.target === scrim) app.closeDialog();
});
$('dialog').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const sw = target.closest('.swatch');
  if (sw) {
    app.applyAccent((sw as HTMLElement).dataset.accent!);
    app.showPalette();
    return;
  }
  const btn = target.closest('[data-cmd]');
  if (!btn) return;
  const cmd = (btn as HTMLElement).dataset.cmd;
  if (cmd === 'again') { app.closeDialog(); app.newGame(); app.toast('已开始新对局'); }
  else if (cmd === 'resign-confirm') { app.confirmResign(); }
  else if (cmd === 'clear') {
    app.records = { b: {}, w: {} };
    app.saveRecords();
    app.newGame();
    app.closeDialog();
    app.toast('记录已清除');
  } else if (cmd === 'startdl') {
    void app.startDownload();
  } else if (cmd === 'skipdl') {
    app.skipDownload();
  } else app.closeDialog();
});

/* ================= 模式 / 尺寸 / 执子 ================= */
$('modes').addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (!chip) return;
  const mode = chip.dataset.mode!;
  if (mode === app.mode) return;
  if (mode.startsWith('ai-') && !app.ai.ready) {
    app.showDownloadDialog();
    return;
  }
  app.mode = mode;
  app.settings.mode = mode;
  app.saveSettings();
  document.querySelectorAll('#modes .chip').forEach((c) => c.classList.toggle('sel', (c as HTMLElement).dataset.mode === mode));
  $('sides').style.display = mode === 'pvp' ? 'none' : 'flex';
  app.newGame();
  app.toast(mode === 'pvp' ? '双人对战开始' : '人机对战 · ' + $('modes').querySelector(`[data-mode="${mode}"]`)?.textContent?.trim());
});

$('sizes').addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (!chip) return;
  const size = Number(chip.dataset.size) as 9 | 13 | 19;
  if (!size || size === app.game.size) return;
  app.settings.boardSize = size;
  app.saveSettings();
  app.newGame();
  app.toast(`切换到 ${size} 路棋盘，新对局开始`);
});

$('sides').addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (!chip) return;
  const side = chip.dataset.side as 'B' | 'W';
  if (!side || side === app.settings.side) return;
  app.humanColor = side === 'W' ? 2 : BLACK;
  app.settings.side = side;
  app.saveSettings();
  document.querySelectorAll('#sides .chip').forEach((c) => c.classList.toggle('sel', (c as HTMLElement).dataset.side === side));
  app.newGame();
  app.toast(side === 'W' ? '你执白后行，AI 执黑先行' : '你执黑先行，AI 执白后行');
});

/* ================= 工具按钮 ================= */
$('btnUndo').addEventListener('click', () => app.undo());
$('btnPass').addEventListener('click', () => {
  const ok = app.humanPlace(-1, -1);
  if (ok) app.toast('停一手' + (app.phase === 'scoring' ? '，双方连续停一手，进入计分' : ''));
});
$('btnResign').addEventListener('click', () => app.requestResign());
$('btnRestart').addEventListener('click', () => { app.newGame(); app.toast('已开始新对局'); });
$('btnResume').addEventListener('click', () => {
  app.resumeFromScoring();
});
$('btnConfirmScore').addEventListener('click', () => app.confirmScore());

/* ================= 棋盘交互 ================= */
let touchTap: { x0: number; y0: number; id: number } | null = null;
const TAP_SLOP2 = 12 * 12;

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touchTap = touchTap ? null : { x0: e.clientX, y0: e.clientY, id: e.pointerId };
    return;
  }
  e.preventDefault();
  canvas.focus({ preventScroll: true });
  tryPlaceFromEvent(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (touchTap && e.pointerId === touchTap.id) {
      const dx = e.clientX - touchTap.x0;
      const dy = e.clientY - touchTap.y0;
      if (dx * dx + dy * dy > TAP_SLOP2) touchTap = null;
    }
    return;
  }
  const c = app.renderer.eventCell(e);
  const changed = JSON.stringify(c) !== JSON.stringify(app.renderer.hover);
  app.renderer.hover = c;
  if (changed) app.renderer.scheduleDraw();
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch') return;
  if (touchTap && e.pointerId === touchTap.id) {
    touchTap = null;
    canvas.focus({ preventScroll: true });
    tryPlaceFromEvent(e);
  }
});
canvas.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch' && touchTap && e.pointerId === touchTap.id) touchTap = null;
});
canvas.addEventListener('pointerleave', () => { app.renderer.hover = null; app.renderer.scheduleDraw(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function tryPlaceFromEvent(e: PointerEvent): void {
  const c = app.renderer.eventCell(e);
  if (!c) return;
  if (app.phase === 'scoring') {
    app.toggleDeadAt(c.x, c.y);
    return;
  }
  app.humanPlace(c.x, c.y);
}

/* ================= 键盘 ================= */
document.addEventListener('keydown', (e) => {
  if (app.dialogOpen) {
    if (e.key === 'Escape') app.closeDialog();
    return;
  }
  const k = e.key;
  if (k === 'Escape' && menu.classList.contains('open')) {
    closeMenu();
    $('btnMenu').focus();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.isContentEditable || active.closest('button,a,input,textarea,select,[role="button"],[role="menuitem"],[contenteditable="true"]'))) return;
  const tag = (active && active.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault();
  const n = app.game.size;
  const mv: Record<string, [number, number]> = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
  };
  if (mv[k]) {
    const [dx, dy] = mv[k]!;
    app.renderer.cursor = {
      x: (app.renderer.cursor.x + dx + n) % n,
      y: (app.renderer.cursor.y + dy + n) % n,
    };
    app.renderer.kbdCursor = true;
    app.renderer.hover = null;
    app.renderer.scheduleDraw();
    return;
  }
  if (k === 'Enter' || k === ' ') {
    const c = { x: app.renderer.cursor.x, y: app.renderer.cursor.y };
    if (app.phase === 'scoring') { app.toggleDeadAt(c.x, c.y); return; }
    const ok = app.humanPlace(c.x, c.y);
    if (ok) {
      app.renderer.kbdCursor = true;
      app.renderer.hover = null;
      app.renderer.scheduleDraw();
    }
    return;
  }
  if (k === 'z' || k === 'Z') { app.undo(); return; }
  if (k === 'p' || k === 'P') {
    const ok = app.humanPlace(-1, -1);
    if (ok) app.toast('停一手');
    return;
  }
  if (k === 'r' || k === 'R') { app.newGame(); app.toast('已开始新对局'); }
});

/* ================= 布局自适应 ================= */
window.addEventListener('resize', () => app.renderer.onResize());
window.addEventListener('orientationchange', () => setTimeout(() => app.renderer.fitBoard(), 120));
window.addEventListener('beforeunload', () => app.saveSession());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) app.saveSession();
});

app.init();
