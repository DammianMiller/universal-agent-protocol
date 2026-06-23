import { describe, it, expect } from 'vitest';
import {
  normalizeToolPath,
  normalizeToolInput,
} from '../src/self-harness/middleware/path-normalizer.js';

// The real workdir for the title-case bench task.
const FILES = ['titlecase.js', 'package.json'];

describe('path-normalizer — the actual garble cases observed this cycle', () => {
  const cases: [string, string, string][] = [
    // [proposed (garbled), expected (real), what kind of garble]
    ['titlecase.js', 'titlecase.js', 'already correct → unchanged'],
    ['titleCase.js', 'titlecase.js', 'capitalization'],
    ['titlecasejs', 'titlecase.js', 'dropped the dot/extension'],
    ['titlecase/titleCase.js', 'titlecase.js', 'stray subdir + case'],
    ['titlecase.js\n', 'titlecase.js', 'trailing newline'],
    ['  titlecase.js  ', 'titlecase.js', 'surrounding whitespace'],
    ['/tmp/wd/titlecase.js', 'titlecase.js', 'absolute path → basename match'],
    ['titlecsae.js', 'titlecase.js', 'transposition typo (edit distance)'],
  ];
  for (const [proposed, expected, label] of cases) {
    it(`snaps "${JSON.stringify(proposed)}" → "${expected}" (${label})`, () => {
      expect(normalizeToolPath(proposed, FILES).path).toBe(expected);
    });
  }

  it('reports changed=false only when already correct', () => {
    expect(normalizeToolPath('titlecase.js', FILES).changed).toBe(false);
    expect(normalizeToolPath('titleCase.js', FILES).changed).toBe(true);
  });
});

describe('path-normalizer — does NOT invent targets (safety)', () => {
  it('leaves a genuinely new file alone (legitimate create)', () => {
    // "helper.js" shares nothing with the existing files → no confident snap.
    const r = normalizeToolPath('helper.js', FILES);
    expect(r.changed).toBe(false);
    expect(r.path).toBe('helper.js');
  });
  it('does not snap when two files are equally close (ambiguous)', () => {
    const files = ['a.js', 'b.js'];
    // "c.js" is edit-distance 1 from both → ambiguous → unchanged.
    expect(normalizeToolPath('c.js', files).changed).toBe(false);
  });
  it('returns unchanged with an empty workdir', () => {
    expect(normalizeToolPath('x.js', []).changed).toBe(false);
  });
});

describe('path-normalizer — tool-input integration', () => {
  it('corrects a Write file_path and reports the correction', () => {
    const { input, corrections } = normalizeToolInput(
      { file_path: 'titleCase.js', content: 'x' },
      FILES,
    );
    expect(input.file_path).toBe('titlecase.js');
    expect(input.content).toBe('x'); // non-path args untouched
    expect(corrections).toEqual([
      { key: 'file_path', from: 'titleCase.js', to: 'titlecase.js', reason: 'case-normalized to the real filename' },
    ]);
  });
  it('no corrections when the path is already correct', () => {
    const { corrections } = normalizeToolInput({ file_path: 'titlecase.js' }, FILES);
    expect(corrections).toHaveLength(0);
  });
  it('ignores non-string / non-path args', () => {
    const { corrections } = normalizeToolInput({ command: 'ls', timeout: 5 }, FILES);
    expect(corrections).toHaveLength(0);
  });
});
