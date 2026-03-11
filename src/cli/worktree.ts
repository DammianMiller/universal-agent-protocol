import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

type WorktreeAction = 'create' | 'list' | 'pr' | 'cleanup';

interface WorktreeOptions {
  slug?: string;
  id?: string;
  draft?: boolean;
}

export async function worktreeCommand(action: WorktreeAction, options: WorktreeOptions = {}): Promise<void> {
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
  }
}

async function getNextId(cwd: string): Promise<number> {
  const worktreesDir = join(cwd, '.worktrees');
  if (!existsSync(worktreesDir)) {
    return 1;
  }

  const entries = readdirSync(worktreesDir);
  const ids = entries
    .map((e) => parseInt(e.split('-')[0]))
    .filter((n) => !isNaN(n));

  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

async function createWorktree(cwd: string, git: SimpleGit, slug: string): Promise<void> {
  const spinner = ora('Creating worktree...').start();

  try {
    // Get next ID
    const id = await getNextId(cwd);
    const paddedId = String(id).padStart(3, '0');
    const worktreeName = `${paddedId}-${slug}`;
    const branchName = `feature/${worktreeName}`;
    const worktreePath = join(cwd, '.worktrees', worktreeName);

    // Get current branch (base)
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);

    // Create worktree with new branch
    spinner.text = `Creating branch ${branchName}...`;
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, currentBranch.trim()]);

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
        const name = path.split('.worktrees/')[1];
        const id = name?.split('-')[0] || '-';
        console.log(`| ${id} | ${name} | ${branch || 'detached'} | ${path} |`);
      }
    }

    console.log('');
  } catch (error) {
    console.error(chalk.red('Failed to list worktrees'));
    console.error(error);
  }
}

async function createPR(
  cwd: string,
  _git: SimpleGit,
  id: string,
  draft?: boolean
): Promise<void> {
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
      console.log(chalk.yellow('Create PR manually or ensure `gh` CLI is installed and authenticated'));
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

    spinner.succeed(`Cleaned up: ${worktree}`);
  } catch (error) {
    spinner.fail('Failed to cleanup worktree');
    console.error(chalk.red(error));
  }
}
