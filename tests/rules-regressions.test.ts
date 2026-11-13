import { describe, expect, it } from 'vitest';
import { GoGame, IllegalMoveError } from '../src/core/rules';

describe('规则边界与导出回归', () => {
  it('空序列重置保留初始局面，重放历史与逐手落子相同', () => {
    const game = new GoGame(9);
    const initial = game.repetitionHistory();
    game.resetToMoves([]);
    expect(game.repetitionHistory()).toEqual(initial);
    game.place(2, 2);
    game.pass();
    const replay = new GoGame(9);
    replay.resetToMoves(game.moves);
    expect(replay.repetitionHistory()).toEqual(game.repetitionHistory());
  });

  it('非法重放不改变棋盘、提子、死子、历史与行棋方', () => {
    const game = new GoGame(9);
    game.place(2, 2);
    game.setGroupRemoved(2, 2, true);
    const board = game.board;
    const history = game.repetitionHistory();
    expect(() => game.resetToMoves([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toThrow(IllegalMoveError);
    expect(game.board).toBe(board);
    expect(game.moves).toEqual([{ x: 2, y: 2 }]);
    expect(game.removedPoints()).toEqual(new Set([20]));
    expect(game.repetitionHistory()).toEqual(history);
    expect(game.playerToMove).toBe('white');
    expect(game.captures).toEqual({ byBlack: 0, byWhite: 0 });
  });

  it.each([[0, NaN], [0, 0.5], [Infinity, 0], [-1, 0]])('拒绝非整数或越界坐标 (%s,%s)', (x, y) => {
    const game = new GoGame(9);
    let error: unknown;
    try { game.place(x, y); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(IllegalMoveError);
    expect((error as IllegalMoveError).code).toBe('out_of_bounds');
    expect(game.moveNumber).toBe(0);
  });

  it('SGF 属性转义反斜线、闭括号及换行，避免产生额外节点', () => {
    const sgf = new GoGame(9).toSGF({ blackName: 'A\\B];W[aa]\r\nC', whiteName: '白]方' });
    expect(sgf).toContain('PB[A\\\\B\\];W[aa\\] C]');
    expect(sgf).toContain('PW[白\\]方]');
  });
  it('isLegal 识别自杀与打劫回提，且不改变棋局', () => {
    const suicide = new GoGame(9);
    suicide.place(1, 0);
    suicide.place(5, 5);
    suicide.place(0, 1);
    expect(suicide.isLegal(0, 0)).toBe(false); // 白在黑角自杀
    expect(suicide.isLegal(1, 0)).toBe(false); // 已有棋子
    expect(suicide.isLegal(-1, -1)).toBe(true);
    expect(suicide.isLegal(9, 0)).toBe(false);
    suicide.pass();
    expect(suicide.isLegal(0, 0)).toBe(true); // 同一点对黑方合法
    expect(suicide.moveNumber).toBe(4);

    const ko = new GoGame(9);
    for (const [x, y] of [[2, 0], [1, 0], [2, 2], [1, 2], [3, 1], [2, 1], [8, 8], [0, 1]] as const) ko.place(x, y);
    ko.place(1, 1); // 黑提白 (2,1)
    const board = ko.board.map((row) => row.slice());
    const keys = ko.repetitionHistory();
    expect(ko.isLegal(2, 1)).toBe(false); // 白立即回提：全局同形
    expect(() => ko.place(2, 1)).toThrow(IllegalMoveError);
    expect(ko.board).toEqual(board);
    expect(ko.repetitionHistory()).toEqual(keys);
    ko.place(7, 7); // 白寻劫后，黑方不受影响
    expect(ko.isLegal(0, 0)).toBe(true);
  });

  it('超过 30 手的全局同形拒绝时不更换棋盘引用且保留死子标记', () => {
    const game = new GoGame(9);
    for (const [x, y] of [[2, 0], [1, 0], [2, 2], [1, 2], [3, 1], [2, 1], [8, 8], [0, 1]] as const) {
      game.place(x, y);
    }
    game.place(1, 1); // 黑提白 (2,1)
    for (let i = 0; i < 34; i++) game.pass(); // 超出底层引擎 30 手回看窗口，仍轮到白
    game.setGroupRemoved(8, 8, true);
    const boardRef = game.board;
    let code: string | null = null;
    try {
      game.place(2, 1);
    } catch (err) {
      code = (err as IllegalMoveError).code;
    }
    expect(code).toBe('superko');
    expect(game.board).toBe(boardRef);
    expect(game.isRemoved(8, 8)).toBe(true);
  });

  it.each([1, 7, 2026])('isLegal 与 place 的判定一致（9 路随机对局，seed %i）', (seed) => {
    const game = new GoGame(9);
    let state = seed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    let illegal = 0;
    for (let step = 0; step < 90; step++) {
      if (step % 4 === 0) {
        const before = game.board.map((row) => row.slice());
        for (let y = 0; y < 9; y++) {
          for (let x = 0; x < 9; x++) {
            if (game.board[y]![x] !== 0) { expect(game.isLegal(x, y)).toBe(false); continue; }
            const trial = new GoGame(9);
            trial.resetToMoves(game.moves);
            let accepted = true;
            try { trial.place(x, y); } catch (err) { accepted = false; expect(err).toBeInstanceOf(IllegalMoveError); }
            if (!accepted) illegal++;
            expect(game.isLegal(x, y), `step ${step} (${x},${y})`).toBe(accepted);
          }
        }
        expect(game.board).toEqual(before);
      }
      const move = random() % 82;
      try {
        if (move === 81) game.pass(); else game.place(move % 9, Math.floor(move / 9));
      } catch { /* 非法着法：忽略 */ }
    }
    expect(illegal).toBeGreaterThan(0);
  });
});
