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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractScript,
  scriptParses,
  detectBrokenGate,
  authorAcceptanceGate,
} from '../../src/delivery/self-gate.js';

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

/**
 * The SECOND way a gate can be broken rather than strict: it parses fine, it
 * runs, and then its own TOOLING errors — so it never actually tests the
 * repository at all.
 *
 * Live failure (octopus_invaders_v3, 2026-07-22): the model authored
 * `grep -q 'background\.initStars\('`. In a POSIX basic regex `\(` is
 * group-open, so grep aborted with "Unmatched ( or \(" and reported FAIL
 * against code that was CORRECT (main.js:38 did call it). `bash -n` passes on
 * that script, and "fails on the unsolved repo" was trivially satisfied, so the
 * gate was accepted and then frozen by the anti-gutting guard. The deliver
 * spent 4 turns / ~35 minutes at 0% of gates correctly diagnosing verify.sh as
 * broken and being blocked every time it tried to repair it.
 */
describe('detectBrokenGate — telling a BROKEN gate from an unsatisfied one', () => {
  it('catches the exact live output that deadlocked the octopus deliver', () => {
    const live =
      'grep: Unmatched ( or \\(\nFAIL: background.initStars() not called in space-shooter/js/main.js\n';
    expect(detectBrokenGate(live)).not.toBeNull();
  });

  it('catches other unambiguous authoring bugs', () => {
    expect(detectBrokenGate('grep: trailing backslash')).not.toBeNull();
    expect(detectBrokenGate('sed: -e expression #1, char 7: unterminated command')).not.toBeNull();
    expect(detectBrokenGate('verify.sh: line 4: syntax error near unexpected token')).not.toBeNull();
    expect(detectBrokenGate('verify.sh: line 9: [: -eq: unary operator expected')).not.toBeNull();
  });

  it('does NOT flag a gate that simply is not satisfied yet', () => {
    expect(detectBrokenGate('FAIL: solution.txt does not exist\n')).toBeNull();
    expect(detectBrokenGate('2 of 5 checks failed\n')).toBeNull();
    // grep finding no match is the NORMAL path: exit 1, no diagnostic text.
    expect(detectBrokenGate('')).toBeNull();
  });

  it('does NOT flag a missing binary — the deliverable may not be built yet', () => {
    // Deliberately excluded: treating these as broken would regenerate GOOD
    // gates and reintroduce vacuity, which is the worse failure.
    expect(detectBrokenGate('verify.sh: line 3: myapp: command not found')).toBeNull();
    expect(detectBrokenGate('cat: dist/bundle.js: No such file or directory')).toBeNull();
  });
});

describe('authorAcceptanceGate rejects a broken gate end-to-end', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'selfgate-broken-'));
    // The repo ALREADY satisfies the intent, so a correctly-written probe would
    // match. Only the malformed pattern can fail here.
    writeFileSync(join(dir, 'main.js'), 'background.initStars();\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('regenerates instead of installing a gate whose grep pattern is malformed', async () => {
    let call = 0;
    const executor = async (): Promise<string> => {
      call += 1;
      // 1st: the live BRE bug — parses, runs, grep aborts, gate can never pass.
      // 2nd: a well-formed discriminating gate.
      return call === 1
        ? "```bash\ngrep -q 'background\\.initStars\\(' main.js || { echo FAIL; exit 1; }\n```"
        // Runs something, so this pins the BROKEN-script validator alone and
        // does not also trip the "gate never runs the code" one.
        : '```bash\nnode -e "process.exit(1)" || { echo FAIL; exit 1; }\n```';
    };
    const res = await authorAcceptanceGate({
      instruction: 'wire up the background',
      projectRoot: dir,
      executor,
    });

    expect(call).toBe(2); // the broken gate was NOT accepted
    expect(res.attempts).toBe(2);
    expect(res.vacuous).toBe(false);
    expect(res.notes.some((n) => n.includes('BROKEN'))).toBe(true);
    // The installed gate is the good one, failing for the RIGHT reason.
    expect(readFileSync(join(dir, '.uap-deliver', 'verify.sh'), 'utf-8')).toContain('process.exit(1)');
  });
});
