import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';

type SkillAction = 'list' | 'load';

interface SkillOptions {
  category?: string;
  json?: boolean;
  skill?: string;
}

interface SkillEntry {
  name: string;
  path: string;
  source: 'project' | 'factory' | 'claude';
}

const ROOTS: Array<{ source: SkillEntry['source']; path: string }> = [
  { source: 'project', path: 'skills' },
  { source: 'factory', path: '.factory/skills' },
  { source: 'claude', path: '.claude/skills' },
];

export async function skillCommand(action: SkillAction, options: SkillOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const skills = discoverSkills(cwd, options.category);

  switch (action) {
    case 'list':
      renderSkillList(skills, options.json);
      break;
    case 'load':
      if (!options.skill) {
        console.error(chalk.red('Error: skill name required'));
        process.exit(1);
      }
      await loadSkill(skills, options.skill, options.json);
      break;
  }
}

function discoverSkills(cwd: string, category?: string): SkillEntry[] {
  const entries: SkillEntry[] = [];

  for (const root of ROOTS) {
    const rootPath = join(cwd, root.path);
    if (!existsSync(rootPath)) continue;
    if (category && !root.path.includes(category)) continue;

    const items = readdirSync(rootPath, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        const skillDir = join(rootPath, item.name);
        const skillFile = join(skillDir, 'SKILL.md');
        if (existsSync(skillFile)) {
          entries.push({ name: item.name, path: skillFile, source: root.source });
        }
        continue;
      }

      if (item.isFile() && item.name.endsWith('.md')) {
        entries.push({
          name: basename(item.name, '.md'),
          path: join(rootPath, item.name),
          source: root.source,
        });
      }
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function renderSkillList(skills: SkillEntry[], json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  if (skills.length === 0) {
    console.log(chalk.dim('No skills found'));
    return;
  }

  console.log(chalk.bold('\nAvailable Skills\n'));
  for (const skill of skills) {
    console.log(`  ${chalk.cyan(skill.name)} ${chalk.dim(`[${skill.source}]`)}`);
  }
  console.log('');
}

async function loadSkill(skills: SkillEntry[], name: string, json?: boolean): Promise<void> {
  const normalized = name.toLowerCase();
  const match = skills.find((skill) => skill.name.toLowerCase() === normalized);

  if (!match) {
    console.error(chalk.red(`Skill not found: ${name}`));
    process.exit(1);
  }

  const content = readFileSync(match.path, 'utf-8');
  if (json) {
    console.log(JSON.stringify({ ...match, content }, null, 2));
    return;
  }

  console.log(chalk.bold(`\n${match.name}`));
  console.log(chalk.dim(`Source: ${match.source}`));
  console.log(chalk.dim(`Path: ${match.path}`));
  console.log('');
  console.log(content.trim());
  console.log('');
}
