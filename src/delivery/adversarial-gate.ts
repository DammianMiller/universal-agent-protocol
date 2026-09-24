/**
 * Adversarial Red-Team Gate — HLG master architecture, stage 5
 * (docs/plans/hlg-master-architecture-uplift-2026-09-24.md).
 *
 * When a deliver run has converged (all gates green) and BEFORE the verdict
 * is accepted, a skeptical verifier attacks the patch: it writes edge-case
 * tests designed to BREAK the change. If any fail, the run routes back into
 * the convergence loop with that failure as ordinary gate evidence; only a
 * patch that survives proceeds to acceptance (and gate evidence).
 *
 * This module is the STAGE DRIVER: settings resolution, the bounded round
 * loop, breach → re-convergence orchestration, and the repair/rollback
 * rails. The single-round machinery (attack authoring, sanctioning, suite
 * execution, verdicts) lives in adversarial-attack.ts — the split keeps
 * both files under the 500-LOC quality-gate threshold, along the seam the
 * architecture review suggested. This module RE-EXPORTS the attack module's
 * public surface so existing imports from './adversarial-gate.js' keep
 * working.
 *
 *  - BOUNDED: at most `maxRounds` attacks per run (default 2). A breach
 *    consumes a round and re-enters the convergence loop; the breaching
 *    tests REMAIN in the tree, so the repaired state has already survived
 *    that attack — the next round, if budget remains, attacks with FRESH
 *    tests rather than re-running the old ones forever.
 *
 * ACCEPTED RESIDUAL (C-stage review, 2026-09-24): authored tests execute
 * with HOST FILESYSTEM privileges — sanitized-env strips environment
 * variables but does NOT stop file-based credential reads (~/.aws, ~/.ssh,
 * /etc) from inside a running test; and the repo content quoted into the
 * attack prompt is an INDIRECT PROMPT-INJECTION channel into the authoring
 * model. The additive oracle channel plus lexical+symlink path containment
 * bound what an attack may WRITE and never weaken; what it can READ at
 * runtime is everything the host user can read. This stage therefore runs
 * only on the operator's own deliver run, never on untrusted input.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { DeliveryResult, LoopExecutor } from './convergence-loop.js';
import { foldDeliveryResult } from './delivery-result.js';
import type { GateRung } from './verifier-ladder.js';
import { extractTestTitles } from './test-oracle-additive.js';
import {
  breachReconvergencePrompt,
  runAdversarialRound,
  type AdversarialRoundResult,
  type AdversarialStatus,
  type SuiteRunner,
} from './adversarial-attack.js';

// The attack + sanction modules' public surface, re-exported so consumers
// (index.ts, tests) keep a single import site for the whole stage.
export {
  attackSurface,
  breachReconvergencePrompt,
  buildAttackPrompt,
  pickTestRung,
  runAdversarialRound,
  type AdversarialAttackFile,
  type AdversarialRoundOptions,
  type AdversarialRoundResult,
  type AdversarialStatus,
  type SuiteRun,
  type SuiteRunner,
} from './adversarial-attack.js';

export { sanctionAttackBlocks, type SanctionedWrite } from './adversarial-sanction.js';

/** Default attacks per converged run; each breach re-enters the loop once. */
export const DEFAULT_ADVERSARIAL_ROUNDS = 2;
/** Hard ceiling — the stage must never become the loop it exists to bound. */
export const MAX_ADVERSARIAL_ROUNDS = 4;

/** Resolved on/off + round budget for the stage. */
export interface AdversarialGateSettings {
  enabled: boolean;
  maxRounds: number;
}

/**
 * Resolve the adversarial gate's effective settings.
 *
 * Precedence mirrors `resolveParallelTasks` (task-workspace.ts): the
 * `UAP_DELIVER_ADVERSARIAL_GATE` env var > `.uap.json` `deliver.adversarialGate`
 * > the default. The stage is DEFAULT ON; `0`/`off`/`false` at either layer
 * disables it. A positive integer at either layer retunes the round budget
 * (clamped to [1, MAX_ADVERSARIAL_ROUNDS]); any other truthy value keeps the
 * default budget — a typo must never silently disable a safety gate, and the
 * documented off switch is unambiguous.
 */
export function resolveAdversarialGate(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env
): AdversarialGateSettings {
  const off = (v: unknown): boolean => v === false || v === 0 || v === '0' || v === 'off';
  const budget = (v: unknown): number => {
    // Boolean `true` means "on" (the flag form), not a round count —
    // Number(true) === 1 would silently collapse the budget to one round
    // while env 'true' keeps the default. Guard the TYPE, not the value.
    if (typeof v === 'boolean') return DEFAULT_ADVERSARIAL_ROUNDS;
    const n = Number(v);
    return Number.isFinite(n) && n > 0
      ? Math.min(Math.floor(n), MAX_ADVERSARIAL_ROUNDS)
      : DEFAULT_ADVERSARIAL_ROUNDS;
  };
  const fromEnv = env.UAP_DELIVER_ADVERSARIAL_GATE;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return off(fromEnv)
      ? { enabled: false, maxRounds: 0 }
      : { enabled: true, maxRounds: budget(fromEnv) };
  }
  if (raw === undefined || raw === null) {
    return { enabled: true, maxRounds: DEFAULT_ADVERSARIAL_ROUNDS };
  }
  return off(raw)
    ? { enabled: false, maxRounds: 0 }
    : { enabled: true, maxRounds: budget(raw) };
}

