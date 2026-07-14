/**
 * Never advertise a tool you will refuse to run.
 *
 * run_bash was offered in the schema unconditionally and then REFUSED at
 * execution time whenever the run was not sandboxed. The model does what the
 * menu says: on a live mission it spent 58 of 79 tool calls on run_bash — every
 * one bounced — and managed only 21 writes. Nearly three quarters of the turn
 * budget burned on a tool that was never going to run.
 *
 * And it was not probing the sandbox: every attempt was read-only (`cat` ×44,
 * `wc`, `find`, `ls`, `head`). It simply reached for the shell it had been shown.
 */
import { describe, it, expect } from 'vitest';
import { toolsFor } from '../../src/delivery/agentic-executor.js';

const names = (allowBash: boolean): string[] => toolsFor(allowBash).map((t) => t.function.name);

describe('toolsFor — the menu must match what we will actually execute', () => {
  it('HIDES run_bash when bash is disabled (the 58-wasted-calls bug)', () => {
    expect(names(false)).not.toContain('run_bash');
  });

  it('offers run_bash when it is genuinely allowed (sandboxed)', () => {
    expect(names(true)).toContain('run_bash');
  });

  it('keeps every other tool in both modes — read/list/write must never be dropped', () => {
    for (const t of ['read_file', 'list_dir', 'write_file']) {
      expect(names(false), `${t} missing when bash disabled`).toContain(t);
      expect(names(true), `${t} missing when bash allowed`).toContain(t);
    }
  });

  it('hiding run_bash removes exactly one tool, nothing else', () => {
    expect(names(true).length - names(false).length).toBe(1);
  });

  it('does not mutate the shared TOOLS list (filtering must not be destructive)', () => {
    toolsFor(false);
    expect(names(true)).toContain('run_bash');
  });
});
