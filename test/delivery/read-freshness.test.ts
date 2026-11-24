import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runTool,
  newStateHashStore,
  staleAnchorNote,
  recordEditSinceRead,
  noteSeenFileHash,
  markGateServedCurrent,
  externalStaleNote,
} from '../../src/delivery/agentic-executor.js';
import { nearestRangeExcerpt } from '../../src/delivery/edit-match.js';

const EMPTY = new Set<string>();

/**
 * runTool with the read-freshness rails live. The stateHash param is 12th,
 * so the optional tail (sweep, protectIac, writeLedger) is spelled out.
 */
function call(
  root: string,
  name: string,
  args: Record<string, unknown>,
  store = newStateHashStore(),
): string {
  return runTool(
    root,
    name,
    args,
    5000,
    EMPTY,
    true,
    false,
    EMPTY,
    undefined,
    false,
    undefined,
    { store, round: 1, turn: 1 },
  );
}

describe('read-freshness contract (plan D.1 / D.2)', () => {
  let dir: string;
  const SRC = ['function add(a, b) {', '    return a + b;', '}', ''].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-fresh-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('attributes an edit miss on a file never read this run', () => {
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a - b;',
      new_string: 'return a * b;',
    });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/STALE ANCHOR/);
    expect(out).toMatch(/not read this file this run/);
    // The file is untouched by a failed edit.
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('attributes a miss after the model’s own edit invalidated its copy', () => {
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
    // ONE store across the run — freshness is per-conversation state.
    const store = newStateHashStore();
    const first = call(
      dir,
      'edit_file',
      {
        path: 'calc.js',
        old_string: 'return a + b;',
        new_string: 'return a + b + 0;',
      },
      store,
    );
    expect(first).toMatch(/^OK: edited/);
    // The model still believes 'return a + b;' is in the file; it is not.
    const second = call(
      dir,
      'edit_file',
      {
        path: 'calc.js',
        old_string: 'return a + b;',
        new_string: 'return 42;',
      },
      store,
    );
    expect(second).toMatch(/STALE ANCHOR/);
    expect(second).toMatch(/1 of your own edit/);
  });

  it('a serving read clears the staleness — fresh-view misses stay ordinary', () => {
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
    const store = newStateHashStore();
    expect(
      call(
        dir,
        'edit_file',
        {
          path: 'calc.js',
          old_string: 'return a + b;',
          new_string: 'return a + b + 0;',
        },
        store,
      ),
    ).toMatch(/^OK: edited/);
    const read = call(dir, 'read_file', { path: 'calc.js' }, store);
    expect(read).toContain('return a + b + 0;');
    const miss = call(
      dir,
      'edit_file',
      {
        path: 'calc.js',
        old_string: 'NOPE not here;',
        new_string: 'whatever;',
      },
      store,
    );
    expect(miss).toMatch(/^ERROR/);
    expect(miss).not.toMatch(/STALE ANCHOR/);
  });

  it('write_file keeps the authored view fresh — no staleness on the next miss', () => {
    const store = newStateHashStore();
    const wrote = call(
      dir,
      'write_file',
      { path: 'fresh.js', content: 'export const x = 1;\n' },
      store,
    );
    expect(wrote).toMatch(/^OK: wrote/);
    const miss = call(
      dir,
      'edit_file',
      {
        path: 'fresh.js',
        old_string: 'export const y = 2;',
        new_string: 'export const y = 3;',
      },
      store,
    );
    expect(miss).toMatch(/^ERROR/);
    expect(miss).not.toMatch(/STALE ANCHOR/);
  });

  it('forces the current-content digest into a PROVEN stale miss when diagnostics are off', () => {
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
    const prev = process.env.UAP_EDIT_DIAGNOSTICS;
    process.env.UAP_EDIT_DIAGNOSTICS = '0';
    try {
      const out = call(dir, 'edit_file', {
        path: 'calc.js',
        old_string: 'return a - b;',
        new_string: 'return a * b;',
      });
      expect(out).toMatch(/STALE ANCHOR/);
      // Diagnostics off means no Nearest region — but a proven-stale anchor
      // still gets the CURRENT content to re-anchor on.
      expect(out).toMatch(/CURRENT file/);
    } finally {
      if (prev === undefined) delete process.env.UAP_EDIT_DIAGNOSTICS;
      else process.env.UAP_EDIT_DIAGNOSTICS = prev;
    }
  });

  it('no staleness attribution when the caller runs without stateHash (back-compat)', () => {
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
    const out = runTool(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a - b;',
      new_string: 'return a * b;',
    });
    expect(out).toMatch(/^ERROR/);
    expect(out).not.toMatch(/STALE ANCHOR/);
  });

  it('edit_range invalid gets the current line count, a bounded excerpt, and stale attribution', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    writeFileSync(join(dir, 'lines.txt'), lines, 'utf-8');
    const out = call(dir, 'edit_range', {
      path: 'lines.txt',
      start_line: 40,
      end_line: 45,
      new_text: 'replacement',
    });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/The file has 30 line\(s\)\. Lines 27-30/);
    expect(out).toMatch(/30: line 30/);
    expect(out).toMatch(/STALE ANCHOR/);
  });

  it('edit_range invalid on a fresh-authored file gets the hint without stale attribution', () => {
    const content = Array.from({ length: 10 }, (_, i) => `entry ${i + 1}`).join('\n') + '\n';
    const store = newStateHashStore();
    expect(
      call(dir, 'write_file', { path: 'entries.txt', content }, store),
    ).toMatch(/^OK: wrote/);
    const out = call(
      dir,
      'edit_range',
      { path: 'entries.txt', start_line: 99, end_line: 100, new_text: 'x' },
      store,
    );
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/The file has 10 line\(s\)/);
    expect(out).not.toMatch(/STALE ANCHOR/);
  });
});

