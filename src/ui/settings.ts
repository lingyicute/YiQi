/** 本地存储（localStorage 不可用时静默降级，游戏照常可玩）。 */

const NS = 'yiqi.';

export const LS = {
  get<T>(key: string, dflt: T): T {
    try {
      const v = localStorage.getItem(NS + key);
      if (v != null) return JSON.parse(v) as T;
    } catch { /* ignore */ }
    return dflt;
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch { /* ignore */ }
  },
};

export type Settings = {
  theme: 'light' | 'dark' | null;
  accent: string;
  mode: string;            // 'ai-easy' | 'ai-medium' | 'ai-hard' | 'ai-expert' | 'pvp'
  side: 'B' | 'W';
  boardSize: 9 | 13 | 19;
  sound: boolean;
  coords: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: null,
  accent: 'purple',
  mode: 'ai-hard',
  side: 'B',
  boardSize: 19,
  sound: true,
  coords: true,
};

export type WinLoss = { w: number; l: number };
export type Records = Record<string, WinLoss>;

export const emptyRecords = (): Records => ({});

/**
 * 兼容旧版按执黑/执白分桶（{b:{...},w:{...}}）的存储：
 * 迁移为按难度合并的单一计数表。
 */
export function migrateRecords(raw: unknown): Records {
  if (!raw || typeof raw !== 'object') return {};
  const out: Records = {};
  const add = (k: string, v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const { w, l } = v as { w?: unknown; l?: unknown };
    if (!['easy', 'medium', 'hard', 'expert'].includes(k)) return;
    if (typeof w !== 'number' || typeof l !== 'number' || !Number.isSafeInteger(w) || !Number.isSafeInteger(l) || w < 0 || l < 0) return;
    const r = out[k] || (out[k] = { w: 0, l: 0 });
    r.w += w; r.l += l;
  };
  const src = raw as { b?: unknown; w?: unknown };
  if (src.b || src.w) {
    for (const part of [src.b, src.w]) {
      if (!part || typeof part !== 'object') continue;
      for (const [k, v] of Object.entries(part as Record<string, unknown>)) add(k, v);
    }
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) add(k, v);
  return out;
}

export const ACCENTS: Record<string, string> = {
  purple: '#a78bfa', blue: '#82aaff', teal: '#5edfd0', green: '#6fdc8c',
  yellow: '#ecc64f', orange: '#f6ad7b', pink: '#f17bb0', red: '#ef6f6f',
};
export const ACC_DEEP: Record<string, string> = {
  purple: '#6a54c8', blue: '#3f63c0', teal: '#0f7a6e', green: '#1e7a3c',
  yellow: '#7d660d', orange: '#a04d08', pink: '#b02e6e', red: '#c03230',
};

export type SessionSave = {
  mode: string;
  side: 'B' | 'W';
  size: 9 | 13 | 19;
  moves: Array<{ x: number; y: number }>;
  elapsed: number;
  over: boolean;
  /** 可选字段兼容旧版存档；缺失时从末尾两次 PASS 推断。 */
  phase?: 'play' | 'scoring';
  removed?: number[];
};

const MODES = ['ai-easy', 'ai-medium', 'ai-hard', 'ai-expert', 'pvp'];

/** JSON.parse 只保证语法正确，不保证存储对象符合当前 schema。 */
export function normalizeSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const s = raw as Record<string, unknown>;
  if (s.theme === 'light' || s.theme === 'dark' || s.theme === null) out.theme = s.theme;
  if (typeof s.accent === 'string' && Object.hasOwn(ACCENTS, s.accent)) out.accent = s.accent;
  if (typeof s.mode === 'string' && MODES.includes(s.mode)) out.mode = s.mode;
  if (s.side === 'B' || s.side === 'W') out.side = s.side;
  if (s.boardSize === 9 || s.boardSize === 13 || s.boardSize === 19) out.boardSize = s.boardSize;
  if (typeof s.sound === 'boolean') out.sound = s.sound;
  if (typeof s.coords === 'boolean') out.coords = s.coords;
  return out;
}

export function parseSession(raw: unknown): SessionSave | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.mode !== 'string' || !MODES.includes(s.mode)) return null;
  if (s.side !== 'B' && s.side !== 'W') return null;
  if (s.size !== 9 && s.size !== 13 && s.size !== 19) return null;
  if (typeof s.over !== 'boolean' || !Array.isArray(s.moves) || !s.moves.length) return null;
  const size = s.size;
  const moves: SessionSave['moves'] = [];
  for (const m of s.moves) {
    if (!m || typeof m !== 'object') return null;
    const { x, y } = m;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (!(x === -1 && y === -1) && !(x >= 0 && x < size && y >= 0 && y < size)) return null;
    moves.push({ x, y });
  }
  if (s.phase !== undefined && s.phase !== 'play' && s.phase !== 'scoring') return null;
  if (s.removed !== undefined && (!Array.isArray(s.removed) || !s.removed.every(p => Number.isInteger(p) && p >= 0 && p < size * size))) return null;
  return {
    mode: s.mode, side: s.side, size, moves, over: s.over,
    elapsed: typeof s.elapsed === 'number' && Number.isFinite(s.elapsed) ? Math.max(0, Math.floor(s.elapsed)) : 0,
    phase: s.phase,
    removed: s.removed as number[] | undefined,
  };
}