/** Options for the whole stage (bounded rounds + re-convergence). */
export interface AdversarialGateOptions {
  instruction: string;
  projectRoot: string;
  rungs: GateRung[];
  executor: LoopExecutor;
  settings: AdversarialGateSettings;
  /** The converged result under attack. */
  initial: DeliveryResult;
  /**
   * Re-enter the convergence loop with the breach as feedback. The breaching
   * tests are already in the tree, so a successful re-convergence has made
   * THEM pass too — the attack persists as ordinary gate evidence.
   */
  reconverge: (prompt: string) => Promise<DeliveryResult>;
  runSuite?: SuiteRunner;
  timeoutMs?: number;
  /** Operator-facing progress lines. */
  note?: (line: string) => void;
  /**
   * Re-derive the rung set AT GATE TIME. deliver.ts wires this to
   * `mergeRedetectedRungs(rungs, detectRungs(projectRoot), …)` — the same
   * policy the loop's mid-mission redetection uses — because the rungs this
   * stage receives were detected at t0, and a mission that CREATED its own
   * test gate (greenfield) would otherwise no-surface forever. A throwing
   * detector falls back to `opts.rungs`.
   */
  redetectRungs?: () => GateRung[];
  /**
   * Called with each breaching round BEFORE reconvergence, so the caller can
   * extend the repair executor's protected set with the breaching test files
   * (the t0 protection snapshot predates them). The post-repair verification
   * below enforces the rule regardless; this is defense in depth.
   */
  onBreach?: (breach: AdversarialRoundResult) => void;
}

/** The stage's outcome, including the (possibly re-converged) final result. */
export interface AdversarialGateReport {
  status: AdversarialStatus | 'disabled';
  rounds: AdversarialRoundResult[];
  authored: number;
  ran: number;
  failed: number;
  /** The state to accept (survived/no-surface) or reject (breached). */
  result: DeliveryResult;
  /** One-line outcome for telemetry / the gate-evidence artifact. */
  summary: string;
}

/**
 * Post-repair verification (C-stage review: vacuous breach repair). The
 * reconvergence prompt's "never delete, skip, or weaken" rule is PROSE, and
 * the repair executor's protected-files set was snapshotted at t0 — before
 * the adversarial tests existed — so nothing structural stops a repair from
 * deleting or gutting the very tests that pinned the breach. After a repair
 * reports success, every breaching test file must still EXIST and still
 * contain its authored titles; anything else is a failed repair, whatever
 * the loop's gates say (a repair that removed the test trivially turns them
 * green). Returns the per-file violations; empty means the attack survived
 * the repair intact.
 */
function breachingTestsGutted(projectRoot: string, breach: AdversarialRoundResult): string[] {
  const gutted: string[] = [];
  for (const f of breach.attackFiles ?? []) {
    const abs = join(projectRoot, f.rel);
    let content: string | null = null;
    try {
      content = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
    } catch {
      content = null;
    }
    if (content === null) {
      gutted.push(`${f.rel}: breaching test file was deleted during repair`);
      continue;
    }
    const present = new Set(extractTestTitles(content));
    const missing = f.titles.filter((t) => !present.has(t));
    if (missing.length > 0) {
      gutted.push(
        `${f.rel}: ${missing.length} authored adversarial test(s) removed or renamed during repair (${missing
          .slice(0, 2)
          .join('; ')})`
      );
    }
  }
  return gutted;
}

/**
 * Terminal-breach rollback: a REJECTED run must not leave the user's suite
 * red, so the breaching round's authored files come back OUT — created files
 * removed, appended-to files restored to their pre-attack bytes. (The
 * keep-best rollback rail settled BEFORE this stage runs, so this is the
 * only rail left.) Survived and repaired rounds keep their tests: those
 * pass, and are regression tests now. Best-effort, like rollbackWrites.
 */
function rollbackAttackFiles(projectRoot: string, round: AdversarialRoundResult): string[] {
  const rolledBack: string[] = [];
  for (const f of round.attackFiles ?? []) {
    try {
      if (f.prior === null) rmSync(join(projectRoot, f.rel), { force: true });
      else writeFileSync(join(projectRoot, f.rel), f.prior, 'utf-8');
      rolledBack.push(f.rel);
    } catch {
      /* rollback is best-effort; the round notes carry the residue */
    }
  }
  return rolledBack;
}

function summarize(
  status: AdversarialGateReport['status'],
  rounds: AdversarialRoundResult[],
  totals: { authored: number; ran: number; failed: number }
): string {
  const counts = `${totals.authored} authored / ${totals.ran} ran / ${totals.failed} failed`;
  if (status === 'disabled') return 'adversarial gate: disabled';
  if (status === 'survived') {
    return `adversarial gate: patch survived ${rounds.length} round(s) (${counts})`;
  }
  if (status === 'no-surface') {
    return `adversarial gate: no attack surface found after ${rounds.length} round(s) (${counts})`;
  }
  return `adversarial gate: patch BREACHED (${counts}) — re-convergence could not repair it`;
}

