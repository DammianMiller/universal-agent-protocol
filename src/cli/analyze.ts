import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { analyzeProject } from '../analyzers/index.js';

interface AnalyzeOptions {
  output: 'json' | 'yaml' | 'md';
  save?: boolean;
}

export async function analyzeCommand(options: AnalyzeOptions): Promise<void> {
  const cwd = process.cwd();
  const spinner = ora('Analyzing project...').start();

  try {
    const analysis = await analyzeProject(cwd);
    spinner.succeed('Analysis complete');

    let output: string;

    switch (options.output) {
      case 'yaml':
        output = yaml.dump(analysis, { indent: 2, lineWidth: 120 });
        break;
      case 'md':
        output = formatAsMarkdown(analysis);
        break;
      case 'json':
      default:
        output = JSON.stringify(analysis, null, 2);
        break;
    }

    console.log('\n' + output);

    if (options.save) {
      const filename = `.uap.analysis.${options.output === 'md' ? 'md' : 'json'}`;
      writeFileSync(join(cwd, filename), output);
      console.log(chalk.green(`\nSaved to ${filename}`));
    }
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(error));
    process.exit(1);
  }
}

function formatAsMarkdown(analysis: ReturnType<typeof analyzeProject> extends Promise<infer T> ? T : never): string {
  const lines: string[] = [
    `# Project Analysis: ${analysis.projectName}`,
    '',
    analysis.description ? `> ${analysis.description}` : '',
    '',
    '## Overview',
    '',
    `| Property | Value |`,
    `|----------|-------|`,
    `| Default Branch | \`${analysis.defaultBranch}\` |`,
    `| Languages | ${analysis.languages.join(', ') || 'N/A'} |`,
    `| Frameworks | ${analysis.frameworks.join(', ') || 'N/A'} |`,
    `| Package Managers | ${analysis.packageManagers.join(', ') || 'N/A'} |`,
    '',
  ];

  if (analysis.urls.length > 0) {
    lines.push('## URLs', '');
    for (const url of analysis.urls) {
      lines.push(`- **${url.name}**: ${url.value}`);
    }
    lines.push('');
  }

  if (analysis.components.length > 0) {
    lines.push('## Components', '');
    for (const comp of analysis.components) {
      lines.push(`### ${comp.name} (\`${comp.path}\`)`);
      lines.push('');
      lines.push(`- **Language**: ${comp.language}`);
      if (comp.framework) lines.push(`- **Framework**: ${comp.framework}`);
      lines.push(`- ${comp.description}`);
      lines.push('');
    }
  }

  if (analysis.databases.length > 0) {
    lines.push('## Databases', '');
    for (const db of analysis.databases) {
      lines.push(`- **${db.type}**: ${db.purpose}`);
    }
    lines.push('');
  }

  if (analysis.ciCd) {
    lines.push('## CI/CD', '');
    lines.push(`Platform: ${analysis.ciCd.platform}`, '');
    lines.push('| Workflow | Purpose |');
    lines.push('|----------|---------|');
    for (const wf of analysis.ciCd.workflows) {
      lines.push(`| \`${wf.file}\` | ${wf.purpose} |`);
    }
    lines.push('');
  }

  if (analysis.existingDroids.length > 0) {
    lines.push('## Existing Droids', '');
    lines.push(analysis.existingDroids.map((d) => `- \`${d}\``).join('\n'));
    lines.push('');
  }

  if (analysis.existingCommands.length > 0) {
    lines.push('## Existing Commands', '');
    lines.push(analysis.existingCommands.map((c) => `- \`${c}\``).join('\n'));
    lines.push('');
  }

  return lines.join('\n');
}
