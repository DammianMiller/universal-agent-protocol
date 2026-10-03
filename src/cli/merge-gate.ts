/**
 * `uap merge gate <missionId>` — run the deterministic merge gate for one
 * mission against the current tree — and `gatePr`, the evidence-gathering
 * path the merge queue calls before landing a marker-carrying PR.
 *
 * Everything here re-derives fresh: ledger hashes, run-state from disk, the
 * gate-evidence artifact for the sha being landed, salvage rulings. Nothing
 * comes from the deliver run's self-report.
 */
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { getMission, listSalvage, openMissionDb, verifyAcceptanceHash } from '../mission/ledger.js';
import { getMissionDbPath } from '../mission/database.js';
import { loadRunState } from '../delivery/run-state.js';
import { gateEvidencePath, type GateEvidence } from '../delivery/gate-evidence.js';
import {
  evaluateMergeGate,
  missionMarkerOf,
  parseUnifiedDiff,
  type ChangedFile,
  type GateEvidenceCheck,
  type GateRunState,
  type MergeGateFinding,
  type MergeGateResult,
} from '../delivery/merge-gate.js';

export interface MergeGateOptions {
  projectRoot?: string;
  /** Base ref the diff is taken against (default: origin/master, else master). */
  base?: string;
  json?: boolean;
  /** Acknowledge deliberate gate-infrastructure changes (see axiom-honesty). */
  allowGateInfra?: boolean;
}

/**
 * Refs flow into one git argv token (`<base>...HEAD`), so a ref beginning
 * with `--` would be parsed as a git option and silently distort the diff the
 * gate evaluates (security review P3). Only plain ref characters pass.
 */
export function validateBaseRef(base: string): string | null {
  return /^[\w.\/-]+$/.test(base) && !base.startsWith('--') ? base : null;
}

/** The default diff base: origin/master when the remote ref is resolvable
 *  (fresher than a stale local master), else master. */
export function resolveDefaultBase(cwd: string): string {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', 'origin/master'], {
      encoding: 'utf-8',
      stdio: 'ignore',
      timeout: 15_000,
    });
    return 'origin/master';
  } catch {
    return 'master';
  }
}

