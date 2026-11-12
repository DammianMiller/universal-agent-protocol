import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The raw-context death-spiral breaker (Fix F) must catch the treadmill class
 * the 3.0 default was blind to.
 *
 * Measured live (droid + flash-next, cognition-engine, 2026-11-06): a client
 * with no maxContextLimit believes its window is 250k and only compacts there,
 * against a 131,072-token rail. The session ramped from 132% to 162% raw in
 * 4 minutes, then sat at 190-198% for 4+ hours — every turn CRITICAL-PRUNEd
 * blind to ~6 messages (only ~24-40k tokens actually reached the model), so
 * findings evaporated and the model re-read the same files forever. The
 * breaker existed the whole time but its 300% gate was written for 936%
 * runaways; this one never crossed 200%, so it never fired.
 *
 * The fix is the shipped default itself, so the test exercises the real
 * constant definitions out of anthropic_proxy.py under python3, against the
 * live utilization sequence from that session.
 */

const proxyPath = join(process.cwd(), 'tools', 'agents', 'scripts', 'anthropic_proxy.py');

function sliceConstants(source: string): string {
  const start = source.indexOf('PROXY_RAW_CTX_FINALIZE_RATIO = float(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\nPROXY_STREAM_REASONING_FALLBACK', start);
  expect(end).toBeGreaterThan(-1);
  return source.slice(start, end);
}

interface RunResult {
  out: string;
  status: number | null;
}

function runGate(pythonBody: string, envOverrides?: Record<string, string>): RunResult {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.PROXY_RAW_CTX_FINALIZE_RATIO;
  delete env.PROXY_RAW_CTX_FINALIZE_STREAK;
  for (const [k, v] of Object.entries(envOverrides ?? {})) env[k] = v;
  const r = spawnSync('python3', ['-'], { input: pythonBody, encoding: 'utf-8', timeout: 30_000, env });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

const harness = (source: string, scenario: string) => `
import os
${sliceConstants(source)}

# The gate exactly as wired at the two call sites: the streak increment in the
# request handler (ratio > 0 and utilization >= ratio, else reset) and the
# breaker check in build_openai_request (streak > 0 and streak >= STREAK).
def fires_over(seq):
    streak = 0
    fires = 0
    for u in seq:
        if PROXY_RAW_CTX_FINALIZE_RATIO > 0 and u >= PROXY_RAW_CTX_FINALIZE_RATIO:
            streak += 1
        else:
            streak = 0
        if PROXY_RAW_CTX_FINALIZE_STREAK > 0 and streak >= PROXY_RAW_CTX_FINALIZE_STREAK:
            fires += 1
    return fires

${scenario}
`;

// The ACTUAL raw incoming utilization from the 2026-11-06 journal, 12:40-12:44:
// 132.6%, 133.0%, 135.0%, ... 160.2%, 162.4% — the ramp that opens the
// treadmill.
const liveRamp = [
  1.326, 1.330, 1.350, 1.355, 1.357, 1.360, 1.364, 1.367, 1.382, 1.396,
  1.409, 1.411, 1.424, 1.441, 1.453, 1.472, 1.485, 1.497, 1.525, 1.537,
  1.538, 1.542, 1.546, 1.563, 1.567, 1.585, 1.602, 1.624,
];

// Where the same session plateaued for 4+ hours: 190-198% and never higher.
const livePlateau = [1.902, 1.914, 1.920, 1.931, 1.939, 1.958, 1.982, 1.953, 1.912, 1.902];

// A merely-full session: a client sized to the rail (~95-100%) and a 200k-
// believing client at its own compact trigger (~141% of the 131,072 rail).
const merelyFull = [0.95, 1.10, 1.30, 1.41, 1.35, 1.30, 1.41, 1.38, 1.41, 1.35];

describe('anthropic_proxy raw-context finalize gate (Fix F)', () => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
  const havePython = python.status === 0;
  const source = readFileSync(proxyPath, 'utf-8');

  it.skipIf(!havePython)('shipped default catches the live 2026-11-06 treadmill ramp', () => {
    const scenario = `
assert PROXY_RAW_CTX_FINALIZE_RATIO == 1.6, PROXY_RAW_CTX_FINALIZE_RATIO
assert fires_over(${JSON.stringify(liveRamp)}) > 0, "1.6 gate never fired on the live ramp"
assert fires_over(${JSON.stringify(livePlateau)}) > 0, "1.6 gate never fired on the live plateau"
print("OK")
`;
    const { out, status } = runGate(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('the retired 3.0 default was blind to that exact sequence (regression record)', () => {
    // Documents WHY 3.0 failed: the same live sequence, gated at the old
    // default, never trips the breaker — the treadmill runs for hours.
    const scenario = `
assert fires_over(${JSON.stringify(liveRamp)} + ${JSON.stringify(livePlateau)}) == 0, \\
    "3.0 gate fired on a sequence that peaked at 198%"
print("OK")
`;
    const { out, status } = runGate(
      harness(source, scenario),
      { PROXY_RAW_CTX_FINALIZE_RATIO: '3.0' },
    );
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('a merely-full session never trips the shipped gate, and 0 disables it', () => {
    const scenario = `
assert fires_over(${JSON.stringify(merelyFull)}) == 0, \\
    "shipped gate fired inside the merely-full band (100-141%)"
os.environ["PROXY_RAW_CTX_FINALIZE_RATIO"] = "0"
PROXY_RAW_CTX_FINALIZE_RATIO = float(os.environ["PROXY_RAW_CTX_FINALIZE_RATIO"])
assert fires_over(${JSON.stringify(livePlateau)}) == 0, "ratio=0 did not disable the breaker"
print("OK")
`;
    const { out, status } = runGate(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it('wires the gate into both call sites and keeps the evidence in the source', () => {
    // Source-text guards so the gate cannot drift back above the runaway band
    // or lose the streak/breaker wiring.
    expect(source).toContain('os.environ.get("PROXY_RAW_CTX_FINALIZE_RATIO", "1.6")');
    expect(source).not.toContain('os.environ.get("PROXY_RAW_CTX_FINALIZE_RATIO", "3.0")');
    // Streak increment (request handler) and breaker (build_openai_request).
    expect(source).toContain('monitor.catastrophic_ctx_streak += 1');
    expect(source).toContain('monitor.catastrophic_ctx_streak >= PROXY_RAW_CTX_FINALIZE_STREAK');
    // The breaker must still end the client's loop with a terminal summary.
    expect(source).toContain('CONTEXT DEATH-SPIRAL BREAKER');
    expect(source).toContain('continue. No tools are available. Reply with a brief');
    // The live evidence that set the band, so a future retune has the data.
    expect(source).toContain('2026-11-06');
    expect(source).toContain('190-198%');
  });
});
