/**
 * Self-Harness — cross-model transfer store (P3).
 *
 * Addresses the paper's stated limitation (fixes stay model-specific). Every
 * accepted Mod is recorded keyed by (model family, failure kind, signature) with
 * its measured delta + provenance. When a NEW model hits the same failure KIND,
 * the proposer seeds from Mods that already worked for that kind on OTHER models
 * — those still go through full validation (transfer is a prior, not a shortcut),
 * and negative results are recorded so known-bad Mods are not re-proposed.
 *
 * See docs/design/SELF_HARNESS.md §8, §11 (P3).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Mod, describeMod, validateMod } from './mods.js';
import { FailureKind, normalizeModel, WeaknessReport } from './weakness.js';
import type { Proposer } from './propose.js';
import type { HarnessProfile } from './profile.js';

export interface TransferEntry {
  /** Full (model-specific) signature the Mod was mined against. */
  signature: string;
  kind: FailureKind;
  /** Normalized model family the Mod was validated on. */
  model: string;
  mod: Mod;
  /** Measured validation correctness delta when accepted (or rejected: <=0). */
  delta: number;
  /** Whether this entry was an acceptance (true) or a recorded rejection (false). */
  accepted: boolean;
  /** ISO timestamp; provenance string (suite, n, stats). */
  validatedAt: string;
  provenance: string;
}

/** Structural identity of a Mod, for de-duplication across sources. */
export function modKey(mod: Mod): string {
  switch (mod.kind) {
    case 'env':
      return `env:${mod.key}=${mod.to}`;
    case 'scaffold':
      return `scaffold:${mod.component}:${mod.op}:${mod.text}`;
    case 'middleware':
      return `mw:${mod.id}:${JSON.stringify(mod.params)}`;
    case 'config':
      return `config:${mod.key}=${mod.to}`;
    case 'tool':
      return `tool:${mod.key}=${mod.to}`;
  }
}

export function dedupeMods(mods: Mod[]): Mod[] {
  const seen = new Set<string>();
  const out: Mod[] = [];
  for (const m of mods) {
    const k = modKey(m);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

export interface TransferQueryOptions {
  /** Exclude entries already validated on this (normalized) model family. */
  excludeModel?: string;
  /** Only entries that were ACCEPTED (positive). Default true. */
  acceptedOnly?: boolean;
}

export interface PruneOptions {
  /** Drop ACCEPTED entries whose measured delta is <= this (no longer worth
   * transferring — the ablation idea: stop carrying a Mod that stopped paying
   * off). Default 0 (keep only strictly-positive accepted). */
  minDelta?: number;
  /** Drop ANY entry older than this many days. Default 90. */
  maxAgeDays?: number;
  /** Override "now" (ms epoch) for deterministic tests. */
  now?: number;
}

export interface PruneResult {
  removed: TransferEntry[];
  kept: number;
}

export interface TransferStore {
  record(entry: TransferEntry): void;
  /** Cross-model lookup by failure kind, ranked by measured delta (desc). */
  query(kind: FailureKind, opts?: TransferQueryOptions): TransferEntry[];
  all(): TransferEntry[];
  /** Ablation-prune: drop stale / no-longer-paying-off entries. */
  prune(opts?: PruneOptions): PruneResult;
}

/** In-memory store (tests, ephemeral runs). */
export class MemoryTransferStore implements TransferStore {
  protected entries: TransferEntry[] = [];

  record(entry: TransferEntry): void {
    // Replace a prior entry for the same (model, modKey) so the latest delta wins.
    const k = `${entry.model}|${modKey(entry.mod)}`;
    this.entries = this.entries.filter((e) => `${e.model}|${modKey(e.mod)}` !== k);
    this.entries.push(entry);
  }

  query(kind: FailureKind, opts: TransferQueryOptions = {}): TransferEntry[] {
    const acceptedOnly = opts.acceptedOnly ?? true;
    const exclude = opts.excludeModel ? normalizeModel(opts.excludeModel) : null;
    return this.entries
      .filter((e) => e.kind === kind)
      .filter((e) => (acceptedOnly ? e.accepted : true))
      .filter((e) => (exclude ? normalizeModel(e.model) !== exclude : true))
      .sort((a, b) => b.delta - a.delta);
  }

  all(): TransferEntry[] {
    return [...this.entries];
  }

  prune(opts: PruneOptions = {}): PruneResult {
    const minDelta = opts.minDelta ?? 0;
    const maxAgeMs = (opts.maxAgeDays ?? 90) * 86_400_000;
    const now = opts.now ?? Date.now();
    const removed: TransferEntry[] = [];
    this.entries = this.entries.filter((e) => {
      const age = now - (Date.parse(e.validatedAt) || 0);
      const stale = age > maxAgeMs;
      const noLongerPays = e.accepted && e.delta <= minDelta;
      if (stale || noLongerPays) {
        removed.push(e);
        return false;
      }
      return true;
    });
    return { removed, kept: this.entries.length };
  }
}

/** JSON-file-backed store (persisted across runs; default under .uap/self-harness). */
export class JsonTransferStore extends MemoryTransferStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      try {
        this.entries = JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        this.entries = [];
      }
    }
  }

  override record(entry: TransferEntry): void {
    super.record(entry);
    this.persist();
  }

  override prune(opts: PruneOptions = {}): PruneResult {
    const res = super.prune(opts);
    if (res.removed.length) this.persist();
    return res;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries, null, 2), 'utf-8');
  }
}

/** Build a TransferEntry from an accepted/rejected Mod + measured delta. */
export function makeEntry(args: {
  signature: string;
  kind: FailureKind;
  model: string;
  mod: Mod;
  delta: number;
  accepted: boolean;
  validatedAt: string;
  provenance: string;
}): TransferEntry {
  return { ...args, model: args.model };
}

/** One-line description of a transfer entry, for `uap self-harness transfer` output. */
export function describeEntry(e: TransferEntry): string {
  const tag = e.accepted ? `+${e.delta.toFixed(3)}` : `rejected`;
  return `[${e.kind}] ${describeMod(e.mod)}  (${tag} on ${e.model}; ${e.provenance})`;
}

/**
 * Wrap a base proposer so it SEEDS candidates from the transfer store: for each
 * weakness, Mods that worked for the same failure kind on OTHER model families
 * are proposed first (as priors that still get fully validated), then the base
 * proposer's candidates. De-duped so a transferred Mod the base would also emit
 * isn't validated twice.
 */
export function makeTransferProposer(store: TransferStore, base: Proposer): Proposer {
  return {
    id: `transfer+${base.id}`,
    propose(weaknesses: WeaknessReport[], profile: HarnessProfile): Mod[] {
      const seeds: Mod[] = [];
      for (const w of weaknesses) {
        for (const e of store.query(w.kind, { excludeModel: w.model })) {
          if (validateMod(e.mod).ok) seeds.push(e.mod);
        }
      }
      return dedupeMods([...seeds, ...base.propose(weaknesses, profile)]);
    },
  };
}
