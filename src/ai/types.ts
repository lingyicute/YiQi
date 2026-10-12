/**
 * Shared types for the YiQi AI layer, kept compatible with the shapes the
 * vendored web-katrain KataGo engine (MIT, https://github.com/Sir-Teo/web-katrain)
 * expects. Board state is `board[y][x]`, row-major from the top.
 */

export type Player = 'black' | 'white';
export type Intersection = Player | null;
export type BoardState = Intersection[][];
export type BoardSize = 9 | 13 | 19;

/** KataGo rulesets. YiQi plays 'chinese-ogs'（= goban-engine `chinese` + 位置超级劫，中国大陆规则）。 */
export type GameRules =
  | 'japanese'
  | 'chinese'
  | 'chinese-ogs'
  | 'korean'
  | 'aga'
  | 'new-zealand'
  | 'tromp-taylor'
  | 'stone-scoring';

export type KataGoBackendPreference = 'wasm' | 'webgpu' | 'cpu';
export type FloatArray = Float32Array | number[];

export interface Move {
  x: number; // -1 = pass
  y: number;
  player: Player;
}

export interface RegionOfInterest {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** One searched root move, as reported by the analysis. */
export interface CandidateMove {
  x: number;
  y: number;
  winRate: number; // 0-1, black perspective
  winRateLost?: number; // positive = worse for side to play
  scoreLead: number;
  scoreSelfplay?: number;
  scoreStdev?: number;
  visits: number;
  edgeVisits?: number;
  noResultValue?: number;
  weight?: number;
  edgeWeight?: number;
  pointsLost: number;
  relativePointsLost?: number;
  order: number; // 0 for best move
  prior?: number;
  pv?: string[];
  pvVisits?: number[];
  pvEdgeVisits?: number[];
  lcb?: number;
  utilityLcb?: number;
  playSelectionValue?: number; // KataGo play selection weight, LCB adjusted
  utility?: number; // KataGo utilityAvg for this child, black perspective
  humanPrior?: number; // human SL policy for this move, when that net is loaded
  ownership?: FloatArray;
}
