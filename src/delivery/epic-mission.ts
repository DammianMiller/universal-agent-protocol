/**
 * Epic Mission — the epic-controller delivery runner (the DEFAULT `uap
 * deliver` path: epics are on for every mission), extracted from deliver.ts
 * behind narrow functional seams.
 *
 * Why extracted: this was the largest untested closure left in deliver.ts
 * after the orchestrated-mission extraction (PR #518) — the exact structural
 * condition that let PR #516 ship an inert feature. The contracts/scaffold
 * steering, epic spec assembly, ledger wiring, split policy, parallel-branch
 * selection, and acceptance parity in here were unobservable; now they are
 * unit-tested with every seam faked (test/delivery/epic-mission.test.ts).
 *
 * What this module owns: epic planning → Epic[] assembly (with the
 * single-'mission' fallback), the completion-ledger lifecycle, the
 * epic-controller wiring (attempts / split policy / split re-planning), the
 * per-epic scoped prompt + spec composition (contracts / scaffold / fill
 * steering, priors, retry feedback), the parallel-vs-classic branch choice,
 * epic-level acceptance parity, contract locking, and the mission aggregate.
 *
 * What stays with the caller (deliver.ts), injected as seams: every executor
 * (epic planning, task decomposition, the classic convergence loop, the
 * orchestrated runner), judge state + the acceptance judge, task records,
 * ledger and contract-lock effects, and logging.
 */

import { CONTEXT_BUDGET_MARKER } from './context-budget.js';
import type { DeliveryResult } from './convergence-loop.js';
import type { DeliveryPhase } from './decompose.js';
import { runEpics, type Epic, type EpicRunResult } from './epic-controller.js';
import { foldDeliveryResult } from './delivery-result.js';
import type { DeliveryTaskHandle } from './task-sync.js';

export interface EpicMissionDeps {
  /** The overall mission text. */
  instruction: string;
  /** Produce the top-level epic decomposition (caller wires executor/budget/
   * contracts flags). Fewer than 2 phases ⇒ the mission runs as ONE epic. */
  planEpics: () => Promise<DeliveryPhase[]>;
  /** Re-decompose a failed epic into smaller sub-epics (split path). The
   * module composes the reactive sub-goal; the caller only runs the planner. */
  planSplit: (subGoal: string) => Promise<DeliveryPhase[]>;
  /**
   * Inner task decomposition for the PARALLEL branch (caller wires the
   * planner with thoughtExperiment off — the mission-level decomposition
   * already passed validation and each task converges against real gates).
   */
  planEpicTasks: (goal: string) => Promise<DeliveryPhase[]>;
  /** Resolved deliver.parallelTasks; >1 enables the orchestrated branch. */
  epicParallelTasks: number;
  /** Run one epic as an orchestrated task DAG (worktree-isolated parallel
   * dispatch); the caller wires the orchestrated-mission runner. */
  runOrchestrated: (
    missionText: string,
    plan: DeliveryPhase[],
    parentTaskId?: string
  ) => Promise<DeliveryResult>;
  /** Run one epic as the classic single convergence loop. */
  runEpicLoop: (scoped: string) => Promise<DeliveryResult>;
  /** Point the judge at this epic's spec and reset breaker evidence. */
  setEpicSpec: (spec: string) => void;
  /**
   * Epic-level acceptance judge (parity: the classic loop judges every green
   * turn against the epic spec; the orchestrated branch judges ONCE after a
   * green run). Resolve null when the judge is unavailable — the objective
   * verdicts stand. Pass null to disable entirely (acceptance off).
   */
  judgeEpic: ((spec: string) => Promise<{ passed: boolean; feedback?: string } | null>) | null;
  /** Delivery-task records (fail-soft; both optional). */
  openTask?: (title: string) => Promise<DeliveryTaskHandle | null>;
  completeTask?: (record: DeliveryTaskHandle | null, result: DeliveryResult) => void;
  /** Completion-ledger lifecycle (best-effort; caller wraps init/mark). */
  ledgerInit?: (items: Array<{ id: string; title: string; deps?: string[] }>) => void;
  ledgerMark?: (id: string, status: 'done' | 'failed', note?: string) => void;
  /**
   * The PERSISTED epic plan from an interrupted run. When provided (and ≥1),
   * planEpics is skipped entirely: resume must be deterministic — replanning
   * would mint new epic ids (resetting the completion ledger's done marks)
   * and draw new boundaries over already-built work, which the anti-no-op
   * rail then refuses to accept.
   */
  initialEpics?: DeliveryPhase[];
  /**
   * Ids of epics ACCEPTED by the interrupted run: marked done without running
   * (their summaries ride in via initialPriorSummaries), so dependents
   * unblock and completed work is never redone.
   */
  initialDone?: string[];
  /**
   * Prior-epic summaries carried over from an INTERRUPTED run (resume at the
   * epic boundary): the remaining epics see them as "already built" context,
   * exactly like same-run priors.
   */
  initialPriorSummaries?: string[];
  /** Persist the (fallback-shaped) epic plan before execution starts, so an
   * interruption at ANY point can resume against the same plan. Fail-soft. */
  persistPlan?: (epics: DeliveryPhase[]) => void;
  /**
   * Persist cumulative resume progress after each accepted epic: the summary
   * list AND the accepted-epic id set. Fail-soft.
   */
  persistCompleted?: (progress: { summaries: string[]; completed: string[] }) => void;
  /** Currently locked contract files (read view, refreshed per use). */
  lockedContracts: () => string[];
  /**
   * P1: read the CONTENTS of the currently-locked contract files, concatenated,
   * for verbatim injection into every later epic's prompt. The existing
   * mechanism only names the locked paths and relies on the model to read them;
   * injecting the actual signatures is what stops fresh-context epics from
   * re-inventing a divergent CONFIG shape / module API. Null when none locked.
   */
  readContractFiles?: () => string | null;
  /** Lock an accepted contracts epic's files; returns what was newly locked. */
  lockContracts: (files: string[]) => string[];
  /** Epic-controller tuning (caller resolves env). */
  maxAttemptsPerEpic: number;
  splitDepth: number;
  splitOnAnyFailure: boolean;
  /** Per-session token budget, for the split log line only. */
  sessionBudget?: number;
  /** Progress lines (the caller decorates with chalk). */
  note?: (line: string) => void;
}

