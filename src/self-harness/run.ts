/**
 * Self-Harness — the autonomous run loop + versioned-profile persistence.
 *
 * `runSelfHarnessLoop` is the testable core behind `uap self-harness run`: it runs
 * one orchestrator iteration (mine -> propose -> validate -> decide), and — only
 * when `apply` is set — physically commits the accepted `env` Mods to the env
 * file, restarts the inference server once, and persists a *versioned profile
 * snapshot* + an append-only history log so every change is auditable and
 * revertible (design §4, §10). Without `apply` it is a pure dry-run: it reports
 * what it would accept and persists nothing.
 *
 * The `validate` dependency is injected (the real one is `buildValidator` in
 * validate.ts), so this loop is exercisable end-to-end without a live server.
 *
 * See docs/design/SELF_HARNESS.md §7, §10, §11.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { RunRecord } from '../benchmarks/paired/types.js';
import { Mod, describeMod } from './mods.js';
import { runIteration, type IterationResult, type Validator } from './orchestrator.js';
import {
  HarnessProfile,
  applyEnvModToFile,
  loadProfileSnapshot,
  saveProfileSnapshot,
  type ProfileSnapshot,
} from './profile.js';
import type { Proposer } from './propose.js';
import type { DecisionOptions } from './decide.js';
import type { TransferStore } from './transfer.js';

export interface RunLoopDeps {
  model: string;
  /** Baseline records to mine for weaknesses (e.g. a prior paired bench). */
  records: RunRecord[];
  /** Current in-effect harness profile (from the env file or a prior snapshot). */
  profile: HarnessProfile;
  /** Injected validator (real one runs the paired bench per Mod). */
  validate: Validator;
  proposer?: Proposer;
  maxCandidates?: number;
  decision?: DecisionOptions;
  transferStore?: TransferStore;
  log?: (msg: string) => void;
  /** Stable ISO timestamp (Date is unavailable in some hosts; caller supplies). */
  now: string;
  /**
   * When true, physically apply accepted env Mods to `envPath`, restart the
   * server, and persist the snapshot/history. When false (default), dry-run.
   */
  apply: boolean;
  /** Env file the accepted env Mods are committed to (required when apply+env). */
  envPath?: string;
  /** Versioned profile snapshot JSON path (persisted on a committing run). */
  snapshotPath?: string;
  /** Append-only history JSONL path (one line per committing iteration). */
  historyPath?: string;
  /** Restart the inference server once after committing env Mods. */
  restart?: () => Promise<void>;
  /** Provenance string stamped on transfer-store + history entries. */
  provenance?: string;
}

export interface RunLoopResult {
  iteration: IterationResult;
  /** Accepted Mods that were physically committed (empty on a dry-run). */
  committed: Mod[];
  /** True iff a snapshot/history was written (apply + at least one acceptance). */
  persisted: boolean;
  snapshot: ProfileSnapshot | null;
}

/** One append-only history record; mirrors the snapshot for audit/bisect. */
export interface HistoryEntry {
  at: string;
  model: string;
  version: number;
  accepted: string[];
  provenance: string;
}

export async function runSelfHarnessLoop(deps: RunLoopDeps): Promise<RunLoopResult> {
  const log = deps.log ?? (() => {});
  const iteration = await runIteration({
    model: deps.model,
    records: deps.records,
    profile: deps.profile,
    validate: deps.validate,
    proposer: deps.proposer,
    maxCandidates: deps.maxCandidates,
    decision: deps.decision,
    transferStore: deps.transferStore,
    validatedAt: deps.now,
    provenance: deps.provenance,
    log,
  });

  const accepted = iteration.accepted;
  if (!deps.apply || accepted.length === 0) {
    if (!deps.apply && accepted.length > 0) {
      log(`dry-run: ${accepted.length} Mod(s) would be committed — pass --apply to persist`);
    }
    return { iteration, committed: [], persisted: false, snapshot: null };
  }

  // --- Commit: physically apply accepted env Mods, restart, persist. ---
  const envMods = accepted.filter((m): m is Extract<Mod, { kind: 'env' }> => m.kind === 'env');
  if (envMods.length > 0) {
    if (!deps.envPath) throw new Error('runSelfHarnessLoop: apply set with env Mods but no envPath');
    for (const mod of envMods) {
      applyEnvModToFile(deps.envPath, mod);
      log(`committed: ${describeMod(mod)} -> ${deps.envPath}`);
    }
    if (deps.restart) await deps.restart();
  }

  const prev = deps.snapshotPath ? loadProfileSnapshot(deps.snapshotPath) : null;
  const version = (prev?.version ?? 0) + 1;
  const snapshot: ProfileSnapshot = {
    version,
    updatedAt: deps.now,
    model: deps.model,
    profile: iteration.profile,
    accepted: accepted.map(describeMod),
    provenance: deps.provenance ?? 'self-harness run',
  };

  if (deps.snapshotPath) {
    saveProfileSnapshot(deps.snapshotPath, snapshot);
    log(`profile snapshot v${version} -> ${deps.snapshotPath}`);
  }
  if (deps.historyPath) {
    const entry: HistoryEntry = {
      at: deps.now,
      model: deps.model,
      version,
      accepted: snapshot.accepted,
      provenance: snapshot.provenance,
    };
    mkdirSync(dirname(deps.historyPath), { recursive: true });
    appendFileSync(deps.historyPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  return { iteration, committed: accepted, persisted: true, snapshot };
}
