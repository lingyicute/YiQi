/**
 * 围棋棋盘渲染（Canvas 2D）。
 * 渲染风格沿用 YiRenju：主题化棋盘底色、渐变棋子、落子动画、悬浮 Ghost、
 * 键盘光标、最后一手强调点；围棋扩展：星位随路数变化、坐标、
 * 终局地域着色与死子标记。
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

const ACCENTS: Record<string, string> = {
  purple: '#a78bfa', blue: '#82aaff', teal: '#5edfd0', green: '#6fdc8c',
  yellow: '#ecc64f', orange: '#f6ad7b', pink: '#f17bb0', red: '#ef6f6f',
};
const ACC_DEEP: Record<string, string> = {
  purple: '#6a54c8', blue: '#3f63c0', teal: '#0f7a6e', green: '#1e7a3c',
  yellow: '#7d660d', orange: '#a04d08', pink: '#b02e6e', red: '#c03230',
};

/** 每种路数的星位（0 基坐标）。 */
export function starPoints(n: number): Array<[number, number]> {
  if (n === 9) return [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]];
  if (n === 13) return [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]];
  const a = [3, 9, 15];
  const out: Array<[number, number]> = [];
  for (const x of a) for (const y of a) out.push([x, y]);
  return out;
}

const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRST';