/**
 * Run a mission as a SEQUENCE of epics on the epic controller — each epic a
 * fresh convergence context (classic loop, or an orchestrated task DAG under
 * parallel dispatch), retried with failure feedback and recursively split
 * when it cannot land whole.
 */
export async function runEpicMission(deps: EpicMissionDeps): Promise<DeliveryResult> {
  const note = deps.note ?? ((): void => undefined);
  const all: DeliveryResult = {
    success: true, alreadyDelivered: false, turns: 0, bestScore: 0, bestTurn: 0,
    history: [], finalFeedback: '', finalOutput: '', totalDurationMs: 0,
  };

  // Resume determinism: a persisted plan wins over replanning (see the
  // initialEpics doc above for why). A persisted plan is already
  // fallback-shaped, so it also bypasses the degenerate-plan fallback —
  // re-shaping a persisted single-epic plan would swap its id.
  const persisted = deps.initialEpics && deps.initialEpics.length >= 1 ? deps.initialEpics : undefined;
  const planned = persisted ?? (await deps.planEpics());
  const epics: Epic[] = (persisted || planned.length >= 2
    ? planned
    : [{ id: 'mission', title: 'Mission', goal: deps.instruction }]
  ).map((ph) => ({
    id: ph.id,
    title: ph.title,
    goal: ph.goal,
    ...(ph.deps ? { deps: ph.deps } : {}),
    ...(ph.contracts ? { contracts: true } : {}),
    ...(ph.scaffold ? { scaffold: true } : {}),
    // Planner-emitted acceptance criteria feed the epic spec's judge clause
    // (previously declared on Epic but never populated — a dead clause).
    ...(ph.criteria?.length ? { criteria: ph.criteria } : {}),
  }));
  note(`🗂  epic controller: ${epics.length} epic(s): ${epics.map((e) => e.title).join(' → ')}`);
  // Persist the shaped plan BEFORE execution: an interruption at any point
  // (even mid-first-epic) must resume against these exact epics and ids.
  try {
    deps.persistPlan?.(epics);
  } catch {
    // resume-state persistence is best-effort
  }
  let lastContractEpicFiles: string[] = [];

  // Hands-free: auto-populate the completion ledger so the whole multi-epic
  // build has an objective, cross-session definition of done (Option B). The
  // Stop hook + reactor consult it to keep any model going until 100%.
  try {
    deps.ledgerInit?.(epics.map((e) => ({ id: e.id, title: e.title, ...(e.deps ? { deps: e.deps } : {}) })));
  } catch {
    // ledger is best-effort
  }

  const epicResult = await runEpics({
    mission: deps.instruction,
    epics,
    maxAttemptsPerEpic: deps.maxAttemptsPerEpic,
    splitDepth: deps.splitDepth,
    splitOnAnyFailure: deps.splitOnAnyFailure,
    // Resume at the epic boundary: completed epics from an interrupted run
    // ride in as priors + a done set (skipped, never redone); each accepted
    // epic persists the updated progress back.
    initialPriorSummaries: deps.initialPriorSummaries,
    initialDone: deps.initialDone,
    onProgress: deps.persistCompleted,
    // P1: carry the locked contract files' CONTENTS verbatim into every epic.
    ...(deps.readContractFiles ? { readContract: deps.readContractFiles } : {}),
    // Re-decompose a failed epic into sub-epics. Fires on context-budget
    // exhaustion (rail auto-size) and, under splitOnAnyFailure, on any
    // exhausted-attempts failure (auto-escalation). Always provided so the
    // escalation has a planner; declines (null) when it can't produce ≥2.
    splitEpic: async (epic, lastFailure, splitReason) => {
      // Structured reason from the controller — no more sniffing the marker
      // out of the failure text.
      const reason = splitReason?.budgetStopped
        ? `outgrew its ~${(deps.sessionBudget ?? 0).toLocaleString()}-token session budget`
        : 'could not be delivered whole after all attempts';
      note(`  ✂ epic ${epic.id} ${reason} — re-planning as smaller sub-epics`);
      const subGoal =
        `${epic.goal}\n\n(The previous attempt did not complete` +
        `${lastFailure ? `: ${lastFailure.slice(0, 300)}` : ''}. Split this into smaller, independently completable phases.)`;
      const subs = await deps.planSplit(subGoal);
      if (subs.length < 2) return null;
      // A split CONTRACTS (or SCAFFOLD) epic's pieces are still contracts/
      // scaffold work: without the flag, an epic accepted VIA SPLIT locked
      // nothing (or the parent's last FAILED attempt's files). Each accepted
      // piece now locks its own files through the normal onEpic path.
      return subs.map((s) => ({
        id: s.id,
        title: s.title,
        goal: s.goal,
        ...(epic.contracts ? { contracts: true } : {}),
        ...(epic.scaffold ? { scaffold: true } : {}),
        // A split piece's judge deserves the same criteria treatment as an
        // unsplit epic — dropping them here was the flag-propagation bug's
        // sibling.
        ...(s.criteria?.length ? { criteria: s.criteria } : {}),
      }));
    },
    onEpic: (epic, outcome) => {
      try {
        deps.ledgerMark?.(epic.id, outcome.accepted ? 'done' : 'failed', outcome.accepted ? undefined : outcome.summary);
      } catch {
        // best-effort
      }
      if (epic.contracts && outcome.accepted && lastContractEpicFiles.length > 0) {
        const locked = deps.lockContracts(lastContractEpicFiles);
        if (locked.length > 0) {
          note(`  🔒 contracts locked for later epics: ${locked.join(', ')}`);
        }
      }
      note(
        `  ${outcome.accepted ? '✓' : '✗'} epic ${epic.id}: ${outcome.accepted ? 'accepted' : 'failed'} after ${outcome.attempts} attempt(s), ${outcome.turns} turn(s)`
      );
    },
    runEpic: async (epic, ctx): Promise<EpicRunResult> => {
      const priors = ctx.priorSummaries.length
        ? `\n\nALREADY BUILT (prior epics — build on them, do not redo):\n${ctx.priorSummaries.map((sm, i) => `${i + 1}. ${sm}`).join('\n')}`
        : '';
      const retry = ctx.lastFailure ? `\n\nPREVIOUS ATTEMPT FEEDBACK (fix this):\n${ctx.lastFailure}` : '';
      // Contracts-first steering: the contracts epic is told its output IS
      // the frozen API; later epics are told which files are locked and to
      // build against them exactly. Locked paths also land in the judge's
      // spec, so spec-referenced evidence guarantees it SEES the contracts.
      const locked = deps.lockedContracts();
      const contractsNote = epic.contracts
        ? '\n\nThis is the CONTRACTS epic: define the COMPLETE shared types/interfaces/registry APIs the later epics will build against. They must compile, with minimal stub bodies. After this epic is accepted these files are FROZEN for the rest of the mission — make the signatures right.' +
          // A split contracts epic's later pieces run with the earlier pieces'
          // files ALREADY locked — without this list they would burn attempts
          // on refused writes with zero steering.
          (locked.length > 0
            ? `\nAlready-locked sibling contract files (read-only — write attempts will be refused): ${locked.join(', ')}. Extend the shared surface in NEW files and build against these exactly.`
            : '')
        : locked.length > 0
          ? `\n\nLOCKED CONTRACTS (read-only — write attempts will be refused): ${locked.join(', ')}. Build against these exact APIs; make YOUR code match their imports, type names and signatures.`
          : '';
      const scaffoldIds = new Set(epics.filter((e) => e.scaffold).map((e) => e.id));
      const fillsScaffold = !epic.scaffold && (epic.deps ?? []).some((d) => scaffoldIds.has(d));
      const scaffoldNote = epic.scaffold
        ? '\n\nThis is a SCAFFOLD epic: create the compiling SKELETON only — complete public signatures, wired imports/exports, and todo!()-style stub bodies (todo!() / raise NotImplementedError / throw new Error("TODO")). Do NOT implement the logic; a later FILL epic does that. The build/check gates must pass.'
        : fillsScaffold
          ? '\n\nThis is a FILL epic: the skeleton already exists with correct signatures. IMPLEMENT the stub bodies (todo!()/NotImplementedError/TODO throws) — do NOT change any existing signature, rename anything, or restructure modules. When you finish, no stub markers should remain in the files this epic fills.'
          : '';
      // P1: inject the locked contracts VERBATIM (signatures, CONFIG shape) so a
      // fresh-context epic builds against the EXACT shared surface rather than
      // re-inventing a divergent one. Skipped for the contracts epic itself
      // (it is authoring them) and capped so the prompt stays bounded.
      const contractBody = !epic.contracts && ctx.contract
        ? `\n\nSHARED CONTRACT — the locked contract files, VERBATIM. Build against these EXACT names, shapes and signatures; do NOT invent different ones:\n${ctx.contract.slice(0, 6000)}`
        : '';
      const scoped =
        `OVERALL MISSION (context): ${deps.instruction.slice(0, 300)}\n\n` +
        `EPIC — ${epic.title}:\n${epic.goal}${priors}${retry}${contractsNote}${scaffoldNote}${contractBody}\n\n` +
        'Deliver ONLY this epic. All gates must pass at the end.';
      note(`▶ epic ${epic.id} (attempt ${ctx.attempt}): ${epic.title}`);
      // Grade the epic's DELIVERABLE, not the process prompt: the scoped
      // prompt carries process instructions ("read X first"), prior-epic
      // summaries, and retry feedback — none verifiable from code, so a
      // small judge rejects objectively-green turns against them forever.
      const epicSpec =
        `EPIC — ${epic.title}:\n${epic.goal}` +
        (epic.criteria?.length ? `\nAcceptance criteria:\n${epic.criteria.map((c) => `- ${c}`).join('\n')}` : '') +
        (locked.length > 0 ? `\n(Builds against locked contracts: ${locked.join(', ')})` : '') +
        (fillsScaffold ? '\n(FILL epic: no todo!()/NotImplementedError/TODO-throw stub markers may remain in the files it implements; signatures must be unchanged.)' : '') +
        (epic.scaffold ? '\n(SCAFFOLD epic: complete compiling signatures with stub bodies are the DELIVERABLE — unimplemented logic is expected and correct here.)' : '');
      deps.setEpicSpec(epicSpec);
      const epicTask = (await deps.openTask?.(`${epic.title} — ${epic.goal.slice(0, 120)}`)) ?? null;

      /** Shared tail: aggregate, record, lock bookkeeping, budget-marker summary. */
      const settle = (r: DeliveryResult): EpicRunResult => {
        foldDeliveryResult(all, r);
        deps.completeTask?.(epicTask, r);
        const files = [...new Set(r.history.flatMap((h) => h.filesApplied ?? []))];
        if (epic.contracts) lastContractEpicFiles = files;
        // Rail sizing: surface budget exhaustion to the epic controller — its
        // split path keys off the structured budgetStopped field below; the
        // marker in the summary is human-facing text, not protocol.
        const budgetHit = !r.success && r.history.some((h) => h.budgetStopped);
        return {
          success: r.success,
          turns: r.turns,
          // Structured field for the controller's split trigger; the marker
          // stays in the summary for humans (and marker-matching callers).
          ...(budgetHit ? { budgetStopped: true } : {}),
          summary:
            `${epic.goal.slice(0, 140)}${files.length ? ` [files: ${files.join(', ')}]` : ''}` +
            (budgetHit ? ` ${CONTEXT_BUDGET_MARKER} session(s) exceeded the context budget — scope is too large for one session` : ''),
        };
      };

      // Epic-path parallel dispatch: with deliver.parallelTasks > 1, an epic
      // whose goal itself decomposes runs as an orchestrated task DAG —
      // worktree-isolated parallel dispatch inside the DEFAULT (epics-on)
      // path. Only the DECOMPOSITION call is fail-soft (a miss falls through
      // to the classic single loop); a runner exception must propagate —
      // swallowing it would silently restart the epic on a partially-merged
      // tree.
      if (deps.epicParallelTasks > 1) {
        // Retry feedback must reach the decomposition (fresh tasks that fix
        // the failure) — mirroring the split path — because the
        // orchestrator's 300-char mission snippet cannot carry it into
        // every task.
        const epicPlanGoal =
          `${epic.title}: ${epic.goal}` +
          (ctx.lastFailure
            ? `\n\n(The previous attempt did not complete: ${ctx.lastFailure.slice(0, 300)}. The tasks you produce must FIX this.)`
            : '');
        let epicPlan: DeliveryPhase[] = [];
        try {
          epicPlan = await deps.planEpicTasks(epicPlanGoal);
        } catch {
          epicPlan = [];
        }
        if (epicPlan.length < 2) {
          note(`  ⇉ epic ${epic.id}: no usable task decomposition — classic single-loop epic`);
        } else {
          note(`  ⇉ epic ${epic.id}: decomposed into ${epicPlan.length} tasks — orchestrated parallel dispatch`);
          // The orchestrator's mission snippet carries the HEAD of this
          // text — lead with the epic essence, then retry + steering.
          const epicMissionText =
            `EPIC — ${epic.title}: ${epic.goal}` +
            (ctx.lastFailure ? `\nPREVIOUS ATTEMPT FEEDBACK (address this): ${ctx.lastFailure}` : '') +
            `${contractsNote}${scaffoldNote}${priors}`;
          const r = await deps.runOrchestrated(epicMissionText, epicPlan, epicTask?.id);
          // Epic-level acceptance parity: the classic path judges every
          // green turn against the EPIC spec (criteria, FILL "no stub
          // markers remain", locked contracts). Green tasks + a green
          // combined tree still must satisfy it — one judge call, BEFORE
          // settle so the task record reflects the judged outcome (a
          // rejected attempt must not leave a "done" record behind).
          let acceptanceFailure: string | null = null;
          if (r.success && deps.judgeEpic) {
            const verdict = await deps.judgeEpic(epicSpec);
            if (!verdict) {
              // Fail-open must never be invisible — the acceptance rail just
              // silently degraded to objective verdicts.
              note(`  ⚖ epic ${epic.id}: acceptance judge unavailable — objective verdicts stand`);
            } else if (!verdict.passed) {
              acceptanceFailure = (verdict.feedback ?? '').slice(0, 240);
            }
          }
          const effective: DeliveryResult = acceptanceFailure !== null
            ? { ...r, success: false, finalFeedback: `EPIC acceptance failed: ${acceptanceFailure}` }
            : r;
          const settled = settle(effective);
          if (acceptanceFailure !== null) {
            return {
              success: false,
              turns: r.turns,
              summary: `${epic.goal.slice(0, 120)} — tasks green but EPIC acceptance failed: ${acceptanceFailure}`,
            };
          }
          return settled;
        }
      }

      const r = await deps.runEpicLoop(scoped);
      return settle(r);
    },
  });

  all.success = epicResult.success;
  if (!epicResult.success) {
    all.finalFeedback = `epic controller incomplete — failed epic(s): ${epicResult.failed.join(', ')}\n${all.finalFeedback}`;
  }
  return all;
}
