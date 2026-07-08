/**
 * Verifier Ladder
 *
 * Turns the repository's completion gates (build, type-check, test, lint)
 * into a programmatic verifier that the convergence loop can call after each
 * model iteration. Each rung runs a real command in the project root; the
 * ladder reports a pass/fail per rung, an aggregate score (fraction of rungs
 * passed), and structured feedback sized for small-model context budgets.
 *
 * Detection is npm-centric (package.json scripts); callers targeting other
 * ecosystems can pass explicit rungs.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { synthesizeExecutionRung } from './execution-gate.js';

/**
 * Cheap-first promotion tiers. The convergence loop runs the cheapest tier
 * first and only promotes to the next, more expensive tier once the prior is
 * green. `fast` is the existing build/typecheck/unit-test/lint band; the
 * `ci`/`deploy-staging`/`deploy-prod` bands are NEVER run locally — they are
 * consumed after commit via the CI watcher (see ci-watcher.ts).
 */
export type GateTier =
  | 'fast'
  | 'runtime'
  | 'integration'
  | 'deploy-dev'
  | 'ci'
  | 'deploy-staging'
  | 'deploy-prod';

/** Cheap → expensive promotion order. */
export const TIER_ORDER: GateTier[] = [
  'fast',
  'runtime',
  'integration',
  'deploy-dev',
  'ci',
  'deploy-staging',
  'deploy-prod',
];

export interface GateRung {
  /** Stable identifier, e.g. 'build', 'typecheck', 'test', 'lint' */
  id: string;
  /** Human-readable name shown in feedback */
  name: string;
  /** Executable to run (no shell interpolation) */
  command: string;
  /** Arguments passed verbatim */
  args: string[];
  /**
   * Required rungs gate delivery: the ladder only passes when all required
   * rungs pass, and a required failure stops later rungs (fail-fast).
   * Optional rungs are reported but never block delivery.
   */
  required: boolean;
  /** Per-rung timeout in milliseconds */
  timeoutMs: number;
  /**
   * Cheap-first promotion tier. Absent ⇒ 'fast' (back-compat: existing
   * callers and detectors that predate tiering keep working).
   */
  tier?: GateTier;
  /**
   * Optional teardown run after the rung regardless of outcome (e.g. a
   * deploy-dev compose down / server kill). Best-effort; a teardown failure
   * never flips a passing rung to failed.
   */
  teardown?: { command: string; args: string[]; timeoutMs: number };
}

/** Effective tier for a rung — absent tier means the original `fast` band. */
export function tierOf(rung: GateRung): GateTier {
  return rung.tier ?? 'fast';
}

export type RungFailureReason = 'exit' | 'timeout' | 'signal' | 'spawn-error';

export interface RungResult {
  id: string;
  name: string;
  passed: boolean;
  /** True when the rung never ran because an earlier required rung failed */
  skipped: boolean;
  exitCode: number | null;
  /** Why the rung failed; undefined when it passed or was skipped */
  failureReason?: RungFailureReason;
  durationMs: number;
  /** Tail of combined stdout+stderr, truncated for prompt injection */
  outputTail: string;
}

export interface LadderResult {
  /** True when every required rung passed */
  passed: boolean;
  /** Fraction of all rungs that passed (skipped rungs count as not passed) */
  score: number;
  results: RungResult[];
  /** Structured feedback for the next loop iteration */
  feedback: string;
}

