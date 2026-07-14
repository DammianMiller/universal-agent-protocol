/**
 * A gate that cannot RUN is not a gate.
 *
 * The live failure (2026-07-14, octopus): the model's gate-authoring response was
 * truncated mid-script, so it had an opening ```bash fence and no closing one.
 * extractScript's regex required BOTH, did not match, and fell back to the raw
 * response — writing the markdown fence itself into verify.sh. bash then died on
 * line 2 with `unexpected EOF while looking for matching \``.
 *
 * The deeper defect: a syntax error is not a spawnError. bash spawns fine and
 * exits non-zero — and the authoring loop read "non-zero on the unsolved repo" as
 * PROOF OF A STRICT GATE, so it installed the broken script and every subsequent
 * turn failed on it. The model could not see the cause and could not fix it: a
 * phantom failure, exactly like the WebGL blank-canvas bug.
 */
import { describe, it, expect } from 'vitest';
import { extractScript, scriptParses } from '../../src/delivery/self-gate.js';

describe('extractScript — a truncated response must not smuggle a fence into the gate', () => {
  it('strips an UNCLOSED opening fence (the live truncation)', () => {
    const truncated = 'Here is the gate:\n```bash\n#!/bin/sh\necho hi\nexit 1';
    const s = extractScript(truncated);
    expect(s).not.toContain('```');
    expect(s).toContain('echo hi');
  });

  it('still strips a normal closed fence', () => {
    const s = extractScript('```bash\n#!/bin/sh\nls\nexit 1\n```');
    expect(s).toBe('#!/bin/sh\nls\nexit 1');
  });

  it('tolerates a fence with trailing info text on the open line', () => {
    const s = extractScript('```sh title=verify\n#!/bin/sh\nexit 1\n```');
    expect(s).not.toContain('```');
    expect(s).toContain('exit 1');
  });

  it('a bare (unfenced) script is untouched, and always gets a shebang', () => {
    expect(extractScript('ls -la\nexit 1')).toBe('#!/usr/bin/env bash\nls -la\nexit 1');
  });
});

describe('scriptParses — the check that tells a STRICT gate from a BROKEN one', () => {
  it('rejects the exact script the live run installed', () => {
    // Fence on line 2 => unterminated backtick.
    const broken = '#!/usr/bin/env bash\n```bash\n#!/bin/sh\necho hi\n';
    const r = scriptParses(broken);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unexpected EOF|syntax error/i);
  });

  it('rejects a truncated script (cut mid-token)', () => {
    expect(scriptParses('#!/bin/sh\nX=$(find . -name "*.').ok).toBe(false);
  });

  it('accepts a valid script that FAILS at runtime — failing is the gate doing its job', () => {
    // The critical distinction: exit 1 is a correct strict gate; a syntax error is not.
    const strict = '#!/bin/sh\necho "not solved yet" >&2\nexit 1';
    expect(scriptParses(strict).ok).toBe(true);
  });

  it('accepts a valid multi-construct script', () => {
    const s = '#!/usr/bin/env bash\nset -e\nif [ -f x ]; then\n  echo y\nfi\nfor i in 1 2; do echo $i; done\nexit 1';
    expect(scriptParses(s).ok).toBe(true);
  });
});
