/**
 * Open-Collider Ideation CLI Tests
 *
 * Verifies project scaffolding produces the open-collider file contract, and
 * that curated-idea reading locates and parses the newest curated_ideas.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ideateSetup,
  readCuratedIdeas,
  findCuratedIdeasFile,
} from '../../src/cli/ideate.js';

describe('ideate CLI', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-ideate-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scaffolds the open-collider project file contract', async () => {
    await ideateSetup('demo', { dir: join(root, 'projects'), json: true });
    const dir = join(root, 'projects', 'demo');
    for (const f of [
      'brief_validated.json',
      'input_bank.yaml',
      'project_config.yaml',
      join('prompts', 'idea_generation.md'),
      join('prompts', 'judge.md'),
      join('texts', 'T01.txt'),
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    // brief is valid JSON with scoring axes
    const brief = JSON.parse(readFileSync(join(dir, 'brief_validated.json'), 'utf-8'));
    expect(brief.scoring_axes).toContain('non-triviality');
  });

  it('reads curated ideas, picking the newest brainstorm', () => {
    const dir = join(root, 'projects', 'demo');
    const iter1 = join(dir, 'brainstorms', 'brainstorm_001', 'iter_001');
    mkdirSync(iter1, { recursive: true });
    writeFileSync(
      join(iter1, 'curated_ideas.json'),
      JSON.stringify({ ideas: ['collide thermodynamics with scheduling', 'use swarm routing'] })
    );

    const file = findCuratedIdeasFile(dir);
    expect(file).toBe(join(iter1, 'curated_ideas.json'));

    const ideas = readCuratedIdeas(dir);
    expect(ideas).toHaveLength(2);
    expect(ideas[0]).toContain('thermodynamics');
  });

  it('returns no ideas when none have been produced', () => {
    const dir = join(root, 'projects', 'demo');
    mkdirSync(dir, { recursive: true });
    expect(findCuratedIdeasFile(dir)).toBeNull();
    expect(readCuratedIdeas(dir)).toEqual([]);
  });
});
