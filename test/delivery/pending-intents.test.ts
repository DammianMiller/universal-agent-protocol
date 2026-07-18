/**
 * P1 (plan D1): gate-recorded edit intents replay deterministically —
 * exact-anchor replacement, ordered, filterable by file, fail-loud on moved
 * anchors, never fuzzy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readPendingIntents, applyPendingIntents } from '../../src/delivery/pending-intents.js';

describe('pending-intents', () => {
  let dir: string;

  const record = (intents: object[]) => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'pending-deliver.jsonl'),
      intents.map((i) => JSON.stringify(i)).join('\n') + '\n');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pend-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'const x = 1;\nconst y = 2;\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replays a replace intent whose anchor matches exactly once', () => {
    record([{ ts: 1, tool: 'Edit', file_path: 'src/a.ts', edit: { old_string: 'const x = 1;', new_string: 'const x = 42;' } }]);
    const res = applyPendingIntents(dir);
    expect(res.applied).toHaveLength(1);
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf-8')).toContain('x = 42');
  });

  it('skips loudly when the anchor is gone or ambiguous — never fuzzy', () => {
    record([
      { ts: 1, tool: 'Edit', file_path: 'src/a.ts', edit: { old_string: 'NOT PRESENT', new_string: 'x' } },
      { ts: 2, tool: 'Edit', file_path: 'src/a.ts', edit: { old_string: 'const', new_string: 'let' } },
    ]);
    const res = applyPendingIntents(dir);
    expect(res.applied).toHaveLength(0);
    expect(res.skipped.map((s) => s.reason).join(' ')).toMatch(/not found/);
    expect(res.skipped.map((s) => s.reason).join(' ')).toMatch(/matches 2 times/);
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf-8')).toContain('const x = 1;');
  });

  it('replays a Write intent as a whole-file write and applies in recorded order', () => {
    record([
      { ts: 1, tool: 'Write', file_path: 'src/b.ts', edit: { content: 'export const b = 1;\n' } },
      { ts: 2, tool: 'Edit', file_path: 'src/b.ts', edit: { old_string: 'b = 1', new_string: 'b = 2' } },
    ]);
    const res = applyPendingIntents(dir);
    expect(res.applied.map((a) => a.kind)).toEqual(['write', 'replace']);
    expect(readFileSync(join(dir, 'src/b.ts'), 'utf-8')).toContain('b = 2');
  });

  it('filters by file and refuses paths outside the project root', () => {
    record([
      { ts: 1, tool: 'Edit', file_path: 'src/a.ts', edit: { old_string: 'const y = 2;', new_string: 'const y = 3;' } },
      { ts: 2, tool: 'Edit', file_path: '../outside.ts', edit: { old_string: 'x', new_string: 'y' } },
      { ts: 3, tool: 'Edit', file_path: 'src/other.ts', edit: { old_string: 'x', new_string: 'y' } },
    ]);
    const res = applyPendingIntents(dir, 'src/a.ts');
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].file.endsWith('a.ts')).toBe(true);
    const all = applyPendingIntents(dir);
    expect(all.skipped.some((s) => s.reason === 'outside project root')).toBe(true);
  });

  it('skips pre-D1 intents (hint only, no recorded content)', () => {
    record([{ ts: 1, tool: 'Edit', file_path: 'src/a.ts', hint: 'implement the intended change' }]);
    const res = applyPendingIntents(dir);
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/no replayable content/);
  });

  it('consumes applied intents — a second replay run is a no-op and never duplicates', () => {
    // Insertion-style edit: old_string survives as a prefix of new_string, so
    // the anchor still matches after application. Pre-fix, every replay run
    // re-applied it and duplicated the inserted block.
    record([{ ts: 1, tool: 'Edit', file_path: 'src/a.ts',
      edit: { old_string: 'const x = 1;', new_string: 'const x = 1;\nconst inserted = true;' } }]);
    const first = applyPendingIntents(dir);
    expect(first.applied).toHaveLength(1);
    const after = readFileSync(join(dir, 'src/a.ts'), 'utf-8');
    expect(after.split('const inserted = true;').length - 1).toBe(1);

    const second = applyPendingIntents(dir);
    expect(second.applied).toHaveLength(0);
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf-8')).toBe(after);
    // consumed from the pending log, archived to the applied log
    expect(readPendingIntents(dir)).toHaveLength(0);
    expect(readFileSync(join(dir, '.uap', 'pending-deliver.applied.jsonl'), 'utf-8')).toContain('const inserted = true;');
  });

  it('skips an insertion intent whose new content is already on disk (already applied)', () => {
    // The same insertion recorded twice (e.g. the agent retried the blocked
    // edit): the first applies, the duplicate must be detected + consumed.
    const edit = { old_string: 'const y = 2;', new_string: 'const y = 2;\nconst z = 3;' };
    record([
      { ts: 1, tool: 'Edit', file_path: 'src/a.ts', edit },
      { ts: 2, tool: 'Edit', file_path: 'src/a.ts', edit },
    ]);
    const res = applyPendingIntents(dir);
    expect(res.applied).toHaveLength(1);
    expect(res.skipped.map((s) => s.reason)).toContain('already applied (new content present)');
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf-8').split('const z = 3;').length - 1).toBe(1);
    expect(readPendingIntents(dir)).toHaveLength(0);
  });

  it('consumes an identical whole-file write as already applied', () => {
    writeFileSync(join(dir, 'src/c.ts'), 'export const c = 1;\n');
    record([{ ts: 1, tool: 'Write', file_path: 'src/c.ts', edit: { content: 'export const c = 1;\n' } }]);
    const res = applyPendingIntents(dir);
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0].reason).toBe('already applied (content identical)');
    expect(readPendingIntents(dir)).toHaveLength(0);
  });

  it('keeps stale-anchor and pre-D1 intents in the log (not consumed)', () => {
    record([
      { ts: 1, tool: 'Edit', file_path: 'src/a.ts', edit: { old_string: 'NOT PRESENT', new_string: 'x' } },
      { ts: 2, tool: 'Edit', file_path: 'src/a.ts', hint: 'implement the intended change' },
      { ts: 3, tool: 'Edit', file_path: 'src/a.ts', edit: { old_string: 'const x = 1;', new_string: 'const x = 9;' } },
    ]);
    const res = applyPendingIntents(dir);
    expect(res.applied).toHaveLength(1);
    const left = readPendingIntents(dir);
    expect(left.map((i) => i.ts).sort()).toEqual([1, 2]);
  });

  it('readPendingIntents tolerates garbage lines and a missing log', () => {
    expect(readPendingIntents(dir)).toEqual([]);
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'pending-deliver.jsonl'), 'not-json\n{"file_path":"src/a.ts","ts":1,"tool":"Edit"}\n');
    expect(readPendingIntents(dir)).toHaveLength(1);
  });
});
