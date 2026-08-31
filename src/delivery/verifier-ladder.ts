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
import { existsSync, readFileSync, readdirSync, lstatSync } from 'fs';
import { join, resolve, sep } from 'path';
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
  | 'final'
  | 'ci'
  | 'deploy-staging'
  | 'deploy-prod';

/** Cheap → expensive promotion order. */
/**
 * Tiers deferred while a non-promotion-blocking rung is red: the ones that stand
 * up real infrastructure per run — docker compose up/down, an ephemeral postgres,
 * migrations. See the cost ceiling in runTieredLadder.
 *
 * `runtime` and `final` are deliberately NOT here, even though `final` drives a
 * headless browser. They carry the two signals unblocking promotion existed to
 * deliver — does the artifact EXECUTE, and does it BEHAVE on the user journeys —
 * and deferring them would re-starve exactly what `blocksPromotion` unstarved,
 * just for a different reason. The complaint this ceiling answers was a compose
 * cycle every turn, not a browser run.
 */
export const COSTLY_TIERS: ReadonlySet<GateTier> = new Set<GateTier>([
  'integration',
  'deploy-dev',
]);

export const TIER_ORDER: GateTier[] = [
  'fast',
  'runtime',
  'integration',
  'deploy-dev',
  'final',
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
   * Names of the tests that PASSED when baseline-delta demoted this rung.
   *
   * Demotion says "this gate was already red, do not punish the mission for
   * it" — correct, but at rung granularity it also let the mission break
   * anything else in the same rung for free (the gap the demotion docstring
   * admits). This set is what makes the difference legible: a test that was
   * passing at baseline and is failing now is breakage this mission caused.
   *
   * A plain array rather than a Set so a rung stays structured-cloneable.
   */
  baselinePassing?: string[];
  /**
   * Optional teardown run after the rung regardless of outcome (e.g. a
   * deploy-dev compose down / server kill). Best-effort; a teardown failure
   * never flips a passing rung to failed.
   */
  teardown?: { command: string; args: string[]; timeoutMs: number };
  /**
   * Exit codes that count as a pass (default [0]). Lets marker-scoped pytest
   * rungs treat "no tests collected" (exit 5) as a vacuous pass instead of a
   * permanent required failure on repos that declare the marker but have not
   * written marked tests yet.
   */
  passExitCodes?: number[];
  /**
   * Working directory for the rung, relative to the project root (B1 declared
   * gates: `delivery.gates[].cwd`). Absent ⇒ the project root.
   */
  cwd?: string;
  /**
   * Path globs this gate covers (B1 declared gates: `delivery.gates[].scope`).
   * Metadata for mission-scoped gate relevance (A3); the ladder itself does
   * not filter on it yet.
   */
  scope?: string[];
  /**
   * Does a failure of this rung stop promotion to later tiers? Default true.
   *
   * Set false for a SYNTHETIC rung — one UAP injected rather than one the
   * project declares. The model-authored acceptance self-gate is the case this
   * exists for: it has no tier, so it lands in `fast`, and while it is red the
   * ladder never promotes to `runtime` or `final`. That starved the execution
   * gate, the user-path validator AND the vision review all at once, and it is
   * the steady state for a mature repo (`needsSelfGate` is raised when the
   * project's own gates are all GREEN).
   *
   * A non-promotion-blocking rung still counts toward the aggregate verdict —
   * it cannot be passed by ignoring it. It just stops one synthetic check from
   * hiding every real one behind it.
   */
  blocksPromotion?: boolean;
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
  /**
   * Per-test PASS/FAIL names parsed from the FULL output, before truncation.
   *
   * Parsing them from `outputTail` instead was a latent, size-dependent bug:
   * the tail keeps the SUFFIX, and every runner prints its per-test lines
   * ABOVE the panic bodies and summary. On a small crate the default 2 000-char
   * tail happens to retain them; on a real suite it retains none, the parse
   * returns null, and the regression check silently stops working —
   * nondeterministically, since libtest prints in completion order.
   */
  testOutcomes?: { passed: string[]; failed: string[] };
  /**
   * True when this is a TEST rung that exited 0 having run ZERO tests. Passing
   * because there is nothing to run is not evidence of anything — see
   * testsActuallyRan.
   */
  zeroTests?: boolean;
  /**
   * Why a skipped rung was skipped. 'deferred-cost' means the cost ceiling held
   * it back while a non-blocking rung is red — no gate FAILED, so reporting it as
   * "earlier gate failed" would point the model at a problem that does not exist.
   */
  skipReason?: 'earlier-failure' | 'deferred-cost';
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
  /**
   * Fail a test rung that exited 0 having run ZERO tests. Set at max fidelity:
   * "there were no tests" must never read as "the tests passed".
   */
  requireTestsRan?: boolean;
}

const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_TAIL_CHARS = 2_000;

/**
 * Tail kept from the one-off baseline preflight.
 *
 * The per-test names no longer come from here — `runRung` parses them from the
 * untruncated output — so this only governs how much failure text the demotion
 * report carries. Kept generous because it is paid once per mission.
 */
export const BASELINE_CAPTURE_TAIL_CHARS = 200_000;

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

  // Rust gates are detected UNCONDITIONALLY, not only when npm rungs are
  // absent: a polyglot root (package.json + Cargo.toml) previously produced
  // npm-only rungs, so cargo work could never turn a phase green — observed
  // live 2026-07-09, an 8-phase Rust mission stagnated to its turn cap because
  // every turn was judged by `npm run build` alone.
  rungs.push(...detectCargoRungs(projectRoot, timeoutMs));

  // EVERY other ecosystem present — Go, .NET, C/C++ (CMake), JVM (Maven/Gradle/
  // sbt), Swift, Ruby, PHP, Elixir, Dart, Haskell, Zig, Python. Unconditional for
  // exactly the reason cargo is: these used to sit behind the `rungs.length === 0`
  // fallback below, so a Go/C++/.NET/Python component in a repo that also had a
  // package.json was NEVER compiled or tested — it passed vacuously, judged only
  // by `npm run build`. A polyglot repo must gate on ALL of its languages.
  rungs.push(...detectPolyglotRungs(projectRoot, timeoutMs));

  // Generic fallbacks (Makefile / bare test script) only when nothing
  // ecosystem-specific was detected at all.
  if (rungs.length === 0) {
    rungs.push(...detectNonNpmRungs(projectRoot, timeoutMs));
  }

  // Promotion tiers above `fast`: integration suites and a local dev
  // deploy+smoke. These are appended after the fast band so cheap-first
  // promotion (runTieredLadder) runs them only once the fast tier is green.
  rungs.push(...detectIntegrationRungs(projectRoot, scripts, timeoutMs));
  const migration = detectMigrationRung(projectRoot);
  if (migration) rungs.push(migration);
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

  // B1 (deliver-hardening 2026-07-13): project-declared gates from
  // `.uap.json → delivery.gates[]` merge with — and OUTRANK — the detected
  // set. Detection is heuristic; a declaration is the project stating its
  // real contract (pay2u: docker buildx for apps/api/**, gen_openapi --check
  // for handler files), and a heuristic must never veto it.
  return mergeDeclaredRungs(rungs, detectDeclaredRungs(projectRoot, timeoutMs));
}

/**
 * Split a declared gate command into argv. Declared gates are project-authored
 * IaC (same trust level as package.json scripts); quotes are honored, pipes
 * and redirects are NOT — wrap those in `bash -lc '…'` explicitly.
 */
function splitDeclaredCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const DECLARED_TIERS: ReadonlySet<string> = new Set<GateTier>([
  'fast',
  'runtime',
  'integration',
  'deploy-dev',
  'final',
  'ci',
  'deploy-staging',
  'deploy-prod',
]);

/**
 * Read `.uap.json → delivery.gates[]` as rungs. Read RAW (JSON.parse, not the
 * zod loader): this module is imported by hot paths that must not pull in the
 * config stack, and a malformed file must degrade to "no declared gates",
 * never break detection. Unknown tiers fall back to 'fast'.
 */