describe('nearestRangeExcerpt (plan D.2 unit)', () => {
  const TEN = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join('\n');

  it('clamps an out-of-bounds request into the file and numbers the lines', () => {
    const out = nearestRangeExcerpt(TEN, 99, 100);
    expect(out).toMatch(/The file has 10 line\(s\)\. Lines 7-10/);
    expect(out).toContain('10: row 10');
  });

  it('shows a window around an in-bounds range', () => {
    const out = nearestRangeExcerpt(TEN, 4, 5);
    expect(out).toMatch(/Lines 1-8/);
    expect(out).toContain('4: row 4');
    expect(out).toContain('5: row 5');
  });

  it('degrades cleanly on an empty file', () => {
    const out = nearestRangeExcerpt('', 3, 5);
    expect(out).toMatch(/The file has 1 line\(s\)/);
  });

  it('bounds the excerpt length on long lines', () => {
    const wide = Array.from({ length: 20 }, () => 'x'.repeat(200)).join('\n');
    const out = nearestRangeExcerpt(wide, 1, 20, 300);
    expect(out.length).toBeLessThanOrEqual(300 + '\n… (truncated)'.length);
    expect(out).toContain('… (truncated)');
  });
});

describe('staleAnchorNote (plan D.1 unit)', () => {
  it('returns null without a store', () => {
    expect(staleAnchorNote(undefined, '/tmp/anything.ts')).toBeNull();
  });

  it('returns null when the model’s view is fresh', () => {
    const store = newStateHashStore();
    store.freshness.set('/a/b.ts', { reads: 1, editsSinceRead: 0 });
    expect(staleAnchorNote(store, '/a/b.ts')).toBeNull();
  });

  it('reports own-edit staleness after recordEditSinceRead', () => {
    const store = newStateHashStore();
    store.freshness.set('/a/b.ts', { reads: 1, editsSinceRead: 0 });
    recordEditSinceRead(store, '/a/b.ts');
    recordEditSinceRead(store, '/a/b.ts');
    expect(staleAnchorNote(store, '/a/b.ts')).toMatch(/2 of your own edits/);
  });
});

