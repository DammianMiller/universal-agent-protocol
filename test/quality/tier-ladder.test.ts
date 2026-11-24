/**
 * Tier ladder tests — Wave 1.2 acceptance: N=3 seeded variants ranked
 * deterministically on a fixture; the ladder fires on a measured plateau;
 * exhaustion below tier cuts with a documented gap. Class-generic (drives
 * api-behavior and bench-score tiers through the same loop).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rankMeasurements, runTierLadder, TierLadderCandidate, TierLadderMeasurement, candidateDivergence, roundDivergence } from '../../src/quality/tier-ladder.js';
import { storeArtifactAnchor } from '../../src/quality/classes.js';
import { deriveTier } from '../../src/quality/tiers.js';
import { qualityCommand } from '../../src/cli/quality.js';
import { pngPath } from './png-fixture.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-ladder-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/* ------------------------------ fixtures ------------------------------- */

interface ExchangeFixture {
  request?: unknown;
  expected?: unknown;
  response?: unknown;
  latencyMs?: number;
}

function transcriptFile(name: string, exchanges: ExchangeFixture[]): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({
    version: 1,
    schema: {
      required: ['id', 'status'],
      properties: { id: 'string', status: 'string', items: 'array', count: 'integer' },
    },
    exchanges,
  }));
  return p;
}

function benchFile(name: string, results: Array<{ task: string; status: string }>): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({ version: 1, results }));
  return p;
}

const ok = (latencyMs: number): ExchangeFixture => ({
  request: { op: 'list' },
  expected: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
  response: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
  latencyMs,
});

const degraded = (latencyMs: number): ExchangeFixture => ({
  request: { op: 'list' },
  expected: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
  response: { status: 'oops' },
  latencyMs,
});

/** Anchor an api-behavior exemplar and derive the tier the ladder climbs to. */
function apiTier(): string {
  storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('ex.json', [ok(100), ok(150)]));
  const tier = deriveTier(tmp, 'api-behavior', 'fable-high')!;
  expect(tier.key).toBe('api-behavior/fable-high');
  return tier.key;
}

/* --------------------------- ranking + climb ---------------------------- */

describe('runTierLadder: ranking', () => {
  it('ranks N=3 seeded variants deterministically on a fixture (worst-severity order)', async () => {
    const tierKey = apiTier();
    const candidates = (): TierLadderCandidate[] => [
      { id: 'c-bad', artifactPath: transcriptFile('bad.json', [degraded(900)]) },
      { id: 'c-mid', artifactPath: transcriptFile('mid.json', [degraded(10), ok(20)]) },
      { id: 'c-good', artifactPath: transcriptFile('good.json', [ok(250)]) },
    ];
    const result = await runTierLadder({ projectRoot: tmp, tierKey, generate: candidates, maxRounds: 1 });
    // one failing axis (latency 250 > tier max 200) beats two (mid) beats four (bad)
    expect(result.rounds[0].best).toBe('c-good');
    const order = [...(result.rounds[0].candidates as TierLadderMeasurement[])]
      .sort(rankMeasurements)
      .map((c) => c.id);
    expect(order).toEqual(['c-good', 'c-mid', 'c-bad']);
    // determinism: the same generation sequence reproduces the same trace
    const again = await runTierLadder({ projectRoot: tmp, tierKey, generate: candidates, maxRounds: 1 });
    expect(again.rounds[0].best).toBe('c-good');
    expect(again.summary).toBe(result.summary);
  });

  it('reaches the tier when a later round produces an at-tier candidate', async () => {
    const tierKey = apiTier();
    const rounds: TierLadderCandidate[][] = [
      [{ id: 'r1', artifactPath: transcriptFile('r1.json', [ok(250)]) }],
      [{ id: 'r2', artifactPath: transcriptFile('r2.json', [ok(100), ok(150)]) }],
    ];
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: (round) => rounds[round - 1] ?? [],
      maxRounds: 2,
    });
    expect(result.outcome).toBe('tier-reached');
    expect(result.winner?.id).toBe('r2');
    expect(result.rounds).toHaveLength(2);
    expect(result.finalGap?.pass).toBe(true);
  });
});

