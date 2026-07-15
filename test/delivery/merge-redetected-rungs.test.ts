/**
 * mergeRedetectedRungs (PR #519 follow-up): the single-source redetect-merge
 * policy shared by the convergence loop and deliver's post-merge verification.
 */

import { describe, it, expect } from 'vitest';
import { mergeRedetectedRungs, type GateRung } from '../../src/delivery/verifier-ladder.js';

const rung = (id: string, tier?: string): GateRung =>
  ({ id, name: id, command: 'true', required: true, ...(tier ? { tier } : {}) }) as never;

describe('mergeRedetectedRungs', () => {
  it('merges only fast/runtime tiers by default (no silent escalation)', () => {
    const current = [rung('build', 'fast')];
    const merged = mergeRedetectedRungs(current, [
      rung('exec', 'runtime'),
      rung('deploy', 'deploy-dev'),
      rung('integration-suite', 'integration'),
    ]);
    expect(merged.map((r) => r.id)).toEqual(['build', 'exec']);
  });

  it('dedupes by id and returns the SAME array when nothing qualifies', () => {
    const current = [rung('build', 'fast')];
    expect(mergeRedetectedRungs(current, [rung('build', 'fast')])).toBe(current);
    expect(mergeRedetectedRungs(current, [])).toBe(current);
  });

  it('honors a caller-supplied allow filter', () => {
    const current = [rung('build', 'fast')];
    const merged = mergeRedetectedRungs(current, [rung('deploy', 'deploy-dev')], () => true);
    expect(merged.map((r) => r.id)).toEqual(['build', 'deploy']);
  });
});
