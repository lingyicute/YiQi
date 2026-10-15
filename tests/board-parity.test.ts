import { describe, expect, it } from 'vitest';
import { GoGame, IllegalMoveError } from '../src/core/rules';
import { playMove, undoMove, setBoardSize, type SimPosition, type UndoSnapshot } from '../src/ai/katago/fastBoard';
import { positionSuperkoBans, stonesRepetitionKey } from '../src/ai/katago/superkoHistory';
import { situationalKey } from '../src/ai/superko';

describe('UI rules / search board differential checks (Chinese PSK)', () => {
  for (const size of [9, 13, 19]) {
    for (const seed of [1, 42, 2026]) {
      it(`${size}x${size}, deterministic seed ${seed}: legality, captures, rollback and history keys`, () => {
        setBoardSize(size);
        const game = new GoGame(size);
        const pos: SimPosition = { stones: new Uint8Array(size * size), koPoint: -1 };
        let state = seed;
        const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
        for (let i = 0; i < 400; i++) {
          const move = random() % (size * size + 1);
          const pass = move === size * size;
          const player = game.playerToMove === 'black' ? 1 : 2;
          const before = pos.stones.slice(), ko = pos.koPoint;
          const bans = positionSuperkoBans({ board: game.nnBoard(), currentPlayer: game.playerToMove, rules: 'chinese-ogs', repetitionHistory: game.repetitionHistory() }, pos);
          const captured: number[] = [];
          let undo: UndoSnapshot | undefined;
          if (pass || !bans?.[move]) {
            try { undo = playMove(pos, move, player, captured); } catch { /* illegal */ }
          }
          let accepted = false;
          try {
            if (pass) game.pass(); else game.place(move % size, Math.floor(move / size));
            accepted = true;
          } catch (err) { expect(err).toBeInstanceOf(IllegalMoveError); }
          expect(!!undo, `move ${i}: ${move}`).toBe(accepted);
          expect([...pos.stones]).toEqual(game.board.flat());
          expect(stonesRepetitionKey(pos.stones, game.playerToMove === 'black' ? 1 : 2)).toBe(situationalKey(game.nnBoard(), game.playerToMove));
          if (undo) {
            undoMove(pos, move, player, undo, captured);
            expect(pos.stones).toEqual(before);
            expect(pos.koPoint).toBe(ko);
            expect(captured).toEqual([]);
            playMove(pos, move, player, captured);
          } else {
            expect(pos.stones).toEqual(before);
            expect(pos.koPoint).toBe(ko);
          }
        }
      });
    }
  }
});
