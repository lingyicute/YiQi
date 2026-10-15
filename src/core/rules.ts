/**
 * YiQi 规则层：对 OGS `goban-engine`（Apache-2.0）的封装。
 *
 * 以「着法序列 + 规则 + 贴目 + 棋盘尺寸」作为唯一接口（见 围棋规则库选型.md）：
 * goban-engine 负责合法性校验、提子、禁全同形（劫）、数目与计分；
 * 对弈 UI 与 KataGo 引擎都只消费这里的棋盘快照与着法序列。
 *
 * 中国大陆规则：数子法、黑贴 7.5 目（3¾ 子）、禁全局同形（位置超级劫 psk）、
 * 空点（dame）不填亦计分由数子法自然处理。
 */
import { GobanEngine } from 'goban-engine';
import type { JGOFMove } from 'goban-engine/build/engine/formats/JGOF';
import { positionalKey, situationalKey } from '../ai/superko';
import type { BoardState as NNBoardState, Move as NNMove, Player } from '../ai/types';

export type Point = { x: number; y: number };
/** {x:-1,y:-1} 表示停一手（pass）。 */
export type GameMove = Point;

export const KOMI = 7.5;

export type RuleErrorCode =
  | 'occupied'
  | 'suicide'
  | 'ko'
  | 'superko'
  | 'out_of_bounds'
  | 'unknown';

export class IllegalMoveError extends Error {
  readonly code: RuleErrorCode;
  constructor(code: RuleErrorCode, message: string) {
    super(message);
    this.name = 'IllegalMoveError';
    this.code = code;
  }
}

function classifyEngineError(err: unknown): RuleErrorCode {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('stone_already_placed_here')) return 'occupied';
  if (msg.includes('illegal_self_capture') || msg.includes('move is suicide')) return 'suicide';
  if (msg.includes('illegal_board_repetition') || msg.includes('superko') || msg.includes('repeating')) return 'superko';
  if (msg.includes('illegal_ko_move') || msg.includes('ko')) return 'ko';
  if (msg.includes('out of bounds')) return 'out_of_bounds';
  return 'unknown';
}

export interface ScoreSummary {
  black: number;
  white: number;
  /** 每个点的归属：0 空/单官，1 黑，2 白（计子/地域着色，供画布显示） */
  ownership: Int8Array;
}

export class GoGame {
  readonly size: number;
  private engine: GobanEngine;
  private _moves: GameMove[] = [];
  /** 供 KataGo 的情境键（含行棋方）。 */
  private _repetitionKeys = new Set<string>();
  /** 完整历史位置键（位置超级劫强制检查用——引擎自带检查只回看 30 手）。 */
  private _positionKeys = new Set<string>();
  private _currentPlayerCache: Player = 'black';

  constructor(size: number) {
    this.size = size;
    this.engine = GoGame.createEngine(size);
    this.recordRepetition();
  }

  private static createEngine(size: number): GobanEngine {
    return new GobanEngine({
      width: size,
      height: size,
      komi: KOMI,
      rules: 'chinese',
      allow_superko: false,
      superko_algorithm: 'psk',
    });
  }

  /** 全部着法（含停一手），从当前分叉回溯的干净主干。 */
  get moves(): readonly GameMove[] {
    return this._moves;
  }

  get playerToMove(): Player {
    return this._currentPlayerCache;
  }

  /** 原始棋盘：board[y][x]，0 空 1 黑 2 白。 */
  get board(): number[][] {
    return this.engine.board;
  }

  /** 白方提掉的黑子数 / 黑方提掉的白子数。 */
  get captures(): { byBlack: number; byWhite: number } {
    return {
      byBlack: this.engine.black_prisoners,
      byWhite: this.engine.white_prisoners,
    };
  }

