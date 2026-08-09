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
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

  it('injects matched patterns but excludes low-confidence experts', () => {
    const deps: ReactorDeps = {
      capabilityRouter: stubCapabilityRouter({
        confidence: 0.2, // below the 0.3 inject threshold
        recommendedDroids: ['security-auditor'],
        recommendedSkills: ['sec-context-review'],
      }),
      patternRouter: stubPatternRouter([{ abbreviation: 'P12', title: 'Output Existence' }]),
    };
    const r = resolve(baseCtx, { injectThreshold: 0.3 }, deps);
    // pattern injects (kept it from being silent)...
    expect(r.inject).toContain('P12');
    // ...but the low-confidence experts/skills do NOT ride along
    expect(r.inject).not.toContain('security-auditor');
    expect(r.inject).not.toContain('sec-context-review');
    expect(r.actions.some((a) => a.target === 'security-auditor')).toBe(false);
    expect(r.actions.some((a) => a.target === 'sec-context-review')).toBe(false);
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


describe('reactor.resolve — delivery routing (#3-B / #3-C2)', () => {
  it('injects a deliver reminder for a code capability AT/ABOVE the inject threshold', () => {
    const r = resolve(
      { event: 'user-prompt', promptText: 'build a feature' },
      undefined,
      {
        capabilityRouter: stubCapabilityRouter({
          matchedCapabilities: ['typescript'],
          confidence: 0.6,
        }),
        patternRouter: stubPatternRouter([]),
      }
    );
    expect(r.inject.toLowerCase()).toContain('route through deliver');
    expect(r.surfacedKeys).toContain('deliver:routing');
  });

  it('#3-C2: does NOT inject on a LOW-confidence code capability with no source file', () => {
    const r = resolve(
      { event: 'user-prompt', promptText: 'monitor the build and plan options' },
      undefined,
      {
        capabilityRouter: stubCapabilityRouter({
          matchedCapabilities: ['typescript'],
          confidence: 0.1,
        }),
        patternRouter: stubPatternRouter([]),
      }
    );
    expect(r.surfacedKeys).not.toContain('deliver:routing');
  });

  it('#3-C2: injects when changedFiles has a source file even at low confidence', () => {
    const r = resolve(
      { event: 'user-prompt', promptText: 'tweak it', changedFiles: ['src/foo.ts'] },
      undefined,
      {
        capabilityRouter: stubCapabilityRouter({ matchedCapabilities: [], confidence: 0 }),
        patternRouter: stubPatternRouter([]),
      }
    );
    expect(r.surfacedKeys).toContain('deliver:routing');
  });

  it('does NOT inject for a non-code capability', () => {
    const r = resolve(
      { event: 'user-prompt', promptText: 'write the docs' },
      undefined,
      {
        capabilityRouter: stubCapabilityRouter({
          matchedCapabilities: ['documentation'],
          confidence: 0.6,
        }),
        patternRouter: stubPatternRouter([]),
      }
    );
    expect(r.surfacedKeys).not.toContain('deliver:routing');
  });

  it('dedupes when deliver:routing already surfaced this session', () => {
    const r = resolve(
      { event: 'user-prompt', promptText: 'build a feature', surfaced: ['deliver:routing'] },
      undefined,
      {
        capabilityRouter: stubCapabilityRouter({
          matchedCapabilities: ['typescript'],
          confidence: 0.6,
        }),
        patternRouter: stubPatternRouter([]),
      }
    );
    expect(r.surfacedKeys).not.toContain('deliver:routing');
  });
});


describe('reactor.resolve — engineering principles stance', () => {
  const deps: ReactorDeps = {
    capabilityRouter: stubCapabilityRouter({ confidence: 0.1 }),
    patternRouter: stubPatternRouter([]),
  };

  function project(principles?: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'uap-reactor-principles-'));
    if (principles) {
      writeFileSync(join(dir, '.uap.json'), JSON.stringify({ principles }));
    }
    return dir;
  }

  it('asks for the stance even at LOW routing confidence', () => {
    // It is a standalone context block, not a routed capability: a code task
    // whose routing is uncertain still needs the compat question answered.
    const cwd = project();
    try {
      const r = resolve(
        { event: 'user-prompt', promptText: 'implement the parser', cwd },
        { injectThreshold: 0.9 },
        deps
      );
      expect(r.surfacedKeys).toContain('principles:stance');
      expect(r.inject).toContain('Engineering principles');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('asks once — dedupes on the surfaced key', () => {
    const cwd = project();
    try {
      const r = resolve(
        {
          event: 'user-prompt',
          promptText: 'implement the parser',
          cwd,
          surfaced: ['principles:stance'],
        },
        undefined,
        deps
      );
      expect(r.surfacedKeys).not.toContain('principles:stance');
      expect(r.inject).not.toContain('Engineering principles');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('goes quiet once the project has answered', () => {
    const cwd = project({ compat: 'preserve', maturity: 'production' });
    try {
      const r = resolve({ event: 'user-prompt', promptText: 'implement the parser', cwd }, undefined, deps);
      expect(r.surfacedKeys).not.toContain('principles:stance');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('stays silent on work that will not write code', () => {
    const cwd = project();
    try {
      const r = resolve({ event: 'user-prompt', promptText: 'what does this repo do?', cwd }, undefined, deps);
      expect(r.surfacedKeys).not.toContain('principles:stance');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('reactor.resolve — the deliver advice must match what the gate does', () => {
  /**
   * The advice used to say "direct Edit/Write on source files is gated and will
   * be blocked". That is false — `delivery_enforcement.py` allows a trivial Edit
   * (under UAP_DELIVER_TRIVIAL_EDIT_CHARS, default 240), and never fires on
   * deleting or renaming a file, or on docs/tests/scripts. Reading it as
   * "deliver is the only way to touch code" cost a live incident on 2026-08-09:
   * a three-file DELETION was routed through deliver, and the loop — with
   * nothing to author — invented an unrequested dependency that broke the build.
   */
  const codeTask = () =>
    resolve(
      { event: 'user-prompt', promptText: 'build a feature' },
      undefined,
      {
        capabilityRouter: stubCapabilityRouter({ matchedCapabilities: ['typescript'], confidence: 0.6 }),
        patternRouter: stubPatternRouter([]),
      }
    );

  it('no longer claims every direct Edit/Write is blocked', () => {
    const t = codeTask().inject.toLowerCase();
    expect(t).not.toContain('direct edit/write on source files is gated');
    expect(t).not.toMatch(/edit\/write[^.]*will be blocked/);
  });

  it('scopes the routing to SUBSTANTIVE changes', () => {
    expect(codeTask().inject.toLowerCase()).toContain('substantive');
  });

  it('names the work that is NOT gated, so it is not needlessly routed', () => {
    const t = codeTask().inject.toLowerCase();
    expect(t).toContain('deleting or renaming');
    expect(t).toMatch(/docs, tests, scripts/);
    expect(t).toContain('not gated');
  });

  it('warns against handing deliver a task with nothing to author', () => {
    // The mechanism behind the live incident: the loop's job is to make gates
    // pass, so with nothing to write it improvises.
    expect(codeTask().inject.toLowerCase()).toContain('invent work');
  });

  it('still routes real code work through deliver', () => {
    // The point is accuracy, not removing the routing.
    const r = codeTask();
    expect(r.inject.toLowerCase()).toContain('route through deliver');
    expect(r.surfacedKeys).toContain('deliver:routing');
  });
});
