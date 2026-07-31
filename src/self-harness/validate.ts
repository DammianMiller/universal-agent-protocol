/**
 * Self-Harness — the REAL validator (Stage 3), wiring the orchestrator's injected
 * `Validator` seam to the existing paired benchmark (`benchmarks/paired/`).
 *
 * For a candidate `env` Mod the physical A/B is a *server-side* change: the two
 * arms differ only in the inference server's launch env, so they cannot run in a
 * single paired pass. This validator therefore:
 *
 *   1. runs the suite as the `baseline` arm (current harness);
 *   2. physically applies the Mod to the env file + restarts the server;
 *   3. runs the suite again as the `candidate` arm;
 *   4. REVERTS the env file + restarts (each Mod is validated in isolation — §7);
 *   5. pairs the two arms cell-for-cell (`taskId#seed`) and runs `analyze` to get
 *      the same paired statistics `uap bench paired` ships.
 *
 * The held-out suite (disjoint tasks) runs the same way to catch overfitting. The
 * suite-arm runner and the server restart are INJECTED so the loop is testable
 * without a live llama server.
 *
 * `tool` and `middleware` Mods ARE auto-validated (harness plan B), but by a
 * different physical route: they are CLIENT-side, so the arms differ by a
 * process env var and no server restart is needed.
 *
 * `scaffold` / `config` Mods are NOT auto-validated here — free-form prompt text
 * is unbounded, and prompt-only edits measured NEGATIVE (-2.3pp, arXiv
 * 2604.25850). They route through the human-gated pending queue (§9). Passing one
 * returns a null (no-lift) comparison so `decide` rejects it.
 *
 * See docs/design/SELF_HARNESS.md §4, §7, §11.
 */

import { runPaired } from '../benchmarks/paired/runner.js';
import { analyze, type Comparison, type AnalyzeOptions } from '../benchmarks/paired/report.js';
import {
  makeFullCondition,
  type AgentAdapter,
  type Condition,
  type RunRecord,
  type TaskSpec,
  type UapComponent,
} from '../benchmarks/paired/types.js';
import { applyEnvModToFile } from './profile.js';
import { Mod, invertMod, describeMod, validateMod, EnvMod } from './mods.js';
import type { Validator, ValidationOutcome } from './orchestrator.js';

const BASELINE_LABEL = 'baseline';
const CANDIDATE_LABEL = 'candidate';

/** Run one suite arm under a fixed label + component set, returning its records. */
export type ArmRunner = (
  suiteDir: string,
  label: string,
  components: ReadonlySet<UapComponent>,
) => Promise<RunRecord[]>;

export interface ValidatorDeps {
  /** Validation suite dir (fixed tasks the Mod is optimized against). */
  suiteDir: string;
  /** Held-out suite dir (disjoint tasks; regression guard). Null skips it. */
  heldoutDir?: string | null;
  /** KEY=value env file the env Mod is written to (e.g. llama-server.env). */
  envPath: string;
  /** Restart the inference server so an env change takes effect. */
  restart: () => Promise<void>;
  /**
   * Components active in BOTH arms — the current harness scaffold. Defaults to
   * full UAP (the shipping surface); an env Mod is orthogonal to the scaffold.
   */
  components?: ReadonlySet<UapComponent>;
  /** Concrete adapter for the default arm runner (required unless `runArm` given). */
  adapter?: AgentAdapter;
  /** Model id stamped on the run (default arm runner). */
  model?: string;
  /** Paired seeds/epochs per (task, arm) — research floor is 5. */
  epochs?: number;
  /** Max concurrent cells in the default arm runner. */
  concurrency?: number;
  /** Paired-statistics options (seed, iterations, ropeMargin) — passed to analyze. */
  analyzeOpts?: AnalyzeOptions;
  /** Injected arm runner (default: real `runPaired`). Overridable for tests. */
  runArm?: ArmRunner;
  log?: (msg: string) => void;
}

/**
 * Build a real, live-suite `Validator` for the orchestrator. `env` Mods are
 * validated against the server; `tool`/`middleware` Mods against a process-env
 * flip; everything else returns a null comparison (reject).
 */
