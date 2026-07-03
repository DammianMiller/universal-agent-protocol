/**
 * Workspace-isolated exploration: candidates verify concurrently in their own
 * trees; the winner is still committed + re-verified in the real tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exploreAndCommit } from '../../src/delivery/explorer.js';
import type { CandidateWorkspace } from '../../src/delivery/candidate-workspace.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

const RUNG: GateRung = {
  id: 'g',
  name: 'g',
  command: 'true',
  args: [],
  required: true,
  timeoutMs: 1000,
  tier: 'fast',
};

function ladder(passed: boolean, score: number): LadderResult {
  return {
    passed,
    score,
    results: [{ rung: RUNG, passed, output: '', durationMs: 1 }],
    feedback: '',
  } as unknown as LadderResult;
}

describe('exploreAndCommit with workspaceProvider', () => {
  let mainRoot: string;
  const workspaces: string[] = [];
  let cleanedUp = 0;

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), 'uap-explore-main-'));
    workspaces.length = 0;
    cleanedUp = 0;
  });
  afterEach(() => {
    rmSync(mainRoot, { recursive: true, force: true });
    for (const ws of workspaces) rmSync(ws, { recursive: true, force: true });
  });

  function makeProvider(): () => CandidateWorkspace {
    return () => {
      const root = mkdtempSync(join(tmpdir(), 'uap-explore-ws-'));
      workspaces.push(root);
      return {
        root,
        cleanup: () => {
          cleanedUp++;
        },
      };
    };
  }

  it('evaluates candidates in isolated workspaces and commits only the winner to the main tree', async () => {
    const laddersRunIn: string[] = [];
    const result = await exploreAndCommit(
      'task',
      'prompt',
      async (prompt) => {
        // The winning candidate is the one steered by the 'test-first' seed.
        const marker = prompt.includes('failing gates first') ? 'winner' : 'loser';
        return '```file:out.txt\n' + marker + '\n```';
      },
      {
        candidates: 2,
        projectRoot: mainRoot,
        rungs: [RUNG],
        workspaceProvider: makeProvider(),
        ladderRunner: (rungs, root) => {
          laddersRunIn.push(root);
          // Only the workspace (or final tree) containing 'winner' passes.
          const content = existsSync(join(root, 'out.txt'))
            ? readFileSync(join(root, 'out.txt'), 'utf-8')
            : '';
          return ladder(content.includes('winner'), content.includes('winner') ? 1 : 0);
        },
      }
    );

    // Both candidates were verified in their OWN isolated workspaces…
    expect(workspaces.length).toBe(2);
    expect(laddersRunIn).toEqual(expect.arrayContaining(workspaces));
    expect(cleanedUp).toBe(2);
    // …and the winner was committed to the main tree and re-verified there.
    expect(result.winner).not.toBeNull();
    expect(result.winner!.strategy).toBe('test-first');
    expect(readFileSync(join(mainRoot, 'out.txt'), 'utf-8')).toContain('winner');
    expect(laddersRunIn[laddersRunIn.length - 1]).toBe(mainRoot);
  });

  it('falls back to sequential in-tree evaluation when the provider returns null', async () => {
    const laddersRunIn: string[] = [];
    const result = await exploreAndCommit(
      'task',
      'prompt',
      async () => '```file:out.txt\nx\n```',
      {
        candidates: 2,
        projectRoot: mainRoot,
        rungs: [RUNG],
        workspaceProvider: () => null,
        ladderRunner: (rungs, root) => {
          laddersRunIn.push(root);
          return ladder(true, 1);
        },
      }
    );
    expect(result.winner).not.toBeNull();
    // Every ladder ran in the shared main tree (sequential path).
    expect(new Set(laddersRunIn)).toEqual(new Set([mainRoot]));
  });
});
