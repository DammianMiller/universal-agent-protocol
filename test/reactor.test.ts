/**
 * Contract tests for the UAP Auto-Apply "Reactor" resolver.
 * See docs/design/UAP_REACTOR.md. This file is the protected oracle that the
 * `uap deliver` convergence loop implements src/coordination/reactor.ts against.
 *
 * Key formats (stable contract):
 *   droid    -> `droid:<name>`
 *   skill    -> `skill:<name>`
 *   pattern  -> `pattern:<abbreviation>`
 */
import { describe, it, expect } from 'vitest';
import {
  resolve,
  type ReactorContext,
  type ReactorOptions,
  type ReactorDeps,
} from '../src/coordination/reactor';
import type { CapabilityRouter, RoutingResult } from '../src/coordination/capability-router';
import type { PatternRouter, PatternDefinition } from '../src/coordination/pattern-router';

function stubCapabilityRouter(result: Partial<RoutingResult>): CapabilityRouter {
  const full: RoutingResult = {
    recommendedDroids: [],
    recommendedSkills: [],
    confidence: 0,
    reasoning: '',
    ...(result as RoutingResult),
  } as RoutingResult;
  return { routeTask: () => full } as unknown as CapabilityRouter;
}

function stubPatternRouter(defs: Array<Partial<PatternDefinition>>): PatternRouter {
  const full = defs.map((d, i) => ({
    id: d.id ?? i,
    file: d.file ?? `p${i}.md`,
    title: d.title ?? `Pattern ${i}`,
    abbreviation: d.abbreviation ?? `P${i}`,
    category: d.category ?? 'general',
    keywords: d.keywords ?? [],
  }));
  return { matchPatterns: () => full } as unknown as PatternRouter;
}

const baseCtx: ReactorContext = { event: 'user-prompt', promptText: 'do a thing' };

describe('reactor.resolve — assist mode', () => {
  it('smoke: composes real routers without throwing and returns a well-formed result', () => {
    const r = resolve({
      event: 'user-prompt',
      promptText: 'add JWT authentication and fix the security vulnerability in the login endpoint',
      changedFiles: ['src/auth/login.ts'],
    });
    expect(typeof r.inject).toBe('string');
    expect(typeof r.block).toBe('boolean');
    expect(Array.isArray(r.actions)).toBe(true);
    expect(Array.isArray(r.surfacedKeys)).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('stays silent below the inject threshold with no matched patterns', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({ confidence: 0.1 }),
      patternRouter: stubPatternRouter([]),
    };
    const r = resolve(baseCtx, { injectThreshold: 0.3 }, deps);
    expect(r.inject).toBe('');
    expect(r.actions).toHaveLength(0);
  });

  it('injects experts, skills, and patterns above threshold', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({
        confidence: 0.6,
        recommendedDroids: ['security-auditor'],
        recommendedSkills: ['sec-context-review'],
      }),
      patternRouter: stubPatternRouter([{ abbreviation: 'P12', title: 'Output Existence' }]),
    };
    const r = resolve(baseCtx, { injectThreshold: 0.3 }, deps);
    expect(r.inject).toContain('security-auditor');
    expect(r.inject).toContain('sec-context-review');
    expect(r.inject).toContain('P12');
    expect(r.confidence).toBe(0.6);
    expect(r.block).toBe(false);
  });

  it('auto-spawns an expert above the spawn threshold for a whitelisted type', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({
        confidence: 0.9,
        recommendedDroids: ['security-auditor'],
      }),
      patternRouter: stubPatternRouter([]),
    };
    const opts: ReactorOptions = { autoSpawnThreshold: 0.8, autoSpawnTaskTypes: ['security'] };
    const r = resolve(baseCtx, opts, deps);
    const spawn = r.actions.find((a) => a.kind === 'spawn-expert');
    expect(spawn).toBeDefined();
    expect(spawn?.target).toBe('security-auditor');
  });

  it('does NOT auto-spawn off-whitelist (only suggests)', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({
        confidence: 0.9,
        recommendedDroids: ['security-auditor'],
      }),
      patternRouter: stubPatternRouter([]),
    };
    const opts: ReactorOptions = { autoSpawnThreshold: 0.8, autoSpawnTaskTypes: ['migration'] };
    const r = resolve(baseCtx, opts, deps);
    expect(r.actions.find((a) => a.kind === 'spawn-expert')).toBeUndefined();
  });

  it('dedups against already-surfaced keys', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({
        confidence: 0.6,
        recommendedDroids: ['security-auditor', 'code-reviewer'],
      }),
      patternRouter: stubPatternRouter([]),
    };
    const ctx: ReactorContext = { ...baseCtx, surfaced: ['droid:security-auditor'] };
    const r = resolve(ctx, { injectThreshold: 0.3 }, deps);
    expect(r.surfacedKeys).toContain('droid:code-reviewer');
    expect(r.surfacedKeys).not.toContain('droid:security-auditor');
    expect(r.actions.some((a) => a.target === 'security-auditor')).toBe(false);
  });

  it('respects the inject character budget', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({
        confidence: 0.7,
        recommendedDroids: ['a-droid', 'b-droid', 'c-droid', 'd-droid', 'e-droid'],
        recommendedSkills: ['skill-one', 'skill-two', 'skill-three'],
      }),
      patternRouter: stubPatternRouter([
        { abbreviation: 'P12', title: 'Output Existence Guarantee Pattern' },
        { abbreviation: 'P35', title: 'Decoder First Strategy Pattern' },
      ]),
    };
    const r = resolve(baseCtx, { injectThreshold: 0.3, maxInjectChars: 200 }, deps);
    expect(r.inject.length).toBeLessThanOrEqual(200);
  });

  it('assist events never block', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({ confidence: 0.9, recommendedDroids: ['x'] }),
      patternRouter: stubPatternRouter([{ abbreviation: 'P1' }]),
    };
    for (const event of ['session-start', 'user-prompt', 'post-tool', 'stop', 'session-end'] as const) {
      expect(resolve({ event, promptText: 'x' }, undefined, deps).block).toBe(false);
    }
  });
});
