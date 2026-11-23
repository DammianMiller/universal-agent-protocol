import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runTool,
  newStateHashStore,
  staleAnchorNote,
  recordEditSinceRead,
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
