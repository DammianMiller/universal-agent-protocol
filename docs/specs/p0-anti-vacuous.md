# SPEC: P0 deliver hardening — anti-vacuous floor + no-op acceptance rail + autoroute default off

Exact, pre-reviewed operations. Apply VERBATIM. See
docs/plans/deliver-hardening-plan-2026-07-13.md (A2 + C1 + C2 + D2).

---

## File 1: `src/delivery/convergence-loop.ts`

### Op 1.1 — REPLACE

```ts
import type { GateRung, LadderResult, LadderOptions } from './verifier-ladder.js';
import { detectRungs, runLadder, tierOf } from './verifier-ladder.js';
```

WITH

```ts
import { execSync } from 'child_process';

import type { GateRung, LadderResult, LadderOptions } from './verifier-ladder.js';
import { detectRungs, runLadder, tierOf } from './verifier-ladder.js';
```

### Op 1.2 — REPLACE

```ts
   * applied" optimization permanently scores such turns 0%.
   */
  alwaysVerify?: boolean;
```

WITH

```ts
   * applied" optimization permanently scores such turns 0%.
   */
  alwaysVerify?: boolean;
  /**
   * Withhold acceptance until the run has actually changed the tree
   * (default true). An LLM acceptance judge must never be the only thing
   * standing between a zero-diff run and "delivered" (2026-07-13 incident:
   * a mission on a gates-green repo "delivered" after writing nothing).
   * Change detection: files the applier wrote, else a git tree fingerprint
   * (covers the direct-mutation agentic executor). Fail-closed when neither
   * signal shows a change; skipped automatically on resume (prior-session
   * turns may have written) and via --allow-noop for genuinely no-op
   * missions.
   */
  requireDiffForAcceptance?: boolean;
```

### Op 1.3 — REPLACE

```ts
  private readonly acceptanceGate?: AcceptanceGate;

  constructor(
```

WITH

```ts
  private readonly acceptanceGate?: AcceptanceGate;
  /** Every file the applier has written this run (union across turns). */
  private appliedFilesTotal = new Set<string>();
  /** Git tree fingerprint at run start; null when unavailable (non-git). */
  private runStartTreeFingerprint: string | null = null;

  constructor(
```

### Op 1.4 — REPLACE

```ts
    this.acceptanceGate = seams.acceptanceGate;
  }
```

WITH

```ts
    this.acceptanceGate = seams.acceptanceGate;
  }

  /**
   * Cheap, stable fingerprint of the working tree: porcelain status (covers
   * untracked adds/removes) + diff stat (covers content edits). Returns null
   * outside a git repo or on any git failure.
   */
  private fingerprintTree(): string | null {
    try {
      const opts = {
        cwd: this.config.projectRoot,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      } as const;
      const status = execSync('git status --porcelain=v1 --untracked-files=all', opts).toString();
      const diff = execSync('git diff HEAD --stat', opts).toString();
      return `${status}\n---\n${diff}`;
    } catch {
      return null;
    }
  }

  /**
   * Has this run changed the project tree yet? Applier-written files are
   * authoritative; the git fingerprint covers direct-mutation executors
   * (agentic write_file bypasses the applier). FAIL-CLOSED: when neither
   * signal shows a change — including when git is unavailable — the answer
   * is false. See requireDiffForAcceptance.
   */
  private hasAppliedChanges(): boolean {
    if (this.appliedFilesTotal.size > 0) return true;
    if (this.runStartTreeFingerprint !== null) {
      const now = this.fingerprintTree();
      if (now !== null) return now !== this.runStartTreeFingerprint;
    }
    return false;
  }
```

### Op 1.5 — REPLACE

```ts
  private async judgeAcceptance(ladder: LadderResult): Promise<{ ladder: LadderResult; acceptanceMet?: number }> {
    if (!this.acceptanceGate || !ladder.passed) return { ladder };
```

WITH

