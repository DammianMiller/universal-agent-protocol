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
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

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
const DEFAULT_TAIL_CHARS = 2_000;

/** Env vars matching these patterns are stripped before running gate
 * commands — project scripts (and npm lifecycle hooks) in arbitrary
 * --project-root checkouts must not inherit provider credentials. */
const SECRET_ENV_RE = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: 'true' };
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_RE.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Detect the gate rungs available in a project from its package.json scripts.
 * Order matters: cheap/structural gates run before expensive ones so failure
 * feedback arrives fast.
 */
export function detectRungs(projectRoot: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): GateRung[] {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return [];
  }

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }

  const rungs: GateRung[] = [];

  if (scripts['build']) {
    rungs.push({
      id: 'build',
      name: 'Build (npm run build)',
      command: 'npm',
      args: ['run', 'build'],
      required: true,
      timeoutMs,
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
    });
  }

  return rungs;
}

function truncateTail(text: string, maxChars: number): string {
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
