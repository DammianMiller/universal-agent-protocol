/**
 * Gate Evidence (uplift 1.4) — binds a deliver mission's gate outcomes to the
 * exact commit they prove.
 *
 * A deliver mission ends with its gates green against some HEAD; that HEAD is
 * the merge candidate a later ship action (git push / gh pr create/merge) will
 * publish. This module records that pairing as
 * `.uap/evidence/<candidateSha>.json` so the `evidence-bound-ship` enforcer can
 * require, at ship time, proof that the gates passed for THIS commit — not for
 * some earlier or later tree. Stale, missing, malformed, or SHA-mismatched
 * evidence is rejected by the enforcer (fail closed).
 *
 * The artifact lives under `.uap/evidence/`, which enforcement-self-protect
 * lists as a PROTECTED_TARGET with no agent carve-out (including
 * interpreter-mediated writes): the deliver CLI (this module) writes it, an
 * agent shell cannot. `.uap/` itself is git-ignored, so evidence is a local
 * record, never committed payload.
 *
 * Writes are atomic (tmp + rename). The writer validates loudly — an
 * unresolvable HEAD, a DIRTY TREE (the gates provably ran against something
 * other than HEAD), or a malformed gate all throw; the deliver seam wraps the
 * call fail-soft so evidence emission can never break a mission.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { GateRung, RungResult } from './verifier-ladder.js';

/** One gate's outcome, as recorded in the evidence artifact. */
export interface GateOutcome {
  /** Gate name, e.g. 'build', 'npm test' (bounded). */
  name: string;
  /** The exact command that ran, e.g. 'npm run build' (bounded). */
  command: string;
  /** Process exit code; 0 is the only passing value the enforcer accepts. */
  exitCode: number;
  /** Bounded tail of combined output (last OUTPUT_TAIL_MAX chars). */
  outputTail: string;
  /**
   * ISO-8601 time the gate finished. Reconstructed from rung durations
   * relative to the recording time (gates run back-to-back inside one ladder
   * pass), NOT a measured wall-clock per gate — treat as approximate.
   */
  at: string;
}

/** The on-disk evidence artifact schema (version 1). */
export interface GateEvidence {
  version: 1;
  /** Full commit SHA the gates prove — the merge candidate. */
  candidateSha: string;
  /** ISO-8601 time the evidence was recorded. */
  recordedAt: string;
  /** Deliver run id, when emitted from a deliver mission. */
  runId?: string;
  /**
   * Gate-affecting env hatches (KNOWN_GATE_HATCHES) that were SET when the
   * evidence was recorded. Audit value only — the enforcer does not act on it,
   * but a reviewer reading the artifact can see the gates ran with e.g. the
   * quality gate disabled.
   */
  hatches: string[];
  gates: GateOutcome[];
}

/** Per-gate output tail bound (last-N characters). */
export const OUTPUT_TAIL_MAX = 2000;
/** Field bounds so a pathological gate cannot mint an unbounded artifact. */
export const NAME_MAX = 200;
export const COMMAND_MAX = 500;
/** A mission never legitimately runs more gates than this. */
export const MAX_GATES = 100;

/**
 * Environment variables that weaken or bypass a gate. Mirrors
 * enforcement_self_protect.BYPASS_PATTERNS plus the documented per-gate
 * hatches; recorded into the artifact (when set) for audit. Keep in sync with
 * the enforcer list.
 */
export const KNOWN_GATE_HATCHES = [
  'UAP_DELIVER_BYPASS',
  'UAP_ENFORCE_DELIVERY',
  'UAP_SELF_PROTECT_OFF',
  'UAP_NO_WORKTREE',
  'UAP_WORKDIR_SCOPE_OFF',
  'UAP_INFRA_PROTECT_OFF',
  'UAP_NO_REVIEW',
  'UAP_EVIDENCE_GATE_OFF',
  'UAP_EVIDENCE_MAX_AGE_HOURS',
  'UAP_QUALITY_GATE_OFF',
  'UAP_USER_VALIDATION',
  'UAP_DELIVER_NO_LOCK',
  'UAP_ALLOW_GATELESS_ROOT',
  'UAP_ORACLE_CONSISTENCY',
  'UAP_SCHEMA_DIFF_INLINE',
  'UAP_VISUAL_GATE_OFF',
  'UAP_DESIGN_GATE_OFF',
] as const;

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // sha1 (40) or sha256 (64)

