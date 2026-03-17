import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';

interface SyncOptions {
  from?: string;
  to?: string;
  dryRun?: boolean;
}

const SUPPORTED_PLATFORMS = ['claude', 'factory', 'opencode', 'vscode'];

/** Platform directory roots */
const PLATFORM_DIRS: Record<string, string> = {
  claude: '.claude',
  factory: '.factory',
  opencode: '.opencode',
  vscode: '.vscode',
};

interface DroidDef {
  name: string;
  description: string;
  model: string;
  body: string;
  coordination?: Record<string, unknown>;
  tools?: string[];
}

interface SkillDef {
  name: string;
  description: string;
  model: string;
  body: string;
  version?: string;
  category?: string;
  priority?: number;
  triggers?: string[];
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { meta, body } where meta is a simple key-value map.
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, unknown> = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse simple arrays: [a, b, c]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''));
    }
    // Parse booleans
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    // Parse numbers
    if (typeof value === 'string' && /^\d+$/.test(value)) value = parseInt(value, 10);

    meta[key] = value;
  }

  return { meta, body: match[2].trim() };
}

/**
 * Serialize frontmatter + body back to markdown.
 */
function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(', ')}]`);
    } else if (typeof value === 'object') {
      // Skip complex objects in frontmatter serialization
      continue;
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(body);
  return lines.join('\n');
}

/**
 * Read droids from a platform directory.
 */
function readDroids(platform: string): DroidDef[] {
  const droids: DroidDef[] = [];
  const dir = platform === 'factory' ? '.factory/droids' : `${PLATFORM_DIRS[platform]}/agents`;

  if (!existsSync(dir)) return droids;

  for (const file of readdirSync(dir)) {
    const filePath = join(dir, file);
    const ext = extname(file);

    if (ext === '.md') {
      const content = readFileSync(filePath, 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      droids.push({
        name: (meta.name as string) || basename(file, '.md'),
        description: (meta.description as string) || '',
        model: (meta.model as string) || 'inherit',
        body,
        coordination: meta.coordination as Record<string, unknown> | undefined,
        tools: meta.tools as string[] | undefined,
      });
    } else if (ext === '.json') {
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        droids.push({
          name: data.name || basename(file, '.json'),
          description: data.description || '',
          model: data.model || 'inherit',
          body: data.instructions || data.prompt || '',
          coordination: data.coordination,
          tools: data.tools,
        });
      } catch {
        // Skip invalid JSON
      }
    }
  }

  return droids;
}

/**
 * Write droids to a platform directory.
 */
function writeDroids(platform: string, droids: DroidDef[], dryRun: boolean): number {
  const dir = platform === 'factory' ? '.factory/droids' : `${PLATFORM_DIRS[platform]}/agents`;

  if (!dryRun && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let written = 0;
  for (const droid of droids) {
    const meta: Record<string, unknown> = {
      name: droid.name,
      description: droid.description,
      model: droid.model,
    };
    if (droid.tools && droid.tools.length > 0) {
      meta.tools = droid.tools;
    }
    if (platform === 'factory' && droid.coordination) {
      // Factory supports coordination metadata
      meta.coordination = droid.coordination;
    }

    const content = serializeFrontmatter(meta, droid.body);
    const filePath = join(dir, `${droid.name}.md`);

    if (dryRun) {
      console.log(chalk.dim(`  [dry-run] Would write: ${filePath}`));
    } else {
      writeFileSync(filePath, content);
    }
    written++;
  }

  return written;
}

/**
 * Read skills from a platform directory.
 */
function readSkills(platform: string): SkillDef[] {
  const skills: SkillDef[] = [];
  const dir = `${PLATFORM_DIRS[platform]}/skills`;

  if (!existsSync(dir)) return skills;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, 'utf-8');
        const { meta, body } = parseFrontmatter(content);
        skills.push({
          name: (meta.name as string) || entry.name,
          description: (meta.description as string) || '',
          model: (meta.model as string) || 'inherit',
          body,
          version: meta.version as string | undefined,
          category: meta.category as string | undefined,
          priority: meta.priority as number | undefined,
          triggers: meta.triggers as string[] | undefined,
        });
      }
    } else if (entry.name.endsWith('.md')) {
      const content = readFileSync(join(dir, entry.name), 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      skills.push({
        name: (meta.name as string) || basename(entry.name, '.md'),
        description: (meta.description as string) || '',
        model: (meta.model as string) || 'inherit',
        body,
        version: meta.version as string | undefined,
        category: meta.category as string | undefined,
        priority: meta.priority as number | undefined,
        triggers: meta.triggers as string[] | undefined,
      });
    }
  }

  return skills;
}

/**
 * Write skills to a platform directory.
 */
function writeSkills(platform: string, skills: SkillDef[], dryRun: boolean): number {
  const dir = `${PLATFORM_DIRS[platform]}/skills`;

  if (!dryRun && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let written = 0;
  for (const skill of skills) {
    const skillDir = join(dir, skill.name);
    const skillFile = join(skillDir, 'SKILL.md');

    const meta: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
      model: skill.model,
    };
    if (skill.version) meta.version = skill.version;
    if (skill.category) meta.category = skill.category;
    if (skill.priority !== undefined) meta.priority = skill.priority;
    if (skill.triggers && skill.triggers.length > 0) meta.triggers = skill.triggers;

    const content = serializeFrontmatter(meta, skill.body);

    if (dryRun) {
      console.log(chalk.dim(`  [dry-run] Would write: ${skillFile}`));
    } else {
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
      }
      writeFileSync(skillFile, content);
    }
    written++;
  }

  return written;
}

/**
 * Read commands from Claude's commands.json.
 */
function readClaudeCommands(): Record<string, string> {
  const cmdFile = '.claude/commands.json';
  if (!existsSync(cmdFile)) return {};
  try {
    return JSON.parse(readFileSync(cmdFile, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write commands to Claude's commands.json.
 */
function writeClaudeCommands(commands: Record<string, string>, dryRun: boolean): number {
  const cmdFile = '.claude/commands.json';
  if (dryRun) {
    console.log(
      chalk.dim(`  [dry-run] Would write: ${cmdFile} (${Object.keys(commands).length} commands)`)
    );
    return Object.keys(commands).length;
  }
  const dir = '.claude';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cmdFile, JSON.stringify(commands, null, 2));
  return Object.keys(commands).length;
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  console.log(chalk.bold('\nPlatform Sync\n'));

  if (!options.from && !options.to) {
    console.log(chalk.yellow('Specify --from and/or --to platforms'));
    console.log(chalk.dim('\nSupported platforms: ' + SUPPORTED_PLATFORMS.join(', ')));
    console.log(chalk.dim('\nExample:'));
    console.log(chalk.dim('  uap sync --from claude --to factory'));
    console.log(chalk.dim('  uap sync --from factory --to claude'));
    console.log(chalk.dim('  uap sync --from factory --to claude --dry-run'));
    return;
  }

  // Validate platform names
  if (options.from && !SUPPORTED_PLATFORMS.includes(options.from)) {
    console.error(chalk.red(`Unknown source platform: ${options.from}`));
    console.log(chalk.dim('Supported: ' + SUPPORTED_PLATFORMS.join(', ')));
    process.exitCode = 1;
    return;
  }
  if (options.to && !SUPPORTED_PLATFORMS.includes(options.to)) {
    console.error(chalk.red(`Unknown target platform: ${options.to}`));
    console.log(chalk.dim('Supported: ' + SUPPORTED_PLATFORMS.join(', ')));
    process.exitCode = 1;
    return;
  }

  if (!options.from || !options.to) {
    console.error(chalk.red('Both --from and --to are required'));
    process.exitCode = 1;
    return;
  }

  if (options.from === options.to) {
    console.error(chalk.red('Source and target platforms must be different'));
    process.exitCode = 1;
    return;
  }

  const dryRun = options.dryRun || false;
  if (dryRun) {
    console.log(chalk.yellow('Dry run mode - no files will be written\n'));
  }

  console.log(`Syncing: ${chalk.cyan(options.from)} -> ${chalk.green(options.to)}\n`);

  let totalSynced = 0;

  // Sync droids/agents
  console.log(chalk.bold('Droids/Agents:'));
  const droids = readDroids(options.from);
  if (droids.length === 0) {
    console.log(chalk.dim('  No droids found in source'));
  } else {
    // Filter out test droids
    const realDroids = droids.filter((d) => !d.name.startsWith('test-droid'));
    if (realDroids.length === 0) {
      console.log(chalk.dim(`  Found ${droids.length} droids (all test droids, skipping)`));
    } else {
      const written = writeDroids(options.to, realDroids, dryRun);
      console.log(chalk.green(`  Synced ${written} droid(s)`));
      totalSynced += written;
    }
  }

  // Sync skills
  console.log(chalk.bold('Skills:'));
  const skills = readSkills(options.from);
  if (skills.length === 0) {
    console.log(chalk.dim('  No skills found in source'));
  } else {
    const written = writeSkills(options.to, skills, dryRun);
    console.log(chalk.green(`  Synced ${written} skill(s)`));
    totalSynced += written;
  }

  // Sync commands (Claude <-> Factory)
  if (
    (options.from === 'claude' || options.to === 'claude') &&
    (options.from === 'factory' || options.to === 'factory')
  ) {
    console.log(chalk.bold('Commands:'));
    if (options.from === 'claude') {
      const commands = readClaudeCommands();
      const count = Object.keys(commands).length;
      if (count === 0) {
        console.log(chalk.dim('  No commands found in source'));
      } else {
        // Write as individual files in .factory/commands/
        const cmdDir = '.factory/commands';
        if (!dryRun && !existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true });
        for (const [name, cmd] of Object.entries(commands)) {
          const filePath = join(cmdDir, `${name}.sh`);
          if (dryRun) {
            console.log(chalk.dim(`  [dry-run] Would write: ${filePath}`));
          } else {
            writeFileSync(filePath, `#!/bin/bash\n${cmd}\n`, { mode: 0o755 });
          }
        }
        console.log(chalk.green(`  Synced ${count} command(s)`));
        totalSynced += count;
      }
    } else {
      // Factory -> Claude: read .factory/commands/*.sh and write to commands.json
      const cmdDir = '.factory/commands';
      if (existsSync(cmdDir)) {
        const commands: Record<string, string> = {};
        for (const file of readdirSync(cmdDir)) {
          if (file.endsWith('.sh')) {
            const content = readFileSync(join(cmdDir, file), 'utf-8');
            const name = basename(file, '.sh');
            // Strip shebang line
            const cmd = content.replace(/^#!.*\n/, '').trim();
            commands[name] = cmd;
          }
        }
        if (Object.keys(commands).length > 0) {
          const written = writeClaudeCommands(commands, dryRun);
          console.log(chalk.green(`  Synced ${written} command(s)`));
          totalSynced += written;
        } else {
          console.log(chalk.dim('  No commands found in source'));
        }
      } else {
        console.log(chalk.dim('  No commands directory found in source'));
      }
    }
  }

  console.log();
  if (totalSynced === 0) {
    console.log(chalk.yellow('Nothing to sync'));
  } else if (dryRun) {
    console.log(chalk.yellow(`Would sync ${totalSynced} item(s) (dry run)`));
  } else {
    console.log(chalk.green(`Synced ${totalSynced} item(s) successfully`));
  }
}
