import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTool, toolsFor, protectedKey } from '../../src/delivery/agentic-executor.js';
import { appliedRegionNote } from '../../src/delivery/edit-match.js';

const EMPTY = new Set<string>();

/** runTool's positional tail, spelled once so the tests stay readable. */
function call(root: string, name: string, args: Record<string, unknown>, protectedFiles = EMPTY) {
  return runTool(root, name, args, 5000, protectedFiles, true, false, EMPTY);
}

describe('edit tools in runTool (harness plan A)', () => {
  let dir: string;
  const SRC = ['function add(a, b) {', '    return a + b;', '}', ''].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-tools-'));
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exposes edit_range alongside edit_file', () => {
    const names = toolsFor(true).map((t) => t.function.name);
    expect(names).toContain('edit_file');
    expect(names).toContain('edit_range');
  });

  it('applies an exact edit exactly as before', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a + b;',
      new_string: 'return a + b + 0;',
    });
    expect(out).toMatch(/^OK: edited/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toContain('return a + b + 0;');
  });

  it('recovers a whitespace-inexact anchor and SAYS it did', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'function  add(a,  b) {',
      new_string: 'function add(a, b, c) {',
    });
    expect(out).toMatch(/^OK: edited/);
    expect(out).toMatch(/did not match byte-for-byte/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toContain('function add(a, b, c) {');
  });

  it('hands back the current nearest region on a genuine miss', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a - b;',
      new_string: 'return a * b;',
    });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/Nearest region/);
    expect(out).toMatch(/edit_range/);
    // The file is untouched by a failed edit.
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('applies a batch of edits atomically', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      edits: [
        { old_string: 'function add', new_string: 'function sum' },
        { old_string: 'return a + b;', new_string: 'return a + b + 1;' },
      ],
    });
    expect(out).toMatch(/2 replacements/);
    const text = readFileSync(join(dir, 'calc.js'), 'utf-8');
    expect(text).toContain('function sum');
    expect(text).toContain('return a + b + 1;');
  });

  it('writes NOTHING when any edit in a batch fails', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      edits: [
        { old_string: 'function add', new_string: 'function sum' },
        { old_string: 'nonexistent anchor xyzzy', new_string: 'boom' },
      ],
    });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/edit 2 of 2/);
    // The first edit must not have landed — a half-applied file would reach the gate.
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('edit_range replaces an inclusive 1-based line range', () => {
    const out = call(dir, 'edit_range', {
      path: 'calc.js',
      start_line: 2,
      end_line: 2,
      new_text: '    return a * b;',
    });
    expect(out).toMatch(/^OK: replaced lines 2-2/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toContain('    return a * b;');
  });

  it('edit_range refuses a range past the end of the file', () => {
    const out = call(dir, 'edit_range', { path: 'calc.js', start_line: 1, end_line: 99, new_text: 'x' });
    expect(out).toMatch(/^ERROR/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('edit_range honours the protected-file guard (no second write path around it)', () => {
    const protectedFiles = new Set([protectedKey(dir, join(dir, 'calc.js'))]);
    const out = call(
      dir,
      'edit_range',
      { path: 'calc.js', start_line: 1, end_line: 1, new_text: 'hacked' },
      protectedFiles,
    );
    expect(out).toMatch(/protected test\/oracle file/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('edit_range refuses to create a file', () => {
    const out = call(dir, 'edit_range', { path: 'new.js', start_line: 1, end_line: 1, new_text: 'x' });
    expect(out).toMatch(/does not exist/);
  });
});

describe('edit tools honour the agent-internal guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-internal-'));
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'state.json'), '{"secret":1}', 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Regression: edit_file lacked the guard write_file has, so the surgical path
  // could rewrite the agent's own machinery while the whole-file path refused.
  it('edit_file refuses to modify .uap internals', () => {
    const out = call(dir, 'edit_file', {
      path: '.uap/state.json',
      old_string: '"secret":1',
      new_string: '"secret":2',
    });
    expect(out).toMatch(/^ERROR|^NOTE/);
    expect(readFileSync(join(dir, '.uap', 'state.json'), 'utf-8')).toBe('{"secret":1}');
  });

  it('edit_range refuses too', () => {
    const out = call(dir, 'edit_range', {
      path: '.uap/state.json',
      start_line: 1,
      end_line: 1,
      new_text: 'hacked',
    });
    expect(out).toMatch(/^ERROR|^NOTE/);
    expect(readFileSync(join(dir, '.uap', 'state.json'), 'utf-8')).toBe('{"secret":1}');
  });
});

describe('edit tools cannot bypass the anti-gutting guard', () => {
  let dir: string;
  // Large enough to trip isSuspectedGutting (>=1500 bytes, shrink below 35%).
  const BIG = Array.from({ length: 200 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-gutting-'));
    writeFileSync(join(dir, 'engine.js'), BIG, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('write_file still refuses to hollow the file out', () => {
    const out = call(dir, 'write_file', { path: 'engine.js', content: '// TODO' });
    expect(out).toMatch(/^ERROR/);
    expect(readFileSync(join(dir, 'engine.js'), 'utf-8')).toBe(BIG);
  });

  // The write_file refusal text names edit_file as the alternative, so without
  // this the recommended escape route was also the bypass: edit_range(1, N, "")
  // deleted the implementation and returned OK.
  it('edit_range refuses the same deletion', () => {
    const lines = BIG.split('\n').length;
    const out = call(dir, 'edit_range', { path: 'engine.js', start_line: 1, end_line: lines, new_text: '// TODO' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/refusing to shrink/);
    expect(readFileSync(join(dir, 'engine.js'), 'utf-8')).toBe(BIG);
  });

  it('edit_file refuses the same deletion', () => {
    const out = call(dir, 'edit_file', { path: 'engine.js', old_string: BIG, new_string: '// TODO' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/refusing to shrink/);
    expect(readFileSync(join(dir, 'engine.js'), 'utf-8')).toBe(BIG);
  });

  it('still allows an ordinary edit that does not hollow the file out', () => {
    const out = call(dir, 'edit_file', { path: 'engine.js', old_string: 'return 0;', new_string: 'return 42;' });
    expect(out).toMatch(/^OK/);
    expect(readFileSync(join(dir, 'engine.js'), 'utf-8')).toContain('return 42;');
  });
});

describe('batch edit input validation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-batch-'));
    writeFileSync(join(dir, 'a.js'), 'let a = 1;\nlet b = 2;\n', 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses both forms at once rather than silently dropping one', () => {
    const out = call(dir, 'edit_file', {
      path: 'a.js',
      old_string: 'let a = 1;',
      new_string: 'let a = 9;',
      edits: [{ old_string: 'let b = 2;', new_string: 'let b = 8;' }],
    });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/EITHER/);
  });

  it('requires new_string explicitly rather than deleting on omission', () => {
    const out = call(dir, 'edit_file', { path: 'a.js', old_string: 'let a = 1;' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/new_string is required/);
    expect(readFileSync(join(dir, 'a.js'), 'utf-8')).toContain('let a = 1;');
  });

  it('caps batch size so one call cannot stall the event loop', () => {
    const edits = Array.from({ length: 100 }, () => ({ old_string: 'let a = 1;', new_string: 'let a = 1;' }));
    const out = call(dir, 'edit_file', { path: 'a.js', edits });
    expect(out).toMatch(/too many edits/);
  });
});

/**
 * Both regressions below come from one live run (cognition-engine, 2026-08-08)
 * in which a deliver churned ~2h without converging. The two tool behaviours
 * exercised here each handed the model a SUCCESS signal for a round that
 * changed nothing, which is what let the loop run flat.
 */
describe('loop-causing tool feedback (live incident 2026-08-08)', () => {
  let dir: string;
  const SRC = ['function add(a, b) {', '    return a + b;', '}', ''].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-fix-'));
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a byte-identical write_file as a NO-OP, not as "OK: wrote"', () => {
    const identical = readFileSync(join(dir, 'calc.js'), 'utf-8');
    const out = call(dir, 'write_file', { path: 'calc.js', content: identical });
    expect(out).toMatch(/^NO-OP/);
    expect(out).not.toMatch(/^OK: wrote/);
    // The file must survive untouched — a no-op is not a delete.
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(identical);
  });

  it('still reports a genuinely changed write_file as OK', () => {
    const changed = SRC.replace('a + b', 'a + b + 1');
    const out = call(dir, 'write_file', { path: 'calc.js', content: changed });
    expect(out).toMatch(/^OK: wrote/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(changed);
  });

  it('rejects a same-length but DIFFERENT write — the no-op check compares bytes, not size', () => {
    // The size comparison is only a short-circuit. If it were the whole test,
    // every same-length edit would be answered NO-OP and silently discarded.
    const sameLength = SRC.replace('a + b', 'a - b');
    expect(sameLength.length).toBe(SRC.length);
    const out = call(dir, 'write_file', { path: 'calc.js', content: sameLength });
    expect(out).toMatch(/^OK: wrote/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(sameLength);
  });

  it('edit_range past EOF refuses WITHOUT truncating the file', () => {
    // The refusal is the point: clamping to the last line deleted the closing
    // brace and the trailing newline, i.e. produced the unclosed-delimiter
    // corruption that made the live run unrecoverable.
    const out = call(dir, 'edit_range', {
      path: 'calc.js',
      start_line: 2,
      end_line: 300,
      new_text: '    return a * b;',
    });
    expect(out).toMatch(/^ERROR/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('tells the model the last line, so its retry needs no extra read round', () => {
    const out = call(dir, 'edit_range', {
      path: 'calc.js',
      start_line: 2,
      end_line: 300,
      new_text: '    return a * b;',
    });
    expect(out).toMatch(/has 3 lines/);
    expect(out).toMatch(/end_line=3/);
  });

  it('still errors on a start_line past EOF through the tool path', () => {
    const out = call(dir, 'edit_range', { path: 'calc.js', start_line: 99, end_line: 100, new_text: 'x' });
    expect(out).toMatch(/^ERROR/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });
});

/**
 * The NO-OP rule has to cover all three write paths, not just write_file.
 *
 * Observed live (cognition-engine, 2026-08-08) AFTER the write_file fix shipped:
 * rounds 9, 10 and 11 of one turn were the same edit_file anchor, each answered
 * "OK: edited (1 replacement)" — the identical loop signal, on the very path the
 * write_file refusals steer models toward by name.
 */
describe('no-op edits report NO-OP on every write path', () => {
  let dir: string;
  const SRC = ['function add(a, b) {', '    return a + b;', '}', ''].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noop-edit-'));
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('edit_file with old_string === new_string is a NO-OP, not "1 replacement"', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a + b;',
      new_string: 'return a + b;',
    });
    expect(out).toMatch(/^NO-OP/);
    // Must not be countable as progress: no "OK" prefix, no "(1 replacement)".
    expect(out).not.toMatch(/^OK/);
    expect(out).not.toMatch(/\(1 replacement\)/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('edit_range that rewrites a range with its current text is a NO-OP', () => {
    const out = call(dir, 'edit_range', {
      path: 'calc.js',
      start_line: 2,
      end_line: 2,
      new_text: '    return a + b;',
    });
    expect(out).toMatch(/^NO-OP/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('a real edit_file change is still reported as OK', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a + b;',
      new_string: 'return a * b;',
    });
    expect(out).toMatch(/^OK: edited/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toContain('a * b');
  });

  it('a real edit_range change is still reported as OK', () => {
    const out = call(dir, 'edit_range', {
      path: 'calc.js',
      start_line: 2,
      end_line: 2,
      new_text: '    return a * b;',
    });
    expect(out).toMatch(/^OK: replaced/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toContain('a * b');
  });
});

/**
 * The NO-OP predicate is a CONTENT comparison, not an argument comparison.
 *
 * A guard written as `old_string === new_string` passes every test above while
 * being strictly weaker: it misses the two shapes that actually occur live —
 * a stale whitespace anchor whose replacement is what is already on disk, and a
 * batch whose edits cancel out.
 */
describe('no-op detection compares CONTENT, not arguments', () => {
  let dir: string;
  const SRC = ['function add(a, b) {', '    return a + b;', '}', ''].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noop-content-'));
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('catches a tolerant-match edit whose replacement is already on disk', () => {
    // old_string differs from new_string, so an argument-level guard lets this
    // through and reports a replacement that changed nothing.
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'function  add(a,  b) {',
      new_string: 'function add(a, b) {',
    });
    expect(out).toMatch(/^NO-OP/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('catches a batch whose edits cancel each other out', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      edits: [
        { old_string: 'a + b', new_string: 'a - b' },
        { old_string: 'a - b', new_string: 'a + b' },
      ],
    });
    expect(out).toMatch(/^NO-OP/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('still lets a batch through when any member really changes the file', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      edits: [
        { old_string: 'a + b', new_string: 'a - b' },
        { old_string: 'function add', new_string: 'function sub' },
      ],
    });
    expect(out).toMatch(/^OK: edited/);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toContain('function sub');
  });
});

describe('chain-anchor truth feed (A)', () => {
  let dir: string;
  const SRC = ['function add(a, b) {', '    return a + b;', '}', ''].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chain-feed-'));
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.UAP_DELIVER_CHAIN_FEED;
  });

  it('a successful edit hands back the applied region, line-numbered', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a + b;',
      new_string: 'return a + b + 0;',
    });
    expect(out).toMatch(/^OK: edited/);
    expect(out).toMatch(/The file now has 3 line/);
    expect(out).toMatch(/around your applied edit/);
    // The excerpt shows the APPLIED text with its line number — the anchor
    // for the model's next chained edit.
    expect(out).toMatch(/2:\s+return a \+ b \+ 0;/);
  });

  it('the line count is the truth AFTER the edit — a multi-line replacement updates it', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a + b;',
      new_string: 'const sum = a + b;\n    return sum;\n    // done',
    });
    expect(out).toMatch(/The file now has 5 line/);
    expect(out).toContain('// done');
  });

  it('edit_range success carries the feed around the replaced block', () => {
    const out = call(dir, 'edit_range', {
      path: 'calc.js',
      start_line: 2,
      end_line: 2,
      new_text: '    return a - b;',
    });
    expect(out).toMatch(/^OK: replaced lines 2-2/);
    expect(out).toMatch(/The file now has 3 line/);
    expect(out).toMatch(/return a - b;/);
  });

  it('UAP_DELIVER_CHAIN_FEED=0 kills the feed (A/B toggle)', () => {
    process.env.UAP_DELIVER_CHAIN_FEED = '0';
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      old_string: 'return a + b;',
      new_string: 'return a + b + 0;',
    });
    expect(out).toMatch(/^OK: edited/);
    expect(out).not.toMatch(/around your applied edit/);
  });

  it('batch edits feed the LAST-applied span (the one nothing after can shift)', () => {
    const out = call(dir, 'edit_file', {
      path: 'calc.js',
      edits: [
        { old_string: 'return a + b;', new_string: 'return a + b + 1;' },
        { old_string: 'function add', new_string: 'function sub' },
      ],
    });
    expect(out).toMatch(/^OK: edited/);
    // The last applied edit was the function rename — that is the region.
    expect(out).toMatch(/function sub/);
    expect(out).toMatch(/The file now has 3 line/);
  });
});

