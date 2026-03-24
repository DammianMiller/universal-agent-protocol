import { describe, it, expect } from 'vitest';
import { isBranchInUseWorktreeError, parseRevListCount } from '../src/cli/worktree.js';

describe('worktree process helpers', () => {
  it('parses rev-list count output safely', () => {
    expect(parseRevListCount('3\n')).toBe(3);
    expect(parseRevListCount('0')).toBe(0);
  });

  it('returns 0 for invalid rev-list output', () => {
    expect(parseRevListCount('not-a-number')).toBe(0);
    expect(parseRevListCount('-2')).toBe(0);
  });

  it('detects gh local branch lock error for worktrees', () => {
    const err = "failed to run git: fatal: 'master' is already used by worktree";
    expect(isBranchInUseWorktreeError(err)).toBe(true);
    expect(isBranchInUseWorktreeError('some other git failure')).toBe(false);
  });
});
