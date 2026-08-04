/**
 * Memory durability: where memories are written, and whether they survive.
 *
 * Three defects sat in one function. A store issued from a worktree — which the
 * worktree policy makes the normal case for anyone doing work — resolved its
 * database against the working directory, so the learning landed in a private
 * DB nothing else reads (45 entries were found stranded across 37 worktrees).
 * `importance` was never passed to the store call, so the flag that decides
 * prune order silently did nothing. And long-term storage was a console.log
 * saying it was "not yet integrated", leaving a rolling 50-entry window as the
 * only tier.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { memoryRoot, shortTermDbPath } from '../src/memory/paths.js';
import { recordMemoryQuery } from '../src/cli/memory.js';
import { dimensionedName, storeLongTerm } from '../src/memory/long-term.js';
import type { AgentContextConfig } from '../src/types/index.js';

const MAIN = '/home/u/project';

describe('memory paths resolve to the main checkout', () => {
  it('strips a worktree suffix so every agent shares one store', () => {
    expect(memoryRoot(`${MAIN}/.worktrees/166-some-slug`)).toBe(MAIN);
    expect(memoryRoot(`${MAIN}/.worktrees/166-some-slug/src/deeper`)).toBe(MAIN);
  });

  it('writes gate evidence where the GATE reads it, not where the query ran', () => {
    // The memory-before-plan gate reads evidence relative to its own cwd and
    // repo_root(), which are both the main checkout. Evidence written into the
    // worktree was therefore invisible to it, and the gate quietly fell back to
    // its "db row" branch — an ordinary row the agent writes constantly, i.e.
    // exactly the weak signal this evidence file exists to replace. The gate
    // still ALLOWED, so nothing looked broken; the hardening was just inert in
    // the one workflow the worktree policy mandates.
    const root = mkdtempSync(join(tmpdir(), 'uap-evidence-'));
    try {
      const worktree = join(root, '.worktrees', '166-some-slug');
      mkdirSync(worktree, { recursive: true });

      recordMemoryQuery(worktree, 'probe topic');

      expect(
        existsSync(join(root, '.uap', 'evidence', 'memory-queries.log')),
        'evidence must land in the main checkout, where the gate looks'
      ).toBe(true);
      expect(
        existsSync(join(worktree, '.uap', 'evidence', 'memory-queries.log')),
        'evidence must NOT be stranded in the worktree'
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a main-checkout path alone', () => {
    expect(memoryRoot(MAIN)).toBe(MAIN);
    expect(memoryRoot(`${MAIN}/src`)).toBe(`${MAIN}/src`);
  });

  it('resolves the configured RELATIVE default against the main checkout', () => {
    // This is the actual bug: the shipped config path is relative, so it used
    // to resolve against cwd — i.e. inside the worktree.
    const fromWorktree = shortTermDbPath(
      `${MAIN}/.worktrees/166-some-slug`,
      './agents/data/memory/short_term.db'
    );
    expect(fromWorktree).toBe(join(MAIN, 'agents/data/memory/short_term.db'));
    expect(fromWorktree).not.toContain('.worktrees');
  });

  it('honours an ABSOLUTE configured path unchanged', () => {
    // An operator naming an explicit location means it.
    const abs = '/var/lib/uap/memory.db';
    expect(shortTermDbPath(`${MAIN}/.worktrees/x`, abs)).toBe(abs);
  });

  it('falls back to the main checkout when nothing is configured', () => {
    expect(shortTermDbPath(`${MAIN}/.worktrees/x`)).toBe(
      join(MAIN, 'agents/data/memory/short_term.db')
    );
  });
});

describe('long-term storage', () => {
  it('pins a collection name to the embedding width', () => {
    // Embedding models change. A 768-wide vector cannot go into the 384-wide
    // collection an older model built, and searching it fails silently.
    expect(dimensionedName('agent_memory', 768)).toBe('agent_memory_v768');
    expect(dimensionedName('agent_memory', 384)).toBe('agent_memory_v384');
  });

  it('fails soft and explains itself when the store is unreachable', async () => {
    // Memory is a side effect of doing the work; it must never fail the work.
    // But it must not claim success either — that is how knowledge is lost
    // silently, which is the whole reason this module exists.
    const config = {
      version: '1.0.0',
      project: { name: 'test', defaultBranch: 'main' },
      memory: { longTerm: { endpoint: 'localhost:59999' } },
    } as unknown as AgentContextConfig;

    const result = await storeLongTerm(config, {
      content: 'unreachable-store probe',
      type: 'action',
      importance: 5,
    });

    expect(result.stored).toBe(false);
    expect(result.reason, 'must say WHY, not just fail').toBeTruthy();
  }, 30_000);
});