export function detectDeclaredRungs(projectRoot: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): GateRung[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(projectRoot, '.uap.json'), 'utf-8'));
  } catch {
    return [];
  }
  const gates = (raw as { delivery?: { gates?: unknown } })?.delivery?.gates;
  if (!Array.isArray(gates)) return [];
  const rungs: GateRung[] = [];
  for (const g of gates) {
    if (!g || typeof g !== 'object') continue;
    const d = g as Record<string, unknown>;
    if (typeof d.id !== 'string' || !d.id || typeof d.cmd !== 'string' || !d.cmd.trim()) continue;
    const argv = splitDeclaredCommand(d.cmd);
    if (argv.length === 0) continue;
    rungs.push({
      id: d.id,
      name: typeof d.name === 'string' && d.name ? d.name : `${d.id} (${d.cmd})`,
      command: argv[0],
      args: argv.slice(1),
      required: d.required !== false,
      timeoutMs:
        typeof d.timeoutSec === 'number' && d.timeoutSec > 0
          ? Math.round(d.timeoutSec * 1000)
          : timeoutMs,
      tier: typeof d.tier === 'string' && DECLARED_TIERS.has(d.tier) ? (d.tier as GateTier) : 'fast',
      cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : undefined,
      scope: Array.isArray(d.scope) ? d.scope.filter((s): s is string => typeof s === 'string') : undefined,
    });
  }
  return rungs;
}

/**
 * Merge declared rungs over detected ones: a declared rung with a detected
 * rung's id REPLACES it in place (outrank = same position, declared fields),
 * and new declared rungs append after the detected set.
 */
export function mergeDeclaredRungs(detected: GateRung[], declared: GateRung[]): GateRung[] {
  if (declared.length === 0) return detected;
  const byId = new Map(declared.map((r) => [r.id, r]));
  const replaced = new Set<string>();
  const merged = detected.map((r) => {
    const d = byId.get(r.id);
    if (!d) return r;
    replaced.add(r.id);
    return d;
  });
  return merged.concat(declared.filter((r) => !replaced.has(r.id)));
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
    // A full-suite coverage fail-under poisons marker-scoped subset runs (the
    // deselected majority reads as uncovered), so disable coverage for this
    // rung when the pytest config wires pytest-cov in. Exit 5 ("no tests ran")
    // is a vacuous pass: the marker being declared does not mean marked tests
    // exist yet, and a required rung that can never pass wedges every mission
    // on the repo (observed live 2026-07-10).
    const args = ['-m', 'pytest', '-m', 'integration', '-q'];
    if (pytestConfigUsesCov(projectRoot)) args.push('--no-cov');
    rungs.push({
      id: 'pytest:integration',
      name: 'Integration tests (pytest -m integration)',
      command: 'python3',
      args,
      required: true,
      timeoutMs: integrationTimeout,
      tier: 'integration',
      passExitCodes: [0, 5],
    });
  }

  return rungs;
}

