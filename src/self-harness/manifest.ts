/**
 * Change manifests — every harness edit is a falsifiable contract
 * (harness plan area C, 2026-07-31).
 *
 * Agentic Harness Engineering (arXiv 2604.25850) attributes a large part of its
 * Terminal-Bench 2 gain (69.7% -> 77.0%) not to smarter proposals but to
 * DECISION OBSERVABILITY: every edit is paired with a self-declared prediction
 * about which tasks it will fix and which it might break, that prediction is
 * checked against the next round's actual per-task outcomes, and edits whose
 * predictions do not materialise are reverted at file granularity.
 *
 * Without this, an accepted Mod is accepted forever on the strength of one
 * noisy A/B. With it, acceptance is provisional and the loop can un-learn.
 *
 * Everything here is pure except the JSON store at the bottom, so the
 * attribution rules are unit-testable without a bench run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunRecord } from '../benchmarks/paired/types.js';
import { Mod, describeMod, invertMod } from './mods.js';

/** A prediction recorded at the moment a Mod is applied. */
export interface ChangeManifest {
  /** Stable id — `modKey`-derived by the caller, or any unique string. */
  id: string;
  mod: Mod;
  /** ISO timestamp. Injected, never `Date.now()`, so runs stay reproducible. */
  createdAt: string;
  /** Task ids this edit claims it will turn from failing to passing. */
  predictedFixes: string[];
  /** Task ids this edit admits it might break. Declaring them is not a free pass. */
  predictedRisks: string[];
  /**
   * Files/knobs the edit touched, for a file-granular revert. For an env Mod
   * this is the env file; for scaffold/middleware, the component id.
   */
  touched: string[];
  /** Human-readable summary, for logs and the pending queue. */
  summary: string;
}

export interface ManifestAttribution {
  manifestId: string;
  /** Predicted fixes that actually flipped fail -> pass. */
  fixesRealised: string[];
  /** Predicted fixes that did not flip. The falsification. */
  fixesMissed: string[];
  /** Predicted risks that did break (declared, so not a surprise). */
  risksRealised: string[];
  /** Tasks that regressed WITHOUT being declared. The expensive kind. */
  unpredictedRegressions: string[];
  /** Net task delta across the whole suite (passes gained minus lost). */
  netDelta: number;
}

export type ManifestVerdict = 'keep' | 'revert';

export interface ManifestDecision {
  verdict: ManifestVerdict;
  reason: string;
  /** The Mod to apply to undo this change, when the verdict is 'revert'. */
  revert?: Mod;
}

/**
 * Task ids that passed, from one CONDITION's records.
 *
 * Scoping to a condition is essential, not tidiness: a real `records.jsonl` from
 * the paired bench holds BOTH arms, so a task the treatment solves and the
 * baseline fails would read as "not passing" in every round, every predicted fix
 * would look unrealised, and `revertOnZeroRealised` would revert every change
 * the loop ever made.
 *
 * `passRatio` is the flakiness bar. Requiring a clean sweep sounds strict but on
 * a stochastic local model it means a task lifted from 1/5 to 4/5 seeds — a real
 * improvement — scores as no fix at all. Default 0.6: pass the majority of seeds.
 */
function passingTasks(records: RunRecord[], condition?: string, passRatio = 0.6): Set<string> {
  const seen = new Map<string, { pass: number; total: number }>();
  for (const r of records) {
    if (condition && r.condition !== condition) continue;
    const acc = seen.get(r.taskId) ?? { pass: 0, total: 0 };
    acc.total++;
    if (r.metrics.correct) acc.pass++;
    seen.set(r.taskId, acc);
  }
  const passed = new Set<string>();
  for (const [taskId, acc] of seen) {
    if (acc.total > 0 && acc.pass / acc.total >= passRatio) passed.add(taskId);
  }
  return passed;
}