/* ------------------------------ plateau --------------------------------- */

describe('runTierLadder: plateau → escalation', () => {
  it('fires escalation after plateau-rounds without improvement, and resets the budget', async () => {
    const tierKey = apiTier();
    const escalatedAt: number[] = [];
    // every round returns the same single-axis failure (latency 250 > 200)
    const flat = (): TierLadderCandidate[] => [{ id: 'flat', artifactPath: transcriptFile('flat.json', [ok(250)]) }];
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: flat,
      maxRounds: 4,
      plateauRounds: 2,
      onEscalate: (r) => {
        escalatedAt.push(r);
      },
    });
    // round1 improves (from infinity), round2 plateaus, round3 fires, round4 plateaus again
    expect(escalatedAt).toEqual([3]);
    expect(result.rounds.find((r) => r.round === 3)?.escalated).toBe(true);
    expect(result.escalationFired).toBe(true);
    expect(result.outcome).toBe('cut-exhausted');
  });

  it('does not escalate on the final round (no rounds left to spend the stronger model on)', async () => {
    const tierKey = apiTier();
    const flat = (): TierLadderCandidate[] => [{ id: 'flat', artifactPath: transcriptFile('flat.json', [ok(250)]) }];
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: flat,
      maxRounds: 3,
      plateauRounds: 2,
    });
    expect(result.escalationFired).toBe(false);
    expect(result.outcome).toBe('cut-exhausted');
  });

  it('a real improvement resets the plateau counter', async () => {
    const tierKey = apiTier();
    let fired = 0;
    const rounds: TierLadderCandidate[][] = [
      [{ id: 'far', artifactPath: transcriptFile('far.json', [degraded(900)]) }],
      [{ id: 'near', artifactPath: transcriptFile('near.json', [ok(250)]) }],
      [{ id: 'near2', artifactPath: transcriptFile('near2.json', [ok(250)]) }],
      [{ id: 'near3', artifactPath: transcriptFile('near3.json', [ok(250)]) }],
    ];
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: (round) => rounds[round - 1] ?? [],
      maxRounds: 4,
      plateauRounds: 2,
      onEscalate: () => {
        fired += 1;
      },
    });
    // round2 improved (0.5 → 0.25 severity); plateaus at rounds 3 and 4 → fire on 4? no: 4 is the last round
    expect(fired).toBe(0);
    expect(result.rounds.map((r) => r.escalated)).toEqual([false, false, false, false]);
  });
});

/* ---------------------------- honest cuts ------------------------------- */

describe('runTierLadder: documented cuts', () => {
  it('cuts with the gap documented when rounds are exhausted below tier', async () => {
    const tierKey = apiTier();
    const flat = (): TierLadderCandidate[] => [{ id: 'flat', artifactPath: transcriptFile('flat.json', [ok(250)]) }];
    const result = await runTierLadder({ projectRoot: tmp, tierKey, generate: flat, maxRounds: 2 });
    expect(result.outcome).toBe('cut-exhausted');
    expect(result.summary).toContain('below tier after 2 round(s)');
    expect(result.finalGap).not.toBeNull();
    expect(result.finalGap?.pass).toBe(false);
    expect(result.finalGap?.worst).toBe('latencyP95Ms');
    const failing = result.finalGap?.axes.filter((a) => a.status === 'fail') ?? [];
    expect(failing).toHaveLength(1);
    expect(failing[0].directive).toContain('latency envelope');
    const lastRound = result.rounds[result.rounds.length - 1];
    expect(lastRound.cut?.reason).toContain('rounds exhausted');
  });

  it('cuts when a round generates no candidates (never guesses a pass)', async () => {
    const tierKey = apiTier();
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: (round) => (round === 1 ? [{ id: 'r1', artifactPath: transcriptFile('r1.json', [ok(250)]) }] : []),
      maxRounds: 3,
    });
    expect(result.outcome).toBe('cut-no-candidates');
    expect(result.winner?.id).toBe('r1');
    expect(result.rounds).toHaveLength(2);
  });

  it('cuts unmeasurable when no candidate matches the tier class shape', async () => {
    const tierKey = apiTier();
    const png = pngPath(tmp, 'not-a-transcript.png', 8, 8, () => [0, 0, 0]);
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: () => [{ id: 'png', artifactPath: png }],
      maxRounds: 1,
    });
    expect(result.outcome).toBe('cut-unmeasurable');
    expect(result.rounds[0].cut?.reason).toContain('API transcript');
  });

  it('fails closed before any round on an unknown tier', async () => {
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey: 'no/such-tier',
      generate: () => [{ id: 'x', artifactPath: transcriptFile('x.json', [ok(1)]) }],
    });
    expect(result.outcome).toBe('cut-no-candidates');
    expect(result.rounds).toHaveLength(0);
    expect(result.summary).toContain("unknown tier 'no/such-tier'");
  });

  it('caps candidates per round (the attempt-farm guard)', async () => {
    const tierKey = apiTier();
    const generated: TierLadderCandidate[] = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      artifactPath: transcriptFile(`c${i}.json`, [ok(250)]),
    }));
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: () => generated,
      maxRounds: 1,
      candidatesPerRound: 3,
    });
    expect(result.rounds[0].candidates).toHaveLength(3);
  });
});