/** True when a pytest config wires pytest-cov into addopts (`--cov`). */
function pytestConfigUsesCov(projectRoot: string): boolean {
  for (const file of ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) {
    const p = join(projectRoot, file);
    if (!existsSync(p)) continue;
    try {
      if (/--cov\b/.test(readFileSync(p, 'utf-8'))) return true;
    } catch {
      /* unreadable config */
    }
  }
  return false;
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

/** Annotation appended to a baseline-red rung's name when it is demoted. */
export const BASELINE_DEMOTION_NOTE = '[pre-existing failure at baseline — non-blocking]';

export interface BaselineDeltaResult {
  /** The rung list with baseline-red required rungs demoted to optional. */
  rungs: GateRung[];
  /** What was demoted, with the baseline failure tail for the record. */
  demoted: Array<{ id: string; name: string; outputTail: string }>;
  /** Wall-clock cost of the preflight. */
  preflightMs: number;
}

/**
 * Baseline-delta gating: preflight the ladder ONCE at mission start and demote
 * any REQUIRED rung that is already red to optional (annotated). A rung that
 * was red before the mission began cannot be a regression the mission caused —
 * yet as a required rung it makes acceptance unreachable, so the model burns
 * its whole turn budget against a failure it did not create and often cannot
 * fix (observed across two live missions: a repo whose npm test was red at
 * baseline consumed every attempt of three consecutive runs; a crashed eslint
 * config captured 13/13 writes of an epic). Demotion-to-optional reuses the
 * existing machinery end-to-end: optional rungs still run and report, the
 * feedback builder explicitly de-prioritizes them below the task goal, and
 * NEW failures (green at baseline → red now) still block as before.
 *
 * Preflights only side-effect-free tiers (fast/integration) and skips rungs
 * with teardown hooks; everything else passes through untouched.
 *
 * Rung-level granularity WAS the gap: new breakage inside an already-red rung
 * used to be indistinguishable from the failures the rung was demoted for.
 * `regressedTests` closes it by NAME — a test that was passing at baseline and
 * is failing now is this mission's doing — and --keep-best consults the same
 * predicate, so the whole-tree backstop sees it too rather than reading an
 * unchanged score.
 */
/** Per-test outcomes recovered from a gate's output. */
export interface TestOutcomes {
  passed: Set<string>;
  failed: Set<string>;
}

/**
 * Per-test PASS/FAIL names from a runner's output, or null when the output
 * does not report per-test outcomes.
 *
 * Counting failures was tried first and reverted: `cargo test` fail-fasts at
 * the first failing target, so a mission that FIXES that target lets cargo
 * reach the next one and report ITS pre-existing failures — the count rises
 * and an improving mission gets told it caused a regression. Names do not have
 * that problem, because a test that never ran at baseline is unknown rather
 * than newly-broken.
 *
 * Null unless at least one per-test line is recognised. A runner that prints
 * only a summary cannot distinguish "revealed" from "broken", and the safe
 * answer there is the behaviour demotion already had.
 */
export function parseTestOutcomes(output: string, rungId?: string): TestOutcomes | null {
  // The check-mark forms are matched ONLY for a rung that is actually a JS test
  // runner. `✓ 34 modules transformed`, `✔ Prettier` and miette/oxlint's `×`
  // diagnostic bullets are not test outcomes, and letting a lint or build rung
  // parse non-null quietly defeats the "opaque output ⇒ old behaviour" valve
  // that keeps this check conservative.
  const jsRunner = rungId === undefined || /test|vitest|jest|spec/i.test(rungId);
  const passed = new Set<string>();
  const failed = new Set<string>();
  const add = (set: Set<string>, name: string | undefined) => {
    const n = (name ?? '').trim();
    if (n) set.add(n);
  };

  for (const line of output.split('\n')) {
    // cargo / rust libtest: `test mod::tests::name ... ok|FAILED|ignored`
    let m = /^\s*test\s+(\S+)\s+\.\.\.\s*(ok|FAILED|ignored)\b/.exec(line);
    if (m) {
      if (m[2] === 'ok') add(passed, m[1]);
      else if (m[2] === 'FAILED') add(failed, m[1]);
      continue; // `ignored` is neither
    }
    // go test -v: `--- PASS: TestName` / `--- FAIL: TestName`
    m = /^\s*---\s+(PASS|FAIL):\s+(\S+)/.exec(line);
    if (m) {
      add(m[1] === 'PASS' ? passed : failed, m[2]);
      continue;
    }
    // pytest -v: `tests/test_x.py::test_name PASSED|FAILED`
    m = /^(\S+::\S+)\s+(PASSED|FAILED)\b/.exec(line);
    if (m) {
      add(m[2] === 'PASSED' ? passed : failed, m[1]);
      continue;
    }
    if (!jsRunner) continue;
    // jest / vitest verbose: `✓ name` / `✕ name` / `× name`. The file-level
    // summary lines vitest prints (`✓ test/foo.test.ts (12 tests) 34ms`) are
    // excluded — they are files, not tests, and would collide across runs.
    m = /^\s*(?:[✓✔])\s+(.+?)(?:\s+\(\d+\s*(?:ms|tests?)\))?\s*$/.exec(line);
    if (m && !/\(\d+\s+tests?\)/.test(line)) {
      add(passed, m[1]);
      continue;
    }
    m = /^\s*(?:[✕✖×])\s+(.+?)(?:\s+\(\d+\s*ms\))?\s*$/.exec(line);
    if (m && !/\(\d+\s+tests?\)/.test(line)) add(failed, m[1]);
  }

  if (passed.size === 0 && failed.size === 0) return null;
  // Deliberately NOT reconciling passed/failed here: the parser stays a pure
  // reader so callers can still see that a name was BOTH. `regressedTests`
  // does the reconciliation, symmetrically on both sides — doing it here also
  // applied it to the baseline capture, which could record an ambiguous name
  // as cleanly-passing and then report a permanent regression once its passing
  // instance stopped being printed.
  return { passed, failed };
}

/**
 * Tests that were PASSING when this rung was demoted and are FAILING now —
 * i.e. breakage this mission introduced into an already-red gate.
 *
 * Both sides come from `RungResult.testOutcomes`, parsed from the UNTRUNCATED
 * output, so this no longer depends on what fits in a tail. Where a caller
 * supplies no parsed outcomes the tail is used as a fallback, and that path is
 * a subset of truth — it can under-report, never invent.
 */
/**
 * The demoted rungs whose CURRENT result contains tests that were passing at
 * baseline — with the names, so the model is told what IT broke rather than
 * being handed the pre-existing red suite it was explicitly told to ignore.
 */
export function baselineRegressions(
  rungs: GateRung[],
  results: RungResult[]
): Array<{ id: string; tests: string[] }> {
  const out: Array<{ id: string; tests: string[] }> = [];
  for (const rung of rungs) {
    const res = results.find((r) => r.id === rung.id);
    if (!res || res.skipped || res.passed) continue;
    const tests = regressedTests(rung, res);
    if (tests.length) out.push({ id: rung.id, tests });
  }
  return out;
}

/** Model-facing note naming the regressed tests, or '' when there are none. */
export function formatBaselineRegressions(
  regressions: Array<{ id: string; tests: string[] }>
): string {
  if (!regressions.length) return '';
  const body = regressions
    .map((r) => `  ${r.id}: ${r.tests.slice(0, 10).join(', ')}${r.tests.length > 10 ? ` (+${r.tests.length - 10} more)` : ''}`)
    .join('\n');
  return (
    `\n\nREGRESSION — these tests PASSED before your changes and fail now. They are ` +
    `NOT the pre-existing failures this gate was demoted for, so "already red" does not ` +
    `excuse them:\n${body}\nFix these first; they are breakage you introduced.`
  );
}

export function regressedTests(rung: GateRung, result: RungResult): string[] {
  if (!rung.baselinePassing?.length) return [];
  // Prefer what runRung parsed from the FULL output; fall back to the tail only
  // for callers that synthesised a result without it.
  const outcomes = result.testOutcomes
    ? { passed: new Set(result.testOutcomes.passed), failed: new Set(result.testOutcomes.failed) }
    : parseTestOutcomes(result.outputTail, rung.id);
  if (!outcomes) return [];
  // A name observed passing somewhere in THIS run is not evidence of breakage
  // (aliased names across crates; a retry that later succeeded).
  return rung.baselinePassing
    .filter((name) => outcomes.failed.has(name) && !outcomes.passed.has(name))
    .sort();
}

export function demoteBaselineFailures(
  rungs: GateRung[],
  projectRoot: string,
  tailChars: number = DEFAULT_TAIL_CHARS
): BaselineDeltaResult {
  const PREFLIGHT_TIERS = new Set<GateTier>(['fast', 'integration']);
  const start = Date.now();
  const demoted: BaselineDeltaResult['demoted'] = [];
  const out = rungs.map((r) => {
    if (!r.required || !PREFLIGHT_TIERS.has(tierOf(r)) || r.teardown) return r;
    // Capture the baseline with a much larger tail than the per-turn one. The
    // per-test lines a runner prints BEFORE its summary are the first thing
    // truncation eats, and they are exactly what the regression check needs.
    // Under-capturing here only loses regressions, never invents them — but
    // there is no reason to lose them cheaply.
    const res = runRung(r, projectRoot, Math.max(tailChars, BASELINE_CAPTURE_TAIL_CHARS), false, true);
    if (res.passed) return r;
    demoted.push({ id: r.id, name: r.name, outputTail: res.outputTail });
    // Only names that were unambiguously green. A name printed both ok and
    // FAILED in one run (two crates, same unqualified test name) tells us
    // nothing, and treating it as green would report a regression forever.
    const baselineFailed = new Set(res.testOutcomes?.failed ?? []);
    const baselinePassing = (res.testOutcomes?.passed ?? []).filter((n) => !baselineFailed.has(n));
    return {
      ...r,
      required: false,
      name: `${r.name} ${BASELINE_DEMOTION_NOTE}`,
      ...(baselinePassing.length ? { baselinePassing } : {}),
    };
  });
  return { rungs: out, demoted, preflightMs: Date.now() - start };
}

/**
 * Cargo gates for Rust projects (root Cargo.toml). `cargo check` is the
 * required compile gate; `cargo test` runs and is reported but does not block
 * (a pre-existing red test in a large workspace would otherwise wedge every
 * phase of a long mission — the acceptance judge still sees its result).
 * Workspace builds routinely exceed the generic 5-minute rung timeout on a
 * cold target dir, so cargo rungs get a 15-minute floor.
 */
/**
 * Features whose code the DEFAULT build never compiles.
 *
 * `cargo check --workspace` compiles default features only. A crate can put its
 * entire public surface behind `#[cfg(feature = "x")]`, and then the compile
 * gate passes without ever looking at it — the same shape as the workspace
 * membership hazard below, where code outside `[workspace] members` "passes"
 * because cargo never sees it.
 *
 * Measured 2026-08-12 on a pgrx Postgres extension: every `#[pg_extern]` lived
 * in `#[cfg(feature = "pgrx")] mod pgrx_funcs`, and `default = []`. The gate
 * reported ZERO errors. Enabling the feature revealed 52 — invented pgrx APIs,
 * `SetOfIterator` returns with no item type — none of which any judge caught,
 * because a green compile gate is exactly the evidence a judge trusts.
 *
 * Detects a GATED MODULE specifically, not any `cfg(feature)`. A crate gating a
 * few `serde` impls is ordinary and its default build still covers the crate;
 * gating a whole `mod` means entire files or bodies are invisible. That
 * distinction is what keeps this from firing on half of crates.io.
 */
export function featureGatedModules(projectRoot: string): string[] {
  let manifest: string;
  try {
    manifest = readFileSync(join(projectRoot, 'Cargo.toml'), 'utf8');
  } catch {
    return [];
  }
  const featureBlock = /\n\[features\]([\s\S]*?)(?=\n\[|$)/.exec(manifest);
  if (!featureBlock) return [];
  const declared = new Set<string>();
  let defaults: string[] = [];
  for (const line of featureBlock[1]!.split('\n')) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*\[([^\]]*)\]/.exec(line);
    if (!m) continue;
    if (m[1] === 'default') {
      defaults = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    } else {
      declared.add(m[1]!);
    }
  }
  // A feature reachable from `default` IS compiled by the plain gate.
  const reachable = new Set(defaults);
  const gated = new Set<string>();
  for (const file of rustSources(join(projectRoot, 'src'))) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // `#[cfg(feature = "x")]` immediately preceding a `mod` / `pub mod`.
    const re = /#\[cfg\(\s*feature\s*=\s*"([^"]+)"\s*\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\b/g;
    for (const m of text.matchAll(re)) {
      const name = m[1]!;
      if (declared.has(name) && !reachable.has(name)) gated.add(name);
    }
  }
  return [...gated].sort();
}

