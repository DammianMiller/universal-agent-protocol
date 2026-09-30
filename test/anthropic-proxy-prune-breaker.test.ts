import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The prune circuit breaker must distinguish a death SPIRAL from a fixed
 * overhead FLOOR.
 *
 * Measured live (opencode + qwen38, 2026-09-30): a tool-heavy client (99 tool
 * schemas, ~66k est tokens of a 114,688-token window) sits permanently above
 * the 42% prune threshold even after pruning drops every droppable message.
 * The old breaker condition — "3+ consecutive prunes and still above
 * threshold" — read that flat floor as a death spiral and forced finalize
 * every few turns (8 breaker fires in 10 minutes), each one ending a healthy
 * ~44% session. The operator symptom: "the opencode client keeps stopping".
 *
 * The fix is behavioral, so it is exercised for real: the discriminator is
 * sliced out of anthropic_proxy.py and run under python3 against the actual
 * post-prune utilization sequence observed in the live failure.
 */

const proxyPath = join(process.cwd(), 'tools', 'agents', 'scripts', 'anthropic_proxy.py');

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\ndef ', start);
  return source.slice(start, end === -1 ? undefined : end);
}

function runDiscriminator(pythonBody: string): { out: string; status: number | null } {
  const r = spawnSync('python3', ['-'], { input: pythonBody, encoding: 'utf-8', timeout: 30_000 });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

const harness = (source: string, scenario: string) => `
PROXY_CONTEXT_PRUNE_THRESHOLD = 0.42
PROXY_PRUNE_SPIRAL_STREAK = 3
PROXY_PRUNE_SPIRAL_EPSILON = 0.01

class Monitor:
    prune_spiral_streak = 0
    last_post_prune_util = -1.0

${sliceFunction(source, '_prune_breaker_should_fire')}

${scenario}
`;

describe('anthropic_proxy prune circuit breaker', () => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
  const havePython = python.status === 0;
  const source = readFileSync(proxyPath, 'utf-8');

  it.skipIf(!havePython)('holds the breaker on the flat overhead floor observed in the live failure', () => {
    // The ACTUAL post-prune utilization sequence from the 2026-09-30 session
    // where the breaker fired 8 times in 10 minutes. Every value is above the
    // 42% threshold; the floor oscillates a fraction of a point per turn and
    // never rises by a full point. The breaker must not fire even once.
    const scenario = `
m = Monitor()
live_floor = [0.449, 0.454, 0.456, 0.461, 0.425, 0.427, 0.430, 0.434,
              0.437, 0.443, 0.446, 0.447, 0.451, 0.453, 0.455, 0.456]
fires = sum(1 for u in live_floor if _prune_breaker_should_fire(u, m))
assert fires == 0, f"breaker fired {fires} time(s) on a flat floor"
assert m.prune_spiral_streak == 0, "streak accumulated on a flat floor"
print("OK")
`;
    const { out, status } = runDiscriminator(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('fires on a genuinely rising post-prune floor (real death spiral)', () => {
    // A spiral regrows faster than the pruner cuts: the post-prune floor
    // climbs several points per turn. The breaker must fire on the turn that
    // completes the streak.
    const scenario = `
m = Monitor()
seq = [0.50, 0.55, 0.60, 0.65]
results = [_prune_breaker_should_fire(u, m) for u in seq]
assert results == [False, False, False, True], f"unexpected firing pattern: {results}"
assert m.prune_spiral_streak == 3
print("OK")
`;
    const { out, status } = runDiscriminator(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('resets the streak when the floor dips, and requires three fresh rises to re-arm', () => {
    const scenario = `
m = Monitor()
assert not _prune_breaker_should_fire(0.50, m)   # first observation: no trend yet
assert not _prune_breaker_should_fire(0.55, m)   # rise 1
assert not _prune_breaker_should_fire(0.60, m)   # rise 2
assert not _prune_breaker_should_fire(0.58, m)   # floor FELL: spiral broken
assert m.prune_spiral_streak == 0, "falling floor did not reset the streak"
assert not _prune_breaker_should_fire(0.62, m)   # fresh rise 1
assert not _prune_breaker_should_fire(0.66, m)   # fresh rise 2
assert _prune_breaker_should_fire(0.70, m)       # fresh rise 3 -> fire
assert not _prune_breaker_should_fire(0.30, m)   # under threshold: reset again
assert m.prune_spiral_streak == 0, "under-threshold turn did not reset the streak"
print("OK")
`;
    const { out, status } = runDiscriminator(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it('wires the discriminator into the breaker call site and retires the flat-floor condition', () => {
    // Source-text guard so the call site cannot drift back to the old
    // "still above threshold" condition, and so the operator-facing flat-floor
    // notice (the actionable signal that the THRESHOLD is mis-set for this
    // client) stays present.
    expect(source).toContain('if _prune_breaker_should_fire(post_util, monitor):');
    expect(source).toContain('circuit breaker held');
    expect(source).not.toContain('prune_count >= 3 and post_util');
    expect(source).toContain('PROXY_PRUNE_SPIRAL_STREAK');
    expect(source).toContain('PROXY_PRUNE_SPIRAL_EPSILON');
  });
});
