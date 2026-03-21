import chalk from 'chalk';
import ora from 'ora';
import { cpSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import Database from 'better-sqlite3';

type WorktreeAction = 'create' | 'list' | 'pr' | 'cleanup' | 'ensure' | 'prune';

interface WorktreeOptions {
  slug?: string;
  id?: string;
  draft?: boolean;
  strict?: boolean;
  olderThan?: number;
  force?: boolean;
  dryRun?: boolean;
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
      await createWorktree(cwd, git, options.slug!);
      break;
    case 'list':
      await listWorktrees(cwd, git);
      break;
    case 'pr':
      await createPR(cwd, git, options.id!, options.draft);
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

async function createWorktree(cwd: string, git: SimpleGit, slug: string): Promise<void> {
  const spinner = ora('Creating worktree...').start();

  try {
    // Get next ID atomically from DB
    const id = await getNextId(cwd);
    const paddedId = String(id).padStart(3, '0');
    const worktreeName = `${paddedId}-${slug}`;
    const branchName = `feature/${worktreeName}`;
    const worktreePath = join(cwd, '.worktrees', worktreeName);

    // Get current branch (base)
    spinner.text = 'Resolving current branch...';
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);

    // Create worktree with new branch
    spinner.text = `Creating branch ${branchName}...`;
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, currentBranch.trim()]);

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
    console.log(chalk.dim(`  Path: ${worktreePath}`));
    console.log('');
    console.log(chalk.bold('Next steps:'));
    console.log(`  cd .worktrees/${worktreeName}`);
    console.log('  # Make your changes');
    console.log(`  uam worktree pr ${id}`);
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
      console.log(chalk.dim('Create one with: uam worktree create <slug>'));
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
