import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { rankIdeasByNovelty } from '../quality/ideation.js';
import { corpusNovelty } from '../quality/ideation-corpus.js';

export interface IdeateOptions {
  force?: boolean;
  json?: boolean;
  dir?: string;
  /** Print the candidates as measurable ideation-outcome Markdown. */
  render?: boolean;
  /** Rank against the fleet's prior art (embedding seam) — the retread axis. */
  corpus?: boolean;
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

/**
 * Render curated ideas into the measurable ideation-outcome artifact: one `##`
 * section per candidate (the extractor's section boundary). Inner headings
 * inside an idea are demoted to plain lines so a candidate stays ONE section.
 * `uap quality anchor ideation-outcome --file <this>` then measures it.
 */
export function renderIdeasMarkdown(ideas: string[]): string {
  const sections = ideas.map(
    (idea, i) => `## Candidate ${i + 1}\n\n${idea.replace(/^#{1,6}\s/gm, '').trim()}\n`,
  );
  return `# Ideation candidates\n\n${sections.join('\n')}`;
}

/** `uap ideate ideas <name>` — print curated ideas, ranked by measured novelty. */
export async function ideateIdeas(name: string, options: IdeateOptions = {}): Promise<void> {
  const dir = projectDir(name, options);
  const ideas = readCuratedIdeas(dir);
  if (options.render) {
    if (ideas.length === 0) {
      console.error(chalk.yellow(`No curated ideas found for "${name}" yet — nothing to render.`));
      process.exit(2);
    }
    process.stdout.write(renderIdeasMarkdown(ideas));
    return;
  }
  // Corpus-novelty overlay (plan F, the seam half): distance of each
  // candidate from the NEAREST PRIOR solution in the fleet's semantic
  // store. Fail-open — a missing seam ranks by in-set distance only and
  // says why it did.
  let corpus: Awaited<ReturnType<typeof corpusNovelty>> | null = null;
  if (options.corpus) {
    corpus = await corpusNovelty(ideas.map((idea) => ({ prose: idea })), { cwd: process.cwd() });
    if (!corpus.ok) {
      console.error(chalk.dim(`  corpus-novelty unavailable: ${corpus.reason ?? 'unknown'} — ranking in-set only`));
      corpus = null;
    }
  }
  if (options.json) {
    const ranked = rankIdeasByNovelty(ideas);
    const corpusRanked = corpus
      ? corpus.perCandidate!
          .map((d, index) => ({ index, corpusDistance: d }))
          .sort((a, b) => b.corpusDistance - a.corpusDistance)
      : undefined;
    process.stdout.write(
      JSON.stringify(
        {
          project: name,
          count: ideas.length,
          ideas,
          // Plan F: the judge proposes, the measured distance decides —
          // rank by mean lexical distance to the other candidates.
          novelty_rank: ranked.map((r) => ({ index: r.index, novelty: r.novelty })),
          // The retread axis: nearest-prior-art distance per candidate
          // (1 = no nearby prior solution; near 0 = the corpus has this).
          ...(corpus
            ? {
                corpus_novelty: {
                  provider: corpus.provider,
                  collections: corpus.collections,
                  mean: corpus.mean,
                  min: corpus.min,
                  per_candidate: corpus.perCandidate,
                  rank: corpusRanked,
                },
              }
            : {}),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (ideas.length === 0) {
    console.log(chalk.yellow(`\nNo curated ideas found for "${name}" yet. Run: uap ideate run ${name}\n`));
    return;
  }
  const ranked = rankIdeasByNovelty(ideas);
  console.log(chalk.bold(`\n💡 Curated Ideas — ${name} (${ideas.length})\n`));
  ideas.forEach((idea, i) => console.log(`  ${chalk.cyan(`${i + 1}.`)} ${idea}`));
  console.log('');
  console.log(chalk.dim('  Ranked by measured novelty (nearest-neighbor lexical distance):'));
  ranked.slice(0, 3).forEach((r) => {
    const oneLine = r.idea.replace(/\s+/g, ' ').slice(0, 70);
    console.log(`    ${chalk.cyan(`#${r.index + 1}`)} distance ${r.novelty.toFixed(3)} — ${oneLine}${r.idea.length > 70 ? '…' : ''}`);
  });
  if (corpus) {
    console.log(chalk.dim(`  Corpus-novelty (prior-art distance, ${corpus.collections.join(' + ')}): mean ${corpus.mean?.toFixed(3)}, closest ${corpus.min?.toFixed(3)}`));
    corpus.perCandidate!
      .map((d, index) => ({ index, d }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 3)
      .forEach((r) => {
        const oneLine = ideas[r.index].replace(/\s+/g, ' ').slice(0, 70);
        console.log(`    ${chalk.cyan(`#${r.index + 1}`)} prior-art distance ${r.d.toFixed(3)} — ${oneLine}${ideas[r.index].length > 70 ? '…' : ''}`);
      });
  }
  console.log(chalk.dim(`  Render the measurable artifact with: uap ideate ideas ${name} --render\n`));
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
