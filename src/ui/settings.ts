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

export type Records = {
  b: Record<string, { w: number; l: number }>;
  w: Record<string, { w: number; l: number }>;
};

export const emptyRecords = (): Records => ({ b: {}, w: {} });

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
