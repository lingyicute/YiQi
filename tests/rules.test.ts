import { describe, expect, it } from 'vitest';
import { GoGame, IllegalMoveError, KOMI } from '../src/core/rules';

describe('GoGame（goban-engine 封装，中国规则）', () => {
  it('交替落子并切换行棋方', () => {
    const g = new GoGame(9);
    expect(g.playerToMove).toBe('black');
    g.place(2, 2);
    expect(g.playerToMove).toBe('white');
    expect(g.board[2]![2]).toBe(1);
    g.place(3, 3);
    expect(g.board[3]![3]).toBe(2);
    expect(g.moveNumber).toBe(2);
  });

  it('拒绝落在有子处', () => {
    const g = new GoGame(9);
    g.place(4, 4);
    expect(() => g.place(4, 4)).toThrow(IllegalMoveError);
    try {
      g.place(4, 4);
    } catch (err) {
      expect((err as IllegalMoveError).code).toBe('occupied');
    }
    expect(g.moveNumber).toBe(1);
  });

  it('提子：无气棋子被移除并计入俘虏', () => {
    const g = new GoGame(9);
    // 白在角上被黑围死：黑 A1 后黑 A2、B1
    g.place(0, 0); // 黑 A1（0基 x0,y0）
    g.place(8, 8); // 白让一手
    g.place(1, 0); // 黑 B1
    g.place(8, 7); // 白让一手
    g.place(0, 1); // 黑 A2 -> 提掉白? 不，A1是黑。改为提白子：
    // 重新构造：白 0,0；黑 1,0 / 0,1 包围
    const g2 = new GoGame(9);
    g2.place(8, 8); // 黑
    g2.place(0, 0); // 白角
    g2.place(1, 0); // 黑
    g2.place(8, 7); // 白
    g2.place(0, 1); // 黑 → 白 (0,0) 无气被提
    expect(g2.board[0]![0]).toBe(0);
    expect(g2.captures.byBlack).toBe(1);
    expect(g2.captures.byWhite).toBe(0);
  });

  it('打劫：立即回提被禁止，寻劫后可回提', () => {
    const g = new GoGame(9);
    // 经典劫形（交替落子）：
    //   y0: x1=黑 x2=白
    //   y1: x0=黑  (1,1)=劫心  x3=白
    //   y2: x1=黑 x2=白
    g.place(1, 0); // 黑 (1,0)
    g.place(2, 0); // 白 (2,0)
    g.place(0, 1); // 黑 (0,1)
    g.place(3, 1); // 白 (3,1)
    g.place(1, 2); // 黑 (1,2)
    g.place(2, 2); // 白 (2,2)
    g.place(8, 8); // 黑 outside
    g.place(1, 1); // 白 劫心 (1,1)，仅剩气 (2,1)
    g.place(2, 1); // 黑 (2,1) 提白 (1,1)
    expect(g.board[1]![1]).toBe(0);
    expect(g.captures.byBlack).toBe(1);
    // 白立即回提 (1,1) 会重现先前局面 → 禁止
    let code: string | null = null;
    try {
      g.place(1, 1);
    } catch (err) {
      code = (err as IllegalMoveError).code;
    }
    expect(['ko', 'superko']).toContain(code);
    expect(g.board[1]![2]).toBe(1); // 黑劫石仍在
    // 白寻劫、黑应劫后可回提
    g.place(0, 8); // 白寻劫
    g.place(7, 7); // 黑应劫
    g.place(1, 1); // 白回提劫
    expect(g.board[1]![1]).toBe(2);
    expect(g.board[1]![2]).toBe(0);
    expect(g.captures.byWhite).toBe(1);
  });

  it('停一手与连续停一手计数', () => {
    const g = new GoGame(9);
    g.pass();
    expect(g.consecutivePasses).toBe(1);
    g.place(4, 4);
    expect(g.consecutivePasses).toBe(0);
    g.pass();
    g.pass();
    expect(g.consecutivePasses).toBe(2);
  });

  it('数子法计分：地域归属与贴目', () => {
    const g = new GoGame(9);
    // 黑角上一子被白吃掉后，该点成白地域
    g.place(0, 0); // 黑 (0,0)
    g.place(1, 0); // 白 (1,0)
    g.pass();      // 黑停一手
    g.place(0, 1); // 白 (0,1) 提黑 (0,0)
    expect(g.captures.byWhite).toBe(1);
    g.pass();      // 黑停一手
    g.pass();      // 白停一手 → 终局
    const s = g.score();
    // 全盘只剩白 (1,0),(0,1) 两子；其余空点连成一片仅与白相邻 → 全归白
    expect(s.black).toBe(0);
    expect(s.white).toBeCloseTo(81 + KOMI, 5);
    expect(s.ownership[0]).toBe(2); // (0,0) 已成白地域
    expect(s.ownership[1 * 9 + 1]).toBe(2);
  });

  it('死子标记后地域重新划分', () => {
    const g = new GoGame(9);
    g.place(8, 8); // 黑 J1
    g.place(8, 7); // 白 J2
    g.pass();
    g.pass();
    // 标黑 J1 为死子 → 该点成为白地域的一部分（若该区域只与白相邻）
    g.setGroupRemoved(8, 8, true);
    const s = g.score();
    expect(s.ownership[8 * 9 + 8]).toBe(2);
    g.setGroupRemoved(8, 8, false);
    expect(g.isRemoved(8, 8)).toBe(false);
  });

  it('悔棋重建状态', () => {
    const g = new GoGame(9);
    g.place(2, 2);
    g.place(3, 3);
    g.place(4, 4);
    g.undo(2);
    expect(g.moveNumber).toBe(1);
    expect(g.playerToMove).toBe('white');
    expect(g.board[4]![4]).toBe(0);
    expect(g.board[2]![2]).toBe(1);
    // 悔棋后可重新落子
    g.place(4, 4);
    expect(g.board[4]![4]).toBe(2);
  });

  it('resetToMoves 重放并保持一致', () => {
    const g = new GoGame(9);
    g.place(2, 2);
    g.place(3, 3);
    g.pass(); // 黑停一手
    const g2 = new GoGame(9);
    g2.resetToMoves(g.moves);
    expect(g2.moveNumber).toBe(3);
    expect(g2.board[2]![2]).toBe(1);
    expect(g2.playerToMove).toBe('white');
  });

  it('超级劫历史：为 KataGo 提供情境键', () => {
    const g = new GoGame(9);
    g.place(4, 4);
    const keys = g.repetitionHistory();
    expect(keys.length).toBeGreaterThanOrEqual(2); // 空盘 + 一手后
    expect(keys.every((k) => /^[bw]\|/.test(k))).toBe(true);
  });

  it('SGF 导出包含基本属性与着法', () => {
    const g = new GoGame(9);
    g.place(2, 2);
    g.pass();
    const sgf = g.toSGF({ result: 'B+2.5' });
    expect(sgf).toContain('SZ[9]');
    expect(sgf).toContain('KM[7.5]');
    expect(sgf).toContain('RU[Chinese]');
    expect(sgf).toContain(';B[cc]');
    expect(sgf).toContain(';W[]');
    expect(sgf).toContain('RE[B+2.5]');
  });

  it('groupAt 找到整组棋子', () => {
    const g = new GoGame(9);
    g.place(0, 0);
    g.place(8, 8);
    g.place(1, 0);
    g.place(8, 7);
    const group = g.groupAt(0, 0);
    expect(group.length).toBe(2);
    expect(group).toContainEqual({ x: 0, y: 0 });
    expect(group).toContainEqual({ x: 1, y: 0 });
  });
});