```ts
  private async judgeAcceptance(
    ladder: LadderResult,
    opts: { atBaseline?: boolean } = {}
  ): Promise<{ ladder: LadderResult; acceptanceMet?: number }> {
    if (!this.acceptanceGate || !ladder.passed) return { ladder };
    // Anti-no-op rail (P0, 2026-07-13): acceptance is deterministically
    // withheld until the run has changed the tree — this also stops the
    // baseline check from short-circuiting a coding mission as
    // alreadyDelivered on a gates-green repo. At baseline nothing can have
    // changed by definition. Skipped on resume (prior-session turns already
    // wrote; their changes are invisible to this process's fingerprint).
    const unchanged = opts.atBaseline ? true : !this.hasAppliedChanges();
    if ((this.config.requireDiffForAcceptance ?? true) && !this.config.resumeFrom && unchanged) {
      return {
        ladder: {
          ...ladder,
          passed: false,
          feedback:
            `${ladder.feedback}\n\nAcceptance withheld: this run has not changed any files yet — a no-op cannot be "delivered". Apply the mission's changes (or re-run with --allow-noop if no change is genuinely required).`.trim(),
        },
        acceptanceMet: 0,
      };
    }
```

### Op 1.6 — REPLACE

```ts
      const baseline = (await this.judgeAcceptance(rawBaseline)).ladder;
```

WITH

```ts
      const baseline = (await this.judgeAcceptance(rawBaseline, { atBaseline: true })).ladder;
```

### Op 1.7 — REPLACE

```ts
    // Gate-integrity snapshot, taken AFTER the baseline ladder run so files
```

WITH

```ts
    // t0 tree fingerprint for the anti-no-op acceptance rail — taken AFTER
    // the baseline ladder run so files the gates themselves create on first
    // run (e.g. snapshots, lockfiles) don't read as mission changes.
    this.runStartTreeFingerprint = this.fingerprintTree();

    // Gate-integrity snapshot, taken AFTER the baseline ladder run so files
```

### Op 1.8 — REPLACE

```ts
      const outcome = explorerSettings
        ? await this.runExplorerTurn(instruction, prompt, rungs, explorerSettings, executor, ladderRunner, applyOptions)
        : await this.runSingleTurn(prompt, rungs, executor, ladderRunner, applyOptions);

      // Acceptance: judge ONCE on this turn's committed verdict (single-turn
```

WITH

```ts
      const outcome = explorerSettings
        ? await this.runExplorerTurn(instruction, prompt, rungs, explorerSettings, executor, ladderRunner, applyOptions)
        : await this.runSingleTurn(prompt, rungs, executor, ladderRunner, applyOptions);

      // Anti-no-op rail bookkeeping: fold this turn's applier writes into the
      // run-wide union BEFORE the acceptance judge consults it.
      for (const f of outcome.filesApplied) this.appliedFilesTotal.add(f);

      // Acceptance: judge ONCE on this turn's committed verdict (single-turn
```

---

## File 2: `src/cli/deliver.ts`

### Op 2.1 — REPLACE

```ts
export function decideGateStrategy(opts: {
  hasAcceptance: boolean;
  noRealGates: boolean;
  forceSelfGate: boolean;
  selfGateAllowed: boolean;
}): { acceptancePrimary: boolean; needsSelfGate: boolean; noGatesError: boolean } {
  const acceptancePrimary = opts.hasAcceptance && opts.noRealGates && !opts.forceSelfGate;
  const needsSelfGate =
    opts.selfGateAllowed && !acceptancePrimary && (opts.noRealGates || opts.forceSelfGate);
  const noGatesError = opts.noRealGates && !needsSelfGate && !acceptancePrimary;
  return { acceptancePrimary, needsSelfGate, noGatesError };
}
```

WITH

```ts
export function decideGateStrategy(opts: {
  hasAcceptance: boolean;
  noRealGates: boolean;
  forceSelfGate: boolean;
  selfGateAllowed: boolean;
  /**
   * Anti-vacuous floor (P0, 2026-07-13): every REQUIRED project gate passed a
   * pre-run baseline probe. Gates that cannot fail are not a convergence
   * target — "delivered" must mean "something that was red is now green" —
   * so a mission self-gate is engaged exactly as if no gates were detected.
   */
  baselineAllGreen?: boolean;
}): { acceptancePrimary: boolean; needsSelfGate: boolean; noGatesError: boolean } {
  const acceptancePrimary = opts.hasAcceptance && opts.noRealGates && !opts.forceSelfGate;
  const needsSelfGate =
    opts.selfGateAllowed &&
    !acceptancePrimary &&
    (opts.noRealGates || opts.forceSelfGate || opts.baselineAllGreen === true);
  const noGatesError = opts.noRealGates && !needsSelfGate && !acceptancePrimary;
  return { acceptancePrimary, needsSelfGate, noGatesError };
}
```

### Op 2.2 — REPLACE

```ts
  epics?: boolean;
  dryRun?: boolean;
  json?: boolean;
}
```

WITH

```ts
  epics?: boolean;
  /** `--allow-noop`: permit success without any tree change (disables the
   * anti-no-op acceptance rail for missions that genuinely require none). */
  allowNoop?: boolean;
  dryRun?: boolean;
  json?: boolean;
}
```

### Op 2.3 — REPLACE

```ts
  let autoPlan: AutoPlan | undefined;
  if (options.auto !== false && process.env.UAP_DELIVER_AUTO !== '0' && !hasExplicitAidFlags(options)) {
    autoPlan = planAutoOptimization(instruction);
    applyAutoPlan(options, autoPlan);
    if (!options.dryRun) {
      console.log(chalk.cyan(`⚙ auto-optimize: ${autoPlan.summary}`));
    }
  }
