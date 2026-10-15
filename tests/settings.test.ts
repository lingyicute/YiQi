import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateRecords, normalizeSettings, parseSession } from '../src/ui/settings';

const session = { mode: 'pvp', side: 'B', size: 9, moves: [{ x: 1, y: 1 }], elapsed: 3, over: false };

describe('local storage schema', () => {
  it.each([null, [], 1, 'bad', { boardSize: 0, mode: '__proto__', accent: 'constructor', sound: 'false' }])('normalizes invalid settings: %j', raw => {
    expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
  it('preserves supported preferences', () => {
    expect(normalizeSettings({ boardSize: 9, mode: 'pvp', sound: false })).toMatchObject({ boardSize: 9, mode: 'pvp', sound: false });
  });
  it.each([null, {}, { ...session, moves: [null] }, { ...session, moves: [{ x: -1, y: 2 }] }, { ...session, side: 'X' }, { ...session, removed: [-1] }])('rejects malformed session: %j', raw => {
    expect(parseSession(raw)).toBeNull();
  });
  it('accepts legacy saves and explicit play/scoring phases', () => {
    expect(parseSession(session)).toMatchObject(session);
    expect(parseSession({ ...session, phase: 'scoring', removed: [10] })).toMatchObject({ phase: 'scoring', removed: [10] });
    expect(parseSession({ ...session, elapsed: Infinity })?.elapsed).toBe(0);
  });
  it('migrates legacy records but ignores unknown keys and invalid counts', () => {
    expect(migrateRecords({ b: { hard: { w: 2, l: 1 } }, w: { hard: { w: 1, l: 3 } } })).toEqual({ hard: { w: 3, l: 4 } });
    expect(migrateRecords(JSON.parse('{"__proto__":{"w":1,"l":2},"easy":{"w":-1,"l":0},"hard":{"w":1.5,"l":0}}'))).toEqual({});
  });
});
