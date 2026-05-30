import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface IdeateOptions {
  force?: boolean;
  json?: boolean;
  dir?: string;
}

/** Root directory for ideation projects (open-collider `projects/` contract). */
function projectsRoot(options: IdeateOptions = {}): string {
  return options.dir || join(process.cwd(), 'projects');
}

function projectDir(name: string, options: IdeateOptions = {}): string {
  return join(projectsRoot(options), name);
}

const BRIEF_TEMPLATE = {
  problem: 'Describe the problem to ideate on.',
  context: 'Why it matters / constraints.',
  scoring_axes: ['relevance', 'non-triviality', 'viability'],
};

const INPUT_BANK_TEMPLATE = `# Open Collider input bank
# Reference materials the collider draws from. Add domains/seeds below.
references:
  - id: T01
    title: First reference
    file: texts/T01.txt
domains_hint: []   # leave empty — the collider generates structurally distant domains
`;

const PROJECT_CONFIG_TEMPLATE = `# Open Collider project config
mode: skill            # skill (free, Claude Code subagents) | api (ANTHROPIC_API_KEY)
iterations: 1
candidates_per_iteration: 240
`;

const IDEA_GEN_PROMPT = `# Idea Generation
Collide the given reference with a structurally DISTANT knowledge domain.
Surface ideas in low-density regions of idea-space (Koestler bisociation).
Do NOT inject domain-relevant context — that deepens convergence.
`;

const JUDGE_PROMPT = `# Judge
Score each idea on: relevance to the brief, non-triviality (distance from the
obvious cluster), and viability. Curate to the strongest, most distinct ideas.
`;

/** `uap ideate setup <name>` — scaffold an open-collider project. */
export async function ideateSetup(name: string, options: IdeateOptions = {}): Promise<void> {
  if (!name || !name.trim()) {
    console.error(chalk.red('ideate setup: project name required'));
    process.exit(2);
  }
  const dir = projectDir(name, options);
  if (existsSync(dir) && !options.force) {
    console.error(chalk.yellow(`Project already exists at ${dir} (use --force to overwrite).`));
    process.exit(2);
  }

  mkdirSync(join(dir, 'texts'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'brief_validated.json'), JSON.stringify(BRIEF_TEMPLATE, null, 2) + '\n');
  writeFileSync(join(dir, 'input_bank.yaml'), INPUT_BANK_TEMPLATE);
  writeFileSync(join(dir, 'project_config.yaml'), PROJECT_CONFIG_TEMPLATE);
  writeFileSync(join(dir, 'prompts', 'idea_generation.md'), IDEA_GEN_PROMPT);
  writeFileSync(join(dir, 'prompts', 'judge.md'), JUDGE_PROMPT);
  writeFileSync(join(dir, 'texts', 'T01.txt'), 'Paste a reference text here.\n');

  if (options.json) {
    process.stdout.write(JSON.stringify({ created: dir }, null, 2) + '\n');
    return;
  }
  console.log(chalk.green(`\n✓ Ideation project scaffolded at ${dir}\n`));
  console.log('  Next:');
  console.log(`    1. Edit ${chalk.cyan('brief_validated.json')} and add reference texts under ${chalk.cyan('texts/')}`);
  console.log(`    2. Run ${chalk.cyan(`uap ideate run ${name}`)} (Skill mode is free)`);
  console.log(`    3. Read results with ${chalk.cyan(`uap ideate ideas ${name}`)}\n`);
}

/** `uap ideate run <name>` — drive the brainstorm flow. */
export async function ideateRun(name: string, options: IdeateOptions = {}): Promise<void> {
  const dir = projectDir(name, options);
  if (!existsSync(dir)) {
    console.error(chalk.red(`No project at ${dir}. Run: uap ideate setup ${name}`));
    process.exit(2);
  }
  const apiReady = !!process.env.ANTHROPIC_API_KEY;
  console.log(chalk.bold('\n💡 Open Collider — Brainstorm\n'));
  console.log(`  ${chalk.dim('Project:')} ${dir}`);
  console.log(`  ${chalk.dim('Mode:')}    ${apiReady ? 'api available (ANTHROPIC_API_KEY set)' : chalk.green('skill (free)')}`);
  console.log('');
  console.log('  Skill mode (recommended, free): drive via the ideation-expert droid /');
  console.log(`  the open-collider ${chalk.cyan('/brainstorm')} command over this project.`);
  console.log('  Phases: brief → distant domains → collide → curate.');
  console.log('');
  console.log(`  When done, curated ideas land under ${chalk.cyan(`projects/${name}/brainstorms/.../curated_ideas.json`)}`);
  console.log(`  Read them with ${chalk.cyan(`uap ideate ideas ${name}`)}\n`);
}

/** Find the newest curated_ideas.json under a project's brainstorms tree. */
export function findCuratedIdeasFile(dir: string): string | null {
  const brainstorms = join(dir, 'brainstorms');
  if (!existsSync(brainstorms)) return null;
  let newestPath: string | null = null;
  let newestMtime = -1;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry === 'curated_ideas.json' && st.mtimeMs > newestMtime) {
        newestMtime = st.mtimeMs;
        newestPath = p;
      }
    }
  };
  walk(brainstorms);
  return newestPath;
}

/** Read curated ideas as plain strings — the artifact the planning experts consume. */
export function readCuratedIdeas(dir: string): string[] {
  const file = findCuratedIdeasFile(dir);
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const list = Array.isArray(parsed) ? parsed : parsed.ideas || parsed.curated || [];
    return (list as unknown[])
      .map((i) => (typeof i === 'string' ? i : (i as { idea?: string; text?: string }).idea ?? (i as { text?: string }).text ?? ''))
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

/** `uap ideate ideas <name>` — print curated ideas. */
export async function ideateIdeas(name: string, options: IdeateOptions = {}): Promise<void> {
  const dir = projectDir(name, options);
  const ideas = readCuratedIdeas(dir);
  if (options.json) {
    process.stdout.write(JSON.stringify({ project: name, count: ideas.length, ideas }, null, 2) + '\n');
    return;
  }
  if (ideas.length === 0) {
    console.log(chalk.yellow(`\nNo curated ideas found for "${name}" yet. Run: uap ideate run ${name}\n`));
    return;
  }
  console.log(chalk.bold(`\n💡 Curated Ideas — ${name} (${ideas.length})\n`));
  ideas.forEach((idea, i) => console.log(`  ${chalk.cyan(`${i + 1}.`)} ${idea}`));
  console.log('');
}

/** Dispatch for the `uap ideate <subcommand>` group. */
export async function ideateCommand(
  sub: 'setup' | 'run' | 'ideas',
  name: string,
  options: IdeateOptions = {}
): Promise<void> {
  if (sub === 'setup') return ideateSetup(name, options);
  if (sub === 'run') return ideateRun(name, options);
  return ideateIdeas(name, options);
}
