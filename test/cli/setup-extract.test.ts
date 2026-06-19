import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Avoid touching the real policies.db — capture registration calls instead.
const storeRawPolicy = vi.fn(async () => 'policy-id');
vi.mock('../../src/policies/policy-memory.js', () => ({
  getPolicyMemoryManager: () => ({ storeRawPolicy }),
}));

import {
  classifySection,
  detectCustomSections,
  extractAuto,
  slugify,
} from '../../src/cli/setup-extract.js';

describe('classifySection', () => {
  it('classifies imperative rules as policy', () => {
    const r = classifySection('Secret Handling', 'You MUST NEVER commit secrets. ALWAYS use env vars. REQUIRED gate.');
    expect(r.classification).toBe('policy');
  });
  it('classifies numbered workflows as skill', () => {
    const r = classifySection('How to Deploy', '1. Run build.\n2. Push staging.\n3. Verify smoke test.');
    expect(r.classification).toBe('skill');
  });
  it('leaves ambiguous prose inline', () => {
    const r = classifySection('Notes', 'This project uses a monorepo layout with shared tooling.');
    expect(r.classification).toBe('keep-inline');
  });
});

describe('detectCustomSections + extractAuto', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-extract-'));
    storeRawPolicy.mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeClaude(): void {
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      [
        '# Project',
        '',
        '## Secret Handling',
        'You MUST NEVER commit secrets. ALWAYS use env vars. REQUIRED gate.',
        '',
        '## How to Deploy',
        '1. Run build.',
        '2. Push staging.',
        '',
        '## Memory System',
        'Standard UAP section — should be ignored.',
      ].join('\n')
    );
  }

  it('detects non-standard sections and excludes standard ones', () => {
    writeClaude();
    const detected = detectCustomSections(dir);
    const titles = detected.map((s) => s.title);
    expect(titles).toContain('Secret Handling');
    expect(titles).toContain('How to Deploy');
    expect(titles).not.toContain('Memory System'); // standard → excluded
  });

  it('emits a valid policy (markers present, registered) and a discoverable skill', async () => {
    writeClaude();
    const r = await extractAuto(dir);
    expect(r.extractedPolicies).toContain('secret-handling');
    expect(r.extractedSkills).toContain('how-to-deploy');

    // Policy file has the metadata markers storeRawPolicy parses.
    const policyMd = readFileSync(join(dir, 'policies', 'secret-handling.md'), 'utf-8');
    expect(policyMd).toMatch(/^# secret-handling/m);
    expect(policyMd).toMatch(/\*\*Level\*\*: RECOMMENDED/);
    expect(policyMd).toMatch(/\*\*Enforcement Stage\*\*: pre-exec/);
    expect(storeRawPolicy).toHaveBeenCalledOnce();

    // Skill is discoverable: <name>/SKILL.md with frontmatter.
    const skillMd = readFileSync(join(dir, 'skills', 'how-to-deploy', 'SKILL.md'), 'utf-8');
    expect(skillMd).toMatch(/^---\nname: how-to-deploy\n/);
    expect(skillMd).toMatch(/description: .+/);
  });

  it('is idempotent — re-detect after extraction finds nothing new', async () => {
    writeClaude();
    await extractAuto(dir);
    expect(detectCustomSections(dir)).toHaveLength(0);
  });

  it('resolves slug collisions safely within a run', async () => {
    // Two sections that slugify to the same base in a single run → -2 suffix.
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      '# P\n\n## Secret Handling\nMUST NEVER leak. REQUIRED gate.\n\n## Secret  Handling\nMUST ALWAYS rotate keys. REQUIRED gate.\n'
    );
    await extractAuto(dir);
    const files = readdirSync(join(dir, 'policies'));
    expect(files).toContain('secret-handling.md');
    expect(files.some((f) => /^secret-handling-2\.md$/.test(f))).toBe(true);
  });

  it('emits a YAML-safe skill description even when content has colons/quotes', async () => {
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      '# P\n\n## Build Guide\nNote: use the "fast" path; run the workflow steps. how to build.\n'
    );
    await extractAuto(dir);
    const sk = readdirSync(join(dir, 'skills'))[0];
    const md = readFileSync(join(dir, 'skills', sk, 'SKILL.md'), 'utf-8');
    const descLine = md.split('\n').find((l) => l.startsWith('description:'))!;
    // JSON-quoted → safe YAML flow scalar (starts with a double quote).
    expect(descLine).toMatch(/^description: ".*"$/);
  });

  it('does not re-extract a section already recorded, but does extract a new one', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# P\n\n## Rule A\nMUST NEVER X. REQUIRED gate.\n');
    await extractAuto(dir);
    // Add a second distinct custom section; the first must stay skipped.
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      '# P\n\n## Rule A\nMUST NEVER X. REQUIRED gate.\n\n## Rule B\nMUST ALWAYS Y. REQUIRED gate.\n'
    );
    const detected = detectCustomSections(dir);
    expect(detected.map((s) => s.title)).toEqual(['Rule B']);
  });

  it('slugify produces kebab-case', () => {
    expect(slugify('How To Deploy!')).toBe('how-to-deploy');
    expect(slugify('')).toBe('custom');
  });

  it('does nothing when there are no instruction files', () => {
    expect(detectCustomSections(dir)).toEqual([]);
    expect(existsSync(join(dir, 'policies'))).toBe(false);
  });
});