/** git exports repo-context vars into hook environments; strip them so the
 * git calls below resolve against `projectDir`, never a hook's repo. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(projectDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5000,
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Resolve and validate the candidate SHA for `projectDir`.
 *
 * Throws (fails loudly) when HEAD cannot be resolved — not a repo, unborn
 * branch, git missing — or when git answers with something that is not a
 * commit SHA. Evidence written against a guessed SHA would prove nothing, so
 * there is no silent fallback here.
 */
export function resolveCandidateSha(projectDir: string): string {
  const out = git(projectDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!SHA_RE.test(out)) {
    throw new Error(`gate-evidence: git rev-parse returned a non-SHA: ${JSON.stringify(out.slice(0, 120))}`);
  }
  return out;
}

/**
 * Require the working tree to be CLEAN before evidence binds HEAD.
 *
 * Evidence claims "the gates passed for commit <sha>". If the tree carries
 * uncommitted changes, the gates actually ran against HEAD-plus-delta and the
 * claim is unprovable — the delta could be anything. The deliver flow this
 * supports is therefore: commit the candidate, run `uap deliver` (baseline
 * check goes green as alreadyDelivered), ship.
 *
 * `.uap/` is git-ignored, so the evidence write itself cannot dirty the tree
 * — but the check runs BEFORE the write regardless.
 *
 * Throws with the offending porcelain lines when the tree is dirty.
 */
export function assertCleanTree(projectDir: string): void {
  const status = git(projectDir, ['status', '--porcelain']);
  if (status !== '') {
    const sample = status.split('\n').slice(0, 10).join('; ');
    throw new Error(
      `gate-evidence: refusing to bind HEAD with a dirty working tree — the gates ran ` +
        `against uncommitted changes, which the artifact cannot prove (${sample}). ` +
        'Commit the candidate first, then record evidence.'
    );
  }
}

/** Names of KNOWN_GATE_HATCHES set to a non-empty value right now. */
export function activeGateHatches(env: NodeJS.ProcessEnv = process.env): string[] {
  return KNOWN_GATE_HATCHES.filter((name) => {
    const v = env[name];
    return typeof v === 'string' && v !== '';
  }).sort();
}

/** Bound and validate one gate outcome; throws on a malformed entry. */
function normalizeGate(g: GateOutcome, index: number): GateOutcome {
  if (!g || typeof g !== 'object') {
    throw new Error(`gate-evidence: gate[${index}] is not an object`);
  }
  if (typeof g.name !== 'string' || g.name.trim() === '') {
    throw new Error(`gate-evidence: gate[${index}] has no name`);
  }
  if (typeof g.command !== 'string' || g.command.trim() === '') {
    throw new Error(`gate-evidence: gate[${index}] (${g.name}) has no command`);
  }
  if (!Number.isInteger(g.exitCode)) {
    throw new Error(`gate-evidence: gate[${index}] (${g.name}) has a non-integer exitCode`);
  }
  if (typeof g.at !== 'string' || Number.isNaN(Date.parse(g.at))) {
    throw new Error(`gate-evidence: gate[${index}] (${g.name}) has an unparseable timestamp`);
  }
  const tail = typeof g.outputTail === 'string' ? g.outputTail : '';
  return {
    name: g.name.slice(0, NAME_MAX),
    command: g.command.slice(0, COMMAND_MAX),
    exitCode: g.exitCode,
    // Keep the SUFFIX: a rung's verdict line is at the end of its output.
    outputTail: tail.slice(-OUTPUT_TAIL_MAX),
    at: new Date(g.at).toISOString(),
  };
}

/** Path of the evidence artifact for one candidate SHA. */
export function gateEvidencePath(projectDir: string, sha: string): string {
  return join(projectDir, '.uap', 'evidence', `${sha}.json`);
}

