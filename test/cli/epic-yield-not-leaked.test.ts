/**
 * The plateau yield must reach the EPIC path and nothing else.
 *
 * `epicFlatTurnOption` is a pure function with its own tests, but nothing
 * proved where it is spread — and `deliver.ts` builds six `ConvergenceLoop`s
 * from a shared `loopConfig`. If the option ever reached the single-loop,
 * phased, orchestrated, lazy or re-converge paths, it would end runs early that
 * have no retry to fall back on, which is exactly the always-on rail that was
 * measured unreachable and removed from `convergence-loop.ts` last week.
 *
 * A source-text assertion, following the house precedent in
 * `run-time-budget.test.ts` and `stop-latch.test.ts`: the wiring is a closure
 * inside a 4000-line function, so this is the level at which it can be pinned.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(process.cwd(), 'src/cli/deliver.ts'), 'utf-8');

describe('epic plateau yield is confined to the epic loop', () => {
  it('is spread at exactly one construction site', () => {
    const calls = SRC.match(/\.\.\.epicFlatTurnOption\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('sits inside runEpicLoop, not in the shared loopConfig', () => {
    const start = SRC.indexOf('runEpicLoop: async (scoped, opts) => {');
    expect(start).toBeGreaterThan(-1);
    const spread = SRC.indexOf('...epicFlatTurnOption(');
    expect(spread).toBeGreaterThan(start);
    // …and within that closure, not somewhere later in the file.
    const closureEnd = SRC.indexOf('return loop.deliver(scoped);', start);
    expect(closureEnd).toBeGreaterThan(-1);
    expect(spread).toBeLessThan(closureEnd);
  });

  it('never names abortOnFlatTurns inside runDeliver, where the six loops are built', () => {
    // Every mention must live in the small helper region ABOVE runDeliver. The
    // six `new ConvergenceLoop(` sites and the shared `loopConfig` are all
    // inside that function, so a mention there is the leak this guards against.
    const body = SRC.slice(SRC.indexOf('async function runDeliver('));
    expect(body).not.toContain('abortOnFlatTurns');
    // And the helper region does mention it, so this test cannot pass vacuously
    // if the option is ever renamed.
    expect(SRC.slice(0, SRC.indexOf('async function runDeliver('))).toContain('abortOnFlatTurns');
  });

  it('passes the escalation ladder reach, so it cannot truncate the ladder', () => {
    // Without the second argument the rail can fire before the stronger-model
    // tier is ever issued — measured: an attempt master delivers on turn 6 was
    // abandoned on turn 4 with the stronger model never called.
    expect(SRC).toMatch(/\.\.\.epicFlatTurnOption\(\s*opts\?\.retriesRemaining,\s*escalationLadderReach\s*\)/);
  });
});
