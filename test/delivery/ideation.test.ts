import { describe, it, expect } from 'vitest';
import {
  generateStrategySeeds,
  parseSeedArray,
  seedsFromIdeas,
} from '../../src/delivery/ideation.js';
import { DEFAULT_STRATEGY_SEEDS } from '../../src/delivery/explorer.js';

describe('parseSeedArray', () => {
  it('parses a clean JSON array of seeds', () => {
    const seeds = parseSeedArray(
      JSON.stringify([
        { id: 'data-flow', hint: 'STRATEGY: Trace the data flow first.' },
        { id: 'contract-first', hint: 'STRATEGY: Define the contract first.' },
      ])
    );
    expect(seeds).toEqual([
      { id: 'data-flow', hint: 'STRATEGY: Trace the data flow first.' },
      { id: 'contract-first', hint: 'STRATEGY: Define the contract first.' },
    ]);
  });

  it('tolerates prose and code fences around the array', () => {
    const raw = 'Here are the strategies:\n```json\n[{"id": "a-b", "hint": "STRATEGY: x"}, {"id": "c", "hint": "STRATEGY: y"}]\n```\nDone.';
    expect(parseSeedArray(raw).map((s) => s.id)).toEqual(['a-b', 'c']);
  });

  it('normalizes ids to kebab-case slugs and dedupes', () => {
    const seeds = parseSeedArray(
      JSON.stringify([
        { id: 'Data Flow!', hint: 'STRATEGY: one' },
        { id: 'data-flow', hint: 'STRATEGY: duplicate' },
        { id: '  ', hint: 'STRATEGY: blank id dropped' },
      ])
    );
    expect(seeds).toEqual([{ id: 'data-flow', hint: 'STRATEGY: one' }]);
  });

  it('survives stray brackets in surrounding prose', () => {
    const raw =
      'Plan [draft]: see notes[0].\n[{"id": "x", "hint": "STRATEGY: a"}, {"id": "y", "hint": "STRATEGY: b"}]\nAlso arr[1] later.';
    expect(parseSeedArray(raw).map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('drops malformed entries and returns [] for garbage', () => {
    expect(parseSeedArray('no json here')).toEqual([]);
    expect(parseSeedArray('[1, "two", {"id": "ok"}]')).toEqual([]);
    expect(parseSeedArray('{"id": "object-not-array"}')).toEqual([]);
  });
});

describe('generateStrategySeeds', () => {
  it('returns model-generated seeds when the response parses', async () => {
    const seeds = await generateStrategySeeds(
      'add a parser',
      async () =>
        JSON.stringify([
          { id: 'lexer-first', hint: 'STRATEGY: Build the lexer first.' },
          { id: 'grammar-first', hint: 'STRATEGY: Write the grammar first.' },
          { id: 'tdd', hint: 'STRATEGY: Tests first.' },
        ])
    );
    expect(seeds.map((s) => s.id)).toEqual(['lexer-first', 'grammar-first', 'tdd']);
  });

  it('falls back to default seeds when the executor throws', async () => {
    const seeds = await generateStrategySeeds('task', async () => {
      throw new Error('model unreachable');
    });
    expect(seeds).toEqual(DEFAULT_STRATEGY_SEEDS);
  });

  it('falls back to default seeds when fewer than two seeds parse', async () => {
    const seeds = await generateStrategySeeds(
      'task',
      async () => '[{"id": "only-one", "hint": "STRATEGY: x"}]'
    );
    expect(seeds).toEqual(DEFAULT_STRATEGY_SEEDS);
  });

  it('caps the seed count at the requested number', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      hint: `STRATEGY: ${i}`,
    }));
    const seeds = await generateStrategySeeds('task', async () => JSON.stringify(many), {
      count: 3,
    });
    expect(seeds).toHaveLength(3);
  });
});

describe('seedsFromIdeas', () => {
  it('converts curated ideas into strategy seeds', () => {
    const seeds = seedsFromIdeas(['Use a ring buffer', 'Model it as a state machine']);
    expect(seeds).toHaveLength(2);
    expect(seeds[0].id).toBe('idea-1');
    expect(seeds[0].hint).toContain('Use a ring buffer');
    expect(seeds[1].hint).toContain('state machine');
  });

  it('returns [] when fewer than two usable ideas exist', () => {
    expect(seedsFromIdeas([])).toEqual([]);
    expect(seedsFromIdeas(['only one'])).toEqual([]);
    expect(seedsFromIdeas(['', '   '])).toEqual([]);
  });

  it('skips blank ideas and respects the count cap', () => {
    const seeds = seedsFromIdeas(['', 'a', 'b', 'c', 'd', 'e'], { count: 3 });
    expect(seeds.map((s) => s.id)).toEqual(['idea-1', 'idea-2', 'idea-3']);
    expect(seeds[0].hint).toContain('a');
  });
});

describe('generateStrategySeeds retry', () => {
  it('recovers when the first completion is empty/degenerate', async () => {
    let calls = 0;
    const executor = async (): Promise<string> => {
      calls++;
      if (calls === 1) return ''; // transient empty completion (proxy no-tool quirk)
      return '[{"id":"grid-first","hint":"STRATEGY: a"},{"id":"loop-first","hint":"STRATEGY: b"}]';
    };
    const { generateStrategySeeds } = await import('../../src/delivery/ideation.js');
    const seeds = await generateStrategySeeds('task', executor);
    expect(calls).toBe(2);
    expect(seeds.map((s) => s.id)).toEqual(['grid-first', 'loop-first']);
  });

  it('falls back to the static defaults only after all attempts fail', async () => {
    let calls = 0;
    const executor = async (): Promise<string> => {
      calls++;
      throw new Error('down');
    };
    const { generateStrategySeeds } = await import('../../src/delivery/ideation.js');
    const { DEFAULT_STRATEGY_SEEDS } = await import('../../src/delivery/explorer.js');
    const seeds = await generateStrategySeeds('task', executor, { attempts: 3 });
    expect(calls).toBe(3);
    expect(seeds).toBe(DEFAULT_STRATEGY_SEEDS);
  });
});

