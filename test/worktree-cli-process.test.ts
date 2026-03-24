import { describe, it, expect } from 'vitest';
import { isAlreadyMergedMessage, parseRevListCount } from '../src/cli/worktree.js';

describe('worktree process helpers', () => {
  it('parses rev-list count output safely', () => {
    expect(parseRevListCount('3\n')).toBe(3);
    expect(parseRevListCount('0')).toBe(0);
  });

  it('returns 0 for invalid rev-list output', () => {
    expect(parseRevListCount('not-a-number')).toBe(0);
    expect(parseRevListCount('-2')).toBe(0);
  });

  it('detects already-merged gh message', () => {
    const message = 'Pull request owner/repo#123 was already merged';
    expect(isAlreadyMergedMessage(message)).toBe(true);
  });

  it('ignores unrelated merge error text', () => {
    const message = "failed to run git: fatal: 'master' is already used by worktree";
    expect(isAlreadyMergedMessage(message)).toBe(false);
  });
});
