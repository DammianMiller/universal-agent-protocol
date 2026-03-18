import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

type DroidsAction = 'list' | 'add' | 'import';

interface DroidsOptions {
  name?: string;
  template?: string;
  path?: string;
}

const BUILTIN_TEMPLATES: Record<string, { description: string; content: string }> = {
  'code-reviewer': {
    description: 'Reviews diffs for correctness, tests, and migration risks',
    content: `---
name: code-reviewer
description: Reviews diffs for correctness, tests, and migration risks
model: inherit
tools: ["Read", "LS", "Grep", "Glob"]
---

You are a senior code reviewer. Examine the diff and context provided:

- Summarize the intent of the change
- Flag correctness risks, missing tests, or rollback hazards
- Call out any migrations or data changes that need coordination

Reply with:
Summary: <one-line>
Findings:
- <issue or ✅ No blockers>
Follow-up:
- <action or leave blank>
`,
  },
  'security-reviewer': {
    description: 'Looks for security issues in code changes',
    content: `---
name: security-reviewer
description: Looks for security issues in recently edited files
model: inherit
tools: ["Read", "Grep", "WebSearch"]
---

Investigate the files referenced for security issues:

- Identify injection, insecure transport, privilege escalation, or secrets exposure
- Check for OWASP Top 10 vulnerabilities
- Suggest concrete mitigations
- Link to relevant CWE or standards when helpful

Respond with:
Summary: <headline>
Findings:
- <file>: <issue>
Mitigations:
- <recommendation>
`,
  },
  'performance-reviewer': {
    description: 'Identifies performance bottlenecks and optimization opportunities',
    content: `---
name: performance-reviewer
description: Identifies performance bottlenecks in code changes
model: inherit
tools: ["Read", "Grep", "Glob"]
---

Analyze the code for performance issues:

- Algorithmic complexity (O(n²), unnecessary iterations)
- N+1 query patterns
- Missing caching opportunities
- Memory leaks or excessive allocations
- I/O bottlenecks

Respond with:
Summary: <headline>
Issues:
- <file:line>: <issue> (severity: high/medium/low)
Recommendations:
- <optimization suggestion>
`,
  },
  'test-writer': {
    description: 'Generates unit tests for code changes',
    content: `---
name: test-writer
description: Generates comprehensive unit tests for code
model: inherit
tools: ["Read", "Create", "Edit", "Execute"]
---

Generate tests for the provided code:

1. Analyze the code to understand its behavior
2. Identify edge cases and error conditions
3. Write comprehensive unit tests
4. Ensure tests are idiomatic for the language/framework
5. Include both happy path and error cases

Follow the project's existing test patterns and conventions.
`,
  },
};

export async function droidsCommand(
  action: DroidsAction,
  options: DroidsOptions = {}
): Promise<void> {
  const cwd = process.cwd();

  switch (action) {
    case 'list':
      await listDroids(cwd);
      break;
    case 'add':
      if (!options.name) {
        console.log(chalk.red('Droid name is required. Usage: uap droids add <name>'));
        return;
      }
      await addDroid(cwd, options.name, options.template);
      break;
    case 'import':
      if (!options.path) {
        console.log(chalk.red('Source path is required. Usage: uap droids import <path>'));
        return;
      }
      await importDroids(cwd, options.path);
      break;
  }
}

async function listDroids(cwd: string): Promise<void> {
  console.log(chalk.bold('\n🤖 Available Droids\n'));

  const droidPaths = [
    { path: join(cwd, '.factory/droids'), label: 'Project (.factory/droids)' },
    { path: join(cwd, '.claude/agents'), label: 'Claude Code (.claude/agents)' },
    { path: join(cwd, '.opencode/agent'), label: 'OpenCode (.opencode/agent)' },
    {
      path: join(process.env.HOME || '~', '.factory/droids'),
      label: 'Personal (~/.factory/droids)',
    },
  ];

  let found = false;

  for (const { path, label } of droidPaths) {
    if (existsSync(path)) {
      const files = readdirSync(path).filter((f) => f.endsWith('.md'));
      if (files.length > 0) {
        console.log(chalk.bold(label));
        for (const file of files) {
          const content = readFileSync(join(path, file), 'utf-8');
          const descMatch = content.match(/description:\s*(.+)/);
          const desc = descMatch ? descMatch[1].trim() : 'No description';
          console.log(`  ${chalk.cyan(basename(file, '.md'))}: ${chalk.dim(desc)}`);
        }
        console.log('');
        found = true;
      }
    }
  }

  if (!found) {
    console.log(chalk.yellow('No droids found.'));
    console.log(chalk.dim('Create one with: uap droids add <name>'));
  }

  console.log(chalk.bold('Built-in Templates:'));
  for (const [name, { description }] of Object.entries(BUILTIN_TEMPLATES)) {
    console.log(`  ${chalk.cyan(name)}: ${chalk.dim(description)}`);
  }
  console.log('');
}

async function addDroid(cwd: string, name: string, template?: string): Promise<void> {
  const spinner = ora(`Creating droid: ${name}...`).start();

  try {
    // Determine target directory
    const droidDir = join(cwd, '.factory/droids');
    if (!existsSync(droidDir)) {
      mkdirSync(droidDir, { recursive: true });
    }

    const droidPath = join(droidDir, `${name}.md`);

    if (existsSync(droidPath)) {
      spinner.fail(`Droid already exists: ${name}`);
      return;
    }

    let content: string;

    if (template && BUILTIN_TEMPLATES[template]) {
      content = BUILTIN_TEMPLATES[template].content.replace(/name: .+/, `name: ${name}`);
    } else if (template) {
      spinner.fail(`Unknown template: ${template}`);
      console.log(chalk.dim('Available templates: ' + Object.keys(BUILTIN_TEMPLATES).join(', ')));
      return;
    } else {
      content = `---
name: ${name}
description: Custom droid for ${name}
model: inherit
tools: ["Read", "LS", "Grep", "Glob"]
---

You are a specialized assistant for ${name} tasks.

Describe what this droid should do and how it should respond.
`;
    }

    writeFileSync(droidPath, content);
    spinner.succeed(`Created droid: ${name}`);
    console.log(chalk.dim(`  Path: ${droidPath}`));
    console.log(chalk.dim(`  Edit the file to customize the droid's behavior.`));
  } catch (error) {
    spinner.fail('Failed to create droid');
    console.error(chalk.red(error));
  }
}

async function importDroids(cwd: string, sourcePath: string): Promise<void> {
  const spinner = ora('Importing droids...').start();

  try {
    if (!existsSync(sourcePath)) {
      spinner.fail(`Path not found: ${sourcePath}`);
      return;
    }

    const files = readdirSync(sourcePath).filter((f) => f.endsWith('.md'));

    if (files.length === 0) {
      spinner.fail('No .md files found in source path');
      return;
    }

    const targetDir = join(cwd, '.factory/droids');
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    let imported = 0;
    for (const file of files) {
      const content = readFileSync(join(sourcePath, file), 'utf-8');
      const targetPath = join(targetDir, file);

      if (existsSync(targetPath)) {
        console.log(chalk.yellow(`  Skipped (exists): ${file}`));
        continue;
      }

      writeFileSync(targetPath, content);
      imported++;
    }

    spinner.succeed(`Imported ${imported} droid(s)`);
  } catch (error) {
    spinner.fail('Failed to import droids');
    console.error(chalk.red(error));
  }
}
