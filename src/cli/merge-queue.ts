/**
 * `uap merge queue` — serialized landing of concurrent agent PRs.
 *
 * Per-PR gates prove a branch is green against the base it was CUT from. They
 * cannot see the semantic conflict where two independently-green PRs break each
 * other once both are on master. That is not hypothetical here: PR #577 landed a
 * legitimate docker-compose file while a stale hygiene test on master asserted
 * the file's absence — both sides green in isolation, master CI red on merge,
 * blocking every version bump in the repo until someone noticed.
 *
 * The queue closes that hole: land ONE PR at a time, then re-sync and re-check
 * every remaining PR against the tip that actually landed, before the next merge.
 */
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { loadOwnershipMap, assessConflict, type OwnershipMap } from '../coordination/ownership.js';

export interface QueueOptions {
  dryRun?: boolean;
  limit?: number;
  /** Land PRs even when their checks are not green (never the default). */
  force?: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  isDraft: boolean;
  updatedAt: string;
  labels: string[];
  files: string[];
}

/** Run `gh` and return stdout. Throws with a readable message on failure. */
function gh(args: string[], cwd?: string): string {
  try {
    return execFileSync('gh', args, { cwd, encoding: 'utf-8' }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`gh ${args.join(' ')} failed: ${e.stderr || e.message || 'unknown error'}`);
  }
}

/** Open, non-draft PRs with their changed-file lists. */
export function fetchOpenPrs(cwd?: string): PullRequest[] {
  const raw = gh(
    ['pr', 'list', '--state', 'open', '--limit', '100', '--json',
      'number,title,headRefName,isDraft,updatedAt,labels,files'],
    cwd
  );
  const parsed = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    headRefName: string;
    isDraft: boolean;
    updatedAt: string;
    labels?: Array<{ name: string }>;
    files?: Array<{ path: string }>;
  }>;
  return parsed.map((p) => ({
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    isDraft: p.isDraft,
    updatedAt: p.updatedAt,
    labels: (p.labels ?? []).map((l) => l.name),
    files: (p.files ?? []).map((f) => f.path),
  }));
}

/** Files touched by both PRs — the direct textual-conflict surface. */
export function overlappingFiles(a: PullRequest, b: PullRequest): string[] {
  const bSet = new Set(b.files);
  return a.files.filter((f) => bSet.has(f));
}

/**
 * Landing order. Mirrors TaskCoordinator.getMergeOrderSuggestion's intent —
 * urgent and small first — but operates on PRs, which is where merges actually
 * happen. Ordering is deterministic so a dry-run plan matches the real run.
 */
