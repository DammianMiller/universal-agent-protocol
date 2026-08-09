import { describe, it, expect } from 'vitest';
import {
  resolveEditMatch,
  applyEditMatch,
  applyRangeEdit,
  nearestMatchReport,
  isIndentSensitive,
} from '../../src/delivery/edit-match.js';

const FILE = [
  'export function greet(name: string) {',
  '    const msg = `hello ${name}`;',
  '    return msg;',
  '}',
  '',
  'export function farewell(name: string) {',
  '    return `bye ${name}`;',
  '}',
  '',
].join('\n');

describe('resolveEditMatch — exact rung (unchanged behaviour)', () => {
  it('matches byte-identical text and reports the exact span', () => {
    const m = resolveEditMatch(FILE, '    return msg;');
    expect(m.kind).toBe('exact');
    expect(applyEditMatch(FILE, m, '    return msg.trim();')).toContain('return msg.trim();');
  });

  it('refuses an ambiguous anchor rather than guessing', () => {
    const doubled = 'let x = 1;\nlet x = 1;\n';
    const m = resolveEditMatch(doubled, 'let x = 1;');
    expect(m.kind).toBe('ambiguous');
    expect(m.count).toBe(2);
    expect(m.note).toMatch(/occurrence/);
  });

  it('honours a 1-based occurrence selector', () => {
    const doubled = 'let x = 1;\nlet x = 1;\n';
    const m = resolveEditMatch(doubled, 'let x = 1;', { occurrence: 2 });
    expect(m.kind).toBe('exact');
    expect(applyEditMatch(doubled, m, 'let x = 2;')).toBe('let x = 1;\nlet x = 2;\n');
  });
});

describe('resolveEditMatch — tolerant rung (harness plan A1)', () => {
  it('recovers an edit whose internal spacing is wrong', () => {
    // The model remembered the code but not the exact spacing around `=`.
    // Exact matching is substring-based, so it fails outright here; before this
    // rung the turn was simply lost.
    const needle = 'const msg  =  `hello ${name}`;';
    expect(FILE.includes(needle)).toBe(false);
    const m = resolveEditMatch(FILE, needle);
    expect(m.kind).toBe('tolerant');
    const updated = applyEditMatch(FILE, m, '    const msg = `hi ${name}`;');
    expect(updated).toContain('    const msg = `hi ${name}`;');
    // The surrounding lines survive untouched — the span must not swallow them.
    expect(updated).toContain('    return msg;');
    expect(updated.split('\n').length).toBe(FILE.split('\n').length);
  });

  it('recovers a multi-line block with collapsed internal whitespace', () => {
    const m = resolveEditMatch(FILE, 'const msg = `hello ${name}`;\nreturn msg;');
    expect(m.kind).toBe('tolerant');
    expect(m.note).toMatch(/normalis/i);
  });

  it('can be switched off — it is a measurable harness knob, not a constant', () => {
    const needle = 'const msg  =  `hello ${name}`;';
    expect(resolveEditMatch(FILE, needle).kind).toBe('tolerant');
    expect(resolveEditMatch(FILE, needle, { tolerant: false }).kind).toBe('miss');
  });

  it('never matches on case or punctuation drift (that would apply a wrong edit)', () => {
    const m = resolveEditMatch(FILE, 'RETURN msg;');
    expect(m.kind).toBe('miss');
  });
});

describe('resolveEditMatch — miss diagnostics (harness plan A2)', () => {
  it('returns the current nearest region with line numbers instead of "not found"', () => {
    const m = resolveEditMatch(FILE, 'return message;');
    expect(m.kind).toBe('miss');
    expect(m.note).toMatch(/Nearest region/);
    expect(m.note).toMatch(/edit_range/);
    // Cites real line numbers the model can act on.
    expect(m.note).toMatch(/\d+\|/);
  });

  it('stays silent rather than quoting an unrelated region', () => {
    expect(nearestMatchReport(FILE, 'zzz qqq wwww vvvv')).toBe('');
  });
});

