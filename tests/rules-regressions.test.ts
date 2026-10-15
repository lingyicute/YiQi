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
});