export interface LadderOptions {
  /** Stop at the first failing required rung (default true — cheaper feedback) */
  failFast?: boolean;
  /** Max characters of command output included per failing rung (default 2000) */
  outputTailChars?: number;
  /** Default per-rung timeout in ms (default 300000) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_TAIL_CHARS = 2_000;

// Secret-stripping for gate spawns now lives in ./sanitized-env (shared with
// the execution/self gates and the agentic executor's own shell; the pattern
// was broadened after an audit found SSH_AUTH_SOCK/DATABASE_URL/*_PRIVATE_KEY
// surviving). Re-exported for existing importers.
export { sanitizedEnv } from './sanitized-env.js';
import { sanitizedEnv } from './sanitized-env.js';

/**
 * Detect the gate rungs available in a project from its package.json scripts.
 * Order matters: cheap/structural gates run before expensive ones so failure
 * feedback arrives fast.
 */
export function detectRungs(projectRoot: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): GateRung[] {
  const rungs: GateRung[] = [];

  const pkgPath = join(projectRoot, 'package.json');
  let scripts: Record<string, string> = {};
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
      scripts = pkg.scripts ?? {};
    } catch {
      scripts = {};
    }
  }

  if (scripts['build']) {
    rungs.push({
      id: 'build',
      name: 'Build (npm run build)',
      command: 'npm',
      args: ['run', 'build'],
      required: true,
      timeoutMs,
      tier: 'fast',
    });
  }

  // Type-check is meaningful for TypeScript projects even when build exists
  // (build may use a bundler that skips type errors). --no-install fails
  // closed instead of letting npx fetch the registry package named 'tsc'.
  if (
    existsSync(join(projectRoot, 'tsconfig.json')) &&
    existsSync(join(projectRoot, 'node_modules', '.bin', 'tsc'))
  ) {
    rungs.push({
      id: 'typecheck',
      name: 'Type-check (tsc --noEmit)',
      command: 'npx',
      args: ['--no-install', 'tsc', '--noEmit'],
      required: true,
      timeoutMs,
      tier: 'fast',
    });
  }

  if (scripts['test']) {
    rungs.push({
      id: 'test',
      name: 'Tests (npm test)',
      command: 'npm',
      args: ['test'],
      required: true,
      timeoutMs,
      tier: 'fast',
    });
  }

  if (scripts['lint']) {
    rungs.push({
      id: 'lint',
      name: 'Lint (npm run lint)',
      command: 'npm',
      args: ['run', 'lint'],
      required: false,
      timeoutMs,
      tier: 'fast',
    });
  }

  // Non-npm projects (the common case for polyglot CLI tasks) expose their
  // checks differently. Detect the real ones so deliver gates on the task's
  // own verifier instead of a hallucinated self-gate.
  if (rungs.length === 0) {
    rungs.push(...detectNonNpmRungs(projectRoot, timeoutMs));
  }

  // Promotion tiers above `fast`: integration suites and a local dev
  // deploy+smoke. These are appended after the fast band so cheap-first
  // promotion (runTieredLadder) runs them only once the fast tier is green.
  rungs.push(...detectIntegrationRungs(projectRoot, scripts, timeoutMs));
  const deployDev = detectDeployDevRung(projectRoot, scripts, timeoutMs);
  if (deployDev) rungs.push(deployDev);

  // Execution gate: prove the artifact actually RUNS, not just that it builds or
  // parses. Appended whenever a runnable artifact (web/node/cli/lib) is detected
  // so crash-class bugs — TDZ ReferenceErrors, undefined cross-file globals,
  // init throws — can never ship green. When nothing is runnable this is null and
  // the caller's fail-closed floor (convergence-loop "no verifiable gates") holds.
  if (!rungs.some((r) => r.id === 'execution')) {
    const exec = synthesizeExecutionRung(projectRoot, timeoutMs);
    if (exec) rungs.push(exec);
  }

  return rungs;
}

/**
 * Detect integration / end-to-end suites: npm `test:integration` / `test:e2e`
 * scripts, or a pytest project declaring an `integration` marker. These cost
 * more than unit tests, so they live in the `integration` tier and only run
 * after the fast tier passes.
 */
export function detectIntegrationRungs(
  projectRoot: string,
  scripts: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): GateRung[] {
  const rungs: GateRung[] = [];
  // Integration suites are slower; give them a larger budget (capped at 20m).
  const integrationTimeout = Math.min(timeoutMs * 4, 1_200_000);

  if (scripts['test:integration']) {
    rungs.push({
      id: 'test:integration',
      name: 'Integration tests (npm run test:integration)',
      command: 'npm',
      args: ['run', 'test:integration'],
      required: true,
      timeoutMs: integrationTimeout,
      tier: 'integration',
    });
  }
  if (scripts['test:e2e']) {
    rungs.push({
      id: 'test:e2e',
      name: 'E2E tests (npm run test:e2e)',
      command: 'npm',
      args: ['run', 'test:e2e'],
      required: true,
      timeoutMs: integrationTimeout,
      tier: 'integration',
    });
  }

  // pytest integration marker — only when no npm integration script already
  // covers it, to avoid double-running in polyglot repos.
  if (rungs.length === 0 && pytestHasIntegrationMarker(projectRoot)) {
    rungs.push({
      id: 'pytest:integration',
      name: 'Integration tests (pytest -m integration)',
      command: 'python3',
      args: ['-m', 'pytest', '-m', 'integration', '-q'],
      required: true,
      timeoutMs: integrationTimeout,
      tier: 'integration',
    });
  }

  return rungs;
}