describe('applyRangeEdit (harness plan A3)', () => {
  it('replaces an inclusive 1-based line range', () => {
    const r = applyRangeEdit(FILE, 2, 3, '    return `hello ${name}`;');
    expect(r.ok).toBe(true);
    expect(r.replacedLines).toBe(2);
    const lines = r.text!.split('\n');
    expect(lines[1]).toBe('    return `hello ${name}`;');
    expect(lines[2]).toBe('}');
  });

  it('does not inject a blank line when new_text ends with a newline', () => {
    const r = applyRangeEdit(FILE, 2, 2, '    const msg = name;\n');
    expect(r.ok).toBe(true);
    expect(r.text!.split('\n').length).toBe(FILE.split('\n').length);
  });

  it('refuses a range past the end of the file', () => {
    const r = applyRangeEdit(FILE, 1, 999, 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/past the end/);
  });

  // Clamping this to the last line was tried on 2026-08-08 and reverted the
  // same day: on a newline-terminated file `lines.length` counts the phantom
  // trailing element, so the clamp ate the closing brace AND the final newline
  // — manufacturing the same "unclosed delimiter" corruption the run that
  // motivated the change had produced. A refusal costs one round; a silent
  // truncation costs the file. This test is the guard against re-adding it.
  it('leaves the file untouched rather than truncating its tail', () => {
    const src = 'function add(a, b) {\n    return a + b;\n}\n';
    const r = applyRangeEdit(src, 2, 300, '    return a * b;');
    expect(r.ok).toBe(false);
    expect(r.text).toBeUndefined();
  });

  it('names the last line so the retry needs no extra read', () => {
    // 'a\nb\n' is 2 lines of content; the error must say 2, not the 3 that
    // split('\n') reports, or the model retries with a number that fails again.
    const r = applyRangeEdit('a\nb\n', 1, 99, 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/has 2 lines/);
    expect(r.error).toMatch(/end_line=2/);
  });

  it('refuses an inverted range', () => {
    const r = applyRangeEdit(FILE, 5, 2, 'x');
    expect(r.ok).toBe(false);
  });
});

describe('tolerant rung does not corrupt what it edits (review findings)', () => {
  it('re-indents the replacement onto the TARGET indentation', () => {
    // The span starts at column 0 of the matched line while the needle was
    // unindented, so splicing verbatim would move the code to column 0 —
    // cosmetic in TS, an IndentationError in Python.
    const py = ['def f():', '        return  1', ''].join('\n');
    const m = resolveEditMatch(py, 'return 1');
    expect(m.kind).toBe('tolerant');
    const out = applyEditMatch(py, m, 'return 2');
    expect(out).toBe(['def f():', '        return 2', ''].join('\n'));
  });

  it('does not inject a blank line when new_string ends with a newline', () => {
    // Same (old,new) pair must not produce different files depending on which
    // rung fired. applyRangeEdit already stripped one trailing newline.
    const src = ['a();', 'b(  1  );', 'c();', ''].join('\n');
    const m = resolveEditMatch(src, 'b( 1 );');
    expect(m.kind).toBe('tolerant');
    expect(applyEditMatch(src, m, 'B();\n').split('\n').length).toBe(src.split('\n').length);
  });

  it('refuses a multi-site tolerant match instead of honouring a stale occurrence', () => {
    // `occurrence` was chosen against the model's belief about EXACT matches;
    // re-indexing it into the normalised candidate list would land the edit at
    // an unrelated site and still report success.
    const dup = ['x(  1  );', 'y();', 'x(   1   );', ''].join('\n');
    const m = resolveEditMatch(dup, 'x( 1 );', { occurrence: 2 });
    expect(m.kind).toBe('ambiguous');
    expect(m.note).toMatch(/too ambiguous/);
  });

  it('keeps indentation significant in Python-like files', () => {
    // The same two statements at two different indent levels. Dropping leading
    // whitespace makes them indistinguishable, so an anchor for one binds to the
    // other — a silent wrong-block edit. Preserving it disambiguates.
    const py = [
      'if x:',
      '    a( 1 )',
      '    b( 2 )',
      'if y:',
      '        a( 1 )',
      '        b( 2 )',
      '',
    ].join('\n');
    const needle = '    a(  1  )\n    b(  2  )';
    expect(py.includes(needle)).toBe(false); // exact rung cannot fire

    const loose = resolveEditMatch(py, needle, { indentSensitive: false });
    expect(loose.kind).toBe('ambiguous'); // both blocks look identical
    expect(loose.count).toBe(2);

    const strict = resolveEditMatch(py, needle, { indentSensitive: true });
    expect(strict.kind).toBe('tolerant'); // only the 4-space block matches
    expect(strict.index).toBe(py.indexOf('    a( 1 )'));
  });

  it('bounds the nearest-region report regardless of needle size', () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} content here`).join('\n');
    const needle = Array.from({ length: 200 }, (_, i) => `line ${i} content HERE`).join('\n');
    const report = nearestMatchReport(big, needle, 8);
    expect(report.split('\n').length).toBeLessThan(20);
  });
});

describe('isIndentSensitive', () => {
  it('flags whitespace-semantic languages', () => {
    for (const p of ['a.py', 'k8s.yaml', 'c.yml', 'Makefile', 'x.nim']) {
      expect(isIndentSensitive(p)).toBe(true);
    }
    for (const p of ['a.ts', 'b.js', 'c.rs', 'd.go', 'e.java']) {
      expect(isIndentSensitive(p)).toBe(false);
    }
  });
});
