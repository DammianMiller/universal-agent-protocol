/**
 * Ladder/ideation join (wave 3 option B) — the ideation-outcome class is a
 * first-class ladder citizen: harvested best-of-N rounds of idea documents
 * rank, climb, and cut against a derived ideation tier exactly as visual and
 * api-behavior artifacts do, and the N3 divergence measure applies to
 * markdown candidates (clones at distance ~0, distinct explorations far).
 *
 * Verified live first (2026-11-24, /tmp/ideation-ladder-demo): a harvested
 * round measured three candidates, ranked the genuine set best, and cut
 * below tier with the compositionDepth directive — this file pins that
 * behavior so the join cannot silently regress.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTierLadder, candidateDivergence } from '../../src/quality/tier-ladder.js';
import { storeArtifactAnchor } from '../../src/quality/classes.js';
import { deriveTier } from '../../src/quality/tiers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-ladder-ideation-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------ fixtures ------------------------------- */

/** A genuine options set: stances committed, sub-structure, distinct domains. */
const RICH_DOC = `# Options

## Option A — measure retreads against the corpus
We choose the corpus-novelty axis: every candidate is embedded and measured against the long-term idea store, so a retread surfaces before curation. It wins on prior-art capture — the o7 corpus proved in-set distance is blind to prior work.

- Mechanism: retrieval query per candidate, nearest prior across collections
- Failure mode: a degraded embedding provider silently zeroes the signal — fail open with the reason

## Option B — cap runaway reasoning at the wall
We choose the request's own max_tokens as the only reliable cap: the wire budget field measured as a TOTAL completion cap, so any fraction setting is a wall shrink. It wins on operator control — no server rebuild, the knob already ships.

- Mechanism: leave the field off; the wall stays the caller's max_tokens
- Failure mode: a future build implementing a true thinking-only budget would make this conservative

## Option C — guard best-of-N against clone farming
We choose the divergence guard: near-duplicate candidates drop before measurement, so one exploration farmed N times cannot pass for N explorations. It wins on honesty — measured ok/degraded clones sit at distance zero.

- Mechanism: text Jaccard over significant words, kept-first dedupe
- Failure mode: schema-heavy transcripts share scaffolding, so the default is measure-only
`;

/** No stance, no structure — the degenerate shape. */
const FLAT_DOC = `# Options

## Option A
We could maybe do something with the axis. It might help. Hard to say.

## Option B
We could perhaps do something with the axis. It may help. Hard to say.
`;

function doc(name: string, text: string): { id: string; artifactPath: string } {
  const p = join(tmp, name);
  writeFileSync(p, text, 'utf-8');
  return { id: name, artifactPath: p };
}

/** Anchor a rich exemplar and derive the tier the ladder climbs to. */
function ideationTier(): string {
  const anchor = doc('anchor.md', RICH_DOC);
  storeArtifactAnchor(tmp, 'ideation-outcome', anchor.artifactPath);
  const tier = deriveTier(tmp, 'ideation-outcome', 'frontier')!;
  expect(tier.key).toBe('ideation-outcome/frontier');
  return tier.key;
}

/* ------------------------------- the join ------------------------------ */

describe('ladder/ideation join (wave 3 B)', () => {
  it('a harvested ideation round ranks the genuine set above the hedge stack and reaches the tier', async () => {
    const tierKey = ideationTier();
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: () => [doc('rich.md', RICH_DOC), doc('flat.md', FLAT_DOC)],
      maxRounds: 1,
    });
    expect(result.outcome).toBe('tier-reached');
    expect(result.winner).not.toBeNull();
    // The genuine options set wins, and the hedge stack did not carry it.
    expect(result.rounds[0].candidates.length).toBe(2);
    const winnerId = result.rounds[0].candidates.find(
      (c) => c.id === result.winner?.id
    );
    expect(winnerId?.id ?? result.winner?.id).toBe('rich.md');
  });

  it('an all-flat round cuts below tier with the composition directive the executor can act on', async () => {
    const tierKey = ideationTier();
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: () => [doc('flat1.md', FLAT_DOC), doc('flat2.md', FLAT_DOC)],
      maxRounds: 1,
    });
    expect(result.outcome).not.toBe('tier-reached');
    expect(result.finalGap?.axes.some((a) => a.status === 'fail')).toBe(true);
    const directive = result.finalGap?.axes
      .filter((a) => a.status === 'fail')
      .map((a) => a.directive ?? '')
      .join(' ');
    // The cut names what to ADD, not just that it failed — the live run's
    // behavior (compositionDepth directive on a flat set).
    expect(directive).toMatch(/composition|stance|novelty/);
  });

  it('N3 divergence applies to markdown candidates: clones at ~0, distinct explorations far', () => {
    const rich = doc('rich.md', RICH_DOC);
    const clone = doc('clone.md', RICH_DOC); // same bytes: distance 0
    const altered = doc(
      'altered.md',
      RICH_DOC.replace('corpus-novelty axis', 'corpus-recency axis').replace(
        'clone farming',
        'duplicate farming',
      ),
    );
    const distinct = doc(
      'distinct.md',
      `# Options\n\n## Option D — a different domain entirely\nWe choose fleet scheduling: pin the vision arm to daylight hours when the GPU is idle. It wins on cost.\n\n- Mechanism: cron the benchmark suite\n- Failure mode: contention with the pagoda round\n`,
    );
    expect(candidateDivergence(rich, clone)).toBe(0);
    // A few changed words on heavy shared scaffolding: still very close.
    expect(candidateDivergence(rich, altered)).toBeLessThan(0.15);
    // A genuinely different exploration: measurably far.
    expect(candidateDivergence(rich, distinct)).toBeGreaterThan(0.5);
  });

  it('the degenerate guard (no stance) is attributed, not scored as a near-miss', async () => {
    const tierKey = ideationTier();
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: () => [doc('flat.md', FLAT_DOC)],
      maxRounds: 1,
    });
    expect(result.outcome).not.toBe('tier-reached');
    // The degenerate reason appears in the run's records so the executor
    // prompt carries the fix (render candidates with stances).
    const serialized = JSON.stringify(result);
    expect(serialized).toMatch(/stance/);
  });
});