/* --------------------------- class-generic ------------------------------ */

describe('runTierLadder: bench-score class through the same loop', () => {
  it('climbs a bench tier across rounds', async () => {
    storeArtifactAnchor(tmp, 'bench-score', benchFile('ex.json', [
      { task: 'a', status: 'pass' },
      { task: 'b', status: 'pass' },
      { task: 'c', status: 'fail' },
    ]));
    const tierKey = deriveTier(tmp, 'bench-score', 'frontier')!.key;
    const rounds: TierLadderCandidate[][] = [
      [{ id: 'weak', artifactPath: benchFile('weak.json', [
        { task: 'a', status: 'fail' },
        { task: 'b', status: 'fail' },
      ]) }],
      [{ id: 'climbing', artifactPath: benchFile('climb.json', [
        { task: 'a', status: 'pass' },
        { task: 'b', status: 'error' },
      ]) }],
      [{ id: 'at-tier', artifactPath: benchFile('at.json', [
        { task: 'a', status: 'pass' },
        { task: 'b', status: 'pass' },
      ]) }],
    ];
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: (round) => rounds[round - 1] ?? [],
      maxRounds: 3,
    });
    expect(result.outcome).toBe('tier-reached');
    expect(result.winner?.id).toBe('at-tier');
  });
});

/* ------------------------------- CLI ----------------------------------- */

describe('qualityCommand: ladder subcommand', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  function roundsDir(projectDir: string, rounds: Record<string, string[]>): string {
    const root = join(projectDir, 'ladder-rounds');
    for (const [dir, files] of Object.entries(rounds)) {
      mkdirSync(join(root, dir), { recursive: true });
      for (const f of files) {
        writeFileSync(
          join(root, dir, f),
          JSON.stringify(f.startsWith('good')
            ? { version: 1, schema: { required: ['id', 'status'], properties: { id: 'string', status: 'string', items: 'array', count: 'integer' } }, exchanges: [ok(250)] }
            : { version: 1, schema: { required: ['id', 'status'], properties: { id: 'string', status: 'string' } }, exchanges: [degraded(900)] }),
        );
      }
    }
    return root;
  }

  it('climbs harvested rounds to tier and exits clean', async () => {
    apiTier();
    const root = roundsDir(tmp, {
      round01: ['a-degraded.json', 'b-near.json'],
      round02: ['a-at-tier.json'],
    });
    // the round02 at-tier file must actually pass: overwrite with the exemplar shape
    writeFileSync(
      join(root, 'round02', 'a-at-tier.json'),
      JSON.stringify({ version: 1, schema: { required: ['id', 'status'], properties: { id: 'string', status: 'string', items: 'array', count: 'integer' } }, exchanges: [ok(100), ok(150)] }),
    );
    await qualityCommand('ladder', { projectDir: tmp, tier: 'api-behavior/fable-high', roundsDir: root });
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('tier api-behavior/fable-high reached on round 2');
    expect(out).toContain('round 01');
  });

  it('cuts below tier with the documented gap and exits 2', async () => {
    apiTier();
    const root = roundsDir(tmp, {
      round01: ['a-degraded.json'],
      round02: ['b-degraded.json'],
    });
    await qualityCommand('ladder', { projectDir: tmp, tier: 'api-behavior/fable-high', roundsDir: root });
    expect(process.exitCode).toBe(2);
    const out = logs.join('\n');
    expect(out).toContain('cut below tier');
    expect(out).toContain('rounds exhausted');
  });

  it('usage-fails without a rounds directory or tier', async () => {
    await qualityCommand('ladder', { projectDir: tmp });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('Usage: uap quality ladder');
  });

  it('rejects a rounds directory with no roundNN subdirectories', async () => {
    apiTier();
    const empty = join(tmp, 'empty-rounds');
    mkdirSync(empty, { recursive: true });
    await qualityCommand('ladder', { projectDir: tmp, tier: 'api-behavior/fable-high', roundsDir: empty });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('no roundNN');
  });
});