/** True when a pytest config declares an `integration` marker. */
function pytestHasIntegrationMarker(projectRoot: string): boolean {
  for (const file of ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) {
    const p = join(projectRoot, file);
    if (!existsSync(p)) continue;
    try {
      const body = readFileSync(p, 'utf-8');
      // Look for a `markers` block that mentions integration.
      if (/markers\b[\s\S]{0,400}?integration\b/i.test(body)) return true;
    } catch {
      /* unreadable config */
    }
  }
  return false;
}

/**
 * Detect a local dev deploy+smoke gate. Priority:
 *   1. an explicit `deploy:dev` / `smoke:dev` / `smoke` npm script;
 *   2. a docker-compose file paired with a `smoke` script (compose brought up
 *      by the deploy-dev runner, torn down via the rung's teardown);
 * Returns null when nothing is discoverable — the loop still converges on the
 * fast + integration tiers. The deploy-dev tier is only RUN when the caller
 * opts in (maxTier >= deploy-dev); detection is always safe.
 */
export function detectDeployDevRung(
  projectRoot: string,
  scripts: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): GateRung | null {
  const deployTimeout = Math.min(timeoutMs, 300_000);

  if (scripts['deploy:dev']) {
    return {
      id: 'deploy:dev',
      name: 'Dev deploy + smoke (npm run deploy:dev)',
      command: 'npm',
      args: ['run', 'deploy:dev'],
      required: true,
      timeoutMs: deployTimeout,
      tier: 'deploy-dev',
    };
  }

  const smokeScript = scripts['smoke:dev'] ? 'smoke:dev' : scripts['smoke'] ? 'smoke' : null;
  const composeFile = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find(
    (f) => existsSync(join(projectRoot, f))
  );

  if (smokeScript && composeFile) {
    // Compose is brought up by the deploy-dev runner; the smoke script is the
    // health check; teardown always tears the stack down (see deploy-dev-gate).
    return {
      id: 'deploy:dev:compose',
      name: `Dev deploy + smoke (compose up → npm run ${smokeScript})`,
      command: 'npm',
      args: ['run', smokeScript],
      required: true,
      timeoutMs: deployTimeout,
      tier: 'deploy-dev',
      teardown: { command: 'docker', args: ['compose', 'down', '-v'], timeoutMs: 30_000 },
    };
  }

  if (smokeScript) {
    // Smoke check with no compose — the runner starts `npm start` (if present)
    // in the background, runs smoke, then kills it.
    return {
      id: 'deploy:dev:smoke',
      name: `Dev deploy + smoke (npm run ${smokeScript})`,
      command: 'npm',
      args: ['run', smokeScript],
      required: true,
      timeoutMs: deployTimeout,
      tier: 'deploy-dev',
    };
  }

  return null;
}

/**
 * Detect real gates in non-npm projects: a Makefile test/check/build target,
 * a pytest suite, or a conventional shell test script. Ordered cheap→expensive.
 */
export function detectNonNpmRungs(projectRoot: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): GateRung[] {
  const rungs: GateRung[] = [];
  const has = (p: string): boolean => existsSync(join(projectRoot, p));

  // Makefile — prefer a test/check target, else the default build target.
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find((m) => has(m));
  if (makefile) {
    let target: string | null = null;
    try {
      const body = readFileSync(join(projectRoot, makefile), 'utf-8');
      if (/^test\s*:/m.test(body)) target = 'test';
      else if (/^check\s*:/m.test(body)) target = 'check';
      else if (/^(all|build)\s*:/m.test(body)) target = null; // default goal
    } catch {
      /* unreadable Makefile — fall back to default goal */
    }
    rungs.push({
      id: 'make',
      name: `Make (${target ? `make ${target}` : 'make'})`,
      command: 'make',
      args: target ? [target] : [],
      required: true,
      timeoutMs,
    });
  }

  // pytest — only when there are actual test files (an empty suite exits 5).
  let hasPyTests = has('tests') || has('test');
  if (!hasPyTests) {
    try {
      hasPyTests = readdirSync(projectRoot).some((f) => /^test_.*\.py$|.*_test\.py$/.test(f));
    } catch {
      /* unreadable dir */
    }
  }
  if (hasPyTests && rungs.length === 0) {
    rungs.push({
      id: 'pytest',
      name: 'Tests (pytest)',
      command: 'python3',
      args: ['-m', 'pytest', '-q'],
      required: true,
      timeoutMs,
    });
  }

  // Conventional shell test/check scripts (NOT deliver's own .uap-deliver gate).
  if (rungs.length === 0) {
    const script = ['run_tests.sh', 'run-tests.sh', 'test.sh', 'tests.sh', 'check.sh'].find((s) => has(s));
    if (script) {
      rungs.push({
        id: 'script',
        name: `Script (bash ${script})`,
        command: 'bash',
        args: [script],
        required: true,
        timeoutMs,
      });
    }
  }

  return rungs;
}

