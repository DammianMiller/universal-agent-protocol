/**
 * Open-Collider Ideation CLI Tests
 *
 * Verifies project scaffolding produces the open-collider file contract, and
 * that curated-idea reading locates and parses the newest curated_ideas.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ideateSetup,
  ideateIdeas,
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

  /** Two curated ideas plus one distinct from the other two. */
  function seedCurated(): { projects: string; distinctIndex: number } {
    const dir = join(root, 'projects', 'demo');
    const iter = join(dir, 'brainstorms', 'brainstorm_001', 'iter_001');
    mkdirSync(iter, { recursive: true });
    writeFileSync(
      join(iter, 'curated_ideas.json'),
      JSON.stringify({
        ideas: [
          'The routing cache layer will improve routing cache layer latency.',
          'The routing cache store will improve routing cache store latency.',
          'Acoustic sensor arrays must calibrate against fermented ceramic trays.',
        ],
      }),
    );
    return { projects: join(root, 'projects'), distinctIndex: 2 };
  }

  it('renders the measurable ideation-outcome artifact on --render (plan F)', async () => {
    const { projects } = seedCurated();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => (writes.push(String(chunk)), true));
    try {
      await ideateIdeas('demo', { dir: projects, render: true });
    } finally {
      spy.mockRestore();
    }
    const out = writes.join('');
    expect(out).toContain('## Candidate 1');
    expect(out).toContain('## Candidate 3');
    expect(out).toContain('Acoustic sensor arrays must calibrate');
  });

  it('emits the measured novelty rank in JSON mode (plan F)', async () => {
    const { projects, distinctIndex } = seedCurated();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => (writes.push(String(chunk)), true));
    try {
      await ideateIdeas('demo', { dir: projects, json: true });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.count).toBe(3);
    expect(parsed.novelty_rank[0].index).toBe(distinctIndex);
    expect(parsed.novelty_rank[0].novelty).toBeGreaterThan(parsed.novelty_rank[1].novelty);
  });
});