/** The condition to attribute against when the caller does not name one. */
function inferCondition(records: RunRecord[]): string | undefined {
  const labels = new Set(records.map((r) => r.condition));
  // One arm: unambiguous. Several: prefer the shipping surface, else give up and
  // let the caller name it rather than silently mixing arms.
  if (labels.size === 1) return [...labels][0];
  for (const preferred of ['uap-full', 'candidate', 'with-mod']) {
    if (labels.has(preferred)) return preferred;
  }
  return undefined;
}

/**
 * Check a manifest's prediction against what actually happened.
 *
 * `before` and `after` are the record sets from the round the edit was made and
 * the round after it.
 */
export function attributeManifest(
  manifest: ChangeManifest,
  before: RunRecord[],
  after: RunRecord[],
  opts: { condition?: string; passRatio?: number } = {},
): ManifestAttribution {
  const condition = opts.condition ?? inferCondition(after) ?? inferCondition(before);
  const passedBefore = passingTasks(before, condition, opts.passRatio);
  const passedAfter = passingTasks(after, condition, opts.passRatio);
  // INTERSECTION, not union. A task present in `before` and absent from `after`
  // (suite edited, run aborted, sampled subset, adapter crash) is not a
  // regression — absence is not failure — but a union scored it as one and
  // triggered an immediate revert.
  const beforeIds = new Set(
    before.filter((r) => !condition || r.condition === condition).map((r) => r.taskId),
  );
  const afterIds = new Set(
    after.filter((r) => !condition || r.condition === condition).map((r) => r.taskId),
  );
  const allTasks = new Set<string>([...beforeIds].filter((t) => afterIds.has(t)));

  const fixesRealised: string[] = [];
  const fixesMissed: string[] = [];
  for (const t of manifest.predictedFixes) {
    // A predicted fix for a task that did not run again is unproven, not missed —
    // counting it as missed would revert the change on an incomplete round.
    if (!afterIds.has(t)) continue;
    if (!passedBefore.has(t) && passedAfter.has(t)) fixesRealised.push(t);
    else fixesMissed.push(t);
  }

  const risky = new Set(manifest.predictedRisks);
  const risksRealised: string[] = [];
  const unpredictedRegressions: string[] = [];
  let gained = 0;
  let lost = 0;
  for (const t of allTasks) {
    const wasPassing = passedBefore.has(t);
    const isPassing = passedAfter.has(t);
    if (!wasPassing && isPassing) gained++;
    if (wasPassing && !isPassing) {
      lost++;
      if (risky.has(t)) risksRealised.push(t);
      else unpredictedRegressions.push(t);
    }
  }

  return {
    manifestId: manifest.id,
    fixesRealised,
    fixesMissed,
    risksRealised,
    unpredictedRegressions,
    netDelta: gained - lost,
  };
}

export interface ManifestPolicyOptions {
  /**
   * Revert when an edit predicted fixes and delivered NONE of them, even if the
   * net delta is neutral. Default true — an edit that did not do what it claimed
   * is unexplained behaviour in the harness, and unexplained changes accumulate.
   */
  revertOnZeroRealised?: boolean;
  /**
   * Tolerated undeclared regressions before an automatic revert. Default 0: the
   * whole point of declaring risks is that undeclared breakage is not tolerated.
   */
  maxUnpredictedRegressions?: number;
}

/**
 * Decide whether a change survives its own prediction.
 *
 * Order matters — undeclared regressions are checked FIRST, because an edit that
 * broke something nobody predicted is disqualified regardless of what else it
 * happened to fix.
 */