export function truncateTail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…(truncated)…\n${trimmed.slice(-maxChars)}`;
}

/** Run a single rung synchronously in the project root. */
export function runRung(rung: GateRung, projectRoot: string, tailChars: number = DEFAULT_TAIL_CHARS): RungResult {
  const start = Date.now();
  const res = spawnSync(rung.command, rung.args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: rung.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: sanitizedEnv(),
  });

  const durationMs = Date.now() - start;
  const exitCode = res.status;
  const passed = exitCode === 0;

  // spawnSync reports timeouts/missing binaries via res.error (+ res.signal),
  // with status null and empty output — without this the model would get a
  // bare "FAIL" and burn its turn budget against an unexplained gate.
  let failureReason: RungFailureReason | undefined;
  let diagnostic = '';
  if (!passed) {
    const errCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
    if (errCode === 'ETIMEDOUT' || (res.error && res.signal === 'SIGTERM')) {
      failureReason = 'timeout';
      diagnostic = `Gate timed out after ${rung.timeoutMs}ms.`;
    } else if (res.error) {
      failureReason = 'spawn-error';
      diagnostic = `Gate could not run: ${res.error.message}`;
    } else if (res.signal) {
      failureReason = 'signal';
      diagnostic = `Gate was killed by signal ${res.signal}.`;
    } else {
      failureReason = 'exit';
    }
  }

  const combined = `${diagnostic}\n${res.stdout ?? ''}\n${res.stderr ?? ''}`;

  return {
    id: rung.id,
    name: rung.name,
    passed,
    skipped: false,
    exitCode,
    failureReason,
    durationMs,
    outputTail: passed ? '' : truncateTail(combined, tailChars),
  };
}

/**
 * Build feedback text from rung results. Only the first failing required
 * rung's output is included in detail — small models do better with one
 * concrete problem at a time than with a wall of every failure.
 */
export function formatFeedback(results: RungResult[], rungs: GateRung[]): string {
  const requiredIds = new Set(rungs.filter((r) => r.required).map((r) => r.id));
  const lines: string[] = ['Gate results:'];
  for (const r of results) {
    const status = r.skipped ? 'SKIPPED (earlier gate failed)' : r.passed ? 'PASS' : 'FAIL';
    const optional = requiredIds.has(r.id) ? '' : ' (optional)';
    lines.push(`- ${r.name}${optional}: ${status}`);
  }

  const firstFailure =
    results.find((r) => !r.passed && !r.skipped && requiredIds.has(r.id)) ??
    results.find((r) => !r.passed && !r.skipped);
  if (firstFailure && firstFailure.outputTail) {
    lines.push('');
    lines.push(`Fix this gate first — ${firstFailure.name} output:`);
    lines.push('```');
    lines.push(firstFailure.outputTail);
    lines.push('```');
  }

  return lines.join('\n');
}