```

WITH

```ts
  let autoPlan: AutoPlan | undefined;
  if (options.auto !== false && process.env.UAP_DELIVER_AUTO !== '0' && !hasExplicitAidFlags(options)) {
    autoPlan = planAutoOptimization(instruction);
    applyAutoPlan(options, autoPlan);
    if (!options.dryRun) {
      console.log(chalk.cyan(`⚙ auto-optimize: ${autoPlan.summary}`));
    }
  }
  // Verification RAILS are independent of the optimization AIDS (P0,
  // 2026-07-13): --no-auto / explicit aid flags stand down exploration,
  // critic and ideation, but must not silently drop the acceptance judge —
  // without it, a gates-green no-op run reads as delivered. When the
  // auto-planner did not run, acceptance defaults ON; opt out explicitly
  // with UAP_DELIVER_ACCEPTANCE=0.
  if (!autoPlan && options.acceptance === undefined && process.env.UAP_DELIVER_ACCEPTANCE !== '0') {
    options.acceptance = true;
    if (!options.dryRun) {
      console.log(chalk.cyan('⚖ acceptance judge on (verification rail; UAP_DELIVER_ACCEPTANCE=0 to disable)'));
    }
  }
```

### Op 2.4 — REPLACE

```ts
  const { acceptancePrimary, needsSelfGate, noGatesError } = decideGateStrategy({
    hasAcceptance: Boolean(options.acceptance),
    noRealGates,
    forceSelfGate: options.forceSelfGate === true,
    selfGateAllowed,
  });
```

WITH

```ts
  // Anti-vacuous floor (P0, 2026-07-13 incident): probe the REQUIRED rungs
  // once before choosing the convergence target. If everything is already
  // green, gate-satisfaction cannot measure this mission — a run on a
  // gates-green repo would false-green as a no-op (observed live: a 6-file
  // C++ mission "delivered" after writing nothing, because the only detected
  // gates were unrelated npm web gates). UAP_DELIVER_VACUOUS_FLOOR=0 opts out.
  let baselineAllGreen = false;
  if (
    !noRealGates &&
    options.forceSelfGate !== true &&
    selfGateAllowed &&
    process.env.UAP_DELIVER_VACUOUS_FLOOR !== '0' &&
    !options.dryRun
  ) {
    try {
      const requiredRungs = rungs.filter((r) => r.required);
      baselineAllGreen = requiredRungs.length > 0 && runLadder(requiredRungs, projectRoot).passed;
    } catch {
      baselineAllGreen = false; // probe is best-effort; never blocks a run
    }
    if (baselineAllGreen) {
      console.log(
        chalk.cyan(
          '⚖ anti-vacuous floor: all required project gates are ALREADY green — authoring a mission self-gate so success requires real, verified change'
        )
      );
    }
  }

  const { acceptancePrimary, needsSelfGate, noGatesError } = decideGateStrategy({
    hasAcceptance: Boolean(options.acceptance),
    noRealGates,
    forceSelfGate: options.forceSelfGate === true,
    selfGateAllowed,
    baselineAllGreen,
  });