describe('appliedRegionNote (A unit)', () => {
  const TEXT = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', ''].join('\n');

  it('a negative span degrades to the line count alone', () => {
    expect(appliedRegionNote(TEXT, -1, 0)).toBe('The file now has 7 line(s).');
  });

  it('centers a ±3 line window on the span, numbered', () => {
    // 'four' begins at char index 14; a 4-char span covers it.
    const out = appliedRegionNote(TEXT, 14, 4);
    expect(out).toContain('The file now has 7 line(s).');
    expect(out).toContain('1: one');
    expect(out).toContain('4: four');
    expect(out).toContain('7: seven');
    expect(out).not.toContain('… (truncated)');
  });

  it('clamps the window at the file edges', () => {
    const out = appliedRegionNote(TEXT, 0, 3); // 'one'
    expect(out).toContain('1: one');
    expect(out).not.toMatch(/0: /);
  });

  it('bounds total output characters', () => {
    // A WIDE span (8 lines of 100 chars) plus the ±3 window exceeds the
    // 900-char cap — the note truncates honestly rather than emit a
    // screenful per success note. (Single long lines cannot reach the cap:
    // each line is pre-truncated to 160 by truncateForReport.)
    const long = Array.from({ length: 20 }, () => `${'x'.repeat(100)}`).join('\n');
    const span = 100 * 8 + 7; // lines 1-8 inclusive, newlines counted
    const out = appliedRegionNote(long, 0, span);
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain('… (truncated)');
  });
});