export function decideManifest(
  manifest: ChangeManifest,
  attribution: ManifestAttribution,
  opts: ManifestPolicyOptions = {},
): ManifestDecision {
  const maxUnpredicted = opts.maxUnpredictedRegressions ?? 0;
  const revertOnZero = opts.revertOnZeroRealised ?? true;

  if (attribution.unpredictedRegressions.length > maxUnpredicted) {
    return {
      verdict: 'revert',
      reason:
        `${attribution.unpredictedRegressions.length} undeclared regression(s) ` +
        `(${attribution.unpredictedRegressions.slice(0, 5).join(', ')}) — ` +
        `the manifest did not declare them.`,
      revert: invertMod(manifest.mod),
    };
  }

  if (attribution.netDelta < 0) {
    return {
      verdict: 'revert',
      reason: `net task delta ${attribution.netDelta} — the change costs more than it wins.`,
      revert: invertMod(manifest.mod),
    };
  }

  // Gate on what was actually OBSERVED this round (realised + missed), not on
  // what was predicted: if none of the predicted tasks re-ran, there is no
  // evidence either way and reverting would punish an incomplete round.
  const observed = attribution.fixesRealised.length + attribution.fixesMissed.length;
  if (revertOnZero && observed > 0 && attribution.fixesRealised.length === 0) {
    return {
      verdict: 'revert',
      reason:
        `predicted ${manifest.predictedFixes.length} fix(es), realised none — ` +
        `the edit did not do what it claimed.`,
      revert: invertMod(manifest.mod),
    };
  }

  return {
    verdict: 'keep',
    reason:
      `realised ${attribution.fixesRealised.length}/${manifest.predictedFixes.length} predicted fix(es), ` +
      `net delta ${attribution.netDelta}, no undeclared regressions.`,
  };
}

/** Build a manifest for a Mod. `now` is injected so runs stay reproducible. */
export function makeManifest(params: {
  id: string;
  mod: Mod;
  now: string;
  predictedFixes?: string[];
  predictedRisks?: string[];
  touched?: string[];
}): ChangeManifest {
  return {
    id: params.id,
    mod: params.mod,
    createdAt: params.now,
    predictedFixes: params.predictedFixes ?? [],
    predictedRisks: params.predictedRisks ?? [],
    touched: params.touched ?? defaultTouched(params.mod),
    summary: describeMod(params.mod),
  };
}

/** The file/knob a Mod edits — the granularity a revert operates at. */
export function defaultTouched(mod: Mod): string[] {
  switch (mod.kind) {
    case 'env':
      return [`env:${mod.key}`];
    case 'scaffold':
      return [`scaffold:${mod.component}`];
    case 'middleware':
      return [`middleware:${mod.id}`];
    case 'config':
      return [`config:${mod.key}`];
    case 'tool':
      return [`tool:${mod.key}`];
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface StoreShape {
  open: ChangeManifest[];
  closed: Array<{ manifest: ChangeManifest; attribution: ManifestAttribution; decision: ManifestDecision }>;
}

const EMPTY_STORE: StoreShape = { open: [], closed: [] };

/**
 * JSON-backed manifest store under `.uap/self-harness/manifests.json`.
 *
 * Deliberately a plain file, not SQLite: manifests are few, human-auditable, and
 * an operator inspecting why the loop reverted its own change should be able to
 * read them without a client.
 */
export class ManifestStore {
  private readonly path: string;
  private data: StoreShape;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, '.uap', 'self-harness', 'manifests.json');
    this.data = this.load();
  }

  private load(): StoreShape {
    try {
      if (!existsSync(this.path)) return { ...EMPTY_STORE, open: [], closed: [] };
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<StoreShape>;
      return { open: parsed.open ?? [], closed: parsed.closed ?? [] };
    } catch {
      // A corrupt store must not wedge the loop; start clean and keep going.
      return { open: [], closed: [] };
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf-8');
    } catch {
      /* best-effort */
    }
  }

  /** Manifests awaiting next-round attribution. */
  open(): ChangeManifest[] {
    return [...this.data.open];
  }

  record(manifest: ChangeManifest): void {
    this.data.open = this.data.open.filter((m) => m.id !== manifest.id);
    this.data.open.push(manifest);
    this.persist();
  }

  /** Move a manifest to the closed log with its verdict. */
  close(
    manifest: ChangeManifest,
    attribution: ManifestAttribution,
    decision: ManifestDecision,
  ): void {
    this.data.open = this.data.open.filter((m) => m.id !== manifest.id);
    this.data.closed.push({ manifest, attribution, decision });
    this.persist();
  }

  closed(): StoreShape['closed'] {
    return [...this.data.closed];
  }
}