/** Features a `#[cfg(feature = "...")]` immediately preceding a `mod` refers to. */
function cfgGatedFeatureNames(projectRoot: string): string[] {
  const names = new Set<string>();
  const re = /#\[cfg\(\s*feature\s*=\s*"([^"]+)"\s*\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\b/g;
  for (const file of rustSources(join(projectRoot, 'src'))) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(re)) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Every feature name the manifest declares — including the ones Cargo creates
 * IMPLICITLY for optional dependencies. `serde = { optional = true }` declares
 * a feature "serde" with no `[features]` table in sight, so missing that would
 * make this rule fire on perfectly ordinary crates.
 */
function manifestFeatureNames(manifest: string): Set<string> {
  const names = new Set<string>();
  const featureBlock = /\n\[features\]([\s\S]*?)(?=\n\[|$)/.exec(manifest);
  if (featureBlock) {
    for (const line of featureBlock[1]!.split('\n')) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*\[/.exec(line);
      if (m) names.add(m[1]!);
    }
  }
  // Inline form: `[dependencies]` … `name = { …, optional = true }`.
  for (const block of manifest.matchAll(/\n\[(?:[a-z0-9_.-]+\.)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
    for (const line of block[1]!.split('\n')) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{([^}]*)\}/.exec(line);
      if (m && /\boptional\s*=\s*true\b/.test(m[2]!)) names.add(m[1]!);
    }
  }
  // Table form: `[dependencies.name]` … `optional = true`.
  for (const block of manifest.matchAll(
    /\n\[(?:[a-z0-9_.-]+\.)?dependencies\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|$)/g
  )) {
    if (/\boptional\s*=\s*true\b/.test(block[2]!)) names.add(block[1]!);
  }
  return names;
}

/**
 * Features that gate a module but that the manifest never declares.
 *
 * Distinct from — and worse than — `featureGatedModules`. That one reports real
 * code the DEFAULT build skips; this reports code NOTHING can build. Cargo
 * rejects `--features x` for an undeclared x ("unknown feature"), so the module
 * is not merely unchecked, it is dead, while `cargo check` reports zero errors.
 *
 * Measured live 2026-08-12: nine `#[pg_extern]` functions inside
 * `#[cfg(feature = "pgrx")] mod pgrx_funcs`, a manifest with no `[features]`
 * table and no pgrx dependency, and a green gate over all of it.
 */
export function undeclaredFeatureGates(projectRoot: string): string[] {
  let manifest: string;
  try {
    manifest = readFileSync(join(projectRoot, 'Cargo.toml'), 'utf8');
  } catch {
    return [];
  }
  const declared = manifestFeatureNames(manifest);
  return cfgGatedFeatureNames(projectRoot)
    .filter((name) => !declared.has(name))
    .sort();
}

/** Every .rs file under a directory, bounded so a huge tree cannot stall detection. */
function rustSources(dir: string, depth = 0, budget = { left: 400 }): string[] {
  if (depth > 6 || budget.left <= 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (budget.left <= 0) break;
    const p = join(dir, name);
    let stat;
    try {
      stat = lstatSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (name === 'target' || name === 'node_modules' || name.startsWith('.')) continue;
      out.push(...rustSources(p, depth + 1, budget));
    } else if (name.endsWith('.rs')) {
      budget.left -= 1;
      out.push(p);
    }
  }
  return out;
}

/**
 * Is a usable docker CLI present? Probed once per ladder build, cheaply.
 *
 * UNVERIFIED BY TESTS: on a machine with docker this is indistinguishable from
 * `return true`, and on one without it from `return false` — so a mutation of it
 * survives either way. The DECISION that uses it is covered instead, through the
 * injectable seam on detectCargoRungs. Noted rather than left looking covered.
 */
export function dockerAvailable(): boolean {
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5_000,
      encoding: 'utf-8',
      env: sanitizedEnv(),
    });
    return r.status === 0 && !!`${r.stdout ?? ''}`.trim();
  } catch {
    return false;
  }
}

/**
 * Has the project asked for the containerised feature check?
 *
 * OPT-IN, and that is measured rather than cautious. A non-default feature
 * gates a module in 218 of 681 real registry crates (32%), and this rung pulls
 * an image and compiles a workspace inside it — minutes, with no warm target
 * dir, every time the ladder runs. Defaulting it on would tax a third of all
 * Rust projects on every turn to answer a question most of them do not have.
 * A project whose real API lives behind a feature turns it on and gets an
 * actual check instead of the advisory notice.
 */
function dockerFeatureCheckEnabled(projectRoot: string): boolean {
  const raw = process.env.UAP_DOCKER_FEATURE_CHECK;
  if (raw !== undefined) return ['1', 'true', 'on', 'yes'].includes(raw.toLowerCase());
  try {
    const cfg = JSON.parse(readFileSync(join(projectRoot, '.uap.json'), 'utf8')) as {
      delivery?: { dockerFeatureCheck?: unknown };
    };
    return cfg.delivery?.dockerFeatureCheck === true;
  } catch {
    return false; // absent or unreadable config is not an opt-in
  }
}

