import { describe, expect, it } from 'vitest';
import { KataGoBinModelParser } from '../src/ai/katago/binModelParser';

const text = (s: string) => new TextEncoder().encode(s);

describe('KataGo binary parser boundaries', () => {
  it('does not read beyond a Uint8Array view into its backing buffer', () => {
    const backing = new Uint8Array(64);
    backing.set(text('@BIN@'));
    const parser = new KataGoBinModelParser(backing.subarray(0, 7));
    expect(() => parser.readBinaryFloats(1)).toThrow('EOF');
  });
  it('reads valid binary floats from a nonzero-offset view', () => {
    const backing = new Uint8Array(64);
    backing.set(text('@BIN@'), 7);
    new DataView(backing.buffer).setFloat32(12, 1.25, true);
    const parser = new KataGoBinModelParser(backing.subarray(7, 16));
    expect([...parser.readBinaryFloats(1)]).toEqual([1.25]);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid binary element count %s', count => {
    expect(() => new KataGoBinModelParser(text('@BIN@1234')).readBinaryFloats(count)).toThrow();
  });
  it.each(['12junk', '1.5', '1e3', '9007199254740993'])('rejects invalid integer token %s', token => {
    expect(() => new KataGoBinModelParser(text(token)).readInt()).toThrow('Invalid int');
  });
  it.each(['1.2junk', 'Infinity', 'NaN', '0x10'])('rejects invalid float token %s', token => {
    expect(() => new KataGoBinModelParser(text(token)).readFloatAscii()).toThrow('Invalid float');
  });
  it('accepts signed integers and decimal exponent notation', () => {
    const parser = new KataGoBinModelParser(text('-12 +4 -1.25e-3 .5 2.'));
    expect(parser.readInt()).toBe(-12);
    expect(parser.readInt()).toBe(4);
    expect(parser.readFloatAscii()).toBe(-0.00125);
    expect(parser.readFloatAscii()).toBe(0.5);
    expect(parser.readFloatAscii()).toBe(2);
  });
});
