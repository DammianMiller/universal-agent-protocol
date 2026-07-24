import chalk from 'chalk';
import ora from 'ora';
import { cpSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';

type WorktreeAction =
  | 'create'
  | 'list'
  | 'pr'
  | 'finish'
  | 'cleanup'
  | 'ensure'
  | 'prune'
  | 'sync'
  | 'hygiene';

interface WorktreeOptions {
  slug?: string;
  id?: string;
  from?: string;
  description?: string;
  draft?: boolean;
  strict?: boolean;
  olderThan?: number;
  force?: boolean;
  dryRun?: boolean;
  /** create: skip the fetch of the base remote (offline / air-gapped). */
  noFetch?: boolean;
  /** hygiene: emit a single-line advisory instead of the full table. */
  brief?: boolean;
  /** sync/hygiene: operate on every worktree, not just the current one. */
  all?: boolean;
}

let worktreeDb: Database.Database | null = null;

function getWorktreeDb(cwd: string): Database.Database {
  if (worktreeDb) return worktreeDb;

  const dbDir = join(cwd, '.uap');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  // Migrate from legacy .uam/ location if it exists
  const legacyDbPath = join(cwd, '.uam', 'worktree_registry.db');
  const dbPath = join(dbDir, 'worktree_registry.db');
  if (!existsSync(dbPath) && existsSync(legacyDbPath)) {
    cpSync(legacyDbPath, dbPath);
  }
  worktreeDb = new Database(dbPath);
  worktreeDb.pragma('journal_mode = WAL');
  worktreeDb.pragma('busy_timeout = 10000');

  worktreeDb.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      status TEXT DEFAULT 'active',
      UNIQUE(slug)
    );
    
    CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
  `);

  return worktreeDb;
}

async function getNextId(cwd: string): Promise<number> {
  const db = getWorktreeDb(cwd);
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) as max_id FROM worktrees').get() as {
    max_id: number;
  };
  return row.max_id + 1;
}

export async function worktreeCommand(
  action: WorktreeAction,
  options: WorktreeOptions = {}
): Promise<void> {
  const cwd = process.cwd();
  const git = simpleGit(cwd);

  // Check if we're in a git repo
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    console.error(chalk.red('Not a git repository'));
    process.exit(1);
  }

  switch (action) {
    case 'create':
      await createWorktree(cwd, git, options.slug!, options.from, options.noFetch);
      break;
    case 'sync':
      await syncWorktree(cwd, git, { id: options.id, all: options.all });
      break;
    case 'hygiene':
      await worktreeHygiene(cwd, git, { brief: options.brief });
      break;
    case 'list':
      await listWorktrees(cwd, git);
      break;
    case 'pr':
      await createPR(cwd, git, options.id!, options.draft);
      break;
    case 'finish':
      await finishWorktree(cwd, git, options.id!);
      break;
    case 'cleanup':
      await cleanupWorktree(cwd, git, options.id!);
      break;
    case 'ensure':
      await ensureWorktree(cwd, git, options.strict);
      break;
    case 'prune':
      await pruneStaleWorktrees(cwd, {
        olderThan: options.olderThan ?? 30,
        force: options.force ?? false,
        dryRun: options.dryRun ?? false,
      });
      break;
  }
}

async function createWorktree(
  cwd: string,
  git: SimpleGit,
  slug: string,
  baseBranch?: string,
  noFetch?: boolean
): Promise<void> {
  const spinner = ora('Creating worktree...').start();

  try {
    // Get next ID atomically from DB
    const id = await getNextId(cwd);
    const paddedId = String(id).padStart(3, '0');
    const worktreeName = `${paddedId}-${slug}`;
    const branchName = `feature/${worktreeName}`;
    const worktreePath = join(cwd, '.worktrees', worktreeName);

    // FRESH-BASE GATE. A worktree used to be cut from whatever the main checkout
    // happened to have at HEAD — so if local master was stale (or the operator was
    // parked on some unrelated branch), the agent started N commits behind and every
    // file it touched was at risk of silently reverting work that had already landed.
    // Observed live: a worktree created while local master was 1 behind origin was
    // born stale, and the oldest worktrees in this repo drifted to 1241 commits behind.
    // Base on the REMOTE tip by default; --from still wins for deliberate stacking.
    spinner.text = 'Resolving base branch...';
    let branchBase: string;
    if (baseBranch) {
      // Explicit base: fetch it first so `--from origin/x` (and a local ref that
      // tracks it) resolves to the current remote tip rather than a stale copy.
      // Strip the remote prefix — `git fetch origin origin/x` is not a valid
      // refspec, so it failed silently and left the stale local ref in place.
      if (!noFetch) {
        await fetchQuietly(git, baseBranch.replace(/^origin\//, ''));
      }
      try {
        await git.revparse([baseBranch]);
        branchBase = baseBranch;
      } catch {
        spinner.fail(`Base branch not found: ${baseBranch}`);
        process.exit(1);
      }
    } else {
      branchBase = await resolveFreshBase(git, { noFetch, spinner });
    }

    // Create worktree with new branch
    spinner.text = `Creating branch ${branchName}...`;
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, branchBase]);

    // A worktree WITHOUT the hooks is a hole straight through every gate.
    // `git worktree add` materializes only TRACKED files, and the hook scripts are
    // untracked — so a fresh worktree has no .opencode/hooks, no gate runs, and an
    // agent working there writes source completely UNGATED: no routing to deliver,
    // no self-protect, no infra-protect. Observed live: the client was working in
    // `.worktrees/001-dev-environment-setup` with zero enforcement, and nothing was
    // being routed at all.
    //
    // Only the hook FILES need copying: the gate already anchors the policy DB and
    // the enforcers to MAIN_ROOT (see uap-policy-gate.sh), so a worktree inherits
    // the parent's policies automatically once a hook is actually there to run.
    spinner.text = 'Installing enforcement hooks into the worktree...';
    try {
      const { hooksCommand } = await import('./hooks.js');
      await hooksCommand('install', { projectDir: worktreePath });
      // Hooks alone are INERT for opencode: its gate runs from the .opencode
      // plugin, and the deliver tool is reached through the MCP router config.
      // Installing the hook scripts without wiring these leaves the files sitting
      // there doing nothing — which looks fixed and is not.
      const { wireDeliverMcp } = await import('./deliver-defaults.js');
      wireDeliverMcp(worktreePath);
    } catch (err) {
      // Never fail worktree creation over this — but say so loudly, because an
      // unhooked worktree silently bypasses enforcement.
      spinner.warn(
        `Worktree created, but hooks could not be installed — work there will be UNGATED: ${String(err).slice(0, 120)}`
      );
    }

    // Register in DB to prevent race conditions
    const db = getWorktreeDb(cwd);
    db.prepare(
      `
      INSERT INTO worktrees (slug, branch_name, worktree_path, status)
      VALUES (?, ?, ?, 'active')
    `
    ).run(slug, branchName, worktreePath);

    spinner.succeed(`Created worktree: ${worktreeName}`);
    console.log(chalk.dim(`  Branch: ${branchName}`));
    console.log(chalk.dim(`  Base:   ${branchBase}`));
    console.log(chalk.dim(`  Path:   ${worktreePath}`));
    console.log('');
    console.log(chalk.bold('Next steps:'));
    console.log(`  cd .worktrees/${worktreeName}`);
    console.log('  # Make your changes');
    console.log(`  uap worktree pr ${id}`);
  } catch (error) {
    spinner.fail('Failed to create worktree');
    console.error(chalk.red(error));
  }
}

async function listWorktrees(_cwd: string, git: SimpleGit): Promise<void> {
  console.log(chalk.bold('\n📁 Git Worktrees\n'));

  try {
    const worktrees = await git.raw(['worktree', 'list', '--porcelain']);
    const entries = worktrees.split('\n\n').filter(Boolean);

    if (entries.length <= 1) {
      console.log(chalk.yellow('No additional worktrees found.'));
      console.log(chalk.dim('Create one with: uap worktree create <slug>'));
      return;
    }

    console.log('| ID  | Name | Branch | Path |');
    console.log('|-----|------|--------|------|');

    for (const entry of entries) {
      const lines = entry.split('\n');
      const path = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '');
      const branch = lines.find((l) => l.startsWith('branch '))?.replace('branch refs/heads/', '');

      if (path && path.includes('.worktrees')) {
        const name = path.split('.worktrees/')[1] || 'unknown';
        const id = name.split('-')[0] || '-';
        console.log(`| ${id} | ${name} | ${branch || 'detached'} | ${path} |`);
      }
    }

    console.log('');
  } catch (error) {
    console.error(chalk.red('Failed to list worktrees'));
    console.error(error);
  }
}

async function createPR(cwd: string, _git: SimpleGit, id: string, draft?: boolean): Promise<void> {
  const spinner = ora('Creating pull request...').start();

  try {
    // Find worktree by ID
    const worktreesDir = join(cwd, '.worktrees');
    const entries = readdirSync(worktreesDir);
    const worktree = entries.find((e) => e.startsWith(`${id.padStart(3, '0')}-`));

    if (!worktree) {
      spinner.fail(`Worktree with ID ${id} not found`);
      return;
    }

    const worktreePath = join(worktreesDir, worktree);
    const worktreeGit = simpleGit(worktreePath);

    // Get branch name
    const branch = await worktreeGit.revparse(['--abbrev-ref', 'HEAD']);

    // Sync branch with latest master before push/PR to reduce mergeability issues
    spinner.text = 'Syncing with origin/master...';
    await syncBranchWithMaster(worktreeGit, branch.trim());

    // Push branch
    spinner.text = 'Pushing branch...';
    await worktreeGit.push(['-u', 'origin', branch.trim()]);

    // Create PR using gh CLI
    spinner.text = 'Creating PR...';
    const { execSync } = await import('child_process');

    const draftFlag = draft ? '--draft' : '';
    const prCommand = `gh pr create --fill ${draftFlag}`;

    try {
      const result = execSync(prCommand, { cwd: worktreePath, encoding: 'utf-8' });
      spinner.succeed('Pull request created');
      console.log(chalk.dim(result.trim()));
    } catch (ghError) {
      spinner.warn('Branch pushed, but PR creation failed');
      console.log(
        chalk.yellow('Create PR manually or ensure `gh` CLI is installed and authenticated')
      );
      console.log(chalk.dim(`Branch: ${branch.trim()}`));
    }
  } catch (error) {
    spinner.fail('Failed to create PR');
    console.error(chalk.red(error));
  }
}

async function finishWorktree(cwd: string, git: SimpleGit, id: string): Promise<void> {
  const spinner = ora('Finishing worktree (sync, merge, cleanup)...').start();

  try {
    const worktreesDir = join(cwd, '.worktrees');
    const entries = readdirSync(worktreesDir);
    const worktree = entries.find((e) => e.startsWith(`${id.padStart(3, '0')}-`));

    if (!worktree) {
      spinner.fail(`Worktree with ID ${id} not found`);
      return;
    }

    const worktreePath = join(worktreesDir, worktree);
    const worktreeGit = simpleGit(worktreePath);
    const branch = (await worktreeGit.revparse(['--abbrev-ref', 'HEAD'])).trim();

    spinner.text = 'Syncing with origin/master...';
    await syncBranchWithMaster(worktreeGit, branch);

    spinner.text = 'Pushing branch...';
    await worktreeGit.push(['-u', 'origin', branch]);

    spinner.text = 'Ensuring PR exists...';
    const prNumber = ensurePrNumber(worktreePath);

    spinner.text = `Merging PR #${prNumber}...`;
    try {
      runGh(`gh pr merge ${prNumber} --merge`, worktreePath);
    } catch (error) {
      const message = extractErrorMessage(error);
      if (!isAlreadyMergedMessage(message)) {
        throw error;
      }
    }

    spinner.text = 'Deleting remote branch...';
    await deleteRemoteBranch(worktreeGit, branch);

    spinner.succeed(`PR #${prNumber} merged`);
    await cleanupWorktree(cwd, git, id);
  } catch (error) {
    spinner.fail('Failed to finish worktree');
    console.error(chalk.red(error));
  }
}

