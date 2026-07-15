/**
 * CI watch + re-converge runner (extracted from deliver.ts): pass counting,
 * terminal statuses, feedback plumbing, and the changed-files fallback —
 * every seam faked (no git, no CI, no model).
 */

import { describe, it, expect } from 'vitest';
import { runCiReconverge, type CiReconvergeDeps, type CiWatchOutcome } from '../../src/delivery/ci-reconverge.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';

const ok = (over: Partial<DeliveryResult> = {}): DeliveryResult => ({
  success: true,
  alreadyDelivered: false,
  turns: 1,
  bestScore: 1,
  bestTurn: 1,
  history: [],
  finalFeedback: '',
  finalOutput: '',
  totalDurationMs: 1,
  ...over,
});

function deps(over: Partial<CiReconvergeDeps>): CiReconvergeDeps {
  return {
    instruction: 'ship it',
    initial: ok(),
    ciPasses: 2,
    commitAndWatch: async () => ({ status: 'green' }),
    changedFiles: () => ['fallback.ts'],
    reconverge: async () => ok(),
    ...over,
  };
}

describe('runCiReconverge', () => {
  it('returns the initial result untouched on first-pass green (with the deploy detail)', async () => {
    const notes: string[] = [];
    const initial = ok({ finalOutput: 'the goods' });
    const r = await runCiReconverge(
      deps({ initial, greenDetail: ' (dev/staging deploy verified)', note: (l) => notes.push(l) })
    );
    expect(r).toBe(initial);
    expect(notes.some((n) => n.includes('CI green (dev/staging deploy verified)'))).toBe(true);
  });

  it('skipped / no-run end the watch WITHOUT failing the mission', async () => {
    for (const status of ['skipped', 'no-run'] as const) {
      let watches = 0;
      const r = await runCiReconverge(
        deps({
          commitAndWatch: async () => {
            watches++;
            return { status, feedback: 'no workflow' };
          },
        })
      );
      expect(r.success).toBe(true);
      expect(watches).toBe(1);
    }
  });

  it('a failed run re-converges against the CI feedback, then the retry can go green', async () => {
    const watchResults: CiWatchOutcome[] = [
      { status: 'failed', feedback: 'lint job exploded' },
      { status: 'green' },
    ];
    const prompts: string[] = [];
    const r = await runCiReconverge(
      deps({
        ciPasses: 3,
        commitAndWatch: async () => watchResults.shift()!,
        reconverge: async (prompt) => {
          prompts.push(prompt);
          return ok();
        },
      })
    );
    expect(r.success).toBe(true);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('ship it');
    expect(prompts[0]).toContain('lint job exploded');
  });

  it('exhausting the passes fails the mission with the CI feedback attached', async () => {
    let watches = 0;
    const r = await runCiReconverge(
      deps({
        ciPasses: 2,
        commitAndWatch: async () => {
          watches++;
          return { status: 'timeout', feedback: `still red after watch ${watches}` };
        },
        reconverge: async () => ok(),
      })
    );
    expect(r.success).toBe(false);
    expect(r.finalFeedback).toContain('still red after watch 2');
    expect(watches).toBe(2); // pass cap honored
  });

  it('a re-converge that cannot reach local-green stops the watch immediately', async () => {
    let watches = 0;
    const r = await runCiReconverge(
      deps({
        ciPasses: 5,
        commitAndWatch: async () => {
          watches++;
          return { status: 'failed', feedback: 'red' };
        },
        reconverge: async () => ok({ success: false, finalFeedback: 'local gates broke' }),
      })
    );
    expect(r.success).toBe(false);
    expect(r.finalFeedback).toBe('local gates broke');
    expect(watches).toBe(1); // never pushed a non-green tree again
  });

  it('falls back to the explicit changed-file list when the loop reported none', async () => {
    const committed: string[][] = [];
    await runCiReconverge(
      deps({
        initial: ok({ history: [] }), // agentic executor: no filesApplied
        commitAndWatch: async (files) => {
          committed.push(files);
          return { status: 'green' };
        },
      })
    );
    expect(committed).toEqual([['fallback.ts']]);
  });

  it('prefers the loop-applied file set when present', async () => {
    const committed: string[][] = [];
    await runCiReconverge(
      deps({
        initial: ok({ history: [{ filesApplied: ['a.ts', 'b.ts'] } as never, { filesApplied: ['a.ts'] } as never] }),
        commitAndWatch: async (files) => {
          committed.push(files);
          return { status: 'green' };
        },
      })
    );
    expect(committed).toEqual([['a.ts', 'b.ts']]); // deduped, no fallback
  });
});

describe('round-2 review fixes', () => {
  it('an EMPTY file set (loop + fallback) skips the watch — never a blanket git add -A', async () => {
    let watched = 0;
    const notes: string[] = [];
    const r = await runCiReconverge(
      deps({
        initial: ok({ history: [] }),
        changedFiles: () => [],
        commitAndWatch: async () => {
          watched++;
          return { status: 'green' };
        },
        note: (l) => notes.push(l),
      })
    );
    expect(watched).toBe(0); // the watcher never saw an empty set
    expect(r.success).toBe(true);
    expect(notes.some((n) => n.includes('no changed files'))).toBe(true);
  });

  it('a re-converge FOLDS into the mission result instead of replacing it', async () => {
    const initial = ok({
      turns: 3,
      history: [{ filesApplied: ['first.ts'] } as never],
      finalOutput: 'initial output',
    });
    const watchResults = [
      { status: 'failed', feedback: 'red' } as const,
      { status: 'green' } as const,
    ];
    const r = await runCiReconverge(
      deps({
        initial,
        ciPasses: 3,
        commitAndWatch: async () => watchResults.shift()!,
        reconverge: async () => ok({ turns: 2, history: [{ filesApplied: ['fix.ts'] } as never], finalOutput: 'fixed' }),
      })
    );
    expect(r.turns).toBe(5); // 3 initial + 2 re-converge — history survives
    expect(r.history).toHaveLength(2);
    expect(r.finalOutput).toBe('fixed');
    // the caller's object was never mutated
    expect(initial.turns).toBe(3);
    expect(initial.history).toHaveLength(1);
  });
});
