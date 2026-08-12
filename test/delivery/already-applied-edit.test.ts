/**
 * "old_string not found" when the change is ALREADY IN THE FILE.
 *
 * Observed live (2026-08-12, rounds 11 and 12 of one turn): the model applied
 * an edit at round 7, the per-write `cargo check` came back clean at round 10,
 * and it then re-sent the round-7 edit twice. Its anchor no longer existed, so
 * it got "old_string not found" — a message that reads as *you got the anchor
 * wrong, try again*, which is exactly the wrong advice. It had already
 * succeeded.
 *
 * Telling it so is the whole fix: a miss whose replacement text is already
 * present is not a failed edit, it is a duplicate request, and the model needs
 * to move on rather than re-anchor.
 *
 * Guarded by a length floor: a short fragment like `)` or `let x` appears all
 * over a real file, and calling those "already applied" would silently swallow
 * genuine edits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTool } from '../../src/delivery/agentic-executor.js';

const EMPTY: ReadonlySet<string> = new Set();
const call = (root: string, args: Record<string, unknown>) =>
  runTool(root, 'edit_file', args, 5000, EMPTY, true, false, EMPTY);

const SRC = `pub fn pick(rows: Vec<(i64, i64)>, i: i32) -> Option<i64> {
    rows.iter()
        .filter(|((sr, _c2), src)| (*src) as i32 == i)
        .map(|((sr, _c2), _src)| *sr)
                .next()
}
`;

describe('an edit that was already applied', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-applied-'));
    writeFileSync(join(dir, 'lib.rs'), SRC);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('says so, instead of blaming the anchor', () => {
    const out = call(dir, {
      path: 'lib.rs',
      old_string: '.filter(|((sr, _c2), src)| src as i32 == i)', // the PRE-edit text, long gone
      new_string: '.filter(|((sr, _c2), src)| (*src) as i32 == i)', // ...already in the file
    });
    expect(out, 'the model must not be told to re-anchor a change it already made').not.toMatch(
      /old_string not found/i
    );
    expect(out).toMatch(/already applied|already in the file|already present/i);
  });

  it('tells it what to do next, not just what NOT to do', () => {
    const out = call(dir, {
      path: 'lib.rs',
      old_string: '.filter(|((sr, _c2), src)| src as i32 == i)',
      new_string: '.filter(|((sr, _c2), src)| (*src) as i32 == i)',
    });
    expect(out, 'a diagnosis with no instruction is how the loop continued').toMatch(/do not re-?send/i);
    // "Stop doing that" leaves a model with nowhere to go, which is its own
    // stall. It needs the forward move as well.
    expect(out, 'and where to go instead').toMatch(/move on|finish/i);
  });

  it('leaves the file untouched', () => {
    const before = readFileSync(join(dir, 'lib.rs'), 'utf8');
    call(dir, {
      path: 'lib.rs',
      old_string: 'gone',
      new_string: '.filter(|((sr, _c2), src)| (*src) as i32 == i)',
    });
    expect(readFileSync(join(dir, 'lib.rs'), 'utf8')).toBe(before);
  });

  it('still reports a genuine miss as a miss', () => {
    const out = call(dir, {
      path: 'lib.rs',
      old_string: 'fn nonexistent_anchor_text()',
      new_string: 'fn something_entirely_new_and_long_enough()',
    });
    expect(out).toMatch(/^ERROR:/);
    expect(out).not.toMatch(/already applied/i);
  });

  it('does not call a SHORT fragment already-applied', () => {
    // `)` occurs everywhere. Treating that as "already applied" would swallow
    // real edits behind a reassuring message.
    const out = call(dir, { path: 'lib.rs', old_string: 'no such anchor here', new_string: ')' });
    expect(out).toMatch(/^ERROR:/);
    expect(out).not.toMatch(/already applied/i);
  });

  it('does not fire on a LONG run of pure whitespace that IS in the file', () => {
    // Both conditions on purpose: long enough to clear the floor on raw
    // length, and genuinely present (the fixture has a 16-space indent). So it
    // only passes if the floor is measured AFTER trimming. Indentation matches
    // somewhere in almost every file, which would make "already applied" true
    // and meaningless.
    const blanks = ' '.repeat(16);
    expect(blanks.length).toBeGreaterThan(12);
    expect(SRC, 'fixture must actually contain it, or the case is vacuous').toContain(blanks);
    const out = call(dir, { path: 'lib.rs', old_string: 'no such anchor here', new_string: blanks });
    expect(out).toMatch(/^ERROR:/);
    expect(out).not.toMatch(/already applied/i);
  });

  it('still applies a real edit normally', () => {
    const out = call(dir, { path: 'lib.rs', old_string: 'fn pick', new_string: 'fn choose' });
    expect(out).not.toMatch(/^ERROR:/);
    expect(readFileSync(join(dir, 'lib.rs'), 'utf8')).toContain('fn choose');
  });
});
