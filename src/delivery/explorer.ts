/**
 * Explorer — best-of-N candidate exploration (Phase 2)
 *
 * Instead of committing to a single attempt per turn, the explorer:
 *  1. generates N candidates concurrently, each steered by a distinct
 *     strategy seed (diversity by prompt, not temperature — small-model
 *     profiles pin temperature low for stability)
 *  2. evaluates each candidate against the real gates on the same baseline
 *     tree via apply → verify → rollback
 *  3. ranks objectively (gates passed, then score); a judge tie-breaks
 *     candidates tied at the top
 *  4. commits only the winner to the tree
 *
 * Candidate verification is sequential by design: gates (npm test, builds)
 * cannot safely run concurrently in one tree. Worktree-isolated parallel
 * verification is a planned optimization (inject via `revertibleApplier` +
 * a per-candidate workspace), not a Phase 2 requirement.
 *
 * Fairness caveat: rollback reverts files the model wrote, but gate commands
 * also mutate the tree (dist/ output, snapshots, caches). Candidate N+1 may
 * therefore see candidate N's gate side effects. The committed winner is
 * re-verified after commit so its reported ladder reflects real on-disk
 * state. Full per-candidate isolation requires the workspace seam above.
 */

import type { GateRung, LadderResult, LadderOptions } from './verifier-ladder.js';
import { runLadder } from './verifier-ladder.js';
import type { LadderRunner, LoopExecutor } from './convergence-loop.js';
import { applyFileBlocks, applyFileBlocksWithRollback } from './applier.js';
import type { Applier, ApplyResult, RevertibleApply } from './applier.js';
import type { Judge } from './judge.js';

/** Hard ceiling on candidates per turn — guards direct library callers
 * (the CLI caps lower); each candidate costs a model call + a full gate run. */
export const MAX_CANDIDATES = 8;

export interface StrategySeed {
  id: string;
  hint: string;
}

export const DEFAULT_STRATEGY_SEEDS: StrategySeed[] = [
  {
    id: 'direct',
    hint: 'STRATEGY: Make the most direct, minimal change that satisfies the task. Touch as few files as possible.',
  },
  {
    id: 'test-first',
    hint: 'STRATEGY: Reason from the failing gates first. Identify exactly what the gates check, then implement precisely that.',
  },
  {
    id: 'defensive',
    hint: 'STRATEGY: Implement with rigorous edge-case handling — empty inputs, wrong types, boundary values.',
  },
  {
    id: 'rewrite',
    hint: 'STRATEGY: Re-derive the solution from scratch rather than patching the previous attempt.',
  },
];

export interface CandidateResult {
  id: string;
  strategy: string;
  output: string;
  applyResult: ApplyResult | null;
  ladder: LadderResult | null;
  /** Executor failure for this candidate, if any */
  error?: string;
  passed: boolean;
  score: number;
}

export interface ExplorationResult {
  winner: CandidateResult | null;
  candidates: CandidateResult[];
  /** Judge rationale when a tie-break occurred */
  judgeRationale?: string;
  /** Ladder result of the committed winner (from its evaluation run) */
  ladder: LadderResult | null;
}

export interface ExplorerConfig {
  /** Number of candidates per turn (default 3) */
  candidates?: number;
  seeds?: StrategySeed[];
  judge?: Judge;
  projectRoot: string;
  rungs: GateRung[];
  ladderOptions?: LadderOptions;
  ladderRunner?: LadderRunner;
  /** Override the commit applier (defaults to applyFileBlocks) */
  applier?: Applier;
  /** Override the per-candidate revertible applier (defaults to applyFileBlocksWithRollback) */
  revertibleApplier?: (output: string, projectRoot: string) => RevertibleApply;
  onCandidate?: (candidate: CandidateResult) => void;
}

const DEFAULT_CANDIDATES = 3;

/**
 * Generate, evaluate, and commit the best candidate for one loop turn.
 * The base prompt comes from the loop's prompt builder; each candidate
 * appends its strategy seed.
 */