  /** 连续停一手次数（用于两次停一手终局）。 */
  get consecutivePasses(): number {
    let n = 0;
    for (let i = this._moves.length - 1; i >= 0; i--) {
      const m = this._moves[i]!;
      if (m.x === -1 && m.y === -1) n++;
      else break;
    }
    return n;
  }

  get moveNumber(): number {
    return this._moves.length;
  }

  /** 落子。非法时抛 IllegalMoveError，棋盘状态不变。 */
  place(x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.size || y >= this.size) {
      throw new IllegalMoveError('out_of_bounds', '落点超出棋盘');
    }
    if (this.engine.board[y]![x] !== 0) {
      throw new IllegalMoveError('occupied', '此处已有棋子');
    }
    try {
      // 显式开启简单劫与全同形检查（引擎默认不抛错）
      this.engine.place(x, y, true, true);
    } catch (err) {
      throw new IllegalMoveError(classifyEngineError(err), describeIllegal(this, x, y));
    }
    this._moves.push({ x, y });
    // 完整历史的位置超级劫检查（引擎自带检查只回看 30 手，此处覆盖全局）
    const posKey = positionalKey(this.nnBoard());
    if (this._positionKeys.has(posKey)) {
      this._moves.pop();
      this.resetToMoves(this._moves);
      throw new IllegalMoveError('superko', '违反规则：全局同形再现（打劫需先寻劫）');
    }
    this.recordRepetition(posKey);
  }

  /** 停一手。 */
  pass(): void {
    this.engine.place(-1, -1);
    this._moves.push({ x: -1, y: -1 });
    this.recordRepetition();
  }

  /** 撤回最近 n 手（默认 1），通过重放着法序列重建引擎，保证状态一致。 */
  undo(count = 1): void {
    if (count <= 0) return;
    const keep = this._moves.slice(0, Math.max(0, this._moves.length - count));
    this.resetToMoves(keep);
  }

  /** 用给定着法序列重置整局。 */
  resetToMoves(moves: readonly GameMove[]): void {
    // 在独立实例中验证全部着法；失败时保留原局面（包括死子标记）。
    const next = new GoGame(this.size);
    for (const m of moves) {
      if (m.x === -1 && m.y === -1) next.pass();
      else next.place(m.x, m.y);
    }
    this.engine = next.engine;
    this._moves = next._moves;
    this._repetitionKeys = next._repetitionKeys;
    this._positionKeys = next._positionKeys;
    this._currentPlayerCache = next._currentPlayerCache;
  }

  /** 供 KataGo 的 NN 特征层：board[y][x] → 'black' | 'white' | null。 */
  nnBoard(): NNBoardState {
    const out: NNBoardState = [];
    for (let y = 0; y < this.size; y++) {
      const row: (Player | null)[] = [];
      for (let x = 0; x < this.size; x++) {
        const v = this.engine.board[y]![x]!;
        row.push(v === 1 ? 'black' : v === 2 ? 'white' : null);
      }
      out.push(row);
    }
    return out;
  }

  /** 供 KataGo 的 NN 特征层：整局着法序列。 */
  nnMoveHistory(): NNMove[] {
    const out: NNMove[] = [];
    for (let i = 0; i < this._moves.length; i++) {
      const m = this._moves[i]!;
      out.push({
        x: m.x,
        y: m.y,
        player: i % 2 === 0 ? 'black' : 'white',
      });
    }
    return out;
  }

  /** 供 KataGo 的超级劫检查：每个历史局面的情境键（含当前局面）。 */
  repetitionHistory(): string[] {
    return [...this._repetitionKeys].sort();
  }

  private recordRepetition(posKey?: string): void {
    this._currentPlayerCache = this._moves.length % 2 === 0 ? 'black' : 'white';
    const board = this.nnBoard();
    this._repetitionKeys.add(situationalKey(board, this._currentPlayerCache));
    this._positionKeys.add(posKey ?? positionalKey(board));
  }

  /** 某点所在棋串（同色连通块）。 */
  groupAt(x: number, y: number): Point[] {
    const board = this.engine.board;
    const color = board[y]![x]!;
    if (!color) return [];
    const seen = new Set<number>();
    const stack: Point[] = [{ x, y }];
    const out: Point[] = [];
    while (stack.length) {
      const p = stack.pop()!;
      const key = p.y * this.size + p.x;
      if (seen.has(key)) continue;
      seen.add(key);
      if (board[p.y]![p.x] !== color) continue;
      out.push(p);
      const neighbors = this.neighborsOf(p.x, p.y);
      for (const n of neighbors) {
        if (board[n.y]![n.x] === color && !seen.has(n.y * this.size + n.x)) stack.push(n);
      }
    }
    return out;
  }

  neighborsOf(x: number, y: number): Point[] {
    const out: Point[] = [];
    if (x > 0) out.push({ x: x - 1, y });
    if (x < this.size - 1) out.push({ x: x + 1, y });
    if (y > 0) out.push({ x, y: y - 1 });
    if (y < this.size - 1) out.push({ x, y: y + 1 });
    return out;
  }

  isRemoved(x: number, y: number): boolean {
    return !!this.engine.removal[y]![x];
  }

  /** 标记/取消整组死子（计分阶段）。 */
  setGroupRemoved(x: number, y: number, removed: boolean): void {
    if (!this.engine.board[y]![x]) return;
    for (const p of this.groupAt(x, y)) {
      this.engine.setRemoved(p.x, p.y, removed, false);
    }
  }

  clearRemoved(): void {
    this.engine.clearRemoved();
  }

  /** 当前死子清单（坐标集合，键为 y*size+x）。 */
  removedPoints(): Set<number> {
    const out = new Set<number>();
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.engine.removal[y]![x]) out.add(y * this.size + x);
      }
    }
    return out;
  }

  /**
   * 数子法计分（中国规则）： removal 矩阵中的死子按空点处理。
   * ownership[y*size+x]：1 黑地域/棋子，2 白地域/棋子，0 中立（公共空点）。
   */
  score(): ScoreSummary {
    const s = this.engine.computeScore();
    const ownership = new Int8Array(this.size * this.size);
    const mark = (encoded: string, color: number) => {
      if (!encoded) return;
      const pts = this.engine.decodeMoves(encoded) as JGOFMove[];
      for (const p of pts) ownership[p.y * this.size + p.x] = color;
    };
    mark(s.black.scoring_positions, 1);
    mark(s.white.scoring_positions, 2);
    return { black: s.black.total, white: s.white.total, ownership };
  }

  /** 导出 SGF（GM[1] 围棋；应用中国规则与贴目）。 */
  toSGF(meta: { whiteName?: string; blackName?: string; result?: string; date?: string } = {}): string {
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\r\n|[\r\n\t]/g, ' ');
    const coord = (v: number) => (v < 0 ? '' : String.fromCharCode(97 + v));
    let sgf = `(;GM[1]FF[4]CA[UTF-8]AP[YiQi]SZ[${this.size}]KM[${KOMI}]RU[Chinese]PB[${escape(meta.blackName || '黑方')}]PW[${escape(meta.whiteName || '白方')}]`;
    if (meta.date) sgf += `DT[${escape(meta.date)}]`;
    if (meta.result) sgf += `RE[${escape(meta.result)}]`;
    sgf += '\n';
    for (let i = 0; i < this._moves.length; i++) {
      const m = this._moves[i]!;
      const color = i % 2 === 0 ? 'B' : 'W';
      sgf += `;${color}[${coord(m.x)}${coord(m.y)}]`;
      if ((i + 1) % 15 === 0) sgf += '\n';
    }
    sgf += ')\n';
    return sgf;
  }
}

function describeIllegal(game: GoGame, x: number, y: number): string {
  if (game.board[y]![x] !== 0) return '此处已有棋子';
  return '违反规则：禁着点（自杀或全局同形）';
}