export function buildValidator(deps: ValidatorDeps): Validator {
  const components = deps.components ?? makeFullCondition().components;
  const log = deps.log ?? (() => {});
  const runArm = deps.runArm ?? defaultArmRunner(deps, components);

  return async (mod: Mod): Promise<ValidationOutcome> => {
    // Harness plan B: `tool` and `middleware` Mods are now auto-validated too.
    // They are CLIENT-side (executor env / proxy config), so their A/B needs a
    // process-env flip on the candidate arm rather than a server restart — which
    // is exactly why they were reachable all along and simply were not wired.
    // `scaffold`/`config` still route to the human gate: free-form prompt text is
    // unbounded, and prompt-only edits measured NEGATIVE (arXiv 2604.25850).
    if (mod.kind === 'tool' || mod.kind === 'middleware') {
      // A Mod reaching this far sets a process env var, which is the only
      // env-injection primitive in the codebase (NODE_OPTIONS, ALLOW_STUBS,
      // ALLOW_BASH...). `buildValidator` is exported public API and the Proposer
      // interface is explicitly "the seam an LLM proposer drops into", so the
      // allow-list check cannot be left to the proposers' good manners.
      const check = validateMod(mod);
      if (!check.ok) {
        log(`  refusing ${describeMod(mod)}: ${check.reason}`);
        return { validation: nullComparison(), heldout: null };
      }
      const key = mod.kind === 'tool' ? mod.key : middlewareEnvKey(mod.id);
      const value = mod.kind === 'tool' ? mod.to : mod.params.enabled === false ? '0' : '1';
      // Capture the OBSERVED prior, not the Mod's claimed `from`: a proposer that
      // mis-states `from` would otherwise leave the wrong value set for every
      // later candidate in this process, silently degrading their baselines.
      let prior: string | undefined;
      const apply = () => {
        prior = process.env[key];
        process.env[key] = value;
      };
      const restore = () => {
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      };
      const runClientSuite = async (dir: string): Promise<Comparison> => {
        const baseRecs = await runArm(dir, BASELINE_LABEL, components);
        apply();
        let candRecs: RunRecord[];
        try {
          candRecs = await runArm(dir, CANDIDATE_LABEL, components);
        } finally {
          // Always restore: a leaked env var would silently contaminate every
          // later candidate in the same process (§7 isolation).
          restore();
        }
        return compare([...baseRecs, ...candRecs], deps.analyzeOpts);
      };
      log(`  auto-validating ${mod.kind} Mod: ${describeMod(mod)}`);
      const validation = await runClientSuite(deps.suiteDir);
      const heldout = deps.heldoutDir ? await runClientSuite(deps.heldoutDir) : null;
      return { validation, heldout };
    }

    if (mod.kind !== 'env') {
      log(`  ${describeMod(mod)} is ${mod.kind} — routed to human gate, no auto-validation`);
      return { validation: nullComparison(), heldout: null };
    }
    const envMod: EnvMod = mod;

    const runSuite = async (dir: string): Promise<Comparison> => {
      // Arm 1 — baseline (current server state).
      const baseRecs = await runArm(dir, BASELINE_LABEL, components);
      // Apply the Mod + restart so the candidate arm sees the new env.
      applyEnvModToFile(deps.envPath, envMod);
      await deps.restart();
      let candRecs: RunRecord[];
      try {
        candRecs = await runArm(dir, CANDIDATE_LABEL, components);
      } finally {
        // Always revert to leave the server clean regardless of the arm outcome.
        applyEnvModToFile(deps.envPath, invertMod(envMod) as EnvMod);
        await deps.restart();
      }
      return compare([...baseRecs, ...candRecs], deps.analyzeOpts);
    };

    log(`  validating on ${deps.suiteDir}${deps.heldoutDir ? ` + held-out ${deps.heldoutDir}` : ''}`);
    const validation = await runSuite(deps.suiteDir);
    const heldout = deps.heldoutDir ? await runSuite(deps.heldoutDir) : null;
    return { validation, heldout };
  };
}

/**
 * Env var a middleware toggle maps to, e.g. `toolcall-path-normalizer` ->
 * `UAP_MW_TOOLCALL_PATH_NORMALIZER`. Shared with the proxy so a validated
 * toggle means the same thing in both processes.
 */
export function middlewareEnvKey(id: string): string {
  return `UAP_MW_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/** Default arm runner: a single-condition `runPaired` over the suite. */
function defaultArmRunner(deps: ValidatorDeps, _components: ReadonlySet<UapComponent>): ArmRunner {
  const adapter = deps.adapter;
  if (!adapter) {
    // Defer the error until first use so tests that inject runArm never hit it.
    return async () => {
      throw new Error('buildValidator: default runArm requires an `adapter` in deps');
    };
  }
  return async (suiteDir, label, components) => {
    const { loadSuite } = await import('../benchmarks/paired/suite.js');
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    const tasks: TaskSpec[] = loadSuite(suiteDir);
    const condition: Condition = { label, components };
    const workRoot = mkdtempSync(join(tmpdir(), 'sh-validate-'));
    const out = await runPaired(
      {
        tasks,
        conditions: [condition],
        adapter,
        model: deps.model ?? 'unknown',
        epochs: deps.epochs ?? 5,
        concurrency: deps.concurrency ?? 4,
        workRoot,
      },
      suiteDir,
      new Date().toISOString(),
    );
    return out.records;
  };
}

/** Wrap combined baseline+candidate records and analyze into a Comparison. */
export function compare(records: RunRecord[], analyzeOpts?: AnalyzeOptions): Comparison {
  const report = analyze(
    {
      records,
      model: records[0]?.model ?? 'unknown',
      adapter: records[0]?.adapter ?? 'unknown',
      epochs: countSeeds(records),
      startedAt: '',
      finishedAt: '',
    },
    { ...analyzeOpts, baselineLabel: BASELINE_LABEL },
  );
  const cmp = report.comparisons.find((c) => c.label === CANDIDATE_LABEL);
  if (!cmp) {
    throw new Error(
      `compare: no '${CANDIDATE_LABEL}' comparison produced (labels: ${report.comparisons
        .map((c) => c.label)
        .join(', ')})`,
    );
  }
  return cmp;
}

function countSeeds(records: RunRecord[]): number {
  return new Set(records.map((r) => r.seed)).size || 1;
}

/** A no-lift comparison (Δ=0, not significant) so `decide` rejects. */
export function nullComparison(): Comparison {
  return {
    label: CANDIDATE_LABEL,
    baseline: BASELINE_LABEL,
    correctness: {
      baselineRate: 0,
      treatmentRate: 0,
      delta: { meanDelta: 0, ci: { lower: 0, upper: 0 }, pValue: 1, n: 0, significant: false },
      mcnemar: { bothCorrect: 0, onlyTreatment: 0, onlyBaseline: 0, bothWrong: 0, netGain: 0, pValue: 1, n: 0 },
      verdict: 'tie',
    },
    metrics: {},
    metricVerdicts: {},
  };
}

export { BASELINE_LABEL, CANDIDATE_LABEL };