export function detectCargoRungs(
  projectRoot: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  // Injected so the container decision is testable without depending on
  // whether the machine running the suite happens to have docker. Without this
  // seam a mutant making the rung unreachable still passed every test, because
  // the assertions could only say "the rung OR the notice".
  opts: { hasDocker?: () => boolean } = {}
): GateRung[] {
  if (!existsSync(join(projectRoot, 'Cargo.toml'))) return [];
  const cargoTimeoutMs = Math.max(timeoutMs, 900_000);
  return [
    {
      // Membership guard: a crate directory absent from [workspace] members is
      // INVISIBLE to every cargo gate — its code "passes" without ever being
      // compiled (observed live 2026-07-10: an epic's crate was accepted with
      // 47 latent compile errors because it wasn't a member). Runs before the
      // check rung so the failure message names the missing crates.
      id: 'cargo-members',
      name: 'Workspace membership (crates/* all in [workspace] members)',
      command: 'bash',
      args: [
        '-c',
        // A members glob ("crates/*") covers everything; otherwise every
        // crates/<dir>/Cargo.toml must appear verbatim in the root manifest.
        'grep -qE \'"crates/\\*"\' Cargo.toml && exit 0; missing=""; for t in crates/*/Cargo.toml; do [ -e "$t" ] || continue; d=$(dirname "$t"); grep -q "\\"$d\\"" Cargo.toml || missing="$missing $d"; done; [ -z "$missing" ] && exit 0; echo "NOT in [workspace] members:$missing — code outside the workspace is invisible to cargo gates and does NOT count as delivered; add each path to [workspace] members in the root Cargo.toml"; exit 1',
      ],
      required: true,
      timeoutMs: Math.min(timeoutMs, 30_000),
      tier: 'fast',
    },
    {
      id: 'cargo-check',
      name: 'Check (cargo check --workspace)',
      command: 'cargo',
      args: ['check', '--workspace'],
      required: true,
      timeoutMs: cargoTimeoutMs,
      tier: 'fast',
    },
    // Blind-spot notice for feature-gated modules. ADVISORY, and deliberately
    // compiles nothing.
    //
    // The obvious implementation — add `cargo check --features x` as a required
    // rung — was measured against 681 real crates from the registry and is
    // wrong twice over. It fires on 32% of them, so a third of all Rust
    // projects would pay an extra full compile per gated feature; and the
    // feature may not be buildable at all on this machine (the pgrx crate that
    // exposed this needs a source-built Postgres via `cargo pgrx init`), so a
    // REQUIRED rung would fail every gate for a reason unrelated to the
    // mission. Narrowing by how much code hides behind the gate does not rescue
    // it either: the crate that motivated this scores 19%, below any threshold
    // that keeps the false-positive rate sane, because its gated module is
    // small in lines while holding 100% of its Postgres API.
    //
    // So: state the fact, cheaply, where the operator and the acceptance judge
    // both see it — the same trade-off cargo-test already documents ("runs and
    // is reported but does not block"). What it prevents is the specific way
    // this went wrong: a GREEN compile gate on a crate whose entire surface did
    // not compile, which is exactly the evidence a judge trusts most.
    // A gate on a feature the manifest never declares. Its sibling below
    // reports code the DEFAULT build skips; this reports code NOTHING can
    // build, because cargo rejects `--features x` for an undeclared x. REQUIRED
    // rather than advisory: unlike the container check it needs no toolchain,
    // no image and no network — it compares the manifest to the sources — and
    // a run that newly hides its work behind a feature that cannot exist has
    // delivered nothing. A crate already in this state is not punished:
    // baseline-delta demotes a rung that was red at preflight, so only NEW
    // breakage blocks.
    ...(() => {
      const undeclared = undeclaredFeatureGates(projectRoot);
      if (undeclared.length === 0) return [];
      const list = undeclared.join(', ');
      return [
        {
          id: 'cargo-feature-undeclared',
          name: `Undeclared feature gate (${list})`,
          command: 'bash',
          args: [
            '-c',
            `echo "NOTE: modules are gated behind #[cfg(feature = \\"...\\")] for features this crate never declares: ${list}. Cargo rejects --features ${undeclared[0]} as an unknown feature, so that code can NEVER be compiled by any gate — it is dead, and \\\`cargo check\\\` reports zero errors over it. Declare it under [features] in Cargo.toml (or make the dependency optional, which declares it implicitly), then verify with: cargo check --workspace --features ${undeclared[0]}."; exit 1`,
          ],
          required: true,
          timeoutMs: Math.min(timeoutMs, 30_000),
          tier: 'fast',
        } as GateRung,
      ];
    })(),
    ...(() => {
      const blind = featureGatedModules(projectRoot);
      if (blind.length === 0) return [];
      // Opted in AND docker present: actually CHECK the hidden code instead of
      // only naming it. One rung per feature, never a combined --all-features:
      // feature sets are routinely mutually exclusive (pgrx declares pg12
      // through pg17 and errors if two are on).
      if (dockerFeatureCheckEnabled(projectRoot) && (opts.hasDocker ?? dockerAvailable)()) {
        const containerRungs = blind
          .map((feature) =>
            dockerCargoRung(projectRoot, feature, { hasDocker: true, timeoutMs: cargoTimeoutMs })
          )
          .filter((r): r is GateRung => r !== null);
        if (containerRungs.length > 0) return containerRungs;
      }
      const list = blind.join(', ');
      return [
        {
          id: 'cargo-feature-blind-spot',
          name: `Feature blind spot (default build skips: ${list})`,
          command: 'bash',
          args: [
            '-c',
            `echo "NOTE: cargo check --workspace compiles DEFAULT features only, and these features gate whole modules that the default build therefore never sees: ${list}. Code inside them can be arbitrarily broken while this gate stays green. Verify it with: cargo check --workspace --features ${blind[0]} — or set delivery.dockerFeatureCheck=true in .uap.json to run that check inside a container as part of this gate."; exit 1`,
          ],
          required: false,
          timeoutMs: Math.min(timeoutMs, 30_000),
          tier: 'fast',
        } as GateRung,
      ];
    })(),
    {
      id: 'cargo-test',
      name: 'Tests (cargo test --workspace)',
      command: 'cargo',
      args: ['test', '--workspace'],
      // BLOCKING, like every other language's test rung (npm `test`, pytest,
      // ctest, go-test, dotnet-test all default to required). Rust's was the lone
      // `required: false`, with no comment saying why — so a Rust project could
      // deliver with FAILING tests while an identical Node one could not. A
      // pre-existing red suite is not punished: baseline-delta gating demotes
      // rungs that were already failing at preflight, so only NEW breakage blocks.
      required: true,
      timeoutMs: cargoTimeoutMs,
      tier: 'fast',
    },
  ];
}

/**
 * Migration validation: run the project's SQL migrations against an EPHEMERAL
 * postgres before they can ship broken. A live mission shipped migrations
 * with FK-ordering bugs and a name collision with a legacy table because they
 * never met a database until a human applied them (2026-07-09). Added when a
 * migrations/ dir with .sql files exists; the script itself no-ops with a
 * pass when docker or sqlx is unavailable (vacuous, like the pytest marker
 * rung), and cleans its container via trap + a fixed name so an orphan from a
 * killed run is removed by the next one. Tier `integration`: runs only after
 * the fast tier is green; baseline-delta gating demotes it when the CURRENT
 * migration chain is already broken at mission start.
 */
export function detectMigrationRung(projectRoot: string): GateRung | null {
  const dir = join(projectRoot, 'migrations');
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    if (!readdirSync(dir).some((f) => f.endsWith('.sql'))) return null;
  } catch {
    return null;
  }
  const script = [
    'set -u',
    'command -v docker >/dev/null 2>&1 || { echo "migration gate skipped: docker unavailable"; exit 0; }',
    'command -v sqlx >/dev/null 2>&1 || { echo "migration gate skipped: sqlx-cli unavailable"; exit 0; }',
    'NAME=uap-migrate-gate',
    'docker rm -f "$NAME" >/dev/null 2>&1 || true',
    "trap 'docker rm -f \"$NAME\" >/dev/null 2>&1 || true' EXIT TERM INT",
    'docker run -d --name "$NAME" -e POSTGRES_PASSWORD=uap -e POSTGRES_DB=uap_migrate_gate -p 127.0.0.1::5432 postgres:16-alpine >/dev/null || { echo "migration gate: failed to start postgres container"; exit 1; }',
    'PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed "s/.*://")',
    'ok=""',
    'for i in $(seq 1 120); do docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null && ok=1 && break; sleep 0.5; done',
    '[ -n "$ok" ] || { echo "migration gate: postgres did not become ready"; exit 1; }',
    'DATABASE_URL="postgres://postgres:uap@127.0.0.1:$PORT/uap_migrate_gate" sqlx migrate run',
  ].join('\n');
  return {
    id: 'migrations',
    name: 'Migrations (sqlx migrate run vs ephemeral postgres)',
    command: 'bash',
    args: ['-c', script],
    required: true,
    timeoutMs: 180_000,
    tier: 'integration',
  };
}

/**
 * Detect real gates in non-npm projects: a Makefile test/check/build target,
 * a pytest suite, or a conventional shell test script. Ordered cheap→expensive.
 */
/**
 * Build + test rungs for EVERY ecosystem present — not just the first one found.
 *
 * Called UNCONDITIONALLY (like cargo), because the non-npm detectors used to sit
 * behind `if (rungs.length === 0)`: a Go / C++ / .NET component living in a repo
 * that also had a package.json was NEVER compiled or tested — it passed
 * VACUOUSLY, judged only by `npm run build`. That is the same class of bug that
 * was already fixed for Rust (an 8-phase Rust mission stagnated because every
 * turn was judged by npm alone); this generalizes the fix to every language.
 *
 * Rule: if it is interpreted, transpiled, or compiled, it gets a rung that proves
 * it actually builds and its tests pass. A rung whose toolchain is absent surfaces
 * as a `spawn-error` (INFRA → reported, fails OPEN) rather than silently vanishing,
 * so "we could not test your Go code" is visible instead of counting as a pass.
 */