function runGh(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: 'utf-8' }).trim();
}

function ensurePrNumber(worktreePath: string): string {
  try {
    return runGh('gh pr view --json number --jq ".number"', worktreePath);
  } catch {
    runGh('gh pr create --fill', worktreePath);
    return runGh('gh pr view --json number --jq ".number"', worktreePath);
  }
}

async function syncBranchWithMaster(worktreeGit: SimpleGit, branch: string): Promise<void> {
  const base = await resolveIntegrationRef(worktreeGit);
  await fetchQuietly(worktreeGit, base.replace(/^origin\//, ''));
  const behindRaw = await worktreeGit.raw(['rev-list', '--count', `${branch}..${base}`]);
  const behind = parseRevListCount(behindRaw);

  if (behind === 0) {
    return;
  }

  try {
    await worktreeGit.raw(['merge', '--no-edit', base]);
  } catch {
    throw new Error(
      `Worktree branch is behind ${base} and automatic sync failed. Resolve merge conflicts in the worktree, then rerun the command.`
    );
  }
}

/** Best-effort fetch — never fails the caller (offline, no remote, auth prompt). */
async function fetchQuietly(git: SimpleGit, ref?: string): Promise<boolean> {
  try {
    await git.fetch(ref ? ['origin', ref] : ['origin']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Name of the repo's integration branch, without the remote prefix.
 * Prefers origin/HEAD (what the remote itself calls default), then the usual
 * suspects, then the current local branch. Hard-coding "master" broke every
 * main-branch repo that installed UAP.
 */
export async function resolveDefaultBranch(git: SimpleGit): Promise<string> {
  try {
    const head = await git.raw(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = head.trim().replace('refs/remotes/origin/', '');
    if (name) return name;
  } catch {
    // origin/HEAD not set (common on clones made with --single-branch) — fall through.
  }
  for (const candidate of ['master', 'main']) {
    try {
      await git.revparse([`refs/remotes/origin/${candidate}`]);
      return candidate;
    } catch {
      // not present — try the next one
    }
  }
  try {
    return (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return 'master';
  }
}

/** Fully-qualified ref to integrate against: `origin/<default>` when the remote has it. */
export async function resolveIntegrationRef(git: SimpleGit): Promise<string> {
  const branch = await resolveDefaultBranch(git);
  try {
    await git.revparse([`refs/remotes/origin/${branch}`]);
    return `origin/${branch}`;
  } catch {
    return branch;
  }
}

/**
 * The ref a new worktree should be cut from: the freshly-fetched remote tip.
 * Falls back to the local branch when there is no reachable remote, so this
 * still works offline and in never-pushed repos.
 */
async function resolveFreshBase(
  git: SimpleGit,
  opts: { noFetch?: boolean; spinner?: { text: string } } = {}
): Promise<string> {
  const defaultBranch = await resolveDefaultBranch(git);
  if (!opts.noFetch) {
    if (opts.spinner) opts.spinner.text = `Fetching origin/${defaultBranch}...`;
    await fetchQuietly(git, defaultBranch);
  }
  try {
    await git.revparse([`refs/remotes/origin/${defaultBranch}`]);
    return `origin/${defaultBranch}`;
  } catch {
    // No remote-tracking ref (offline first-run, local-only repo): use the local
    // branch if it exists, else whatever HEAD is. Never fail worktree creation.
  }
  try {
    await git.revparse([defaultBranch]);
    return defaultBranch;
  } catch {
    return 'HEAD';
  }
}

export interface BranchDrift {
  name: string;
  path: string;
  branch: string;
  /** Commits on the integration ref that this branch does not have. */
  behind: number;
  /** Commits on this branch not yet on the integration ref (unmerged work). */
  ahead: number;
  /** Count of uncommitted (staged + unstaged + untracked) entries. */
  dirty: number;
}

/**
 * Measure one worktree's drift against the integration ref. Never throws.
 *
 * Kept to ONE git process on the common path. The first version spent four
 * (`rev-parse`, two `rev-list`, `status`) which, across this repo's 152
 * worktrees, ran ~600 sequential git invocations — comfortably past the 15s
 * budget the session banner allows, so the advisory was always killed before it
 * printed while still costing the full 15 seconds.
 *
 * @param branch pre-resolved from `git worktree list --porcelain`, which already
 *   reports it — re-asking per worktree was a free process we were paying for.
 * @param withDirty `git status` is by far the most expensive call (it stats the
 *   whole tree). Only worth it for worktrees that already look interesting.
 */
export async function measureDrift(
  worktreePath: string,
  integrationRef: string,
  branch?: string,
  withDirty = true
): Promise<BranchDrift | null> {
  try {
    const wtGit = simpleGit(worktreePath);
    const resolved = branch ?? (await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim();

    // One symmetric-difference call replaces two rev-lists. Note the THREE dots:
    // `--left-right --count a...b` emits "<behind>\t<ahead>" relative to the merge base.
    const raw = await wtGit.raw([
      'rev-list',
      '--left-right',
      '--count',
      `${integrationRef}...HEAD`,
    ]);
    const [behindRaw, aheadRaw] = raw.trim().split(/\s+/);
    const behind = parseRevListCount(behindRaw ?? '0');
    const ahead = parseRevListCount(aheadRaw ?? '0');

    let dirty = 0;
    if (withDirty) {
      const status = await wtGit.status();
      // status.files is the authoritative entry list; summing the category arrays
      // double-counts, because a staged-and-modified file appears in both.
      dirty = status.files.length;
    }

    const name = worktreePath.split('.worktrees/')[1] || worktreePath;
    return { name, path: worktreePath, branch: resolved, behind, ahead, dirty };
  } catch {
    return null;
  }
}

/** A linked worktree and the branch git already told us it is on. */
interface WorktreeRef {
  path: string;
  branch: string;
}

/** All linked worktrees under .worktrees/, with their branches. */
async function listWorktreeRefs(git: SimpleGit): Promise<WorktreeRef[]> {
  try {
    const raw = await git.raw(['worktree', 'list', '--porcelain']);
    const refs: WorktreeRef[] = [];
    let current: string | null = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = line.replace('worktree ', '').trim();
      } else if (line.startsWith('branch ') && current) {
        if (current.includes('.worktrees')) {
          refs.push({ path: current, branch: line.replace('branch refs/heads/', '').trim() });
        }
        current = null;
      }
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * Run an async mapper over items with bounded concurrency.
 * Unbounded would spawn 152×N git processes at once and thrash the machine;
 * sequential leaves the CPU idle while each git process does IO.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * `uap worktree sync` — pull the integration branch into a worktree MID-FLIGHT.
 * The old flow only synced at `finish`, which is the most expensive possible
 * moment to discover a conflict. This makes re-basing cheap and routine.
 */
async function syncWorktree(
  cwd: string,
  git: SimpleGit,
  opts: { id?: string; all?: boolean } = {}
): Promise<void> {
  const integrationRef = await resolveIntegrationRef(git);
  const spinner = ora(`Syncing with ${integrationRef}...`).start();

  let targets: string[];
  if (opts.all) {
    targets = (await listWorktreeRefs(git)).map((r) => r.path);
  } else if (opts.id) {
    const found = findWorktreeById(cwd, opts.id);
    if (!found) {
      spinner.fail(`Worktree with ID ${opts.id} not found`);
      return;
    }
    targets = [found];
  } else {
    // Default: the worktree we are standing in.
    targets = [cwd];
  }

  await fetchQuietly(git, integrationRef.replace(/^origin\//, ''));
  spinner.stop();

  let synced = 0;
  let conflicted = 0;
  let already = 0;
  let skipped = 0;

  // Probe concurrently, then merge serially: merges mutate working trees and
  // their output should stay readable and attributable.
  const drifts = await mapLimit(targets, 8, (t) => measureDrift(t, integrationRef));

  for (const drift of drifts) {
    if (!drift) continue;
    if (drift.behind === 0) {
      already++;
      continue;
    }
    // Merging into a dirty tree aborts with "local changes would be overwritten",
    // which the old code reported as a CONFLICT — misleading, and with --all it
    // would say that about every dirty worktree in the repo.
    if (drift.dirty > 0) {
      skipped++;
      console.log(
        chalk.yellow(
          `  ⏭  ${drift.name}: ${drift.dirty} uncommitted change(s) — commit or stash first ` +
            `(${drift.behind} behind)`
        )
      );
      continue;
    }
    const wtGit = simpleGit(drift.path);
    try {
      await wtGit.raw(['merge', '--no-edit', integrationRef]);
      synced++;
      console.log(
        chalk.green(`  ✔ ${drift.name}: merged ${drift.behind} commit(s) from ${integrationRef}`)
      );
    } catch {
      conflicted++;
      console.log(
        chalk.red(
          `  ✖ ${drift.name}: CONFLICT merging ${integrationRef} ` +
            `(${drift.behind} behind). Resolve in ${drift.path}, then commit.`
        )
      );
    }
  }

  console.log('');
  console.log(
    chalk.bold(
      `Sync: ${synced} updated, ${already} already current, ` +
        `${skipped} skipped (dirty), ${conflicted} need manual resolution`
    )
  );
  if (conflicted > 0) {
    process.exitCode = 1;
  }
}

/**
 * `uap worktree hygiene` — surface drift and at-risk work across ALL worktrees.
 * Silent accumulation is how work gets lost: a branch nobody re-synced for a
 * thousand commits will either conflict violently or be quietly abandoned.
 */
async function worktreeHygiene(
  _cwd: string,
  git: SimpleGit,
  opts: { brief?: boolean } = {}
): Promise<void> {
  const integrationRef = await resolveIntegrationRef(git);
  // Refresh the remote tip first: measuring against a stale origin/master
  // under-reports drift, which is precisely what this report exists to catch.
  await fetchQuietly(git, integrationRef.replace(/^origin\//, ''));
  const refs = await listWorktreeRefs(git);

  // Two passes so `git status` — the expensive call — runs only where it can
  // change the verdict. Everything else needs one git process per worktree.
  const cheap = await mapLimit(refs, 8, (r) =>
    measureDrift(r.path, integrationRef, r.branch, false)
  );
  const drifts = await mapLimit(
    cheap.filter((d): d is BranchDrift => d !== null),
    8,
    async (d) => (d.ahead > 0 ? ((await measureDrift(d.path, integrationRef, d.branch, true)) ?? d) : d)
  );

  const atRisk = drifts.filter((d) => d.ahead > 0 || d.dirty > 0);
  const summary = summarizeHygiene(drifts, integrationRef);

  if (opts.brief) {
    if (summary) console.log(summary);
    return;
  }

  console.log(chalk.bold(`\n🧹 Worktree hygiene (vs ${integrationRef})\n`));
  if (drifts.length === 0) {
    console.log(chalk.dim('No linked worktrees.'));
    return;
  }

  drifts.sort((a, b) => b.behind - a.behind);
  console.log('| Worktree | Behind | Ahead | Dirty | Status |');
  console.log('|----------|--------|-------|-------|--------|');
  for (const d of drifts) {
    const status =
      d.ahead > 0 || d.dirty > 0
        ? chalk.yellow('UNMERGED WORK')
        : d.behind > 200
          ? chalk.red('STALE — safe to prune')
          : chalk.dim('clean');
    console.log(`| ${d.name} | ${d.behind} | ${d.ahead} | ${d.dirty} | ${status} |`);
  }

  console.log('');
  if (summary) console.log(summary);
  if (atRisk.length > 0) {
    console.log(
      chalk.dim('  Reconcile with: uap worktree sync --id <id>   then   uap worktree pr <id>')
    );
    console.log(chalk.dim('  Abandon with:  uap worktree cleanup <id>'));
  }
  console.log(chalk.dim('  Bulk prune merged//stale worktrees: uap worktree prune --older-than 30'));
  console.log('');
}

/**
 * One-line advisory for session-start. Returns '' when nothing needs attention,
 * so the caller can stay silent on a healthy repo.
 */
export function summarizeHygiene(drifts: BranchDrift[], integrationRef: string): string {
  if (drifts.length === 0) return '';
  const atRisk = drifts.filter((d) => d.ahead > 0 || d.dirty > 0);
  const stale = drifts.filter((d) => d.behind > 200);
  if (atRisk.length === 0 && stale.length === 0) return '';

  const worst = drifts.reduce((a, b) => (b.behind > a.behind ? b : a));
  const parts: string[] = [];
  if (atRisk.length > 0) {
    parts.push(`${atRisk.length} worktree(s) hold unmerged or uncommitted work`);
  }
  if (stale.length > 0) {
    parts.push(`${stale.length} are >200 commits behind ${integrationRef}`);
  }
  return (
    `⚠️  Worktree drift: ${parts.join('; ')} ` +
    `(worst: ${worst.name} at ${worst.behind} behind). Run \`uap worktree hygiene\`.`
  );
}

/** Resolve a worktree directory from its numeric ID. */
function findWorktreeById(cwd: string, id: string): string | null {
  try {
    const worktreesDir = join(cwd, '.worktrees');
    const entries = readdirSync(worktreesDir);
    const match = entries.find((e) => e.startsWith(`${id.padStart(3, '0')}-`));
    return match ? join(worktreesDir, match) : null;
  } catch {
    return null;
  }
}

export function parseRevListCount(output: string): number {
  const parsed = Number.parseInt(output.trim(), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deleteRemoteBranch(worktreeGit: SimpleGit, branch: string): Promise<void> {
  try {
    await worktreeGit.push(['origin', '--delete', branch]);
  } catch {
    // Branch may already be deleted, protected, or auto-deleted by repo settings.
  }
}

export function isAlreadyMergedMessage(message: string): boolean {
  return message.includes('was already merged');
}

async function cleanupWorktree(cwd: string, git: SimpleGit, id: string): Promise<void> {
  const spinner = ora('Cleaning up worktree...').start();

  try {
    // Find worktree by ID
    const worktreesDir = join(cwd, '.worktrees');
    const entries = readdirSync(worktreesDir);
    const worktree = entries.find((e) => e.startsWith(`${id.padStart(3, '0')}-`));

    if (!worktree) {
      spinner.fail(`Worktree with ID ${id} not found`);
      return;
    }

    const worktreePath = join(worktreesDir, worktree);
    const branchName = `feature/${worktree}`;

    // Remove worktree
    spinner.text = 'Removing worktree...';
    await git.raw(['worktree', 'remove', worktreePath, '--force']);

    // Delete branch
    spinner.text = 'Deleting branch...';
    try {
      await git.deleteLocalBranch(branchName, true);
    } catch {
      // Branch may already be deleted
    }

    // Try to delete remote branch
    try {
      await git.push(['origin', '--delete', branchName]);
    } catch {
      // Remote branch may not exist
    }

    // Remove from registry
    const db = getWorktreeDb(cwd);
    db.prepare('UPDATE worktrees SET status = ? WHERE id = ?').run('cleaned', id);

    spinner.succeed(`Cleaned up: ${worktree}`);
  } catch (error) {
    spinner.fail('Failed to cleanup worktree');
    console.error(chalk.red(error));
  }
}

async function ensureWorktree(cwd: string, _git: SimpleGit, strict?: boolean): Promise<void> {
  const spinner = ora('Checking worktree workflow...').start();

  try {
    // Check if worktrees are enabled in config
    const configPath = join(cwd, '.uap.json');
    if (!existsSync(configPath)) {
      // Try to find .uap.json in parent directories (we might be in a worktree)
      const parentConfig = join(cwd, '..', '..', '.uap.json');
      if (!existsSync(parentConfig)) {
        if (strict) {
          spinner.fail('Not in a worktree (no .uap.json found)');
          process.exit(1);
        }
        console.log(chalk.yellow('⚠️  No .uap.json found. Run "uap init" to set up UAP.'));
        return;
      }
    }

    const { loadUapConfigRaw } = await import('../utils/config-loader.js');
    const config = loadUapConfigRaw(cwd);
    if (!config) {
      spinner.succeed('No .uap.json found — worktree check skipped');
      return;
    }
    const worktreeEnabled = (config as Record<string, unknown>).template
      ? ((config.template as Record<string, unknown>)?.sections as Record<string, unknown>)
          ?.worktreeWorkflow !== false
      : true;

    if (!worktreeEnabled) {
      if (strict) {
        spinner.succeed('Worktree workflow is disabled — strict check skipped');
        return;
      }
      console.log(chalk.dim('Worktree workflow is disabled in .uap.json'));
      return;
    }

    // Check if we're already in a worktree
    const currentDir = cwd;
    // Resolve worktrees dir relative to project root (handle being inside a worktree)
    const projectRoot = existsSync(configPath) ? cwd : join(cwd, '..', '..');
    const worktreesDir = join(projectRoot, '.worktrees');

    if (currentDir.includes('.worktrees/') || currentDir.includes('.worktrees\\')) {
      spinner.succeed('Already working in a git worktree');
      console.log(chalk.dim(`  Path: ${currentDir}`));
      return;
    }

    // Not in a worktree — in strict mode, this is a hard failure
    if (strict) {
      spinner.fail('NOT in a worktree. All file edits are prohibited.');
      console.error(chalk.red('  Current directory: ' + currentDir));
      console.error(chalk.red('  Run: uap worktree create <slug>'));
      console.error(chalk.red('  Then: cd .worktrees/<id>-<slug>/'));
      process.exit(1);
    }

    // Advisory mode — show available worktrees
    const worktrees: { id: string; path: string; branch: string }[] = [];
    if (existsSync(worktreesDir)) {
      const entries = readdirSync(worktreesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({
          name: e.name,
          path: join(worktreesDir, e.name),
        }));

      for (const entry of entries) {
        try {
          const worktreeGit = simpleGit(entry.path);
          const branch = await worktreeGit.revparse(['--abbrev-ref', 'HEAD']);
          worktrees.push({
            id: entry.name.split('-')[0] || 'unknown',
            path: entry.path,
            branch: branch.trim(),
          });
        } catch {
          // Skip invalid worktrees
        }
      }
    }

    if (worktrees.length > 0) {
      spinner.info('No active worktree. Here are your options:');
      console.log('');
      console.log(chalk.bold('Active worktrees:'));
      for (const wt of worktrees) {
        const status =
          wt.branch === 'master' || wt.branch === 'main' ? chalk.yellow('🔴') : chalk.green('🟢');
        console.log(`  ${status} [${wt.id}] ${wt.branch} - ${wt.path}`);
      }
      console.log('');
      console.log(chalk.dim('To switch to a worktree: cd .worktrees/<id>-<slug>'));
      console.log(chalk.dim('Or create a new one: uap worktree create <slug>'));
    } else {
      spinner.info('No active worktrees found.');
      console.log('');
      console.log(chalk.bold('Create a new worktree:'));
      console.log(chalk.cyan('  uap worktree create <slug>'));
      console.log('');
      console.log(
        chalk.dim('<slug> should be descriptive, e.g., "fix-auth-bug" or "add-dashboard"')
      );
    }
  } catch (error) {
    spinner.fail('Failed to check worktree status');
    console.error(chalk.red(error));
    if (strict) {
      process.exit(1);
    }
  }
}

/**
 * Check if a given file path is inside a worktree directory.
 * Exported for use by the worktree file guard in the MCP router.
 */
export function isPathInsideWorktree(filePath: string): boolean {
  return filePath.includes('.worktrees/') || filePath.includes('.worktrees\\');
}

/**
 * Check if a file path is exempt from worktree enforcement.
 * Runtime data directories and node_modules are exempt.
 */
export function isExemptFromWorktree(filePath: string): boolean {
  const exemptPaths = [
    'agents/data/',
    'node_modules/',
    '.uap-backups/',
    '.uap/',
    '.git/',
    'dist/',
  ];
  return exemptPaths.some((exempt) => filePath.includes(exempt));
}

/**
 * Prune stale worktrees - cleanup old/cleaned worktrees automatically
 */
async function pruneStaleWorktrees(
  cwd: string,
  options: { olderThan: number; force: boolean; dryRun: boolean }
): Promise<void> {
  const { rmSync } = await import('fs');

  const db = getWorktreeDb(cwd);
  const days = options.olderThan;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // List stale worktrees (status='cleaned' or older than threshold)
  const stale = db.prepare(`
    SELECT id, slug, worktree_path, created_at, status
    FROM worktrees
    WHERE created_at < ?
  `).all(cutoff) as Array<{
    id: number;
    slug: string;
    worktree_path: string;
    created_at: number;
    status: string;
  }>;

  if (stale.length === 0) {
    console.log(chalk.green(`No worktrees older than ${days} days found`));
    return;
  }

  console.log(chalk.bold(`Found ${stale.length} stale worktree(s) older than ${days} days:`));
  console.log('');

  for (const wt of stale) {
    const age = Math.floor((Date.now() - wt.created_at) / (1000 * 60 * 60 * 24));
    const statusColor = wt.status === 'cleaned' ? chalk.yellow : chalk.dim;
    console.log(`  ${wt.id}: ${wt.slug} (${age} days old) - ${statusColor(wt.status)}`);
  }
  console.log('');

  if (!options.force && !options.dryRun) {
    const inquirer = await import('inquirer');
    const { confirm } = inquirer as any;
    const { confirmed } = await confirm({
      message: `Prune ${stale.length} worktree(s)? (This will delete worktree directories and remove registry entries)`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim('Cancelled'));
      return;
    }
  }

  // Prune
  let pruned = 0;
  let directoriesRemoved = 0;

  for (const wt of stale) {
    // Remove from DB
    db.prepare('DELETE FROM worktrees WHERE id = ?').run(wt.id);
    pruned++;

    // Remove directory
    if (existsSync(wt.worktree_path)) {
      rmSync(wt.worktree_path, { recursive: true, force: true });
      directoriesRemoved++;
    }
  }

  if (options.dryRun) {
    console.log(chalk.yellow(`[DRY RUN] Would prune ${pruned} worktree(s), remove ${directoriesRemoved} directory(ies)`));
  } else {
    console.log(chalk.green(`Pruned ${pruned} worktree(s), removed ${directoriesRemoved} directory(ies)`));
  }
}
