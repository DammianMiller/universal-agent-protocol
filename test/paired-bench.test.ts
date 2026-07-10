/**
 * Tests for the paired UAP benchmark harness (src/benchmarks/paired).
 *
 * Covers: paired statistics (CI / permutation / McNemar / pass@k / seeded RNG),
 * suite loading + verify ground truth, scaffold injection (the on/off toggle),
 * and an end-to-end runner -> analyze -> ablation pass with the mock adapter.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import {
  mulberry32,
  pairedDelta,
  mcnemar,
  passAtK,
  mean,
  std,
  verdict,
} from '../src/benchmarks/paired/stats.js';
import {
  loadSuite,
  materializeWorkdir,
  runVerify,
  loadTask,
} from '../src/benchmarks/paired/suite.js';
import { applyScaffolding, scaffoldEnv } from '../src/benchmarks/paired/scaffold.js';
import {
  MockAdapter,
  hash01,
  parseOpencodeUsage,
  parseFileBlocks,
  parseMiniSweUsage,
  miniSweAdapter,
  SubprocessAdapter,
} from '../src/benchmarks/paired/adapter.js';
import { TaskSpecSchema } from '../src/benchmarks/paired/types.js';
import { runPaired } from '../src/benchmarks/paired/runner.js';
import { analyze } from '../src/benchmarks/paired/report.js';
import { buildAblationConditions, analyzeAblation } from '../src/benchmarks/paired/ablation.js';
import {
  makeBaselineCondition,
  makeFullCondition,
  isBaseline,
  UAP_COMPONENTS,
  type RunnerConfig,
} from '../src/benchmarks/paired/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMOKE_SUITE = join(__dirname, '../benchmarks/suites/smoke');
const REAL_SUITE = join(__dirname, '../benchmarks/suites/real-gate');

const tmpDirs: string[] = [];
function scratchRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'paired-test-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('stats: seeded RNG', () => {
  it('mulberry32 is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA[0]).toBeGreaterThanOrEqual(0);
    expect(seqA[0]).toBeLessThan(1);
  });

  it('different seeds diverge', () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
});

describe('stats: pairedDelta', () => {
  it('detects a clear positive shift with CI excluding 0', () => {
    const deltas = Array.from({ length: 40 }, () => 2); // constant +2
    const r = pairedDelta(deltas, { seed: 7, iterations: 2000 });
    expect(r.meanDelta).toBeCloseTo(2, 6);
    expect(r.ci.lower).toBeGreaterThan(0);
    expect(r.significant).toBe(true);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('reports non-significance for symmetric noise around 0', () => {
    const deltas = [1, -1, 1, -1, 1, -1, 1, -1];
    const r = pairedDelta(deltas, { seed: 3, iterations: 2000 });
    expect(Math.abs(r.meanDelta)).toBeLessThan(1e-9);
    expect(r.significant).toBe(false);
    expect(r.pValue).toBeGreaterThan(0.05);
  });

  it('handles the empty input gracefully', () => {
    const r = pairedDelta([], {});
    expect(r.n).toBe(0);
    expect(r.significant).toBe(false);
  });
});

describe('stats: verdict (ROPE / tie-within-noise norm)', () => {
  it('calls a clear, large positive delta a WIN', () => {
    const r = pairedDelta(Array.from({ length: 40 }, () => 5), { seed: 7, iterations: 2000 });
    expect(verdict(r, { margin: 1, higherIsBetter: true })).toBe('win');
  });

  it('calls a non-significant delta a TIE regardless of sign', () => {
    const r = pairedDelta([1, -1, 1, -1, 1, -1, 1, -1], { seed: 3, iterations: 2000 });
    expect(verdict(r)).toBe('tie');
  });

  it('calls a statistically-significant-but-tiny delta a TIE under the margin', () => {
    // Constant +2: highly significant, but within a margin of 4 ("deltas <4 are ties").
    const r = pairedDelta(Array.from({ length: 50 }, () => 2), { seed: 1, iterations: 2000 });
    expect(r.significant).toBe(true);
    expect(verdict(r, { margin: 4, higherIsBetter: true })).toBe('tie');
    // With a small margin it's a real win.
    expect(verdict(r, { margin: 0.5, higherIsBetter: true })).toBe('win');
  });

  it('respects higherIsBetter=false (lower tokens/cost is a win)', () => {
    const r = pairedDelta(Array.from({ length: 40 }, () => -10), { seed: 9, iterations: 2000 });
    expect(verdict(r, { higherIsBetter: false })).toBe('win'); // fewer tokens
    expect(verdict(r, { higherIsBetter: true })).toBe('loss');
  });
});

describe('stats: mcnemar gate-value 2x2', () => {
  it('counts fixes and regressions correctly', () => {
    // treatment vs baseline correctness
    const treat = [true, true, false, true, true];
    const base = [false, true, false, false, true];
    const m = mcnemar(treat, base);
    expect(m.bothCorrect).toBe(2); // idx 1,4
    expect(m.onlyTreatment).toBe(2); // idx 0,3 (base wrong -> treat right)
    expect(m.onlyBaseline).toBe(0);
    expect(m.bothWrong).toBe(1); // idx 2
    expect(m.netGain).toBe(2);
  });

  it('throws on mismatched lengths', () => {
    expect(() => mcnemar([true], [true, false])).toThrow();
  });
});

describe('stats: passAtK and descriptive', () => {
  it('passAtK matches the closed form', () => {
    expect(passAtK(10, 0, 3)).toBe(0);
    expect(passAtK(10, 10, 3)).toBe(1);
    // 5/10 correct, pass@1 == 0.5
    expect(passAtK(10, 5, 1)).toBeCloseTo(0.5, 6);
  });
  it('mean/std basic', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(std([2, 2, 2])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('adapter: opencode JSONL usage parser', () => {
  it('aggregates step_finish + tool_use events from the JSONL stream', () => {
    const jsonl = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'tool_use', part: { type: 'tool' } }),
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', cost: 0, tokens: { input: 100, output: 20, cache: { read: 50 } } },
      }),
      JSON.stringify({ type: 'tool_use', part: { type: 'tool' } }),
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', cost: 0, tokens: { input: 10, output: 5, cache: { read: 60 } } },
      }),
    ].join('\n');
    const u = parseOpencodeUsage(jsonl, '');
    expect(u.turns).toBe(2);
    expect(u.toolCalls).toBe(2);
    // (100+20+50) + (10+5+60) = 245
    expect(u.tokens).toBe(245);
    expect(u.costUsd).toBeNull(); // local model => cost 0 => null
  });

  it('returns nulls on empty / non-JSON output', () => {
    const u = parseOpencodeUsage('not json\n\n', '');
    expect(u.tokens).toBeNull();
    expect(u.turns).toBeNull();
    expect(u.toolCalls).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('adapter: SubprocessAdapter group-timeout (orphan-proof)', () => {
  function ctx(agentTimeoutSec: number) {
    const task = TaskSpecSchema.parse({
      id: 'to',
      name: 'to',
      instruction: 'noop',
      verifyCmd: 'true',
      agentTimeoutSec,
    });
    return { task, condition: makeBaselineCondition(), workdir: scratchRoot(), seed: 0, model: 'none' };
  }

  it('kills a hung child tree and reports timeout within the window', async () => {
    // bash backgrounds one sleep and foregrounds another — mimics an agent that
    // forks a detached child holding the stdout pipe. Must NOT hang past ~timeout.
    const adapter = new SubprocessAdapter({
      id: 'hang',
      bin: 'bash',
      args: ['-c', 'sleep 600 & sleep 600'],
      parseUsage: () => ({}),
    });
    const start = Date.now();
    const r = await adapter.run(ctx(2));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8000);
    expect(r.error).toMatch(/timed out/);
  }, 15000);

  it('returns cleanly for a fast command', async () => {
    const adapter = new SubprocessAdapter({
      id: 'fast',
      bin: 'bash',
      args: ['-c', 'echo hello'],
      parseUsage: (out) => ({ tokens: out.includes('hello') ? 1 : null }),
    });
    const r = await adapter.run(ctx(10));
    expect(r.error).toBeNull();
    expect(r.tokens).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('adapter: raw FILE-block parser', () => {
  it('extracts multiple files with their content', () => {
    const text =
      'preamble\n<<<FILE src/a.js>>>\nconst a = 1;\nmodule.exports = a;\n<<<END>>>\n' +
      'noise\n<<<FILE b.py>>>\ndef f():\n    return 2\n<<<END>>>\n';
    const blocks = parseFileBlocks(text);
    expect(blocks.map((b) => b.path)).toEqual(['src/a.js', 'b.py']);
    expect(blocks[0].content).toBe('const a = 1;\nmodule.exports = a;');
    expect(blocks[1].content).toBe('def f():\n    return 2');
  });

  it('returns [] when there are no markers', () => {
    expect(parseFileBlocks('just some prose, no files')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('adapter: mini-swe-agent (external comparability anchor)', () => {
  // The SubprocessAdapter keeps its config private; read it structurally for the
  // unit test rather than spawning `mini` (not installed in CI).
  type Cfg = { cfg: { id: string; bin: string; args: string[] } };
  const cfgOf = (a: unknown) => (a as unknown as Cfg).cfg;

  it('defaults to `mini`, embeds the model, and substitutes the instruction', () => {
    const a = miniSweAdapter('qwen36-a3b');
    expect(a.id).toBe('mini-swe-agent');
    const cfg = cfgOf(a);
    expect(cfg.bin).toBe('mini');
    expect(cfg.args).toContain('qwen36-a3b');
    expect(cfg.args).toContain('{instruction}');
  });

  it('honors UAP_MINISWE_BIN / UAP_MINISWE_ARGS overrides', () => {
    const prevBin = process.env.UAP_MINISWE_BIN;
    const prevArgs = process.env.UAP_MINISWE_ARGS;
    try {
      process.env.UAP_MINISWE_BIN = 'mini-extra';
      process.env.UAP_MINISWE_ARGS = '--model local/qwen -t {instruction}';
      const cfg = cfgOf(miniSweAdapter('ignored'));
      expect(cfg.bin).toBe('mini-extra');
      expect(cfg.args).toEqual(['--model', 'local/qwen', '-t', '{instruction}']);
    } finally {
      if (prevBin === undefined) delete process.env.UAP_MINISWE_BIN;
      else process.env.UAP_MINISWE_BIN = prevBin;
      if (prevArgs === undefined) delete process.env.UAP_MINISWE_ARGS;
      else process.env.UAP_MINISWE_ARGS = prevArgs;
    }
  });

  it('parseMiniSweUsage reads a trailing JSON summary and is null-safe otherwise', () => {
    const withSummary = parseMiniSweUsage(
      'step 1\nstep 2\n{"steps": 4, "cost": 0.12, "usage": {"total_tokens": 5000}}\n'
    );
    expect(withSummary.turns).toBe(4);
    expect(withSummary.costUsd).toBeCloseTo(0.12);
    expect(withSummary.tokens).toBe(5000);
    expect(parseMiniSweUsage('no json here\n')).toEqual({});
  });
});

describe('suite loading + verify ground truth', () => {
  it('loads the smoke suite (3 tasks, sorted)', () => {
    const tasks = loadSuite(SMOKE_SUITE);
    expect(tasks.map((t) => t.id)).toEqual(['smoke-easy', 'smoke-hard', 'smoke-medium']);
    expect(tasks.every((t) => t.verifyCmd.length > 0)).toBe(true);
  });

  it('real-gate verify fails on the unmodified fixture and passes once fixed', () => {
    const task = loadTask(join(REAL_SUITE, 'js-sum-bug'));
    const wd = materializeWorkdir(REAL_SUITE, task, scratchRoot());
    // Unmodified: should fail.
    expect(runVerify(task, wd).passed).toBe(false);
    // Apply the fix and re-verify: should pass.
    const file = join(wd, 'sum.js');
    writeFileSync(file, readFileSync(file, 'utf-8').replace('a - b', 'a + b'));
    expect(runVerify(task, wd).passed).toBe(true);
  });

  it('throws on a missing suite directory', () => {
    expect(() => loadSuite(join(tmpdir(), 'definitely-not-a-suite-xyz'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('scaffold injection (the UAP on/off toggle)', () => {
  it('injects AGENTS.md + manifest only for non-baseline arms', () => {
    const dir = scratchRoot();
    const baseDir = join(dir, 'base');
    const fullDir = join(dir, 'full');
    mkdirSync(baseDir);
    mkdirSync(fullDir);

    const baseManifest = applyScaffolding(baseDir, makeBaselineCondition());
    expect(baseManifest.injectedFiles).toEqual([]);
    expect(existsSync(join(baseDir, 'AGENTS.md'))).toBe(false);

    const fullManifest = applyScaffolding(fullDir, makeFullCondition());
    expect(fullManifest.injectedFiles).toContain('AGENTS.md');
    expect(existsSync(join(fullDir, '.uap-bench.json'))).toBe(true);
    const agentsMd = readFileSync(join(fullDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toMatch(/Completion Gates/);
  });

  it('scaffoldEnv encodes the active components and gate flag', () => {
    const env = scaffoldEnv(makeFullCondition());
    expect(env.UAP_BENCH_COMPONENTS?.split(',').sort()).toEqual([...UAP_COMPONENTS].sort());
    expect(env.UAP_DELIVER_ACTIVE).toBe('1');
    expect(scaffoldEnv(makeBaselineCondition()).UAP_DELIVER_ACTIVE).toBe('0');
  });

  it('isBaseline/hash01 helpers behave', () => {
    expect(isBaseline(makeBaselineCondition())).toBe(true);
    expect(isBaseline(makeFullCondition())).toBe(false);
    const h = hash01('abc');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(1);
    expect(hash01('abc')).toBe(h); // stable
  });
});

// ---------------------------------------------------------------------------
describe('end-to-end: runner -> analyze -> ablation (mock adapter)', () => {
  it('produces paired records and a baseline-vs-full comparison', async () => {
    const tasks = loadSuite(SMOKE_SUITE);
    const cfg: RunnerConfig = {
      tasks,
      conditions: [makeBaselineCondition(), makeFullCondition()],
      adapter: new MockAdapter(),
      model: 'test-model',
      epochs: 6,
      concurrency: 4,
      workRoot: scratchRoot(),
    };
    const out = await runPaired(cfg, SMOKE_SUITE, new Date().toISOString());
    // 3 tasks * 6 epochs * 2 conditions
    expect(out.records.length).toBe(36);

    const report = analyze(out, { seed: 1, iterations: 1500 });
    expect(report.meta.taskCount).toBe(3);
    expect(report.perCondition.length).toBe(2);
    const cmp = report.comparisons.find((c) => c.label === 'uap-full');
    expect(cmp).toBeDefined();
    // The mock is constructed so UAP lifts correctness => net gate gain >= 0.
    expect(cmp!.correctness.mcnemar.netGain).toBeGreaterThanOrEqual(0);
    expect(cmp!.correctness.treatmentRate).toBeGreaterThanOrEqual(cmp!.correctness.baselineRate);
    // Token overhead should be reported as a positive paired delta.
    expect(cmp!.metrics.tokens!.meanDelta).toBeGreaterThan(0);
  });

  it('ablation matrix attributes a contribution to every component', async () => {
    const tasks = loadSuite(SMOKE_SUITE);
    const conditions = buildAblationConditions();
    // baseline + full + one per component
    expect(conditions.length).toBe(2 + UAP_COMPONENTS.length);

    const cfg: RunnerConfig = {
      tasks,
      conditions,
      adapter: new MockAdapter(),
      model: 'test-model',
      epochs: 6,
      concurrency: 6,
      workRoot: scratchRoot(),
    };
    const out = await runPaired(cfg, SMOKE_SUITE, new Date().toISOString());
    const abl = analyzeAblation(out, { seed: 2, iterations: 1500 });
    expect(abl.contributions.length).toBe(UAP_COMPONENTS.length);
    // Contributions are sorted descending by correctness delta.
    for (let i = 1; i < abl.contributions.length; i++) {
      expect(abl.contributions[i - 1].correctnessDelta.meanDelta).toBeGreaterThanOrEqual(
        abl.contributions[i].correctnessDelta.meanDelta
      );
    }
  });

  it('analyze throws when the baseline arm is absent', async () => {
    const tasks = loadSuite(SMOKE_SUITE);
    const cfg: RunnerConfig = {
      tasks,
      conditions: [makeFullCondition()], // no baseline
      adapter: new MockAdapter(),
      model: 'test-model',
      epochs: 2,
      concurrency: 2,
      workRoot: scratchRoot(),
    };
    const out = await runPaired(cfg, SMOKE_SUITE, new Date().toISOString());
    expect(() => analyze(out, {})).toThrow(/baseline/);
  });
});