function hex2rgb(h: string): number[] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function mixHex(a: string, b: string, wb: number): string {
  const A = hex2rgb(a), B = hex2rgb(b);
  return '#' + A.map((v, i) => Math.round(v * (1 - wb) + B[i]! * wb).toString(16).padStart(2, '0')).join('');
}
function rgbaOf(h: string, alpha: number): string {
  const c = hex2rgb(h);
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export type BoardTheme = {
  board: string;
  line: string;
  lineStrong: string;
  sBA: string; sBB: string;
  sWA: string; sWB: string; sWS: string;
  primary: string;
  acc: string;
  deep: string;
  coord: string;
};

export type BoardViewState = {
  size: number;
  board: number[][];
  lastMove: { x: number; y: number; at: number } | null;
  /** 计分阶段：ownership[y*size+x]（1 黑 2 白 0 中立），null = 不显示 */
  territory: Int8Array | null;
  removedPoints: Set<number>;
  /** 是否允许人类落子（影响 ghost 显示） */
  canPlay: boolean;
  /** 计分阶段可点击标记死子 */
  scoring: boolean;
  /** Ghost 预览的棋子颜色（当前轮到谁） */
  previewColor: number;
};

export class BoardRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wrap: HTMLElement;
  private CW = 0;
  private pal: BoardTheme | null = null;
  private drawQueued = false;
  private resizeTimer: number | null = null;

  hover: { x: number; y: number } | null = null;
  cursor = { x: 0, y: 0 };
  kbdCursor = false;
  showCoords = true;
  state: BoardViewState;

  constructor(canvas: HTMLCanvasElement, wrap: HTMLElement, state: BoardViewState) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
    this.wrap = wrap;
    this.state = state;
    this.refreshPalette();
  }

  refreshPalette(): void {
    const dark = document.documentElement.dataset.theme === 'dark';
    const accName = ACCENTS[document.documentElement.dataset.accent || ''] ? document.documentElement.dataset.accent! : 'purple';
    const acc = ACCENTS[accName]!;
    this.pal = {
      board: mixHex(dark ? '#1a1624' : '#faf8ff', acc, dark ? 0.12 : 0.15),
      line: dark ? rgbaOf('#efeafa', 0.30) : rgbaOf('#37304a', 0.42),
      lineStrong: dark ? rgbaOf('#efeafa', 0.52) : rgbaOf('#37304a', 0.62),
      sBA: dark ? '#5d5670' : '#575064', sBB: dark ? '#0c0912' : '#16111f',
      sWA: '#ffffff', sWB: dark ? '#c7c2d6' : '#d3cede',
      sWS: dark ? rgbaOf('#3b3350', 0.55) : rgbaOf('#6f6880', 0.45),
      primary: dark ? acc : ACC_DEEP[accName]!,
      acc,
      deep: ACC_DEEP[accName]!,
      coord: dark ? rgbaOf('#efeafa', 0.5) : rgbaOf('#37304a', 0.5),
    };
    this.scheduleDraw();
  }

  geom(): { s: number; m: number; g: number; r: number } {
    const m = this.CW * 0.062;
    const g = (this.CW - 2 * m) / (this.state.size - 1);
    return { s: this.CW, m, g, r: g * 0.44 };
  }

  fitBoard(): void {
    let side: number;
    if (window.innerWidth >= 960) {
      const r = this.wrap.getBoundingClientRect();
      side = Math.min(r.width, r.height);
    } else {
      side = this.wrap.clientWidth;
    }
    side = Math.max(240, Math.min(side, 880));
    if (Math.abs(side - this.CW) > 1) {
      this.CW = side;
      this.canvas.style.width = side + 'px';
      this.canvas.style.height = side + 'px';
    }
    this.scheduleDraw();
  }

  onResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.fitBoard(), 60);
  }

  /** 事件坐标 → 棋盘交叉点。 */
  eventCell(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const G = this.geom();
    if (!G.s) return null;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = Math.round((px - G.m) / G.g);
    const y = Math.round((py - G.m) / G.g);
    const n = this.state.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    if (Math.abs(px - (G.m + x * G.g)) > G.g * 0.55 || Math.abs(py - (G.m + y * G.g)) > G.g * 0.55) return null;
    return { x, y };
  }

  scheduleDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private drawStoneAt(cx: number, cy: number, r: number, p: number, alpha: number): void {
    const ctx = this.ctx;
    const pal = this.pal!;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,.32)';
    ctx.shadowBlur = r * 0.32;
    ctx.shadowOffsetY = r * 0.1;
    const gr = ctx.createRadialGradient(cx - r * 0.36, cy - r * 0.42, r * 0.12, cx, cy, r);
    if (p === BLACK) { gr.addColorStop(0, pal.sBA); gr.addColorStop(1, pal.sBB); }
    else { gr.addColorStop(0, pal.sWA); gr.addColorStop(1, pal.sWB); }
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (p === WHITE) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = pal.sWS;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  private draw(): void {
    const CW = this.CW;
    if (!CW || !this.pal) return;
    const ctx = this.ctx;
    const st = this.state;
    const pal = this.pal;
    const n = st.size;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (this.canvas.width !== Math.round(CW * dpr)) {
      this.canvas.width = Math.round(CW * dpr);
      this.canvas.height = Math.round(CW * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const G = this.geom();
    const { s, m, g, r: rr } = G;

    ctx.clearRect(0, 0, s, s);
    /* 棋盘底 */
    this.roundRect(ctx, 0, 0, s, s, s * 0.05);
    ctx.fillStyle = pal.board;
    ctx.fill();

    /* 网格 */
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = Math.max(1, s * 0.0017);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      ctx.moveTo(m, m + i * g);
      ctx.lineTo(s - m, m + i * g);
      ctx.moveTo(m + i * g, m);
      ctx.lineTo(m + i * g, s - m);
    }
    ctx.stroke();

    /* 边缘坐标（A-T 跳过 I，行号自下而上） */
    if (this.showCoords) {
      const fs = Math.min(Math.max(9, m * 0.42), 12.5);
      ctx.fillStyle = pal.coord;
      ctx.font = `600 ${fs}px ui-sans-serif,system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < n; i++) {
        const letter = GTP_LETTERS[i]!;
        const num = String(n - i);
        const cx = m + i * g;
        ctx.fillText(letter, cx, s - m * 0.52);
        ctx.fillText(num, m * 0.5, m + i * g);
      }
    }

    /* 星位 */
    ctx.fillStyle = pal.lineStrong;
    for (const [sx, sy] of starPoints(n)) {
      ctx.beginPath();
      ctx.arc(m + sx * g, m + sy * g, Math.max(1.6, g * 0.085), 0, Math.PI * 2);
      ctx.fill();
    }

    /* 终局地域着色（计分阶段） */
    if (st.territory) {
      const tSize = Math.max(3, g * 0.22);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const owner = st.territory[y * n + x]!;
          if (!owner) continue;
          const v = st.board[y]![x]!;
          if (v) continue; // 空点才画地域块
          ctx.fillStyle = owner === 1 ? pal.sBB : pal.sWA;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(m + x * g - tSize / 2, m + y * g - tSize / 2, tSize, tSize);
          ctx.globalAlpha = 1;
        }
      }
    }

    const now = performance.now();

    /* 悬浮 Ghost */
    const ghostOK = this.hover && st.canPlay && !st.scoring &&
      st.board[this.hover.y]![this.hover.x] === EMPTY && !st.territory;
    if (ghostOK && this.hover) {
      this.drawStoneAt(m + this.hover.x * g, m + this.hover.y * g, rr, st.previewColor, 0.42);
    }

    /* 键盘光标 */
    if (this.kbdCursor && !st.territory) {
      ctx.save();
      ctx.strokeStyle = pal.primary;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(m + this.cursor.x * g, m + this.cursor.y * g, rr * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      if (!ghostOK && st.canPlay && !st.scoring && st.board[this.cursor.y]![this.cursor.x] === EMPTY) {
        this.drawStoneAt(m + this.cursor.x * g, m + this.cursor.y * g, rr, st.previewColor, 0.42);
      }
    }

    /* 棋子（最后一手带落子动画）+ 死子淡化 */
    const last = st.lastMove;
    const animT = last ? Math.min(1, (now - last.at) / 150) : 1;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = st.board[y]![x]!;
        if (!p) continue;
        const dead = st.removedPoints.has(y * n + x);
        let scale = 1;
        if (last && last.x === x && last.y === y && animT < 1) scale = 1 + 0.5 * (1 - animT) * (1 - animT);
        this.drawStoneAt(m + x * g, m + y * g, rr * scale, p, dead ? 0.38 : 1);
        if (dead) {
          ctx.save();
          ctx.strokeStyle = p === BLACK ? '#e8e4f2' : '#3a3348';
          ctx.globalAlpha = 0.9;
          ctx.lineWidth = Math.max(1.6, g * 0.05);
          ctx.lineCap = 'round';
          const fr = g * 0.18;
          const cx = m + x * g, cy = m + y * g;
          ctx.beginPath();
          ctx.moveTo(cx - fr, cy - fr);
          ctx.lineTo(cx + fr, cy + fr);
          ctx.moveTo(cx + fr, cy - fr);
          ctx.lineTo(cx - fr, cy + fr);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    /* 最后一手标记 */
    if (last && last.x >= 0) {
      const p = st.board[last.y]![last.x]!;
      if (p) {
        ctx.fillStyle = p === BLACK ? pal.acc : pal.deep;
        ctx.beginPath();
        ctx.arc(m + last.x * g, m + last.y * g, Math.max(2.2, rr * 0.22), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (last && animT < 1) this.scheduleDraw();
  }
}