export function orderQueue(prs: PullRequest[]): PullRequest[] {
  const priorityOf = (p: PullRequest): number => {
    const labels = p.labels.map((l) => l.toLowerCase());
    if (labels.some((l) => l.includes('p0') || l.includes('critical'))) return 0;
    if (labels.some((l) => l.includes('hotfix') || l.includes('security'))) return 0;
    if (labels.some((l) => l.includes('bug') || l.includes('fix'))) return 1;
    if (/^(fix|hotfix)\//.test(p.headRefName)) return 1;
    if (labels.some((l) => l.includes('p1'))) return 1;
    if (/^chore\//.test(p.headRefName) || /^docs\//.test(p.headRefName)) return 3;
    return 2;
  };

  return [...prs].sort((a, b) => {
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pa - pb;
    // Smaller diffs land more predictably and unblock others sooner.
    if (a.files.length !== b.files.length) return a.files.length - b.files.length;
    // Oldest first — long-lived branches drift most, so stop the bleeding.
    return a.updatedAt.localeCompare(b.updatedAt);
  });
}

/**
 * PRs that will need a re-sync once `landed` is on the base branch.
 *
 * Shared FILES are the certain case. Shared LANES (per .uap/ownership.json) catch
 * the semantic case that file overlap misses entirely: two PRs editing different
 * files in the same module, each green alone, broken together. That is exactly how
 * PR #577 turned master red — it touched infra while a test asserting the opposite
 * lived in a file it never opened.
 */
export function impactedBy(
  landed: PullRequest,
  remaining: PullRequest[],
  map?: OwnershipMap
): PullRequest[] {
  const lanes = map ?? { lanes: {} };
  return remaining.filter((p) => assessConflict(landed.files, p.files, lanes).conflicts);
}

function checksArePassing(prNumber: number, cwd?: string): boolean {
  try {
    // Non-zero exit means "not all green"; treat any failure as not-passing.
    gh(['pr', 'checks', String(prNumber)], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-sync a PR branch onto the freshly-updated base and push.
 * Returns null on success, or a human-readable reason on failure.
 */
function resyncPr(pr: PullRequest, cwd?: string): string | null {
  try {
    gh(['pr', 'update-branch', String(pr.number)], cwd);
    return null;
  } catch (err) {
    // update-branch fails on a real conflict — exactly what we want surfaced.
    return (err as Error).message.includes('merge conflict')
      ? 'merge conflict with the new base — resolve locally'
      : (err as Error).message.slice(0, 160);
  }
}

export async function mergeQueueCommand(options: QueueOptions = {}): Promise<void> {
  const cwd = process.cwd();
  let prs: PullRequest[];

  try {
    prs = fetchOpenPrs(cwd);
  } catch (err) {
    console.error(chalk.red(String(err)));
    console.error(chalk.dim('Requires the `gh` CLI, authenticated against this repo.'));
    process.exitCode = 1;
    return;
  }

  const eligible = prs.filter((p) => !p.isDraft);
  if (eligible.length === 0) {
    console.log(chalk.dim('No open, non-draft PRs to land.'));
    return;
  }

  const ownership = loadOwnershipMap(cwd);
  const ordered = orderQueue(eligible);
  const limit = options.limit ?? ordered.length;
  const plan = ordered.slice(0, limit);

  console.log(chalk.bold(`\n🚦 Merge queue — ${plan.length} PR(s)\n`));
  for (const [i, pr] of plan.entries()) {
    const others = plan.slice(i + 1);
    const conflicts = impactedBy(pr, others, ownership);
    const note =
      conflicts.length > 0
        ? chalk.yellow(` → forces re-sync of ${conflicts.map((c) => `#${c.number}`).join(', ')}`)
        : '';
    console.log(`  ${i + 1}. #${pr.number} ${pr.title} ${chalk.dim(`(${pr.files.length} files)`)}${note}`);
  }
  console.log('');

  if (options.dryRun) {
    console.log(chalk.dim('Dry run — nothing merged. Re-run without --dry-run to land.'));
    return;
  }

  let landed = 0;
  const skipped: string[] = [];

  for (const [i, pr] of plan.entries()) {
    const remaining = plan.slice(i + 1);

    if (!options.force && !checksArePassing(pr.number, cwd)) {
      console.log(chalk.yellow(`  ⏭  #${pr.number} skipped — checks not green`));
      skipped.push(`#${pr.number} (red checks)`);
      continue;
    }

    try {
      gh(['pr', 'merge', String(pr.number), '--merge'], cwd);
      landed++;
      console.log(chalk.green(`  ✔ #${pr.number} merged`));
    } catch (err) {
      console.log(chalk.red(`  ✖ #${pr.number} merge failed: ${(err as Error).message.slice(0, 140)}`));
      skipped.push(`#${pr.number} (merge failed)`);
      continue;
    }

    // THE POINT OF THE QUEUE: every PR that touches what just landed is now
    // testing against a base that no longer exists. Re-sync before the next merge
    // so the next PR's checks describe reality.
    const impacted = impactedBy(pr, remaining, ownership);
    for (const other of impacted) {
      const failure = resyncPr(other, cwd);
      if (failure) {
        console.log(chalk.red(`     ↳ #${other.number} could not re-sync: ${failure}`));
      } else {
        console.log(chalk.dim(`     ↳ #${other.number} re-synced onto the new base`));
      }
    }
  }

  console.log('');
  console.log(chalk.bold(`Landed ${landed}/${plan.length}.`));
  if (skipped.length > 0) {
    console.log(chalk.yellow(`Skipped: ${skipped.join(', ')}`));
    process.exitCode = 1;
  }
}
