/**
 * Wave 4 H — corpus-novelty as a measured (advisory) gap axis.
 *
 * The deterministic ideation axes cannot see retreads: a document can carry
 * five fresh-sounding sections that all restate known prior art. The N1
 * corpus-novelty seam measures each candidate's distance from the fleet's
 * nearest prior solution; this file pins its join to the GAP command —
 * `uap quality gap --file <doc> --tier ideation-outcome/<t> --corpus`.
 *
 * Doctrine pinned here:
 *   * ADVISORY, non-gating: the overlay never changes the gap's exit code —
 *     tier thresholds stay deterministic; promotion is an explicit operator act.
 *   * Fail-open with a reason: a dead seam prints why and the gap still reports.
 *   * Class-guarded: the overlay is ideation-only; other classes say so and skip.
 *   * Candidate-per-section: one measurement per `##` section, `search_query:`
 *     prefix, on the injected seam (same stubs as ideation-corpus.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gapCmd } from '../../src/cli/quality.js';
import { storeArtifactAnchor } from '../../src/quality/classes.js';
import { deriveTier, saveTier } from '../../src/quality/tiers.js';

let tmp: string;
let logs: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-gap-corpus-'));
  logs = [];
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const RICH_ANCHOR = `# Frontier ideas

## Option A
We will drive the palette via a measured 12-step hue ramp per material family,
because the frame's edge contrast collapses under reuse; this targets edgeFrac.

## Option B
We should relocate the warm-pixel probe onto lantern emissives with tight
falloff, since the wide shot's darkFrac hides the courtyard depth.

## Option C
The render loop must batch draw calls by material, not by mesh, to recover the
frame budget lost to shader swaps; stance: this is the load-bearing change.
`;

/** A gappable ideation tier anchored on the rich exemplar. */
function ideationTier(): string {
  const p = join(tmp, 'anchor.md');
  writeFileSync(p, RICH_ANCHOR, 'utf-8');
  storeArtifactAnchor(tmp, 'ideation-outcome', p);
  const tier = deriveTier(tmp, 'ideation-outcome', 'frontier')!;
  saveTier(tmp, tier);
  return tier.key;
}

/** An injected corpus seam: fixed scores per candidate, named collections. */
function seam(scores: number[][]) {
  let i = 0;
  return {
    embed: async () => new Array<number>(768).fill(0),
    search: async (
      _client: unknown,
      _collection: string,
      _vector: number[],
      _limit: number
    ) => {
      const row = scores[Math.min(i++, scores.length - 1)] ?? [];
      return row.map((score) => ({ score, payload: { content: 'prior' } }));
    },
    listCollections: async () => ['agent_memory_v768'],
    providerName: () => 'nomic',
  };
}

const gapDoc = () => {
  const p = join(tmp, 'gap.md');
  writeFileSync(p, RICH_ANCHOR, 'utf-8');
  return p;
};

describe('gap --corpus: the advisory novelty overlay (wave 4 H)', () => {
  it('measures each candidate section and prints mean + closest-to-prior, without changing the verdict', async () => {
    const tier = ideationTier();
    // First candidate nearly duplicates prior art (0.95), the others are far:
    // distances [0.05, 0.9, 0.8] — mean 0.58333, closest-to-prior 0.05.
    await gapCmd(tmp, { file: gapDoc(), tier, corpus: true }, seam([[0.95], [0.1], [0.2]]));
    const out = logs.join('');
    expect(out).toContain('corpus_novelty (advisory, non-gating)');
    expect(out).toContain('mean 0.58333');
    expect(out).toContain('closest-to-prior 0.05');
    expect(out).toContain('agent_memory_v768');
    // The overlay is advisory: a passing tier still passes, exit code stays 0.
    expect(process.exitCode).toBeUndefined();
  });

  it('a failing gap stays failing with the overlay present — the axis never rescues', async () => {
    const tier = ideationTier();
    const hedge = join(tmp, 'hedge.md');
    writeFileSync(
      hedge,
      '# Ideas\n\n## Maybe\nWe could perhaps do something with the axis. It may help. Hard to say.\n',
      'utf-8'
    );
    await gapCmd(tmp, { file: hedge, tier, corpus: true }, seam([[0.9]]));
    const out = logs.join('');
    expect(out).toContain('✗'); // still below tier
    expect(out).toContain('corpus_novelty');
    expect(process.exitCode).toBe(2);
  });

  it('a dead seam fails OPEN with the reason printed, gap verdict untouched', async () => {
    const tier = ideationTier();
    await gapCmd(
      tmp,
      { file: gapDoc(), tier, corpus: true },
      { embed: async () => { throw new Error('engine down'); }, providerName: () => null }
    );
    const out = logs.join('');
    expect(out).toContain('corpus_novelty: unavailable — embedding failed: engine down');
    // The tier verdict itself still rendered.
    expect(out).toContain('tier ideation-outcome/frontier');
  });

  it('the overlay is class-guarded: a non-ideation tier says so and skips', async () => {
    // Gap a NON-ideation tier (api-behavior) with --corpus: the overlay must
    // announce it is ideation-only and skip, rather than cross-read a JSON
    // transcript as candidate prose.
    const api = join(tmp, 'api.json');
    writeFileSync(
      api,
      JSON.stringify({
        version: 1,
        schema: { required: ['id', 'status'], properties: { id: 'string', status: 'string' } },
        exchanges: [
          {
            request: { op: 'list' },
            expected: { id: 'r1', status: 'ok' },
            response: { id: 'r1', status: 'ok' },
            latencyMs: 100,
          },
        ],
      }),
      'utf-8'
    );
    storeArtifactAnchor(tmp, 'api-behavior', api);
    const apiTier = deriveTier(tmp, 'api-behavior', 'frontier')!;
    saveTier(tmp, apiTier);
    expect(apiTier.key.split('/')[0]).toBe('api-behavior');
    await gapCmd(tmp, { file: api, tier: apiTier.key, corpus: true }, seam([[0.5]]));
    const out = logs.join('');
    expect(out).toContain("corpus-novelty overlay applies to ideation-outcome artifacts (gapping 'api-behavior') — skipped");
    expect(out).not.toContain('corpus_novelty (advisory');
  });

  it('json mode carries the corpus object alongside the report', async () => {
    const tier = ideationTier();
    await gapCmd(tmp, { file: gapDoc(), tier, corpus: true, json: true }, seam([[0.4], [0.6], [0.2]]));
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.corpus.ok).toBe(true);
    expect(parsed.corpus.mean).toBeCloseTo(0.6, 5);
    expect(parsed.tier).toBe(tier);
  });
});
