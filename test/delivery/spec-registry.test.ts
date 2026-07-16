/**
 * Acceptance-spec registry (extracted from deliver.ts): per-root resolution
 * under parallel dispatch, evidence isolation, breaker identity per spec,
 * and the shared-spec lifecycle the phased/epic/watch-ci paths rely on.
 */
import { describe, it, expect } from 'vitest';
import { createSpecRegistry } from '../../src/delivery/spec-registry.js';

const make = (over: { flipLimit?: number } = {}) =>
  createSpecRegistry({ initialSpec: 'MISSION', sharedRoot: '/proj', flipLimit: over.flipLimit ?? 2 });

describe('createSpecRegistry', () => {
  it('resolves per-root when begun, falls back to the shared spec otherwise', () => {
    const r = make();
    expect(r.resolve('/proj')).toBe('MISSION');
    expect(r.resolve('/wt/task-1')).toBe('MISSION');
    r.begin('/wt/task-1', 'TASK ONE');
    expect(r.resolve('/wt/task-1')).toBe('TASK ONE');
    expect(r.resolve('/proj')).toBe('MISSION'); // isolated worktree never re-points shared
    r.end('/wt/task-1', 'MISSION');
    expect(r.resolve('/wt/task-1')).toBe('MISSION');
  });

  it('an in-tree task (root === sharedRoot) re-points the shared spec and end() restores it', () => {
    const r = make();
    r.begin('/proj', 'IN-TREE TASK');
    expect(r.sharedSpec()).toBe('IN-TREE TASK');
    expect(r.resolve('/other')).toBe('IN-TREE TASK'); // shared fallback follows
    r.end('/proj', 'MISSION');
    expect(r.sharedSpec()).toBe('MISSION');
    expect(r.resolve('/proj')).toBe('MISSION');
  });

  it('setShared re-points and resets ONLY the shared root evidence', () => {
    const r = make();
    r.recordWrites('/proj', 3);
    r.recordWrites('/wt/task-1', 5);
    r.setShared('PHASE 2');
    expect(r.resolve('/proj')).toBe('PHASE 2');
    expect(r.evidence('/proj').writes).toBe(0); // fresh spec — fresh evidence
    expect(r.evidence('/wt/task-1').writes).toBe(5); // other roots untouched
  });

  it('begin() zeroes the root evidence; end() deliberately does NOT', () => {
    const r = make();
    r.recordWrites('/wt/t', 4);
    r.begin('/wt/t', 'T');
    expect(r.evidence('/wt/t').writes).toBe(0);
    r.recordWrites('/wt/t', 2);
    r.end('/wt/t', 'MISSION');
    expect(r.evidence('/wt/t').writes).toBe(2); // re-converge still sees the writes
  });

  it('recordWrites ignores non-positive counts and accumulates per root', () => {
    const r = make();
    r.recordWrites('/a', 0);
    expect(r.evidence('/a').writes).toBe(0);
    r.recordWrites('/a', 2);
    r.recordWrites('/a', 3);
    r.recordWrites('/b', 1);
    expect(r.evidence('/a').writes).toBe(5);
    expect(r.evidence('/b').writes).toBe(1);
  });

  it('evidence slots are identity-stable (breaker closures observe later writes)', () => {
    const r = make();
    const slot = r.evidence('/proj');
    r.recordWrites('/proj', 1);
    expect(slot.writes).toBe(1);
  });

  it('breakers are cached per (spec, root) — repeat calls share state, different specs do not', () => {
    const r = make({ flipLimit: 2 });
    r.recordWrites('/proj', 1); // change evidence so the breaker can trip
    const reject = { passed: false, feedback: 'no' };
    // Rejection 1 of spec A: flip 1 of limit 2 → judge verdict stands.
    const first = r.breaker('A', '/proj').check('A', reject);
    expect(first.overridden).toBeUndefined();
    // Rejection 2 through a fresh breaker() call: the CACHED instance carried
    // the flip count, so the limit trips and the gates win.
    const second = r.breaker('A', '/proj').check('A', reject);
    expect(second.overridden).toBe(true);
    // A different spec starts from a fresh breaker.
    const other = r.breaker('B', '/proj').check('B', reject);
    expect(other.overridden).toBeUndefined();
  });

  it('the SAME spec from two roots gets independent breakers reading their own evidence', () => {
    const r = make({ flipLimit: 1 });
    const reject = { passed: false, feedback: 'no' };
    r.recordWrites('/wt/a', 1); // root A has change evidence; root B has none
    // Root A trips its breaker (limit 1 + evidence) — gates win.
    expect(r.breaker('SAME', '/wt/a').check('SAME', reject).overridden).toBe(true);
    // Root B's breaker is a DIFFERENT instance whose guard reads B's (zero)
    // evidence — the zero-diff guard keeps the judge verdict, no override.
    expect(r.breaker('SAME', '/wt/b').check('SAME', reject).overridden).toBeUndefined();
  });

  it('runaway guard clears the breaker cache past 100 specs without breaking resolution', () => {
    const r = make();
    for (let i = 0; i <= 105; i++) r.breaker(`spec-${i}`, '/proj');
    // No assertion on internals — just that a post-clear breaker still works.
    const b = r.breaker('after-clear', '/proj');
    expect(b.check('after-clear', { passed: true, feedback: '' }).passed).toBe(true);
  });
});
