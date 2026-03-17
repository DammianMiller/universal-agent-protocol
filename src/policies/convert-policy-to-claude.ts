#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function convertPolicyToClaude(rawMarkdown: string): string {
  const nameMatch = rawMarkdown.match(/^#\s+(.+)/m);
  const name = nameMatch ? nameMatch[1].trim() : 'Untitled Policy';

  const descMatch = rawMarkdown.match(/^#\s*.*\n\n(.*?)(?=\n-{3,}|##|$)/s);
  const description = descMatch ? descMatch[1].trim() : '';

  const rulesSection = rawMarkdown.match(/## Rules\n\n([\s\S]*?)(?=\n┌|## Enforcement|$)/);
  const rules: Array<{ title: string; details: string[] }> = [];

  if (rulesSection) {
    const ruleLines = rulesSection[1].split('\n');
    let currentRule: { title: string; details: string[] } | null = null;

    for (const line of ruleLines) {
      const ruleMatch = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*/);
      if (ruleMatch) {
        if (currentRule) rules.push(currentRule);
        currentRule = { title: ruleMatch[2], details: [] };
        continue;
      }

      if (line.trim().startsWith('- ')) {
        currentRule?.details.push(line.trim().substring(2));
      } else if (line.trim() && !line.startsWith('#')) {
        currentRule?.details.push(line.trim());
      }
    }
    if (currentRule) rules.push(currentRule);
  }

  const tableMatch = rawMarkdown.match(/\| Rule[^|]+\| Prevents \|[\s\S]*?\n└────────.*\n/);
  const preventionTable: Array<{ rule: string; prevents: string }> = [];

  if (tableMatch) {
    const rows = tableMatch[0].split('\n').filter((_, i) => i > 1 && !_.includes('---'));
    for (const row of rows) {
      const cells = row
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 2) {
        preventionTable.push({ rule: cells[0], prevents: cells[1] });
      }
    }
  }

  const levelMatch = rawMarkdown.match(/## Enforcement Level\s*\n\[(.+?)\]/);
  const level = (levelMatch?.[1]?.toUpperCase() || 'RECOMMENDED') as any;

  const emoji = level === 'REQUIRED' ? '🚨' : level === 'RECOMMENDED' ? '⚠️' : 'ℹ️';

  return `─────────────────────────────────────────────────────────────────────────────────────────────────
${emoji} ${level} POLICY
# ${name}

${description}

─────────────────────────────────────────────────────────────────────────────────────────────────

## Rules

${rules
  .map(
    (rule, i) => `### ${i + 1}. ${rule.title}

${rule.details.join('\n')}
`
  )
  .join('')}

## Prevention Matrix

| Rule | Prevents |
|------|----------|
${preventionTable.map((t) => `| ${t.rule} | ${t.prevents} |`).join('\n')}

─────────────────────────────────────────────────────────────────────────────────────────────────
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3] || 'converted-policy.md';

  if (!inputFile) {
    console.error('Usage: tsx convert-policy-to-claude.ts <input.md> [output.md]');
    process.exit(1);
  }

  const rawPolicy = readFileSync(inputFile, 'utf-8');
  const converted = convertPolicyToClaude(rawPolicy);
  writeFileSync(outputFile, converted);
  console.log(`✅ Converted ${join(process.cwd(), inputFile)} → ${outputFile}`);
}
