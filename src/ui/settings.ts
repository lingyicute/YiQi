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
    if (typeof w !== 'number' || typeof l !== 'number') return;
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
};
