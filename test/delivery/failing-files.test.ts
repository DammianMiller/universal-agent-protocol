import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractFailingFiles, editsMissedFailingFiles } from '../../src/delivery/failing-files.js';

describe('failing-files (error-anchored steering, U1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-failing-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'bench.rs'), 'fn main() {}\n');
    writeFileSync(join(dir, 'src', 'lib.rs'), 'pub mod bench;\n');
    writeFileSync(join(dir, 'src', 'lib.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src', 'bin_main.py'), 'print("hi")\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fail = (outputTail: string) => [{ passed: false, skipped: false, outputTail }];

  it('extracts rustc --> path:line:col locations', () => {
    const out = fail(
      'error[E0432]: unresolved import\n  --> src/bench.rs:21:5\n   |\n21 | use crate::pipeline_stages::CandidateSlot;'
    );
    expect(extractFailingFiles(out, dir)).toEqual(['src/bench.rs']);
  });

  it('extracts TypeScript (line,col) and python File "..." locations', () => {
    const out = fail(
      'src/lib.ts(12,3): error TS2345: mismatch\n\nFile "src/bin_main.py", line 4, in <module>'
    );
    expect(extractFailingFiles(out, dir)).toEqual(['src/lib.ts', 'src/bin_main.py']);
  });

  it('ignores paths that do not exist (model-invented tokens)', () => {
    const out = fail('error at src/nonexistent.rs:9:1\n  --> src/bench.rs:21:5');
    expect(extractFailingFiles(out, dir)).toEqual(['src/bench.rs']);
  });

  it('drops non-source and excluded-segment tokens even when they exist', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'state.json'), '{}');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    const out = fail('problems in .uap/state.json:3:1 and package-lock.json:1:1\n  --> src/bench.rs:21:5');
    expect(extractFailingFiles(out, dir)).toEqual(['src/bench.rs']);
  });

  it('skips passed and skipped rungs entirely', () => {
    const results = [
      { passed: true, skipped: false, outputTail: 'src/bench.rs:21:5' },
      { passed: false, skipped: true, outputTail: 'src/bench.rs:21:5' },
      { passed: false, skipped: false, outputTail: undefined },
    ];
    expect(extractFailingFiles(results, dir)).toEqual([]);
  });

  it('caps at maxFiles keeping first-seen order', () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, 'src', `f${i}.rs`), '');
    const out = fail(Array.from({ length: 10 }, (_, i) => `  --> src/f${i}.rs:1:1`).join('\n'));
    expect(extractFailingFiles(out, dir, 6)).toHaveLength(6);
    expect(extractFailingFiles(out, dir, 6)[0]).toBe('src/f0.rs');
  });

  describe('editsMissedFailingFiles', () => {
    it('flags writes that touched none of the failing set', () => {
      expect(editsMissedFailingFiles(['src/bin/m1-bench.rs'], ['src/bench.rs'])).toBe(true);
    });

    it('accepts a turn that touched at least one failing file', () => {
      expect(editsMissedFailingFiles(['src/bin/m1-bench.rs', 'src/bench.rs'], ['src/bench.rs'])).toBe(false);
    });

    it('never flags a no-write turn (nothing was tried)', () => {
      expect(editsMissedFailingFiles([], ['src/bench.rs'])).toBe(false);
    });

    it('never flags without failing files', () => {
      expect(editsMissedFailingFiles(['src/a.rs'], [])).toBe(false);
    });
  });
});