/** Run the full ladder, honoring fail-fast for required rungs. */
export function runLadder(
  rungs: GateRung[],
  projectRoot: string,
  options: LadderOptions = {}
): LadderResult {
  const failFast = options.failFast ?? true;
  const tailChars = options.outputTailChars ?? DEFAULT_TAIL_CHARS;

  const results: RungResult[] = [];
  let stop = false;

  for (const rung of rungs) {
    if (stop) {
      results.push({
        id: rung.id,
        name: rung.name,
        passed: false,
        skipped: true,
        exitCode: null,
        durationMs: 0,
        outputTail: '',
      });
      continue;
    }

    const result = runRung(rung, projectRoot, tailChars);
    results.push(result);

    if (!result.passed && rung.required && failFast) {
      stop = true;
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const score = rungs.length > 0 ? passedCount / rungs.length : 1;

  // Delivery is gated on required rungs only; optional gates (lint) are
  // reported but never block convergence.
  const requiredRungs = rungs.filter((r) => r.required);
  const requiredPassed = results.filter(
    (r) => r.passed && requiredRungs.some((rung) => rung.id === r.id)
  ).length;
  const passed = requiredPassed === requiredRungs.length;

  return {
    passed,
    score,
    results,
    feedback: formatFeedback(results, rungs),
  };
}

/** A ladder runner: turns a set of rungs into a result. May be async. */
export type LadderRunFn = (
  rungs: GateRung[],
  projectRoot: string,
  options?: LadderOptions
) => LadderResult | Promise<LadderResult>;

export interface TieredLadderOptions extends LadderOptions {
  /**
   * Highest tier to run locally. Default 'deploy-dev'. The `ci`,
   * `deploy-staging` and `deploy-prod` tiers are never run locally — they are
   * verified after commit via the CI watcher — so they are skipped here.
   */
  maxTier?: GateTier;
  /**
   * Inner per-tier runner. Defaults to {@link runLadder}. Injecting this lets
   * the convergence loop's integrity wrapper compose around the whole tiered
   * run while reusing the standard rung execution underneath.
   */
  runner?: LadderRunFn;
  /**
   * Specialized runner for `deploy-dev` rungs (bring-up + smoke + teardown
   * lifecycle). When absent, deploy-dev rungs fall back to {@link runner},
   * which simply spawns the smoke command without managing a compose stack.
   */
  deployDevRunner?: LadderRunFn;
}

const skippedRung = (rung: GateRung): RungResult => ({
  id: rung.id,
  name: rung.name,
  passed: false,
  skipped: true,
  exitCode: null,
  durationMs: 0,
  outputTail: '',
});

/**
 * Cheap-first tiered ladder. Runs the cheapest tier first and only promotes to
 * the next, more expensive tier once the prior tier's required rungs pass. The
 * result is aggregated into a single {@link LadderResult} so the convergence
 * loop's per-turn contract (one ladder result, one feedback string) is
 * unchanged — tier failures flow back through the existing feedback channel.
 */
export async function runTieredLadder(
  rungs: GateRung[],
  projectRoot: string,
  options: TieredLadderOptions = {}
): Promise<LadderResult> {
  const maxTier = options.maxTier ?? 'deploy-dev';
  const maxIdx = TIER_ORDER.indexOf(maxTier);
  const runner: LadderRunFn = options.runner ?? runLadder;
  const tailChars = options.outputTailChars ?? DEFAULT_TAIL_CHARS;
  const innerOptions: LadderOptions = {
    failFast: options.failFast,
    outputTailChars: tailChars,
    timeoutMs: options.timeoutMs,
  };

  // Group rungs by tier, preserving insertion order within a tier.
  const byTier = new Map<GateTier, GateRung[]>();
  for (const rung of rungs) {
    const t = tierOf(rung);
    const list = byTier.get(t) ?? [];
    list.push(rung);
    byTier.set(t, list);
  }

  const results: RungResult[] = [];
  // Rungs that were eligible to run (tier <= maxTier); only these gate delivery.
  const inScope: GateRung[] = [];
  let promotionStopped = false;

  for (const tier of TIER_ORDER) {
    const tierRungs = byTier.get(tier);
    if (!tierRungs || tierRungs.length === 0) continue;

    const eligible = TIER_ORDER.indexOf(tier) <= maxIdx;
    if (!eligible) {
      // Above maxTier — verified remotely, never run locally.
      for (const rung of tierRungs) results.push(skippedRung(rung));
      continue;
    }
    inScope.push(...tierRungs);

    if (promotionStopped) {
      // A cheaper tier failed — don't pay for this tier.
      for (const rung of tierRungs) results.push(skippedRung(rung));
      continue;
    }

    const useRunner = tier === 'deploy-dev' && options.deployDevRunner ? options.deployDevRunner : runner;
    const tierResult = await useRunner(tierRungs, projectRoot, innerOptions);
    results.push(...tierResult.results);

    if (!tierResult.passed) promotionStopped = true;
  }

  // Aggregate — only in-scope rungs gate delivery (remote tiers are skipped).
  // Score is computed over in-scope rungs ONLY: out-of-scope rungs (above
  // maxTier) are skipped and must not dilute the convergence signal that feeds
  // printProgress / bestScore / --keep-best.
  const inScopeIds = new Set(inScope.map((r) => r.id));
  const inScopeResults = results.filter((r) => inScopeIds.has(r.id));
  const passedCount = inScopeResults.filter((r) => r.passed).length;
  const score = inScopeResults.length > 0 ? passedCount / inScopeResults.length : 1;
  const requiredInScope = inScope.filter((r) => r.required);
  const requiredPassed = requiredInScope.filter((rung) =>
    results.some((r) => r.id === rung.id && r.passed)
  ).length;
  const passed = requiredPassed === requiredInScope.length;

  return {
    passed,
    score,
    results,
    feedback: formatFeedback(results, inScope.length > 0 ? inScope : rungs),
  };
}
