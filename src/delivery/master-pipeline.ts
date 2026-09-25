/**
 * Master-pipeline readout — the single named surface describing how
 * `uap deliver` composes the Harness/Loop/Graph master architecture by
 * default (see docs/plans/hlg-master-architecture-uplift-2026-09-24.md):
 *
 *   fan-out ×N (worktree-isolated) → evidence-gated convergence loops →
 *   state-hash read dedup → adversarial red-team gate
 *
 * This module OWNS no behavior — it resolves and formats the effective
 * settings of stages that live elsewhere (`resolveParallelTasks` in
 * task-workspace.ts, the state-hash env knobs in agentic-executor.ts,
 * `resolveAdversarialGate` in adversarial-gate.ts) so the CLI banner and
 * the dry-run plan print ONE consistent description of what the run will
 * do, and so tests can pin the composition without driving a full deliver
 * run. Every knob keeps the same precedence as its owning stage:
 * env > .uap.json `deliver.*` > default.
 */

import { resolveParallelTasks } from './task-workspace.js';
import { stateHashEnabled, stateHashMinBytes } from './agentic-executor.js';
import { resolveAdversarialGate, type AdversarialGateSettings } from './adversarial-gate.js';
import { resolveCriteriaLint } from './criteria-lint.js';
import { resolveEvidenceGate } from './delivery-evidence.js';

export interface MasterPipelineReadout {
  /** Effective fan-out cap for orchestrated dispatch (1 = sequential). */
  parallelTasks: number;
  /** State-hash read dedup enabled (UAP_DELIVER_STATE_HASH !== '0'). */
  stateHash: boolean;
  /** Size floor below which repeats are served in full. */
  stateHashMinBytes: number;
  /** Adversarial red-team gate settings (enabled + round budget). */
  adversarial: AdversarialGateSettings;
  /** Plan-time criteria lint: behavioral criteria get executable-evidence
   * clauses (UAP_DELIVER_CRITERIA_LINT / deliver.criteriaLint). */
  criteriaLint: boolean;
  /** Anti-vacuous delivery: a judge pass with no executable behavioral
   * evidence is refused (UAP_DELIVER_EVIDENCE_GATE / deliver.evidenceGate). */
  evidenceGate: boolean;
}

/**
 * Resolve the effective stage settings. `deliverCfg` is the raw
 * `.uap.json` `deliver` section (undefined when absent); `env` defaults to
 * process.env and is injectable for tests.
 *
 * The state-hash knobs are REUSED from agentic-executor.ts's
 * stateHashEnabled/stateHashMinBytes (env-injectable since the drift fix —
 * a mirrored copy here had already drifted, accepting a negative floor the
 * executor would reject). Semantics are the executor's by construction:
 * enabled unless exactly '0'; min-bytes falls back to the default on
 * unset/empty/non-integer/negative.
 */
export function resolveMasterPipeline(
  deliverCfg?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): MasterPipelineReadout {
  return {
    parallelTasks: resolveParallelTasks(deliverCfg?.parallelTasks, env),
    stateHash: stateHashEnabled(env),
    stateHashMinBytes: stateHashMinBytes(env),
    adversarial: resolveAdversarialGate(deliverCfg?.adversarialGate, env),
    criteriaLint: resolveCriteriaLint(deliverCfg, env),
    evidenceGate: resolveEvidenceGate(deliverCfg, env),
  };
}

/** One-line human readout for the startup banner and the dry-run plan. */
export function formatMasterPipelineLine(p: MasterPipelineReadout): string {
  return (
    `fan-out ×${p.parallelTasks} (worktree-isolated) → evidence loops → ` +
    `state-hash dedup ${p.stateHash ? `on (≥${p.stateHashMinBytes}B)` : 'off'} → ` +
    `adversarial gate ${p.adversarial.enabled ? `on (≤${p.adversarial.maxRounds} rounds)` : 'off'} → ` +
    `criteria lint ${p.criteriaLint ? 'on' : 'off'} → evidence gate ${p.evidenceGate ? 'on' : 'off'}`
  );
}