export function detectPolyglotRungs(projectRoot: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): GateRung[] {
  const rungs: GateRung[] = [];
  const has = (p: string): boolean => existsSync(join(projectRoot, p));
  const hasMatch = (re: RegExp): boolean => {
    try {
      return readdirSync(projectRoot).some((f) => re.test(f));
    } catch {
      return false;
    }
  };
  // Compiles are slow (cargo/cmake/gradle): give them a real budget.
  const buildMs = Math.max(timeoutMs, 900_000);
  const add = (id: string, name: string, command: string, args: string[], required = true): void => {
    rungs.push({ id, name, command, args, required, timeoutMs: buildMs });
  };

  // ── Go ────────────────────────────────────────────────────────────────────
  if (has('go.mod')) {
    add('go-build', 'Build (go build ./...)', 'go', ['build', './...']);
    add('go-test', 'Tests (go test ./...)', 'go', ['test', './...']);
  }

  // ── .NET (C# / F# / VB) ───────────────────────────────────────────────────
  if (has('global.json') || hasMatch(/\.(sln|csproj|fsproj|vbproj)$/i)) {
    add('dotnet-build', 'Build (dotnet build)', 'dotnet', ['build', '--nologo']);
    add('dotnet-test', 'Tests (dotnet test)', 'dotnet', ['test', '--nologo']);
  }

  // ── C / C++ via CMake (Makefile-only projects fall to detectNonNpmRungs) ───
  if (has('CMakeLists.txt')) {
    add('cmake-build', 'Build (cmake --build)', 'bash', [
      '-lc',
      'cmake -S . -B build && cmake --build build',
    ]);
    // ctest exits 8 ("no tests were found") on a project with no test suite —
    // that is a vacuous pass, not a failure.
    rungs.push({
      id: 'ctest',
      name: 'Tests (ctest)',
      command: 'bash',
      args: ['-lc', 'ctest --test-dir build --output-on-failure'],
      required: true,
      timeoutMs: buildMs,
      passExitCodes: [0, 8],
    });
  }

  // ── JVM: Maven / Gradle (Java, Kotlin, Scala, Groovy) ─────────────────────
  if (has('pom.xml')) add('maven-test', 'Tests (mvn test)', 'mvn', ['-B', 'test']);
  if (has('build.gradle') || has('build.gradle.kts')) {
    const gradle = has('gradlew') ? './gradlew' : 'gradle';
    add('gradle-test', `Tests (${gradle} test)`, gradle, ['test', '--console=plain']);
  }
  if (has('build.sbt')) add('sbt-test', 'Tests (sbt test)', 'sbt', ['test']);

  // ── Swift ─────────────────────────────────────────────────────────────────
  if (has('Package.swift')) {
    add('swift-build', 'Build (swift build)', 'swift', ['build']);
    add('swift-test', 'Tests (swift test)', 'swift', ['test']);
  }

  // ── Ruby / PHP ────────────────────────────────────────────────────────────
  if (has('Gemfile')) {
    add('ruby-test', 'Tests (rspec / rake test)', 'bash', [
      '-lc',
      'bundle exec rspec 2>/dev/null || bundle exec rake test',
    ]);
  }
  if (has('composer.json')) {
    add('php-test', 'Tests (phpunit)', 'bash', [
      '-lc',
      'composer test 2>/dev/null || vendor/bin/phpunit',
    ]);
  }

  // ── BEAM / Dart / Haskell / Zig ───────────────────────────────────────────
  if (has('mix.exs')) add('mix-test', 'Tests (mix test)', 'mix', ['test']);
  if (has('pubspec.yaml')) {
    add('dart-test', 'Tests (flutter/dart test)', 'bash', [
      '-lc',
      'flutter test 2>/dev/null || dart test',
    ]);
  }
  if (has('stack.yaml')) add('stack-test', 'Tests (stack test)', 'stack', ['test']);
  else if (hasMatch(/\.cabal$/)) add('cabal-test', 'Tests (cabal test)', 'cabal', ['test']);
  if (has('build.zig')) add('zig-test', 'Tests (zig build test)', 'zig', ['build', 'test']);

  // ── Python ────────────────────────────────────────────────────────────────
  // Also unconditional. pytest previously lived in the `rungs.length === 0`
  // fallback, so a repo with BOTH a package.json and Python tests ran npm only —
  // the Python code was never executed. Keyed off a real Python manifest; exit 5
  // ("no tests collected") is a vacuous pass, not a failure.
  const pyManifest =
    has('pyproject.toml') || has('setup.py') || has('setup.cfg') ||
    has('requirements.txt') || has('Pipfile') || has('tox.ini');
  if (pyManifest) {
    rungs.push({
      id: 'pytest',
      name: 'Tests (pytest)',
      command: 'python3',
      args: ['-m', 'pytest', '-q'],
      required: true,
      timeoutMs: buildMs,
      passExitCodes: [0, 5],
    });
  }

  return rungs;
}

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
export function runRung(
  rung: GateRung,
  projectRoot: string,
  tailChars: number = DEFAULT_TAIL_CHARS,
  requireTestsRan = false,
  /** Capture per-test names even without a baseline set (the preflight). */
  captureOutcomes = false
): RungResult {
  const start = Date.now();
  // B1 declared gates may carry a sub-directory cwd (a gate that only makes
  // sense inside apps/api). Declared config is project-authored IaC — same
  // trust level as a package.json script, which can `cd` anywhere already —
  // but containment is one line and a `../../` escape would run the gate on a
  // DIFFERENT project while reporting against this one (review fix).
  const rootAbs = resolve(projectRoot);
  const declaredCwd = rung.cwd ? resolve(rootAbs, rung.cwd) : rootAbs;
  const contained = declaredCwd === rootAbs || declaredCwd.startsWith(rootAbs + sep);
  if (rung.cwd && !contained) {
    return {
      id: rung.id,
      name: rung.name,
      passed: false,
      skipped: false,
      exitCode: null,
      failureReason: 'spawn-error',
      durationMs: 0,
      outputTail: `declared gate cwd '${rung.cwd}' escapes the project root — refusing to run it`,
    };
  }
  const res = spawnSync(rung.command, rung.args, {
    cwd: declaredCwd,
    encoding: 'utf-8',
    timeout: rung.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: sanitizedEnv(),
  });

  const durationMs = Date.now() - start;
  const exitCode = res.status;
  // A spawn error / signal leaves status null — never a pass, whatever the
  // rung's passExitCodes say.
  let passed = exitCode !== null && (rung.passExitCodes ?? [0]).includes(exitCode);

  // "There were no tests" must never read as "the tests passed". The ladder
  // otherwise decides on exit code alone, so a suite with ZERO tests is
  // indistinguishable from one that passed — a live mission delivered a Rust
  // crate whose entire test result was `0 passed; 0 failed`: compiled, gated,
  // "delivered", never tested. Only flip a PASS to a fail, and only when the
  // runner explicitly reported zero (testsActuallyRan returns null when it
  // cannot tell — we never block on a guess).
  const combinedForTests = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const ran = passed ? testsActuallyRan(rung.id, combinedForTests) : null;
  const zeroTests = ran === false;
  if (zeroTests && requireTestsRan) passed = false;

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
  // Parse per-test outcomes HERE, from the whole output — the truncated tail is
  // for humans and prompts, and a gate must not depend on what fits in it.
  //
  // Only when something will actually consume them: either this rung already
  // carries a baseline set (so this run is the CURRENT side of a comparison),
  // or the caller is capturing a baseline. Attaching them unconditionally put
  // every test name of every rung into `RungResult`, which rides
  // IterationRecord → LoopCheckpoint.history → run-state.json, rewritten in
  // full every turn — megabytes on a large workspace, for data nothing reads.
  const wantOutcomes = Boolean(rung.baselinePassing?.length) || captureOutcomes;
  const parsedOutcomes = wantOutcomes ? parseTestOutcomes(combined, rung.id) : null;

  return {
    id: rung.id,
    name: rung.name,
    passed,
    skipped: false,
    exitCode,
    failureReason,
    durationMs,
    outputTail: passed ? '' : truncateTail(combined, tailChars),
    ...(parsedOutcomes
      ? { testOutcomes: { passed: [...parsedOutcomes.passed], failed: [...parsedOutcomes.failed] } }
      : {}),
    ...(zeroTests ? { zeroTests: true } : {}),
  };
}

