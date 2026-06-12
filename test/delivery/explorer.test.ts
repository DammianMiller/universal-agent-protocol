import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exploreAndCommit } from '../../src/delivery/explorer.js';
import { applyFileBlocksWithRollback } from '../../src/delivery/applier.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

const RUNGS: GateRung[] = [
  { id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 },
];

function ladderFor(content: string | null): LadderResult {
  // Stub gate: scores by what the candidate wrote to solution.txt
  const passed = content === 'correct';
  const score = passed ? 1 : content === 'partial' ? 0.5 : 0;
  return {
    passed,
    score,
    feedback: passed ? 'all pass' : `wrong content: ${content}`,
    results: [],
  };
}

function candidateOutput(content: string): string {
  return `\`\`\`file:solution.txt\n${content}\n\`\`\``;
}

describe('applyFileBlocksWithRollback', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-rollback-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores modified files and deletes created files', () => {
    writeFileSync(join(dir, 'existing.txt'), 'original');
    const output = '```file:existing.txt\nmodified\n```\n```file:created.txt\nnew\n```';

    const { result, restore } = applyFileBlocksWithRollback(output, dir);
    expect(result.filesWritten).toEqual(['existing.txt', 'created.txt']);
    expect(readFileSync(join(dir, 'existing.txt'), 'utf-8')).toBe('modified\n');
    expect(existsSync(join(dir, 'created.txt'))).toBe(true);

    restore();
    expect(readFileSync(join(dir, 'existing.txt'), 'utf-8')).toBe('original');
    expect(existsSync(join(dir, 'created.txt'))).toBe(false);

    // Idempotent
    restore();
    expect(readFileSync(join(dir, 'existing.txt'), 'utf-8')).toBe('original');
  });
});

describe('exploreAndCommit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-explorer-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readSolution(): string | null {
    const path = join(dir, 'solution.txt');
    return existsSync(path) ? readFileSync(path, 'utf-8').trim() : null;
  }

  it('commits the objectively best candidate and rolls back the losers', async () => {
    // Strategies produce different outputs; only one passes the stub gate
    const outputs = [candidateOutput('wrong'), candidateOutput('correct'), candidateOutput('partial')];
    let call = 0;

    const result = await exploreAndCommit(
      'write the solution',
      'BASE PROMPT',
      async () => outputs[call++],
      {
        candidates: 3,
        projectRoot: dir,
        rungs: RUNGS,
        ladderRunner: () => ladderFor(readSolution()),
      }
    );

    expect(result.winner?.id).toBe('c2');
    expect(result.winner?.passed).toBe(true);
    expect(result.candidates.map((c) => c.score)).toEqual([0, 1, 0.5]);
    // Winner committed to the tree, losers rolled back
    expect(readSolution()).toBe('correct');
    expect(result.ladder?.passed).toBe(true);
  });

  it('appends a distinct strategy seed to each candidate prompt', async () => {
    const prompts: string[] = [];
    await exploreAndCommit(
      'task',
      'BASE PROMPT',
      async (p) => {
        prompts.push(p);
        return candidateOutput('wrong');
      },
      { candidates: 3, projectRoot: dir, rungs: RUNGS, ladderRunner: () => ladderFor(readSolution()) }
    );

    expect(prompts).toHaveLength(3);
    expect(prompts.every((p) => p.startsWith('BASE PROMPT'))).toBe(true);
    const strategies = prompts.map((p) => p.split('STRATEGY:')[1]);
    expect(new Set(strategies).size).toBe(3);
  });

  it('invokes the judge only for candidates tied at the top', async () => {
    const judged: string[][] = [];
    const outputs = [candidateOutput('partial'), candidateOutput('partial2'), candidateOutput('wrong')];
    let call = 0;

    // partial and partial2 both score 0.5 (stub treats both as partial)
    const result = await exploreAndCommit(
      'task',
      'BASE',
      async () => outputs[call++],
      {
        candidates: 3,
        projectRoot: dir,
        rungs: RUNGS,
        ladderRunner: () => {
          const content = readSolution();
          const score = content?.startsWith('partial') ? 0.5 : 0;
          return { passed: false, score, feedback: 'nope', results: [] };
        },
        judge: async (_task, candidates) => {
          judged.push(candidates.map((c) => c.id));
          return { winnerId: 'c2', rationale: 'better naming' };
        },
      }
    );

    expect(judged).toEqual([['c1', 'c2']]);
    expect(result.winner?.id).toBe('c2');
    expect(result.judgeRationale).toBe('better naming');
    expect(readSolution()).toBe('partial2');
  });

  it('returns no winner when every candidate errors', async () => {
    const result = await exploreAndCommit(
      'task',
      'BASE',
      async () => {
        throw new Error('inference down');
      },
      { candidates: 2, projectRoot: dir, rungs: RUNGS, ladderRunner: () => ladderFor(null) }
    );

    expect(result.winner).toBeNull();
    expect(result.candidates.every((c) => c.error === 'inference down')).toBe(true);
  });

  it('a committable zero-score candidate outranks an executor-error candidate', async () => {
    // c1 throws; c2 applies files and scores 0 — c2 must win, not null
    let call = 0;
    const result = await exploreAndCommit(
      'task',
      'BASE',
      async () => {
        call++;
        if (call === 1) throw new Error('c1 down');
        return candidateOutput('wrong'); // scores 0 but reaches a real ladder run
      },
      { candidates: 2, projectRoot: dir, rungs: RUNGS, ladderRunner: () => ladderFor(readSolution()) }
    );

    expect(result.winner?.id).toBe('c2');
    expect(result.winner?.score).toBe(0);
    expect(readSolution()).toBe('wrong');
  });

  it('a candidate that emits no file blocks never wins over an evaluated one', async () => {
    let call = 0;
    const result = await exploreAndCommit(
      'task',
      'BASE',
      async () => {
        call++;
        return call === 1 ? 'just prose, no file blocks' : candidateOutput('wrong');
      },
      { candidates: 2, projectRoot: dir, rungs: RUNGS, ladderRunner: () => ladderFor(readSolution()) }
    );

    expect(result.winner?.id).toBe('c2');
    expect(result.candidates[0].applyResult?.error).toBeDefined();
  });

  it('caps candidates at the library ceiling even when more are requested', async () => {
    let calls = 0;
    await exploreAndCommit(
      'task',
      'BASE',
      async () => {
        calls++;
        return candidateOutput('wrong');
      },
      { candidates: 99, projectRoot: dir, rungs: RUNGS, ladderRunner: () => ladderFor(readSolution()) }
    );
    expect(calls).toBe(8); // MAX_CANDIDATES
  });

  it('rolls back losing candidates that create files the winner never touches', async () => {
    let call = 0;
    const result = await exploreAndCommit(
      'task',
      'BASE',
      async () => {
        call++;
        // c1 writes loser-only.txt (wrong); c2 writes solution.txt (correct)
        return call === 1
          ? '```file:loser-only.txt\njunk\n```'
          : candidateOutput('correct');
      },
      {
        candidates: 2,
        projectRoot: dir,
        rungs: RUNGS,
        ladderRunner: () => ladderFor(readSolution()),
      }
    );

    expect(result.winner?.id).toBe('c2');
    expect(readSolution()).toBe('correct');
    expect(existsSync(join(dir, 'loser-only.txt'))).toBe(false);
  });
});
