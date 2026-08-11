/**
 * The same defect as read_file's silent 8 KB window, in two more costumes.
 *
 * `list_dir` was `readdirSync(...).join('\n').slice(0, 4000)` — cut mid-name,
 * no marker, no way to reach the rest. `run_bash` was
 * `${stdout}${stderr}.slice(0, 4000)` — which keeps the WORST half: a failing
 * build prints its verdict at the END ("error: could not compile", "3 failed,
 * 41 passed"), and unlike a file, command output cannot be asked for again.
 *
 * Measured before changing them (2026-08-11): neither had bitten yet — the
 * directories that run listed were 117 and 39 characters, and run_bash appears
 * zero times across 159 delivery logs because it is off without a sandbox. So
 * these are fixed on the principle the read_file loop established, not on
 * observed damage: a truncation nobody is told about cannot be worked around.
 */
import { describe, it, expect } from 'vitest';
import {
  listingWindow,
  clipCommandOutput,
  repeatReadNote,
  newReadCache,
  TOOL_OUTPUT_MAX_BYTES,
} from '../../src/delivery/agentic-executor.js';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const manyEntries = (n: number) => Array.from({ length: n }, (_, i) => `file_${i + 1}.rs`);

describe('listingWindow', () => {
  it('returns a small directory whole, with nothing to read around', () => {
    expect(listingWindow(['a.rs', 'b/', 'c.toml'], { path: 'src' })).toBe('a.rs\nb/\nc.toml');
  });

  it('never cuts a filename in half', () => {
    // Half a filename is worse than no filename: the model will confidently
    // read_file it, get an error, and have learned nothing.
    const out = listingWindow(manyEntries(2000), { maxBytes: 200, path: '.' });
    const body = out.split('\n\n…')[0]!;
    for (const line of body.split('\n')) {
      expect(line, line).toMatch(/^file_\d+\.rs$/);
    }
  });

  it('says how much of the directory it showed', () => {
    const out = listingWindow(manyEntries(2000), { maxBytes: 200, path: 'src' });
    expect(out).toContain('of 2000');
    expect(out).toContain('"offset":');
  });

  it('reaches an entry past the first window', () => {
    const out = listingWindow(manyEntries(2000), { offset: 1900, maxBytes: 200, path: '.' });
    expect(out).toContain('file_1900.rs');
  });

  it('walks the whole directory with no gap and no repeat', () => {
    // Follows the offset the REPLY gives, not one the test works out for
    // itself — the trailer is an instruction to the model, so a wrong next
    // offset is a real defect and a test that recomputes it cannot see one.
    const entries = manyEntries(500);
    const seen: string[] = [];
    let offset: number | null = 1;
    for (let i = 0; i < 200 && offset !== null; i++) {
      const out: string = listingWindow(entries, { offset, maxBytes: 120, path: '.' });
      seen.push(...out.split('\n\n…')[0]!.split('\n'));
      const next = /"offset":(\d+)/.exec(out);
      offset = next ? Number(next[1]) : null;
    }
    expect(seen).toEqual(entries);
  });

  it('says so plainly when the offset is past the end', () => {
    expect(listingWindow(['a', 'b'], { offset: 50, path: 'src' })).toContain('past the end');
  });

  it('returns empty for an empty directory rather than a confusing trailer', () => {
    expect(listingWindow([], { path: 'empty' })).toBe('');
  });

  it('always shows at least one entry, even a pathologically long name', () => {
    const out = listingWindow(['x'.repeat(9000), 'short.rs'], { maxBytes: 4000, path: '.' });
    expect(out.startsWith('xxxx')).toBe(true);
    expect(out).toContain('of 2');
  });
});

describe('clipCommandOutput', () => {
  /** What a failing build actually looks like: noise first, verdict last. */
  const build = (noise: number) =>
    'error[E0432]: unresolved import `crate::foo`\n' +
    'warning: unused variable\n'.repeat(noise) +
    'error: could not compile `pg-ext` (lib) due to 1 previous error\n' +
    'test result: FAILED. 3 failed; 41 passed';

  it('passes short output through untouched', () => {
    expect(clipCommandOutput('cargo check: clean')).toBe('cargo check: clean');
  });

  it('KEEPS THE VERDICT — the reason head-only truncation was wrong', () => {
    const out = clipCommandOutput(build(400), 4000);
    expect(out, 'the summary line lives at the very end').toContain('3 failed; 41 passed');
    expect(out).toContain('could not compile');
  });

  it('keeps the first error too, since later ones usually cascade from it', () => {
    expect(clipCommandOutput(build(400), 4000)).toContain('error[E0432]');
  });

  it('states the gap where the gap is, so nobody reads straight across it', () => {
    const out = clipCommandOutput(build(400), 4000);
    expect(out).toMatch(/… \[\d+ bytes of output elided/);
    const marker = out.indexOf('elided');
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(out.length - 1);
  });

  it('stays within a bounded multiple of the budget', () => {
    // The marker costs something; what must not happen is the "clip" returning
    // most of a 10 MB build log.
    const out = clipCommandOutput('x'.repeat(5_000_000), 4000);
    expect(out.length).toBeLessThan(4000 + 200);
  });

  it('defaults to the documented budget', () => {
    const out = clipCommandOutput('y'.repeat(TOOL_OUTPUT_MAX_BYTES + 5_000));
    expect(out.length).toBeLessThan(TOOL_OUTPUT_MAX_BYTES + 200);
    expect(out).toContain('elided');
  });

  it('reports the true original size, not the clipped one', () => {
    const out = clipCommandOutput('z'.repeat(20_000), 4000);
    expect(out).toContain('of 20000 bytes');
  });
});

describe('paging a directory is not re-listing it', () => {
  it('does not scold the model for asking for the next page of entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-listpage-'));
    mkdirSync(join(root, 'src'));
    const cache = newReadCache();
    expect(repeatReadNote(cache, root, 'list_dir', { path: 'src' }, 1)).toBeNull();
    expect(repeatReadNote(cache, root, 'list_dir', { path: 'src', offset: 200 }, 2)).toBeNull();
    // …but a genuine repeat of the same window still earns the note.
    const note = repeatReadNote(cache, root, 'list_dir', { path: 'src', offset: 200 }, 3);
    expect(note).toContain('unchanged since you read');
    rmSync(root, { recursive: true, force: true });
  });
});