export async function exploreAndCommit(
  task: string,
  basePrompt: string,
  executor: LoopExecutor,
  config: ExplorerConfig
): Promise<ExplorationResult> {
  const count = Math.min(MAX_CANDIDATES, Math.max(1, config.candidates ?? DEFAULT_CANDIDATES));
  const seeds = config.seeds && config.seeds.length > 0 ? config.seeds : DEFAULT_STRATEGY_SEEDS;
  const ladderRunner = config.ladderRunner ?? runLadder;
  const apply = config.applier ?? applyFileBlocks;
  const applyRevertible = config.revertibleApplier ?? applyFileBlocksWithRollback;

  // 1. Generate all candidates concurrently (model calls parallelize fine)
  const generations = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const seed = seeds[i % seeds.length];
      const prompt = `${basePrompt}\n\n${seed.hint}`;
      try {
        return { seed, output: await executor(prompt), error: undefined };
      } catch (err) {
        return { seed, output: '', error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  // 2. Evaluate sequentially on the same baseline via apply → verify → rollback
  const candidates: CandidateResult[] = [];
  for (let i = 0; i < generations.length; i++) {
    const { seed, output, error } = generations[i];
    const id = `c${i + 1}`;

    if (error) {
      const candidate: CandidateResult = {
        id,
        strategy: seed.id,
        output: '',
        applyResult: null,
        ladder: null,
        error,
        passed: false,
        score: 0,
      };
      candidates.push(candidate);
      config.onCandidate?.(candidate);
      continue;
    }

    const { result: applyResult, restore } = applyRevertible(output, config.projectRoot);
    let ladder: LadderResult | null = null;
    try {
      if (!applyResult.error && applyResult.filesWritten.length > 0) {
        ladder = await ladderRunner(config.rungs, config.projectRoot, config.ladderOptions);
      }
    } finally {
      restore();
    }

    const candidate: CandidateResult = {
      id,
      strategy: seed.id,
      output,
      applyResult,
      ladder,
      passed: ladder?.passed ?? false,
      score: ladder?.score ?? 0,
    };
    candidates.push(candidate);
    config.onCandidate?.(candidate);
  }

  // Only candidates that wrote files and reached a real ladder run are
  // committable; anything else (executor error, no/rejected blocks) cannot
  // win regardless of its zero score.
  const committable = (c: CandidateResult): boolean =>
    c.ladder !== null && (c.applyResult?.filesWritten.length ?? 0) > 0;

  // 3. Rank by evaluation tier, then pass/score. A committable candidate
  //    always outranks a non-committable one (fixes error candidates with
  //    score 0 tying with evaluated candidates that scored 0).
  const ranked = [...candidates].sort((a, b) => {
    const ca = committable(a);
    const cb = committable(b);
    if (ca !== cb) return ca ? -1 : 1;
    if (a.passed !== b.passed) return a.passed ? -1 : 1;
    return b.score - a.score;
  });

  const top = ranked[0];
  if (!top || !committable(top)) {
    return { winner: null, candidates, ladder: null };
  }

  // Judge tie-break among committable candidates tied with the top result
  let winner = top;
  let judgeRationale: string | undefined;
  const tied = ranked.filter(
    (c) => committable(c) && c.passed === top.passed && c.score === top.score
  );
  if (tied.length > 1 && config.judge) {
    try {
      const verdict = await config.judge(
        task,
        tied.map((c) => ({
          id: c.id,
          strategy: c.strategy,
          output: c.output,
          ladderFeedback: c.ladder?.feedback ?? '',
          score: c.score,
        }))
      );
      const chosen = tied.find((c) => c.id === verdict.winnerId);
      if (chosen) {
        winner = chosen;
        judgeRationale = verdict.rationale;
      }
    } catch {
      // Judge is a public seam; a throwing judge falls back to objective top.
    }
  }

  // 4. Commit the winner by re-applying. Re-verify the committed tree so the
  //    reported ladder reflects on-disk state (losers' gate side effects may
  //    have perturbed it between the winner's evaluation and now).
  const committed = await apply(winner.output, config.projectRoot);
  let finalLadder = winner.ladder;
  if (committed.filesWritten.length > 0) {
    finalLadder = await ladderRunner(config.rungs, config.projectRoot, config.ladderOptions);
  }

  return { winner: { ...winner, ladder: finalLadder }, candidates, judgeRationale, ladder: finalLadder };
}