/**
 * Build feedback text from rung results. Only the first failing required
 * rung's output is included in detail — small models do better with one
 * concrete problem at a time than with a wall of every failure.
 */
export function formatFeedback(
  results: RungResult[],
  rungs: GateRung[],
  /**
   * Rungs that are nominally optional but ARE blocking this turn — a demoted
   * rung the mission regressed. Without this they take the branch below that
   * says "OPTIONAL … do not prioritize it" while the ladder is refusing to
   * pass on them, and they lose the failure tail that branch withholds on
   * purpose. Both are exactly wrong for breakage the model just caused.
   */
  blockingOptionalIds: ReadonlySet<string> = new Set()
): string {
  const requiredIds = new Set([
    ...rungs.filter((r) => r.required).map((r) => r.id),
    ...blockingOptionalIds,
  ]);
  const lines: string[] = ['Gate results:'];
  for (const r of results) {
    const status = r.skipped
      ? r.skipReason === 'deferred-cost'
        ? 'DEFERRED (cheap gates first — will run once they pass)'
        : 'SKIPPED (earlier gate failed)'
      : r.passed
        ? 'PASS'
        : 'FAIL';
    const optional = requiredIds.has(r.id) ? '' : ' (optional)';
    lines.push(`- ${r.name}${optional}: ${status}`);
  }

  // Which failure gets the one detail block matters. Results arrive in TIER_ORDER,
  // so the fast-tier synthetic self-gate always won the slot — and once
  // blocksPromotion let the runtime/final gates actually RUN behind a red
  // self-gate, they ran and their output was still never shown. The model was
  // told "fix this gate first" about a model-authored acceptance script that is
  // SUPPOSED to stay red until the mission is done, while the real build/execution
  // failure sat one line above with no tail.
  //
  // So prefer a failure that blocks promotion — a real, objective gate the model
  // can actually act on this turn. Fall back to the synthetic one when that is all
  // there is, since then it genuinely is the only thing to work toward.
  const blockingIds = new Set(
    rungs.filter((r) => r.required && r.blocksPromotion !== false).map((r) => r.id)
  );
  const failedRequired = results.filter((r) => !r.passed && !r.skipped && requiredIds.has(r.id));
  const firstRequiredFailure =
    failedRequired.find((r) => blockingIds.has(r.id) && r.outputTail) ??
    // Never drop the only diagnostic we have: preferring a TAILLESS blocking rung
    // over a non-blocking one that actually has output would print no failure
    // detail at all — strictly worse than before this preference existed.
    failedRequired.find((r) => r.outputTail) ??
    failedRequired.find((r) => blockingIds.has(r.id)) ??
    failedRequired[0];
  if (firstRequiredFailure && firstRequiredFailure.outputTail) {
    lines.push('');
    lines.push(`Fix this gate first — ${firstRequiredFailure.name} output:`);
    lines.push('```');
    lines.push(firstRequiredFailure.outputTail);
    lines.push('```');
  } else if (firstRequiredFailure) {
    // A REQUIRED gate failed but produced no output (a script that exits non-zero
    // silently). Say exactly that — the branch below would otherwise tell the
    // model this blocking gate is "OPTIONAL … do not prioritize it", which is the
    // opposite of true and the inverse of the bait that branch exists to prevent.
    lines.push('');
    lines.push(
      `Fix this gate first — ${firstRequiredFailure.name} failed with no output ` +
        `(exit ${firstRequiredFailure.exitCode}). Run it yourself to see why.`
    );
  } else {
    // Optional-only failures must NOT carry the "fix this first" imperative or
    // the failure tail: on an otherwise-green baseline the tail baits the model
    // into burning whole attempts on a non-blocking rung instead of the task
    // goal (observed live 2026-07-10: 13/13 writes against an optional lint
    // rung whose eslint plugin crash the agent could never fix, zero writes
    // toward the epic goal).
    // Scoped to genuinely optional rungs — `firstRequiredFailure` being unset is
    // now the only way to reach here, so this can no longer mislabel a required one.
    const firstOptionalFailure = results.find(
      (r) => !r.passed && !r.skipped && !requiredIds.has(r.id)
    );
    if (firstOptionalFailure) {
      lines.push('');
      lines.push(
        `Note: ${firstOptionalFailure.name} is failing but is OPTIONAL — it does not block ` +
          'acceptance. Do not prioritize it over the task goal.'
      );
    }
  }

  return lines.join('\n');
}

/** Run the full ladder, honoring fail-fast for required rungs. */

/**
 * Did this test rung actually RUN any tests?
 *
 * The ladder decides purely on exit code, so a suite with NO tests is
 * indistinguishable from a suite that passed: `cargo test` on a crate with zero
 * tests exits 0, and the gate calls it verified. A live mission delivered a Rust
 * crate whose entire test result was `0 passed; 0 failed` — compiled, gated,
 * "delivered", and never tested at all.
 *
 * Passing because there was nothing to run is not evidence of anything.
 *
 * Returns false when the runner clearly reports zero tests, true when it clearly
 * ran some, and null when we cannot tell (an unknown runner — never guess, and
 * never block on a guess).
 */
export function testsActuallyRan(rungId: string, output: string): boolean | null {
  const out = output.toLowerCase();

  // Rust: every test binary prints `test result: ok. N passed; ...`. A workspace
  // prints one line per binary, so tests ran iff ANY line reports a non-zero count.
  if (rungId.startsWith('cargo-test') || rungId === 'cargo-test') {
    const results = [...out.matchAll(/test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/g)];
    if (results.length === 0) return null;
    return results.some((m) => Number(m[1]) + Number(m[2]) > 0);
  }

  // Python
  if (rungId.includes('pytest')) {
    if (/no tests ran|collected 0 items/.test(out)) return false;
    if (/\d+ (passed|failed)/.test(out)) return true;
    return null;
  }

  // Go: `?   pkg  [no test files]` for every package means nothing ran.
  if (rungId.startsWith('go-test')) {
    if (/^(ok|---\s*(pass|fail))/m.test(out)) return true;
    if (/\[no test files\]/.test(out)) return false;
    return null;
  }

  // JS/TS (vitest / jest)
  if (rungId === 'test' || rungId.includes('vitest') || rungId.includes('jest')) {
    if (/no test files found|no tests found|found 0 test/.test(out)) return false;
    if (/tests?\s+\d+\s+passed|\d+\s+(passed|failed)/.test(out)) return true;
    return null;
  }

  // .NET
  if (rungId.startsWith('dotnet-test')) {
    const m = out.match(/passed:\s*(\d+).*?failed:\s*(\d+)/s);
    if (m) return Number(m[1]) + Number(m[2]) > 0;
    return null;
  }

  // CTest
  if (rungId === 'ctest') {
    if (/no tests were found/.test(out)) return false;
    if (/tests passed|\d+ tests? failed/.test(out)) return true;
    return null;
  }

  return null; // not a runner we can read — do not guess
}

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

    const result = runRung(rung, projectRoot, tailChars, options.requireTestsRan ?? false);
    results.push(result);

    // Same rule as cross-tier promotion: a synthetic rung fails the ladder but
    // does not hide the rungs ordered after it. Without this the fix was half a
    // fix — the self-gate is pushed into `fast` and redetected build/typecheck/
    // test rungs are APPENDED after it, so on a from-scratch mission (the
    // classic self-gate trigger) a red self-gate marked every real gate
    // `skipped` on every turn, inside the tier, no matter what promotion did.
    if (!result.passed && rung.required && rung.blocksPromotion !== false && failFast) {
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
  // A demoted rung blocks again once THIS mission broke something inside it.
  const regressions = baselineRegressions(rungs, results);
  const passed = requiredPassed === requiredRungs.length && regressions.length === 0;

  return {
    passed,
    score,
    results,
    feedback:
      formatFeedback(results, rungs, new Set(regressions.map((r) => r.id))) +
      formatBaselineRegressions(regressions),
  };
}

