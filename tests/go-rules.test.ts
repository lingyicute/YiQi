import { describe, expect, it } from 'vitest';
import { handicapBonusForWhite, rulesFromSgf, rulesOf } from '../src/ai/goRules';

describe('SGF rule aliases', () => {
  it.each([
    ['Chinese-OGS', 'chinese-ogs'],
    ['chineseogs', 'chinese-ogs'],
    ['Chinese-KGS', 'chinese-kgs'],
    ['chinesekgs', 'chinese-kgs'],
  ])('preserves positional superko for %s', (alias, expected) => {
    const rules = rulesFromSgf(alias);
    expect(rules).toBe(expected);
    expect(rulesOf(rules!).ko).toBe('positional');
  });

  it('keeps ordinary Chinese rules on simple ko', () => {
    expect(rulesFromSgf('Chinese')).toBe('chinese');
    expect(rulesFromSgf('cn')).toBe('chinese');
    expect(rulesOf('chinese').ko).toBe('simple');
  });

  it('uses the distinct OGS and KGS handicap compensation', () => {
    expect(handicapBonusForWhite('chinese-ogs', 3)).toBe(3);
    expect(handicapBonusForWhite('chinese-kgs', 3)).toBe(2);
    expect(handicapBonusForWhite('chinese-kgs', 1)).toBe(0);
  });
});
