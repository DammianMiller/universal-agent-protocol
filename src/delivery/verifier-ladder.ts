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
  | 'final'
  | 'ci'
  | 'deploy-staging'
  | 'deploy-prod';

/** Cheap → expensive promotion order. */
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
   * True when this is a TEST rung that exited 0 having run ZERO tests. Passing
   * because there is nothing to run is not evidence of anything — see
   * testsActuallyRan.
   */
  zeroTests?: boolean;
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
 * with teardown hooks; everything else passes through untouched. Rung-level
 * granularity: new breakage WITHIN an already-red rung is not distinguished —
 * the failure output still reaches the model and judge, and --keep-best
 * remains the whole-tree regression backstop.
 */
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
    const res = runRung(r, projectRoot, tailChars);
    if (res.passed) return r;
    demoted.push({ id: r.id, name: r.name, outputTail: res.outputTail });
    return { ...r, required: false, name: `${r.name} ${BASELINE_DEMOTION_NOTE}` };
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
export function detectCargoRungs(projectRoot: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): GateRung[] {
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
  requireTestsRan = false
): RungResult {
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

  return {
    id: rung.id,
    name: rung.name,
    passed,
    skipped: false,
    exitCode,
    failureReason,
    durationMs,
    outputTail: passed ? '' : truncateTail(combined, tailChars),
    ...(zeroTests ? { zeroTests: true } : {}),
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

  const firstRequiredFailure = results.find(
    (r) => !r.passed && !r.skipped && requiredIds.has(r.id)
  );
  if (firstRequiredFailure && firstRequiredFailure.outputTail) {
    lines.push('');
    lines.push(`Fix this gate first — ${firstRequiredFailure.name} output:`);
    lines.push('```');
    lines.push(firstRequiredFailure.outputTail);
    lines.push('```');
  } else {
    // Optional-only failures must NOT carry the "fix this first" imperative or
    // the failure tail: on an otherwise-green baseline the tail baits the model
    // into burning whole attempts on a non-blocking rung instead of the task
    // goal (observed live 2026-07-10: 13/13 writes against an optional lint
    // rung whose eslint plugin crash the agent could never fix, zero writes
    // toward the epic goal).
    const firstOptionalFailure = results.find((r) => !r.passed && !r.skipped);
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

  for (const tier of TIER_ORDER) {
    const tierRungs = byTier.get(tier);
    if (!tierRungs || tierRungs.length === 0) continue;

    // 'final' is an epilogue tier: always in scope when its rung was
    // synthesized (config-gated upstream), regardless of the cost ceiling —
    // it must not drag integration/deploy-dev into scope, and promotion
    // still guarantees it only runs when every cheaper in-scope tier passed.
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

    const useRunner =
      tier === 'deploy-dev' && options.deployDevRunner ? options.deployDevRunner
      : tier === 'final' && options.userValidationRunner ? options.userValidationRunner
      : runner;
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