/**
 * The stage: attack the converged state up to `settings.maxRounds` times,
 * routing breaches back into the convergence loop as ordinary gate evidence.
 *
 * Round-budget semantics: a breach CONSUMES a round and re-enters the loop.
 * Because the breaching tests stay in the tree, the repaired state has already
 * survived that attack — so exhausting the budget on a successful repair is an
 * accept, not an open question. Only an UNREPAIRED breach rejects the run.
 */
export async function runAdversarialGate(opts: AdversarialGateOptions): Promise<AdversarialGateReport> {
  const totals = { authored: 0, ran: 0, failed: 0 };
  const base = (status: AdversarialGateReport['status'], rounds: AdversarialRoundResult[], result: DeliveryResult): AdversarialGateReport => ({
    status,
    rounds,
    ...totals,
    result,
    summary: summarize(status, rounds, totals),
  });
  if (!opts.settings.enabled) {
    return base('disabled', [], opts.initial);
  }

  const rounds: AdversarialRoundResult[] = [];
  let result = opts.initial;
  for (let round = 1; round <= opts.settings.maxRounds; round++) {
    // Gate-time redetection (C-stage review: stale t0 rungs): the rungs this
    // stage was handed were detected at mission start, so a greenfield
    // mission that CREATED its test gate would no-surface forever. Re-merge
    // the fresh detection the way the loop's mid-mission redetection does.
    let roundRungs = opts.rungs;
    if (opts.redetectRungs) {
      try {
        roundRungs = opts.redetectRungs();
      } catch {
        roundRungs = opts.rungs;
      }
    }
    const filesApplied = [...new Set(result.history.flatMap((h) => h.filesApplied))];
    const r = await runAdversarialRound({
      instruction: opts.instruction,
      projectRoot: opts.projectRoot,
      filesApplied,
      rungs: roundRungs,
      executor: opts.executor,
      round,
      ...(opts.runSuite ? { runSuite: opts.runSuite } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    rounds.push(r);
    totals.authored += r.authored;
    totals.ran += r.ran;
    totals.failed += r.failed;
    opts.note?.(
      r.status === 'breached'
        ? `🛡 adversarial round ${r.round}: BREACH — ${r.failed} adversarial test(s) failed; re-entering the loop`
        : r.status === 'survived'
          ? `🛡 adversarial round ${r.round}: survived — ${r.ran}/${r.authored} authored test(s) ran and passed`
          : `🛡 adversarial round ${r.round}: no attack surface found (${r.feedback})`
    );
    if (r.status !== 'breached') {
      return base(r.status, rounds, result);
    }

    // Breach: let the caller extend the repair's protected set with the
    // breaching test files (its t0 protection snapshot predates them), then
    // feed the failure back into the convergence loop as ordinary evidence.
    opts.onBreach?.(r);
    const repaired = await opts.reconverge(breachReconvergencePrompt(opts.instruction, r));
    const merged: DeliveryResult = { ...result, history: [...result.history] };
    foldDeliveryResult(merged, repaired);
    merged.success = repaired.success;
    merged.changedTree = Boolean(result.changedTree || repaired.changedTree);
    if (!repaired.success) {
      // TERMINAL breach: the run is rejected, and a rejected run must not
      // leave the user's suite red — roll the round's authored files back.
      const rolledBack = rollbackAttackFiles(opts.projectRoot, r);
      r.notes.push(
        `terminal breach — authored adversarial test file(s) rolled back: ${rolledBack.join(', ') || 'none recorded'}`
      );
      merged.finalFeedback =
        `⛔ adversarial gate: the red team broke the patch and the repair loop did not converge.\n\n${repaired.finalFeedback}`;
      return base('breached', rounds, merged);
    }
    // Vacuous-repair check: a "successful" repair that deleted or gutted the
    // breaching tests did not fix anything — it removed the evidence. That
    // is a failed repair, and the (terminal) breach rolls back as above.
    const gutted = breachingTestsGutted(opts.projectRoot, r);
    if (gutted.length > 0) {
      const rolledBack = rollbackAttackFiles(opts.projectRoot, r);
      r.notes.push(`repair gutted the breaching test(s) — repair REJECTED: ${gutted.join('; ')}`);
      if (rolledBack.length > 0) {
        r.notes.push(`terminal breach — authored adversarial test file(s) rolled back: ${rolledBack.join(', ')}`);
      }
      merged.success = false;
      merged.finalFeedback =
        '⛔ adversarial gate: the repair deleted or weakened the breaching adversarial tests instead of fixing the code.\n\n' +
        gutted.map((g) => `  ${g}`).join('\n');
      return base('breached', rounds, merged);
    }
    result = merged;
  }
  // Budget exhausted on a repaired state: the breaching tests remained in the
  // tree, so every repair already had to make them green — accept.
  return base('survived', rounds, result);
}