/* --------------------------- N3: divergence ----------------------------- */

describe('best-of-N divergence (N3)', () => {
  it('candidateDivergence: byte-identical artifacts are 0, distinct text is far, distinct binaries are 1', () => {
    const a = transcriptFile('div-a.json', [ok(100)]);
    const b = transcriptFile('div-b.json', [ok(100)]); // same exchanges = same bytes
    expect(candidateDivergence({ id: 'a', artifactPath: a }, { id: 'b', artifactPath: b })).toBe(0);

    // MEASURED INSIGHT (pinned): ok and degraded variants of the SAME op
    // measure 0 apart — the differing words ('oops', the response body) are
    // sub-5-letter or numeric, so schema scaffolding dominates the
    // significant-word set. This is why duplicateThreshold defaults to 0:
    // a positive default would collapse every same-op round.
    const c = transcriptFile('div-c.json', [degraded(900)]);
    expect(candidateDivergence({ id: 'a', artifactPath: a }, { id: 'c', artifactPath: c })).toBe(0);

    // A genuinely different vocabulary (different op + field names) is far.
    const rich = join(tmp, 'div-rich.json');
    writeFileSync(rich, JSON.stringify({
      version: 1,
      schema: { required: ['uuid', 'state'], properties: { uuid: 'string', state: 'string', inventory: 'array', quantity: 'integer' } },
      exchanges: [
        { request: { op: 'fetch_inventory' }, expected: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, response: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, latencyMs: 90 },
      ],
    }));
    expect(candidateDivergence({ id: 'a', artifactPath: a }, { id: 'r', artifactPath: rich })).toBeGreaterThan(0.3);

    // binaries: byte comparison, coarse but honest
    const png1 = pngPath(tmp, 'div-p1.png', 2, 2, () => [200, 30, 40]);
    const pngCopy = join(tmp, 'div-p1-copy.png');
    writeFileSync(pngCopy, readFileSync(png1));
    expect(candidateDivergence({ id: 'p1', artifactPath: png1 }, { id: 'p2', artifactPath: pngCopy })).toBe(0);
    const png2 = pngPath(tmp, 'div-p2.png', 2, 2, () => [30, 200, 40]);
    expect(candidateDivergence({ id: 'p1', artifactPath: png1 }, { id: 'o', artifactPath: png2 })).toBe(1);
  });

  it('roundDivergence drops near-duplicates kept-first, deterministically', () => {
    const base = transcriptFile('rd-a.json', [ok(100)]);
    const clone = transcriptFile('rd-clone.json', [ok(100)]); // identical bytes
    // a genuinely different vocabulary — the kept pair must sit ABOVE the threshold
    const distinct = join(tmp, 'rd-c.json');
    writeFileSync(distinct, JSON.stringify({
      version: 1,
      schema: { required: ['uuid', 'state'], properties: { uuid: 'string', state: 'string', inventory: 'array', quantity: 'integer' } },
      exchanges: [
        { request: { op: 'fetch_inventory' }, expected: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, response: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, latencyMs: 90 },
      ],
    }));
    const r = roundDivergence(
      [
        { id: 'a', artifactPath: base },
        { id: 'clone', artifactPath: clone },
        { id: 'c', artifactPath: distinct },
      ],
      0.05
    )!;
    expect(r.droppedDuplicates).toEqual(['clone']);
    expect(r.min).toBeGreaterThan(0.05); // the kept pair is above the threshold
    expect(r.mean).toBeCloseTo(r.min, 5); // exactly one kept pair
  });

  it('returns null for a single-candidate round (no pairs exist)', () => {
    expect(roundDivergence([{ id: 'solo', artifactPath: transcriptFile('solo.json', [ok(100)]) }], 0.05)).toBeNull();
  });

  it('the ladder drops exact clones before measuring and records them', async () => {
    const tierKey = apiTier();
    const good = transcriptFile('n3-good.json', [ok(100), ok(150)]);
    const goodClone = transcriptFile('n3-clone.json', [ok(100), ok(150)]);
    // genuinely different vocabulary — must NOT be dropped, only the exact clone
    const mid = join(tmp, 'n3-mid.json');
    writeFileSync(mid, JSON.stringify({
      version: 1,
      schema: { required: ['uuid', 'state'], properties: { uuid: 'string', state: 'string', inventory: 'array', quantity: 'integer' } },
      exchanges: [
        { request: { op: 'fetch_inventory' }, expected: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, response: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, latencyMs: 90 },
      ],
    }));
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      duplicateThreshold: 0.05,
      generate: () => [
        { id: 'good', artifactPath: good },
        { id: 'clone', artifactPath: goodClone },
        { id: 'mid', artifactPath: mid },
      ],
      maxRounds: 1,
    });
    const round = result.rounds[0];
    expect(round.divergence?.droppedDuplicates).toEqual(['clone']);
    expect(round.candidates.map((c) => c.id).sort()).toEqual(['good', 'mid']);
  });

  it('minDivergence cuts a clone-collapse round instead of farming it', async () => {
    const tierKey = apiTier();
    // Three same-schema transcripts: pairwise distance is small (shared
    // scaffolding, differing outcome words) but above the duplicate
    // threshold — nothing drops, yet the set is one exploration farmed N times.
    const t1 = transcriptFile('col-1.json', [ok(100)]);
    const t2 = transcriptFile('col-2.json', [degraded(200)]);
    const t3 = transcriptFile('col-3.json', [degraded(300)]);
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: () => [
        { id: 't1', artifactPath: t1 },
        { id: 't2', artifactPath: t2 },
        { id: 't3', artifactPath: t3 },
      ],
      maxRounds: 2,
      duplicateThreshold: 0.02,
      minDivergence: 0.3,
    });
    expect(result.outcome).toBe('cut-divergence-collapse');
    expect(result.rounds[0].divergence?.mean).toBeLessThan(0.3);
    expect(result.summary).toContain('near-clones');
    expect(result.rounds[0].candidates).toEqual([]);
  });

  it('a genuinely diverse round is untouched by minDivergence', async () => {
    const tierKey = apiTier();
    const rich1 = transcriptFile('rich-1.json', [ok(100)]);
    // a transcript with a genuinely different vocabulary: different op + fields
    writeFileSync(join(tmp, 'rich-2.json'), JSON.stringify({
      version: 1,
      schema: { required: ['uuid', 'state'], properties: { uuid: 'string', state: 'string', inventory: 'array', quantity: 'integer' } },
      exchanges: [
        { request: { op: 'fetch_inventory' }, expected: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, response: { uuid: 'warehouse-north', state: 'ready', inventory: ['lumber', 'stone'], quantity: 7 }, latencyMs: 90 },
      ],
    }));
    const result = await runTierLadder({
      projectRoot: tmp,
      tierKey,
      generate: () => [
        { id: 'r1', artifactPath: rich1 },
        { id: 'r2', artifactPath: join(tmp, 'rich-2.json') },
      ],
      maxRounds: 1,
      minDivergence: 0.2,
    });
    expect(result.outcome).not.toBe('cut-divergence-collapse');
    expect(result.rounds[0].divergence?.mean ?? 0).toBeGreaterThan(0.2);
  });
});