/** Gather the diff being landed: added lines per changed file. */
export function diffAgainstBase(cwd: string, base: string): string {
  const ref = validateBaseRef(base);
  if (!ref) {
    throw new Error(`invalid --base ref '${base}' (plain ref characters only)`);
  }
  try {
    return execFileSync('git', ['-C', cwd, 'diff', '--unified=0', `${ref}...HEAD`], {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { message?: string };
    throw new Error(
      `could not diff HEAD against '${ref}' (${(e.message ?? 'unknown').slice(0, 120)}) — pass --base <ref> if the base is elsewhere`
    );
  }
}

/**
 * Tier-1 evidence read: the gate-evidence artifact deliver records on
 * success, bound to the candidate sha it proved. Malformed artifacts or
 * zero-gate artifacts prove nothing and fail closed (gatesAllZero=false).
 */
export function readEvidenceArtifact(projectRoot: string, expectedSha: string): GateEvidenceCheck {
  const path = gateEvidencePath(projectRoot, expectedSha);
  if (!existsSync(path)) {
    return { present: false, gatesAllZero: false, hatchesEmpty: false, shaMatches: false, expectedSha };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as GateEvidence;
    const gates = Array.isArray(parsed?.gates) ? parsed.gates : [];
    return {
      present: true,
      // An artifact with zero gates proves nothing (the recorder itself
      // refuses to write such an artifact — one that slipped through anyway
      // fails closed here).
      gatesAllZero: gates.length > 0 && gates.every((g) => g?.exitCode === 0),
      hatchesEmpty: Array.isArray(parsed?.hatches) && parsed.hatches.length === 0,
      shaMatches: parsed?.candidateSha === expectedSha,
      expectedSha,
    };
  } catch {
    // Unreadable/unparseable artifact: fail closed as unverifiable.
    return { present: true, gatesAllZero: false, hatchesEmpty: false, shaMatches: false, expectedSha };
  }
}

/** HEAD sha of the tree being landed (the standalone gate's candidate). */
export function headSha(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim();
}

/**
 * Fresh-evidence gathering shared by the standalone CLI and the merge queue.
 * Fails fast when no mission ledger exists (a queue run in a repo that never
 * used missions must not manufacture an empty ledger as a side effect).
 */
export function gatherGateEvidence(
  projectRoot: string,
  missionId: number,
  changedFiles: ChangedFile[],
  markerHash8: string | undefined,
  allowGateInfra = false,
  expectedSha?: string
): { result: MergeGateResult } | { error: string } {
  if (!existsSync(getMissionDbPath(projectRoot))) {
    return { error: `no mission ledger at ${getMissionDbPath(projectRoot)} — no missions exist in this repo` };
  }
  const db = openMissionDb(projectRoot);
  let mission;
  try {
    mission = getMission(db, missionId);
  } catch {
    return { error: `mission #${missionId} not found in ${projectRoot}/.uap/missions.db` };
  }
  const ledgerIntact = verifyAcceptanceHash(db, missionId, mission.acceptance);
  const runStateFull = mission.latestRunId ? loadRunState(projectRoot, mission.latestRunId) : null;
  const runState: GateRunState | null = runStateFull
    ? {
        status: runStateFull.status,
        history: (runStateFull.checkpoint?.history ?? []).map((h) => ({
          passed: h.passed,
          ...(h.acceptanceMet !== undefined ? { acceptanceMet: h.acceptanceMet } : {}),
        })),
        phaseSummaries: runStateFull.phaseSummaries,
      }
    : null;
  // PR-1 provenance discipline: when both pids are known, the run-state pid
  // must match the pid the orchestrator spawned (security review P3).
  const pidCorroborated =
    runStateFull?.pid !== undefined && mission.launchPid !== undefined
      ? runStateFull.pid === mission.launchPid
      : undefined;
  const openSalvageCount = listSalvage(db, { missionId, status: 'proposed' }).length;
  const evidence = expectedSha ? readEvidenceArtifact(projectRoot, expectedSha) : null;

  return {
    result: evaluateMergeGate({
      missionId,
      acceptanceHash8: mission.acceptanceHash.slice(0, 8),
      // Standalone mode passes markerHash8 undefined: the work's provenance is
      // the ledger itself, so the marker is definitionally the current frozen
      // hash. The queue passes the PR's cut-time marker instead — that is
      // where replan-after-cut detection happens.
      markerHash8: markerHash8 ?? mission.acceptanceHash.slice(0, 8),
      ledgerIntact,
      runState,
      evidence,
      ...(pidCorroborated !== undefined ? { pidCorroborated } : {}),
      openSalvageCount,
      changedFiles,
      ...(allowGateInfra ? { allowGateInfra: true } : {}),
    }),
  };
}

/**
 * Run the gate for a PR before the queue lands it. The diff arrives as a LAZY
 * thunk so marker-less PRs (the common case) cost zero extra `gh` calls, and
 * a transport failure maps to `gate: 'error'` — the queue skips that PR and
 * continues the batch instead of crashing (code review P2).
 *
 * `expectedSha` is the PR head SHA the evidence artifact must be bound to.
 */
export function gatePr(
  projectRoot: string,
  prTitleBody: string,
  fetchDiff: () => string,
  gateInfraAcknowledged: boolean,
  expectedSha?: string
): { gate: 'none' } | { gate: 'pass' } | { gate: 'fail'; reasons: string[] } | { gate: 'error'; reason: string } {
  const marker = missionMarkerOf(prTitleBody);
  if (!marker) return { gate: 'none' };
  let diff: string;
  try {
    diff = fetchDiff();
  } catch (err) {
    return { gate: 'error', reason: `diff fetch failed: ${(err as Error).message.slice(0, 160)}` };
  }
  const changedFiles = parseUnifiedDiff(diff);
  const gathered = gatherGateEvidence(
    projectRoot,
    marker.missionId,
    changedFiles,
    marker.hash8,
    gateInfraAcknowledged,
    expectedSha
  );
  if ('error' in gathered) return { gate: 'error', reason: gathered.error };
  if (gathered.result.pass) return { gate: 'pass' };
  return {
    gate: 'fail',
    reasons: gathered.result.findings.filter((f) => !f.ok).map((f) => `${f.check}: ${f.detail}`),
  };
}

function printFinding(f: MergeGateFinding): void {
  const icon = f.ok ? chalk.green('✔') : chalk.red('✖');
  const name = f.check.padEnd(14);
  console.log(`  ${icon} ${chalk.bold(name)} ${f.ok ? chalk.dim(f.detail) : f.detail}`);
}

export function mergeGateCommand(missionIdArg: string, options: MergeGateOptions = {}): void {
  // Strict id: parseInt('3abc') silently yields 3 (code review P3).
  if (!/^\d+$/.test(missionIdArg ?? '')) {
    console.log(chalk.yellow('  Usage: uap merge gate <missionId> [--base <ref>] [--allow-gate-infra] [--json]'));
    process.exitCode = 1;
    return;
  }
  const id = Number.parseInt(missionIdArg, 10);

  const projectRoot = options.projectRoot ?? process.cwd();
  const errOut = options.json ? (m: string) => process.stderr.write(`${m}\n`) : (m: string) => console.log(m);

  let changedFiles;
  try {
    const base = options.base ?? resolveDefaultBase(projectRoot);
    changedFiles = parseUnifiedDiff(diffAgainstBase(projectRoot, base));
  } catch (err) {
    errOut(chalk.red(`  ✖ ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  let sha: string;
  try {
    sha = headSha(projectRoot);
  } catch (err) {
    errOut(chalk.red(`  ✖ cannot resolve HEAD: ${(err as Error).message.slice(0, 120)}`));
    process.exitCode = 1;
    return;
  }

  const gathered = gatherGateEvidence(
    projectRoot,
    id,
    changedFiles,
    /* markerHash8: undefined → the ledger's own hash (standalone mode) */
    undefined,
    options.allowGateInfra === true,
    sha
  );
  if ('error' in gathered) {
    errOut(chalk.yellow(`  ${gathered.error}`));
    process.exitCode = 1;
    return;
  }
  const result = gathered.result;

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.bold(`\n🛡  Merge gate — mission #${id} (${changedFiles.length} changed file(s))\n`));
    for (const f of result.findings) printFinding(f);
    console.log('');
    console.log(
      result.pass
        ? chalk.green(`  PASS — mission #${id} may land`)
        : chalk.red(`  FAIL — mission #${id} is not landable until every check passes`)
    );
  }
  if (!result.pass) process.exitCode = 1;
}
