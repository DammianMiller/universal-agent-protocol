/**
 * A file the agent cannot finish reading is a task it cannot finish.
 *
 * `read_file` returned `contents.slice(0, 8000)` and said nothing about it.
 * Measured live on 2026-08-11 (cognition-engine, run …T015944): the mission was
 * "replace the 6 lateral joins in setup.sql at lines 607, 803, 861, 928, 1047,
 * 1101". setup.sql is 246,583 bytes / 8,025 lines, so the window ended at line
 * 270 — 3.2% of the file — and every one of those six lines was unreachable:
 *
 *   line  607 -> byte  18,287   INVISIBLE
 *   line  803 -> byte  24,348   INVISIBLE
 *   line  861 -> byte  26,000   INVISIBLE
 *   line  928 -> byte  28,004   INVISIBLE
 *   line 1047 -> byte  31,909   INVISIBLE
 *   line 1101 -> byte  33,075   INVISIBLE
 *
 * The model read that same 8 KB 76 times and ran list_dir 133 times across 439
 * rounds and 2h55m. The RECON write-nudge fired in 20 of 38 turns. It was not
 * confused — it was hunting for text the tool would never return, with no way
 * to learn that the rest of the file existed.
 */
import { describe, it, expect } from 'vitest';
import {
  readFileWindow,
  repeatReadNote,
  buildForcedRoundGrounding,
  newReadCache,
} from '../../src/delivery/agentic-executor.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** A file shaped like the one that caused this: long, with a target far in. */
function bigFile(lines = 8025): string {
  return Array.from({ length: lines }, (_, i) =>
    i + 1 === 607 ? 'LEFT JOIN LATERAL (SELECT ...) -- target 607' : `-- line ${i + 1} filler text`
  ).join('\n');
}

describe('readFileWindow', () => {
  it('reaches a line the old window could never return', () => {
    const out = readFileWindow(bigFile(), { offset: 607, windowBytes: 8000, path: 'setup.sql' });
    expect(out).toContain('target 607');
  });

  it('says what it left out, instead of truncating silently', () => {
    const out = readFileWindow(bigFile(), { windowBytes: 8000, path: 'setup.sql' });
    expect(out).toContain('showing lines 1-');
    expect(out).toContain('of 8025');
    expect(out, 'the reply must name the exact next call').toContain('"offset":');
  });

  it('hands back a next-offset that actually continues the file', () => {
    const file = bigFile(300);
    const first = readFileWindow(file, { windowBytes: 400, path: 'f.txt' });
    const next = Number(/"offset":(\d+)/.exec(first)![1]);
    const second = readFileWindow(file, { offset: next, windowBytes: 400, path: 'f.txt' });
    const lastOfFirst = Number(/showing lines 1-(\d+)/.exec(first)![1]);
    expect(next, 'no gap and no overlap').toBe(lastOfFirst + 1);
    expect(second).toContain(`-- line ${next} filler`);
  });

  it('pages the whole file in a finite number of calls, losing no line', () => {
    const file = bigFile(500);
    const seen: string[] = [];
    let offset = 1;
    for (let i = 0; i < 200; i++) {
      const out = readFileWindow(file, { offset, windowBytes: 300, path: 'f.txt' });
      const m = /showing lines (\d+)-(\d+) of (\d+)/.exec(out);
      seen.push(out.split('\n\n…')[0]!);
      if (!m) break;
      const end = Number(m[2]);
      if (end >= Number(m[3])) break;
      offset = end + 1;
    }
    const rebuilt = seen.join('\n');
    expect(rebuilt.split('\n')).toHaveLength(500);
    expect(rebuilt).toBe(file);
  });

  it('returns a short file whole, with no trailer to read around', () => {
    const small = 'line one\nline two\nline three';
    expect(readFileWindow(small, { windowBytes: 8000, path: 's.txt' })).toBe(small);
  });

  it('always returns at least one line, even when that line exceeds the window', () => {
    // Otherwise a minified file or a single long line reads as empty, which is
    // the same dead end in a different costume.
    const huge = 'x'.repeat(50_000) + '\nsecond';
    const out = readFileWindow(huge, { windowBytes: 8000, path: 'min.js' });
    expect(out.startsWith('xxxx')).toBe(true);
    expect(out).toContain('showing lines 1-1 of 2');
  });

  it('says so plainly when the offset is past the end', () => {
    const out = readFileWindow('a\nb\nc', { offset: 99, windowBytes: 8000, path: 'f.txt' });
    expect(out).toContain('past the end');
    expect(out).toContain('3 lines');
  });

  it('treats a garbage or zero offset as the start rather than erroring', () => {
    const file = bigFile(50);
    for (const offset of [0, -5, NaN, undefined]) {
      const out = readFileWindow(file, { offset: offset as number, windowBytes: 300, path: 'f.txt' });
      expect(out, String(offset)).toContain('-- line 1 filler');
    }
  });
});

