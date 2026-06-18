/**
 * Local dev deploy + smoke gate (the `deploy-dev` tier).
 *
 * Runs a deploy-dev rung as a full lifecycle: optionally bring a docker-compose
 * stack up (`docker compose up -d --wait`), run the smoke/health check, then
 * ALWAYS tear the stack down (even on smoke failure or timeout). This gives the
 * convergence loop real "does it actually run" feedback locally, before the
 * change is ever committed.
 *
 * Safety:
 *  - When the rung needs docker and docker is unavailable, the tier is reported
 *    as SKIPPED (not failed) so a missing runtime never poisons convergence
 *    feedback or blocks delivery.
 *  - `UAP_DELIVER_NO_DEPLOY=1` force-skips the tier.
 *  - The deploy command inherits {@link sanitizedEnv} (secrets stripped,
 *    `CI=true`), exactly like the other gate rungs.
 */

import { spawnSync } from 'child_process';
import {
  DEFAULT_TAIL_CHARS,
  formatFeedback,
  sanitizedEnv,
  truncateTail,
  type GateRung,
  type LadderOptions,
  type LadderResult,
  type RungResult,
} from './verifier-ladder.js';

const DEFAULT_BRINGUP_TIMEOUT_MS = 120_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;

export interface DeployDevOptions {
  /** Max chars of command output kept on failure (default 2000). */
  outputTailChars?: number;
  /** Compose bring-up timeout (default 120s). */
  bringUpTimeoutMs?: number;
  /** Teardown timeout (default 30s). */
  teardownTimeoutMs?: number;
  /**
   * Override docker availability detection — primarily for tests. When
   * undefined the runner probes `docker --version`.
   */
  dockerAvailable?: boolean;
}

/** True when the rung's bring-up or teardown shells out to docker. */
function needsDocker(rung: GateRung): boolean {
  return rung.command === 'docker' || rung.teardown?.command === 'docker';
}

function dockerIsAvailable(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  try {
    const res = spawnSync('docker', ['--version'], { timeout: 5_000, encoding: 'utf-8' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function skipped(rung: GateRung, note: string): RungResult {
  return {
    id: rung.id,
    name: rung.name,
    passed: false,
    skipped: true,
    exitCode: null,
    durationMs: 0,
    outputTail: note,
  };
}

/**
 * Run one deploy-dev rung through its bring-up → smoke → teardown lifecycle.
 * Teardown is best-effort and runs in `finally`; a teardown failure never
 * flips a passing smoke result.
 */
export function runDeployDevRung(
  rung: GateRung,
  projectRoot: string,
  options: DeployDevOptions = {}
): RungResult {
  const tailChars = options.outputTailChars ?? DEFAULT_TAIL_CHARS;

  if (process.env.UAP_DELIVER_NO_DEPLOY === '1') {
    return skipped(rung, 'deploy-dev skipped (UAP_DELIVER_NO_DEPLOY=1)');
  }

  const usesDocker = needsDocker(rung);
  if (usesDocker && !dockerIsAvailable(options.dockerAvailable)) {
    // Missing runtime is not a code failure — degrade to skipped.
    return skipped(rung, 'deploy-dev skipped (docker unavailable)');
  }

  const env = sanitizedEnv();
  const start = Date.now();
  const useCompose = usesDocker && !!rung.teardown;

  try {
    // 1. Bring up the compose stack (blocks on container healthchecks).
    if (useCompose) {
      const up = spawnSync('docker', ['compose', 'up', '-d', '--wait'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: options.bringUpTimeoutMs ?? DEFAULT_BRINGUP_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env,
      });
      if (up.status !== 0) {
        const errCode = (up.error as NodeJS.ErrnoException | undefined)?.code;
        const timedOut = errCode === 'ETIMEDOUT' || (up.error && up.signal === 'SIGTERM');
        const diag = timedOut
          ? `Compose bring-up timed out after ${options.bringUpTimeoutMs ?? DEFAULT_BRINGUP_TIMEOUT_MS}ms.`
          : 'Compose bring-up failed.';
        return {
          id: rung.id,
          name: rung.name,
          passed: false,
          skipped: false,
          exitCode: up.status,
          failureReason: timedOut ? 'timeout' : 'exit',
          durationMs: Date.now() - start,
          outputTail: truncateTail(`${diag}\n${up.stdout ?? ''}\n${up.stderr ?? ''}`, tailChars),
        };
      }
    }

    // 2. Smoke / health check.
    const smoke = spawnSync(rung.command, rung.args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: rung.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    const passed = smoke.status === 0;
    let failureReason: RungResult['failureReason'];
    let diagnostic = '';
    if (!passed) {
      const errCode = (smoke.error as NodeJS.ErrnoException | undefined)?.code;
      if (errCode === 'ETIMEDOUT' || (smoke.error && smoke.signal === 'SIGTERM')) {
        failureReason = 'timeout';
        diagnostic = `Smoke check timed out after ${rung.timeoutMs}ms.`;
      } else if (smoke.error) {
        failureReason = 'spawn-error';
        diagnostic = `Smoke check could not run: ${smoke.error.message}`;
      } else if (smoke.signal) {
        failureReason = 'signal';
        diagnostic = `Smoke check killed by signal ${smoke.signal}.`;
      } else {
        failureReason = 'exit';
      }
    }
    return {
      id: rung.id,
      name: rung.name,
      passed,
      skipped: false,
      exitCode: smoke.status,
      failureReason,
      durationMs: Date.now() - start,
      outputTail: passed
        ? ''
        : truncateTail(`${diagnostic}\n${smoke.stdout ?? ''}\n${smoke.stderr ?? ''}`, tailChars),
    };
  } finally {
    // 3. Teardown — always, best-effort.
    if (rung.teardown) {
      try {
        spawnSync(rung.teardown.command, rung.teardown.args, {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: options.teardownTimeoutMs ?? rung.teardown.timeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env,
        });
      } catch {
        /* teardown is best-effort; never flips the rung result */
      }
    }
  }
}

/**
 * LadderRunFn-compatible runner for the deploy-dev tier: runs each rung through
 * {@link runDeployDevRung} and aggregates into a {@link LadderResult}. Wire this
 * as `runTieredLadder`'s `deployDevRunner`.
 */
export function runDeployDevLadder(
  rungs: GateRung[],
  projectRoot: string,
  options: LadderOptions = {}
): LadderResult {
  const tailChars = options.outputTailChars ?? DEFAULT_TAIL_CHARS;
  const results = rungs.map((rung) =>
    runDeployDevRung(rung, projectRoot, { outputTailChars: tailChars })
  );

  // A skipped deploy-dev rung (docker missing / opted out) must not block
  // delivery — treat it as a non-blocking pass for the gate aggregate.
  const requiredRungs = rungs.filter((r) => r.required);
  const requiredOk = requiredRungs.every((rung) =>
    results.some((r) => r.id === rung.id && (r.passed || r.skipped))
  );
  const passedCount = results.filter((r) => r.passed).length;
  const score = results.length > 0 ? passedCount / results.length : 1;

  return {
    passed: requiredOk,
    score,
    results,
    feedback: formatFeedback(results, rungs),
  };
}