describe('read-freshness contract (Q1 — out-of-band gate)', () => {
  let dir: string;
  const SRC = [
    'export function one() {',
    '  return 1;',
    '}',
    'export function two() {',
    '  return 2;',
    '}',
    '',
  ].join('\n');
  // What run_bash (or any external process) does to the file mid-run.
  const MUTATED = SRC.replace('return 2;', 'return 22;');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-fresh-q1-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses an edit on a file changed out-of-band since the last read, and writes nothing', () => {
    writeFileSync(join(dir, 'mod.ts'), SRC, 'utf-8');
    const store = newStateHashStore();
    call(dir, 'read_file', { path: 'mod.ts' }, store);
    writeFileSync(join(dir, 'mod.ts'), MUTATED, 'utf-8'); // the out-of-band change
    const out = call(
      dir,
      'edit_file',
      { path: 'mod.ts', old_string: 'return 2;', new_string: 'return 3;' },
      store
    );
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/STALE READ/);
    expect(out).toMatch(/changed on disk since your last read/);
    // The gate's payload is the CURRENT region, not the model's stale copy.
    expect(out).toMatch(/return 22;/);
    // Refused means refused: the mutation is still the only change on disk.
    expect(readFileSync(join(dir, 'mod.ts'), 'utf-8')).toBe(MUTATED);
  });

  it('one-round recovery: the re-anchored re-send applies without a read round-trip', () => {
    writeFileSync(join(dir, 'mod.ts'), SRC, 'utf-8');
    const store = newStateHashStore();
    call(dir, 'read_file', { path: 'mod.ts' }, store);
    writeFileSync(join(dir, 'mod.ts'), MUTATED, 'utf-8');
    const gated = call(
      dir,
      'edit_file',
      { path: 'mod.ts', old_string: 'return 2;', new_string: 'return 3;' },
      store
    );
    expect(gated).toMatch(/will now be applied/);
    // The model re-anchors on the region the gate just handed over — the
    // current content — and re-sends immediately. No read_file between.
    const out = call(
      dir,
      'edit_file',
      { path: 'mod.ts', old_string: 'return 22;', new_string: 'return 23;' },
      store
    );
    expect(out).toMatch(/^OK: edited/);
    expect(readFileSync(join(dir, 'mod.ts'), 'utf-8')).toContain('return 23;');
  });

  it('no gate when the file is exactly as last read — the edit applies normally', () => {
    writeFileSync(join(dir, 'mod.ts'), SRC, 'utf-8');
    const store = newStateHashStore();
    call(dir, 'read_file', { path: 'mod.ts' }, store);
    const out = call(
      dir,
      'edit_file',
      { path: 'mod.ts', old_string: 'return 1;', new_string: 'return 10;' },
      store
    );
    expect(out).toMatch(/^OK: edited/);
  });

  it('own chained edits are NOT gated — only out-of-band changes are', () => {
    writeFileSync(join(dir, 'mod.ts'), SRC, 'utf-8');
    const store = newStateHashStore();
    call(dir, 'read_file', { path: 'mod.ts' }, store);
    const first = call(
      dir,
      'edit_file',
      { path: 'mod.ts', old_string: 'return 1;', new_string: 'return 10;' },
      store
    );
    expect(first).toMatch(/^OK: edited/);
    // The model knows what it just wrote; a second edit in the chain must
    // apply without a forced re-read (editsSinceRead > 0 is D.1 territory).
    const second = call(
      dir,
      'edit_file',
      { path: 'mod.ts', old_string: 'return 2;', new_string: 'return 20;' },
      store
    );
    expect(second).toMatch(/^OK: edited/);
  });

  it('an authored write_file is a serving view — a later clobber is gated the same way', () => {
    const store = newStateHashStore();
    call(dir, 'write_file', { path: 'gen.ts', content: SRC }, store);
    writeFileSync(join(dir, 'gen.ts'), MUTATED, 'utf-8'); // clobbered out-of-band
    const out = call(
      dir,
      'edit_file',
      { path: 'gen.ts', old_string: 'return 2;', new_string: 'return 3;' },
      store
    );
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/STALE READ/);
  });

  it('edit_range on shifted line numbers is gated with the current excerpt', () => {
    writeFileSync(join(dir, 'mod.ts'), SRC, 'utf-8');
    const store = newStateHashStore();
    call(dir, 'read_file', { path: 'mod.ts' }, store);
    // Out-of-band change that INSERTS lines: every later line number shifts.
    const shifted = `// header added externally\n${SRC}`;
    writeFileSync(join(dir, 'mod.ts'), shifted, 'utf-8');
    const out = call(
      dir,
      'edit_range',
      { path: 'mod.ts', start_line: 4, end_line: 6, new_text: 'export function two() {\n  return 2;\n}' },
      store
    );
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/STALE READ/);
    // Current content in the excerpt, with the externally added header.
    expect(out).toMatch(/header added externally/);
    expect(readFileSync(join(dir, 'mod.ts'), 'utf-8')).toBe(shifted);
  });

  it('a serving read after the out-of-band change clears the gate', () => {
    writeFileSync(join(dir, 'mod.ts'), SRC, 'utf-8');
    const store = newStateHashStore();
    call(dir, 'read_file', { path: 'mod.ts' }, store);
    writeFileSync(join(dir, 'mod.ts'), MUTATED, 'utf-8');
    call(dir, 'read_file', { path: 'mod.ts' }, store); // the model re-reads
    const out = call(
      dir,
      'edit_file',
      { path: 'mod.ts', old_string: 'return 22;', new_string: 'return 23;' },
      store
    );
    expect(out).toMatch(/^OK: edited/);
  });

  it('unit: externalStaleNote is null exactly when the view is provably current or out of scope', () => {
    const store = newStateHashStore();
    expect(externalStaleNote(undefined, '/a.ts', 'x')).toBeNull();
    // Never read: D.1 attribution territory, not this gate.
    expect(externalStaleNote(store, '/a.ts', 'x')).toBeNull();
    // A serving read marks reads=1, then records the bytes it served.
    store.freshness.set('/a.ts', { reads: 1, editsSinceRead: 0 });
    noteSeenFileHash(store, '/a.ts', 'original');
    // Read, unchanged: fresh view.
    expect(externalStaleNote(store, '/a.ts', 'original')).toBeNull();
    // Read, changed out-of-band: the gate speaks.
    expect(externalStaleNote(store, '/a.ts', 'changed')).toMatch(/STALE READ/);
    // Own edits pending: D.1 territory again — the gate stays silent.
    recordEditSinceRead(store, '/a.ts');
    expect(externalStaleNote(store, '/a.ts', 'changed')).toBeNull();
  });

  it('unit: noteSeenFileHash preserves the D.1 counters and markGateServedCurrent resets own-edits', () => {
    const store = newStateHashStore();
    store.freshness.set('/a.ts', { reads: 2, editsSinceRead: 3 });
    noteSeenFileHash(store, '/a.ts', 'content');
    const kept = store.freshness.get('/a.ts');
    expect(kept?.reads).toBe(2);
    expect(kept?.editsSinceRead).toBe(3);
    expect(kept?.fileHash).toBeTruthy();
    markGateServedCurrent(store, '/a.ts', 'newer');
    const reset = store.freshness.get('/a.ts');
    expect(reset?.reads).toBe(3);
    expect(reset?.editsSinceRead).toBe(0);
    // The handover is the current bytes: the re-anchored re-send passes.
    expect(externalStaleNote(store, '/a.ts', 'newer')).toBeNull();
    expect(externalStaleNote(store, '/a.ts', 'older')).toMatch(/STALE READ/);
  });
});