describe('paging is not re-reading', () => {
  const roots: string[] = [];
  const project = () => {
    const r = mkdtempSync(join(tmpdir(), 'uap-paging-'));
    roots.push(r);
    return r;
  };

  it('does not scold the model for reading the NEXT page', () => {
    // The repeat-read note tells the model that re-reading teaches it nothing.
    // Aimed at a paging read it would say "you already read this" about a part
    // of the file it has never seen — pushing it back into the read-loop.
    const root = project();
    writeFileSync(join(root, 'big.sql'), bigFile(2000));
    const cache = newReadCache();
    expect(repeatReadNote(cache, root, 'read_file', { path: 'big.sql' }, 1)).toBeNull();
    expect(repeatReadNote(cache, root, 'read_file', { path: 'big.sql', offset: 600 }, 2)).toBeNull();
    expect(repeatReadNote(cache, root, 'read_file', { path: 'big.sql', offset: 1200 }, 3)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('still catches a genuine repeat of the SAME window', () => {
    const root = project();
    writeFileSync(join(root, 'big.sql'), bigFile(2000));
    const cache = newReadCache();
    repeatReadNote(cache, root, 'read_file', { path: 'big.sql', offset: 600 }, 1);
    const note = repeatReadNote(cache, root, 'read_file', { path: 'big.sql', offset: 600 }, 2);
    expect(note).toContain('unchanged since you read');
    rmSync(root, { recursive: true, force: true });
  });

  it('grounds a file the model reached ONLY by paging', () => {
    // The sharp case: every read of this file carried an offset, so the cache
    // holds no bare "read_file:<path>" key at all. Recovering the path by
    // slicing the key yields "big.sql@2", which does not exist — the read
    // fails, the entry is skipped, and the forced round goes in blind on
    // exactly the long file the model was struggling with.
    const root = project();
    writeFileSync(join(root, 'big.sql'), 'alpha\nbravo\ncharlie');
    const cache = newReadCache();
    repeatReadNote(cache, root, 'read_file', { path: 'big.sql', offset: 2 }, 1);

    const grounding = buildForcedRoundGrounding(cache, root);
    expect(grounding, 'a file only ever paged must still ground the round').toBeTruthy();
    expect(grounding).toContain('alpha');
    rmSync(root, { recursive: true, force: true });
  });

  it('grounds a paged file ONCE, under its real path', () => {
    // Grounding used to recover the path by slicing the cache key. With an
    // offset in the key that yields "big.sql@600", which does not exist — the
    // read fails, the entry is skipped, and the forced round goes in blind.
    const root = project();
    writeFileSync(join(root, 'big.sql'), 'alpha\nbravo\ncharlie');
    const cache = newReadCache();
    repeatReadNote(cache, root, 'read_file', { path: 'big.sql' }, 1);
    repeatReadNote(cache, root, 'read_file', { path: 'big.sql', offset: 2 }, 2);

    const grounding = buildForcedRoundGrounding(cache, root);
    expect(grounding, 'a paged file must still ground the forced round').toBeTruthy();
    expect(grounding).toContain('alpha');
    expect(grounding!.match(/--- big\.sql \(current content\) ---/g), 'once, not per window')
      .toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