```

### Op 2.5 — REPLACE

```ts
    if (sg.vacuous) {
      console.log(
        chalk.yellow(
          '  ⚠ acceptance gate may be weak (could not force an initially-failing check); running multi-turn anyway.'
        )
      );
    } else {
```

WITH

```ts
    if (sg.vacuous) {
      // P0 hard-fail: a REQUIRED self-gate that passes on the unsolved repo
      // re-opens the false-green door — "delivered" would be meaningless.
      if (process.env.UAP_DELIVER_ALLOW_WEAK_SELF_GATE !== '1') {
        fail(
          'The self-gate is REQUIRED for this run (anti-vacuous floor) but stayed vacuous after retries — it passes on the unsolved repo. Add concrete, checkable ACCEPTANCE CRITERIA to the instruction, or set UAP_DELIVER_ALLOW_WEAK_SELF_GATE=1 to accept the risk.'
        );
      }
      console.log(
        chalk.yellow(
          '  ⚠ acceptance gate may be weak (could not force an initially-failing check); UAP_DELIVER_ALLOW_WEAK_SELF_GATE=1 — running multi-turn anyway.'
        )
      );
    } else {
```

### Op 2.6 — REPLACE

```ts
    // The agentic executor mutates the repo directly (no-op applier), so
    // gates must run every turn regardless of applier file count.
    alwaysVerify: agentic ? true : undefined,
```

WITH

```ts
    // The agentic executor mutates the repo directly (no-op applier), so
    // gates must run every turn regardless of applier file count.
    alwaysVerify: agentic ? true : undefined,
    // Anti-no-op acceptance rail (P0): success requires an actual tree
    // change unless the caller explicitly allows a no-op mission.
    requireDiffForAcceptance: options.allowNoop === true ? false : undefined,
```

---

## File 3: `src/bin/cli.ts`

### Op 3.1 — REPLACE

```ts
  .option('--force-self-gate', 'Author a task-specific acceptance gate even when project gates exist')
```

WITH

```ts
  .option('--force-self-gate', 'Author a task-specific acceptance gate even when project gates exist')
  .option('--allow-noop', 'Permit delivery without any tree change (disables the anti-no-op acceptance rail for missions that genuinely require none)')
```

---

## File 4: `templates/hooks/deliver_autoroute.py`

### Op 4.1 — REPLACE

```python
def _autoroute_enabled() -> bool:
    # Default ON: a blocked source edit auto-routes into `uap deliver` in the
    # background instead of dead-ending the agent. Opt out with
    # UAP_DELIVER_AUTOROUTE=0/off/false/no.
    v = os.environ.get("UAP_DELIVER_AUTOROUTE", "on").lower()
    return v not in {"0", "off", "false", "no"}
```

WITH

```python
def _autoroute_enabled() -> bool:
    # Default OFF (P0, 2026-07-13): the auto-spawned deliver run carries only a
    # vacuous "implement the intended change to <file>" hint — the blocked
    # edit's actual content is not plumbed through yet (plan D1) — so a blind
    # background model run is spawned per blocked file. Blind fan-out mangles
    # shared worktrees; the recorded intent + block message let the agent run
    # `uap deliver` itself with the real spec. Opt IN with
    # UAP_DELIVER_AUTOROUTE=1/on/true/yes.
    v = os.environ.get("UAP_DELIVER_AUTOROUTE", "off").lower()
    return v in {"1", "on", "true", "yes"}
```

### Op 4.2 — REPLACE

```python
    intent = {"ts": int(time.time()), "tool": tool, "file_path": file_path, "hint": hint}
    spawn = bool(autoroute_on and hint and file_path and file_path not in seen_files)
    message = reason
    if spawn:
        message = reason + " [auto-routed to `uap deliver` — running in the background]"
```

WITH

```python
    intent = {"ts": int(time.time()), "tool": tool, "file_path": file_path, "hint": hint}
    spawn = bool(autoroute_on and hint and file_path and file_path not in seen_files)
    message = reason
    if spawn:
        message = reason + " [auto-routed to `uap deliver` — running in the background]"
    elif file_path:
        message = reason + (
            " [intent recorded to .uap/pending-deliver.jsonl — apply it yourself by running"
            " `uap deliver` with the exact intended change as the instruction]"
        )
```

---

END OF SPEC. After applying, `npm run build` and the vitest suites
`test/cli/acceptance-verdict.test.ts`, `test/delivery/convergence-loop.test.ts`,
and `test/hooks/deliver-autoroute-default.test.ts` MUST pass. If an anchor does
not match verbatim, STOP and report the mismatch instead of improvising.