/** A ladder runner: turns a set of rungs into a result. May be async. */
/**
 * Redetect-merge policy (pure): fold freshly detected rungs into an existing
 * set. Default allow-list merges only the cheap always-safe tiers (fast +
 * runtime) so re-detection never silently escalates to integration or
 * deploy-dev; callers pass `allow` to enforce their own tier ceiling or
 * --gates subset. Returns the SAME array when nothing new qualifies. Single
 * source for the policy shared by the convergence loop's mid-mission
 * redetection and deliver's post-merge combined-tree verification.
 */
export function mergeRedetectedRungs(
  current: GateRung[],
  detected: GateRung[],
  allow?: (r: GateRung) => boolean
): GateRung[] {
  const have = new Set(current.map((r) => r.id));
  const allowed = allow ?? ((r: GateRung) => tierOf(r) === 'fast' || tierOf(r) === 'runtime');
  const added = detected.filter((r) => !have.has(r.id) && allowed(r));
  return added.length > 0 ? [...current, ...added] : current;
}

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
  /**
   * Specialized runner for the terminal `final` tier (user-path validation
   * against the real client). When absent, `final` rungs fall back to
   * {@link runner}, which would spawn their command verbatim.
   */
  userValidationRunner?: LadderRunFn;
}

const skippedRung = (rung: GateRung, reason?: RungResult['skipReason']): RungResult => ({
  id: rung.id,
  name: rung.name,
  passed: false,
  skipped: true,
  exitCode: null,
  durationMs: 0,
  outputTail: '',
  ...(reason ? { skipReason: reason } : {}),
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
    // Forwarding this is load-bearing: without it, a zero-test rung is detected
    // and reported but never actually BLOCKS — the gate still prints VERIFIED.
    requireTestsRan: options.requireTestsRan,
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
  /** A rung failed that is required but deliberately does not stop promotion. */
  let nonBlockingFailed = false;

  for (const tier of TIER_ORDER) {
    const tierRungs = byTier.get(tier);
    if (!tierRungs || tierRungs.length === 0) continue;

    // 'final' is an epilogue tier: always in scope when its rung was
    // synthesized (config-gated upstream), regardless of the maxTier ceiling —
    // it must not drag integration/deploy-dev into scope. It runs when no
    // PROMOTION-BLOCKING rung has failed; the cost ceiling can leave
    // integration/deploy-dev deferred-not-passed while final still runs, which
    // is intended (it carries the behavioural signal, they carry infrastructure).
    const eligible = tier === 'final' || TIER_ORDER.indexOf(tier) <= maxIdx;
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

    // COST CEILING while a non-blocking rung is red.
    //
    // blocksPromotion exists so a red synthetic self-gate stops starving the real
    // gates. But "don't starve" should not mean "pay for everything, every turn":
    // the self-gate is raised precisely when the project's own gates are green and
    // is REQUIRED to stay red until the mission is done, so without a ceiling every
    // turn of a long run would bring a docker-compose stack up and down
    // (integration/deploy-dev) and drive a headless browser + vision model (final).
    //
    // runtime is the tier that carries the feedback the unblocking was for — does
    // the artifact actually execute — and it is cheap. So while a non-blocking rung
    // is red, run up to runtime and defer the expensive tiers until the ladder is
    // otherwise clean. Escape hatch for anyone who wants the full ladder anyway.
    if (
      nonBlockingFailed &&
      COSTLY_TIERS.has(tier) &&
      process.env.UAP_LADDER_NO_COST_CEILING !== '1'
    ) {
      for (const rung of tierRungs) results.push(skippedRung(rung, 'deferred-cost'));
      continue;
    }

    const useRunner =
      tier === 'deploy-dev' && options.deployDevRunner ? options.deployDevRunner
      : tier === 'final' && options.userValidationRunner ? options.userValidationRunner
      : runner;
    const tierResult = await useRunner(tierRungs, projectRoot, innerOptions);
    results.push(...tierResult.results);

    // Promotion stops only if a rung that BLOCKS promotion failed. A synthetic
    // rung (blocksPromotion: false) still fails the ladder — it just does not
    // hide the real gates in later tiers behind it.
    if (!tierResult.passed) {
      let blockingFailed = false;
      for (const r of tierResult.results) {
        if (r.passed || r.skipped) continue;
        const rung = tierRungs.find((g) => g.id === r.id);
        const required = rung?.required ?? true;
        // A demoted rung the mission REGRESSED is blocking this turn, so it
        // must stop promotion like any other blocking failure. Otherwise a turn
        // that provably cannot pass still brings up the integration tier's
        // containers, the dev deploy, and the vision model in `final` — paying
        // the most expensive tiers to confirm a verdict already decided.
        if (rung && regressedTests(rung, r).length > 0) {
          // Defer the COSTLY tiers, do not stop promotion outright. Stopping
          // would also skip `runtime` and `final` — the execution and user-path
          // gates — and COSTLY_TIERS exists precisely because starving those
          // "re-starves exactly what blocksPromotion unstarved". A regression
          // can persist for several turns, and the model still needs to know
          // whether the artifact runs while it fixes it.
          nonBlockingFailed = true;
          continue;
        }
        if (!required) continue;
        if (rung?.blocksPromotion === false) nonBlockingFailed = true;
        else blockingFailed = true;
      }
      if (blockingFailed) promotionStopped = true;
    }
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
  // The same rule, applied HERE too. This aggregator recomputes the verdict
  // from required rungs, and a demoted rung is required:false by construction —
  // so a check that lived only in runLadder was silently discarded on the one
  // path deliver actually uses. Found by testing the aggregator, not the inner
  // function; the inner-only version passed 15 tests while doing nothing.
  const regressions = baselineRegressions(inScope.length > 0 ? inScope : rungs, results);
  const passed = requiredPassed === requiredInScope.length && regressions.length === 0;

  return {
    passed,
    score,
    results,
    feedback:
      formatFeedback(
        results,
        inScope.length > 0 ? inScope : rungs,
        new Set(regressions.map((r) => r.id))
      ) + formatBaselineRegressions(regressions),
  };
}

/**
 * `cargo check --features <feature>` inside a container.
 *
 * A crate can hide its whole API behind a cargo feature, and the default gate
 * then reports zero errors on code that does not compile. Enabling the feature
 * locally is not a general answer — the motivating pgrx crate needs
 * `cargo pgrx init`, which builds PostgreSQL from source. A container carries
 * that toolchain instead, so the check works on a host that has nothing.
 *
 * Returns null when docker is unavailable or the feature is empty, so a caller
 * can always ask and simply get nothing back.
 *
 * Authored by the local model against an executable spec
 * (test/delivery/docker-cargo-rung.test.ts), which pins every rule below.
 */
export function dockerCargoRung(
  projectRoot: string,
  feature: string,
  opts?: { image?: string; hasDocker?: boolean; timeoutMs?: number }
): GateRung | null {
  if (opts?.hasDocker === false) return null;
  if (!feature || feature.trim().length === 0) return null;

  const image = opts?.image ?? 'rust:1-slim';
  const timeoutMs = opts?.timeoutMs ?? 900_000;

  return {
    id: `cargo-check-docker-${feature}`,
    name: `Cargo check (docker, feature: ${feature})`,
    command: 'docker',
    // Verbatim args: the rung runner does no shell interpolation, so a path
    // with spaces must arrive as ONE argument rather than pre-quoted.
    args: [
      'run',
      '--rm',
      '-v',
      `${projectRoot}:/w`,
      '-w',
      '/w',
      image,
      'cargo',
      'check',
      '--workspace',
      '--features',
      feature,
    ],
    // Advisory: a missing image, no network or a cold pull must never fail a
    // delivery for a reason unrelated to the mission.
    required: false,
    timeoutMs,
    tier: 'fast',
  };
}
