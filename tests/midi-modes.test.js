// Endless encoders, 14-bit CC and NRPN: the decoding that needs no session. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna;
await import('../logic.js');
const logic = globalThis.AddOnLogic;

const cc = (n, v, ch = 1) => logic.parseMidi([0xb0 | (ch - 1), n, v]);
const decode = () => {
  const mapper = { hires: new Map() };
  return (msg) => logic.Mapper.prototype.decode.call(mapper, msg, 'dev');
};

describe('relative encoders', () => {
  it('reads clicks in the three encodings', () => {
    expect([1, 3, 127, 126, 64, 0].map((v) => logic.relativeDelta('twos', v))).toEqual([1, 3, -1, -2, 0, 0]);
    expect([1, 3, 65, 66, 64].map((v) => logic.relativeDelta('signmag', v))).toEqual([1, 3, -1, -2, 0]);
    expect([65, 66, 63, 62, 64].map((v) => logic.relativeDelta('offset', v))).toEqual([1, 2, -1, -2, 0]);
  });
  it('guesses the encoding from a first click, when it can', () => {
    expect([127, 1, 65, 63, 90].map((v) => logic.guessEncoding(v))).toEqual(['twos', 'twos', 'signmag', 'offset', undefined]);
  });
});

describe('14-bit CC and NRPN', () => {
  it('joins an MSB/LSB pair when either half arrives', () => {
    const d = decode();
    expect(d(cc(1, 64))).toEqual([expect.objectContaining({ type: 'cc14', number: 1, raw: 64 << 7 })]);
    expect(d(cc(33, 5))).toEqual([expect.objectContaining({ type: 'cc14', number: 1, raw: (64 << 7) | 5 })]);
    expect(d(cc(34, 5))).toEqual([]); // no MSB for CC 2 yet
  });
  it('keeps channels apart', () => {
    const d = decode();
    d(cc(1, 100, 1));
    expect(d(cc(33, 0, 2))).toEqual([]);
  });
  it('makes an NRPN from the parameter select and the data entry, never from an RPN', () => {
    const d = decode();
    d(cc(99, 1));
    d(cc(98, 2));
    expect(d(cc(6, 3)).filter((m) => m.type === 'nrpn')).toEqual([expect.objectContaining({ number: 130, raw: 3 << 7 })]);
    expect(d(cc(38, 9)).filter((m) => m.type === 'nrpn')).toEqual([expect.objectContaining({ number: 130, raw: (3 << 7) | 9 })]);
    d(cc(101, 0));
    d(cc(100, 0));
    expect(d(cc(6, 3)).filter((m) => m.type === 'nrpn')).toEqual([]);
  });
  it('types sources in, and labels them', () => {
    expect(logic.manualSource({ type: 'nrpn', number: '1/2' })).toEqual({ device: null, type: 'nrpn', channel: null, number: 130 });
    expect(logic.manualSource({ type: 'nrpn', number: '128/0' })).toBeUndefined();
    expect(logic.manualSource({ type: 'nrpn', number: 16384 })).toBeUndefined();
    expect(logic.manualSource({ type: 'cc14', number: 31 }).number).toBe(31);
    expect(logic.manualSource({ type: 'cc14', number: 32 })).toBeUndefined();
    expect(logic.sourceLabel({ type: 'cc14', number: 1 })).toBe('CC 1+33 (14-bit)');
    expect(logic.sourceLabel({ type: 'nrpn', number: 130 })).toBe('NRPN 1/2');
  });
});
