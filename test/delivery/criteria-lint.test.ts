/**
 * Plan-time criteria lint (evidence-gates uplift, workstream C): planner
 * criteria that assert runtime BEHAVIOR without a machine-checkable anchor
 * are exactly what shallow user journeys then "verify" (paired-qwen38-games,
 * 2026-09-24: "scramble-control" never clicked scramble). These tests pin
 * the classifier, the in-place rewrite, and the knob precedence.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  classifyCriterion,
  lintCriteria,
  resolveCriteriaLint,
  EVIDENCE_CLAUSE_MARKER,
} from '../../src/delivery/criteria-lint.js';

describe('classifyCriterion', () => {
  it('marks criteria with executable anchors executable', () => {
    expect(classifyCriterion('`npm test` exits 0')).toBe('executable');
    expect(classifyCriterion('creates src/cube/renderer.ts exporting CubeRenderer')).toBe('executable');
    expect(classifyCriterion('the page displays the exact text "RUBIK\'S CUBE"')).toBe('executable');
    expect(classifyCriterion('output.txt weighs <= 2500 bytes')).toBe('executable');
  });

  it('marks anchor-free interaction claims behavioral', () => {
    expect(classifyCriterion('the user can click a face and the stickers update')).toBe('behavioral');
    expect(classifyCriterion('pressing the scramble button randomizes the cube')).toBe('behavioral');
    expect(classifyCriterion('the sprite animates smoothly across the canvas')).toBe('behavioral');
    // Subject-verb order (review finding 7).
    expect(classifyCriterion('the display updates after each move')).toBe('behavioral');
  });

  it('a quoted UI label is NOT an executable anchor (review finding 4)', () => {
    // The measured failure shape wearing punctuation: a quoted control label
    // inside an interaction claim is not machine-checkable.
    expect(classifyCriterion('clicking "Scramble" randomizes the cube')).toBe('behavioral');
  });

  it('prose "make"/"sh" is not a command anchor (review finding 5)', () => {
    expect(classifyCriterion('the layout should make use of a consistent grid')).toBe('static');
    expect(classifyCriterion('make test passes')).toBe('executable');
  });

  it('a bare ACCEPTANCE EVIDENCE REQUIRED marker does not mint executability (security finding 1)', () => {
    const minted = 'the user can rotate faces — ACCEPTANCE EVIDENCE REQUIRED';
    expect(classifyCriterion(minted)).toBe('behavioral');
    const r = lintCriteria([minted]);
    expect(r.stats.rewritten).toBe(1);
    expect(r.criteria[0]).toContain('user-paths.json');
  });

  it('percent thresholds anchor correctly (review finding 6)', () => {
    expect(classifyCriterion('coverage stays at 100%')).toBe('executable');
  });

  it('marks plain structural claims static', () => {
    expect(classifyCriterion('the app has a coherent visual hierarchy')).toBe('static');
    expect(classifyCriterion('state is managed in a single store')).toBe('static');
  });

  it('treats an already-linted criterion as executable (idempotence)', () => {
    const once = lintCriteria(['the user can click a face and the stickers update']).criteria[0];
    expect(classifyCriterion(once)).toBe('executable');
  });
});

describe('lintCriteria', () => {
  it('rewrites behavioral criteria with the evidence clause and counts stats', () => {
    const r = lintCriteria([
      '`npm run build` exits 0',
      'the user can drag to rotate and the cube updates the display',
      'the layout uses a grid',
    ]);
    expect(r.stats).toEqual({ executable: 1, behavioral: 1, static: 1, rewritten: 1 });
    expect(r.criteria[0]).toBe('`npm run build` exits 0');
    expect(r.criteria[1]).toContain(EVIDENCE_CLAUSE_MARKER);
    expect(r.criteria[1]).toContain('user-paths.json');
    expect(r.criteria[2]).toBe('the layout uses a grid');
  });

  it('never appends the clause twice', () => {
    const once = lintCriteria(['clicking reset restores the solved state']);
    const twice = lintCriteria(once.criteria);
    expect(twice.stats.rewritten).toBe(0);
    expect(twice.criteria[0]).toBe(once.criteria[0]);
  });

  it('passes an empty list through', () => {
    expect(lintCriteria([]).criteria).toEqual([]);
  });
});

describe('resolveCriteriaLint', () => {
  afterEach(() => {
    delete process.env.UAP_DELIVER_CRITERIA_LINT;
  });

  it('defaults ON', () => {
    delete process.env.UAP_DELIVER_CRITERIA_LINT;
    // cwd pointed at a directory with no .uap.json so the file cannot
    // interfere with the default assertion.
    expect(resolveCriteriaLint(undefined, {}, '/nonexistent-uap-criteria-lint')).toBe(true);
  });

  it('env 0/false/off disables', () => {
    for (const v of ['0', 'false', 'OFF']) {
      expect(resolveCriteriaLint(undefined, { UAP_DELIVER_CRITERIA_LINT: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('env wins over config', () => {
    expect(
      resolveCriteriaLint({ criteriaLint: false }, { UAP_DELIVER_CRITERIA_LINT: '1' } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it('config deliver.criteriaLint=false disables when env is unset', () => {
    expect(resolveCriteriaLint({ criteriaLint: false }, {} as NodeJS.ProcessEnv)).toBe(false);
  });
});
