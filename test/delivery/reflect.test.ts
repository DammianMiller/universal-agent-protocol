import { describe, it, expect } from 'vitest';
import { ReflectArchive, parseApproachRewrite } from '../../src/delivery/reflect.js';

describe('ReflectArchive — Pareto best-K', () => {
  it('keeps the best-K candidates by score', () => {
    const a = new ReflectArchive(2);
    a.add({ instruction: 'a', score: 0.5, turn: 1 });
    a.add({ instruction: 'b', score: 0.9, turn: 2 });
    a.add({ instruction: 'c', score: 0.7, turn: 3 });
    expect(a.size()).toBe(2);
    expect(a.all().map((x) => x.instruction)).toEqual(['b', 'c']); // 0.9, 0.7
    expect(a.best()?.instruction).toBe('b');
  });

  it('dedupes by instruction, keeping the higher score', () => {
    const a = new ReflectArchive(4);
    a.add({ instruction: 'a', score: 0.4, turn: 1 });
    a.add({ instruction: 'a', score: 0.8, turn: 5 });
    expect(a.size()).toBe(1);
    expect(a.best()).toMatchObject({ instruction: 'a', score: 0.8 });
  });

  it('breaks score ties by earlier turn', () => {
    const a = new ReflectArchive(4);
    a.add({ instruction: 'late', score: 0.6, turn: 9 });
    a.add({ instruction: 'early', score: 0.6, turn: 2 });
    expect(a.best()?.instruction).toBe('early');
  });

  it('reseedFrom returns the best candidate DIFFERENT from the current one', () => {
    const a = new ReflectArchive(4);
    a.add({ instruction: 'current', score: 0.9, turn: 1 });
    a.add({ instruction: 'other', score: 0.7, turn: 2 });
    expect(a.reseedFrom('current')?.instruction).toBe('other');
    // nothing different to try
    const b = new ReflectArchive(4);
    b.add({ instruction: 'only', score: 0.5, turn: 1 });
    expect(b.reseedFrom('only')).toBeUndefined();
  });

  it('does not collapse to the latest candidate (avoids local optimum)', () => {
    const a = new ReflectArchive(3);
    a.add({ instruction: 'good', score: 0.95, turn: 1 });
    for (let t = 2; t < 8; t++) a.add({ instruction: `weak${t}`, score: 0.1, turn: t });
    // the strong early candidate is retained despite many later weak ones
    expect(a.best()?.instruction).toBe('good');
  });
});

describe('parseApproachRewrite — fail-soft', () => {
  it('parses a valid rewrite', () => {
    const r = parseApproachRewrite('noise {"why":"wrong data model","newInstruction":"use a map"} trailing');
    expect(r).toEqual({ why: 'wrong data model', newInstruction: 'use a map' });
  });
  it('returns null when there is no usable newInstruction', () => {
    expect(parseApproachRewrite('no json here')).toBeNull();
    expect(parseApproachRewrite('{"why":"x"}')).toBeNull();
    expect(parseApproachRewrite('{"newInstruction":"  "}')).toBeNull();
    expect(parseApproachRewrite('{bad json')).toBeNull();
  });
  it('tolerates a missing why', () => {
    expect(parseApproachRewrite('{"newInstruction":"do X"}')).toEqual({ why: '', newInstruction: 'do X' });
  });
});