/** The slice of a DeliveryResult the evidence builder reads. */
export interface GateEvidenceSource {
  history: ReadonlyArray<{ passed: boolean; gateResults: ReadonlyArray<RungResult> }>;
  /** Baseline ladder results when the run short-circuited as alreadyDelivered
   * (history is empty then — without this the evidence path dead-ends on the
   * exact flow that must work: commit → deliver → ship). */
  baselineGates?: ReadonlyArray<RungResult>;
}

/**
 * Build the evidence gate list from a mission result.
 *
 * Source precedence: the LAST passing iteration (findLast semantics — evidence
 * must describe the final passing tree, not an early pass the loop later
 * regressed and repaired), else the baseline ladder run (alreadyDelivered),
 * else an empty list (recordGateEvidence then refuses — zero gates prove
 * nothing).
 *
 * Per-gate `at` is reconstructed: rungs carry durations but no wall-clock
 * finish time, and they run back-to-back inside one ladder pass, so gate i's
 * finish ≈ recordedAt − (durations of the gates after it). Approximate —
 * honest ordering, not honest wall-clock.
 */
export function gateOutcomesFromResult(
  source: GateEvidenceSource,
  rungs: ReadonlyArray<Pick<GateRung, 'id' | 'command' | 'args'>>,
  recordedAt: Date = new Date()
): GateOutcome[] {
  let results: ReadonlyArray<RungResult> | undefined;
  for (let i = source.history.length - 1; i >= 0; i--) {
    const rec = source.history[i];
    if (rec.passed && rec.gateResults.length > 0) {
      results = rec.gateResults;
      break;
    }
  }
  results ??= source.baselineGates;
  if (!results) return [];

  const rungById = new Map(rungs.map((r) => [r.id, r]));
  const ran = results.filter(
    (r): r is RungResult & { exitCode: number } => !r.skipped && r.exitCode !== null
  );
  const base = recordedAt.getTime();
  const outcomes: GateOutcome[] = new Array(ran.length);
  let suffixMs = 0;
  for (let i = ran.length - 1; i >= 0; i--) {
    const r = ran[i];
    const rung = rungById.get(r.id);
    outcomes[i] = {
      name: r.name,
      // The exact command when the rung is still resolvable; the gate name
      // otherwise (redetected mid-loop rungs may not be in scope).
      command: rung ? [rung.command, ...rung.args].join(' ') : r.name,
      exitCode: r.exitCode,
      outputTail: r.outputTail,
      at: new Date(base - suffixMs).toISOString(),
    };
    suffixMs += r.durationMs;
  }
  return outcomes;
}

/**
 * Record gate evidence for the current HEAD of `projectDir`.
 *
 * @param projectDir working tree whose HEAD is the merge candidate
 * @param gates      outcomes of the mission's gates (must be non-empty)
 * @param opts.runId deliver run id to attribute the evidence to
 * @returns the evidence artifact path
 * @throws on an unresolvable/invalid HEAD, a DIRTY tree, a malformed gate, or
 *         an empty list — the caller decides whether that is fatal (the
 *         deliver seam wraps this fail-soft; the enforcer consumes only
 *         well-formed artifacts).
 */
export function recordGateEvidence(
  projectDir: string,
  gates: GateOutcome[],
  opts: { runId?: string } = {}
): string {
  const sha = resolveCandidateSha(projectDir);
  // BEFORE any write: evidence must bind exactly what the gates saw.
  assertCleanTree(projectDir);
  if (!Array.isArray(gates) || gates.length === 0) {
    throw new Error('gate-evidence: refusing to record an artifact with zero gates — it would prove nothing');
  }
  const bounded = gates.slice(0, MAX_GATES).map(normalizeGate);
  const evidence: GateEvidence = {
    version: 1,
    candidateSha: sha,
    recordedAt: new Date().toISOString(),
    ...(opts.runId ? { runId: opts.runId.slice(0, 120) } : {}),
    hatches: activeGateHatches(),
    gates: bounded,
  };
  const path = gateEvidencePath(projectDir, sha);
  mkdirSync(join(projectDir, '.uap', 'evidence'), { recursive: true });
  // Atomic write: a crashed mission must never leave a half-written artifact —
  // the enforcer would read it as malformed and block a legitimate ship.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(evidence, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
  return path;
}
