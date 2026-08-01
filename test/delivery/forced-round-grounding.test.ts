import { describe, expect, it } from 'vitest';
import {
  buildForcedRoundGrounding,
  newReadCache,
  FORCED_GROUNDING_MAX_FILES,
  FORCED_GROUNDING_MAX_BYTES,
} from '../../src/delivery/agentic-executor.js';

const ROOT = '/proj';

function cacheWith(entries: Array<[string, number]>) {
  const c = newReadCache();
  // Real keys are `${tool}:${path}` — see repeatReadNote. Modelling that
  // matters: with bare paths these tests passed while production read a
  // file literally named 'read_file:a.js' and grounded nothing.
  for (const [path, round] of entries) c.seen.set(`read_file:${path}`, { mtimeMs: 1, round });
  return c;
}

describe('buildForcedRoundGrounding', () => {
  it('returns undefined when nothing has been read', () => {
    expect(buildForcedRoundGrounding(newReadCache(), ROOT, () => 'x')).toBeUndefined();
  });

  it('ignores list_dir entries — a directory is not groundable content', () => {
    // The cache holds both tools under one map. Treating a list_dir key as a
    // path makes every read fail and the whole grounding silently vanish,
    // which is exactly how the first implementation broke.
    const c = newReadCache();
    c.seen.set('list_dir:src', { mtimeMs: 1, round: 5 });
    expect(buildForcedRoundGrounding(c, ROOT, () => 'dir listing')).toBeUndefined();

    c.seen.set('read_file:src/a.js', { mtimeMs: 1, round: 6 });
    const out = buildForcedRoundGrounding(c, ROOT, () => 'real content');
    expect(out).toContain('src/a.js');
    expect(out).not.toContain('list_dir');
  });

  it('injects the current on-disk content of a read file', () => {
    const out = buildForcedRoundGrounding(cacheWith([['a.js', 1]]), ROOT, () => 'const a = 1;');
    expect(out).toContain('a.js');
    expect(out).toContain('const a = 1;');
  });

  // The whole point: the model must edit against fact, not recall. If it were
  // handed the content it *remembered*, the stale-context failures this fixes
  // (`old_string not found`) would survive.
  it('reads through to disk at force time, not from the cache', () => {
    const out = buildForcedRoundGrounding(cacheWith([['a.js', 1]]), ROOT, () => 'CHANGED ON DISK');
    expect(out).toContain('CHANGED ON DISK');
  });

  it('prefers the most recently read files', () => {
    // One more candidate than the cap, so the oldest must be the one dropped.
    const out = buildForcedRoundGrounding(
      cacheWith([['oldest.js', 1], ['old.js', 4], ['newer.js', 9], ['newest.js', 12]]),
      ROOT,
      (p) => `body of ${p}`,
    );
    expect(out).toContain('newest.js');
    expect(out).toContain('newer.js');
    expect(out).toContain('old.js');
    expect(out).not.toContain('oldest.js');
  });

  it('caps the number of files', () => {
    const many = Array.from({ length: 10 }, (_, i) => [`f${i}.js`, i] as [string, number]);
    const out = buildForcedRoundGrounding(cacheWith(many), ROOT, () => 'x') ?? '';
    const injected = (out.match(/\(current content\)/g) ?? []).length;
    expect(injected).toBe(FORCED_GROUNDING_MAX_FILES);
  });

  it('stays within the byte budget so it cannot blow the context rail', () => {
    const huge = 'y'.repeat(FORCED_GROUNDING_MAX_BYTES * 2);
    const out = buildForcedRoundGrounding(cacheWith([['big.js', 1]]), ROOT, () => huge) ?? '';
    expect(out.length).toBeLessThan(FORCED_GROUNDING_MAX_BYTES + 2_000);
    expect(out).toContain('truncated');
  });

  // Grounding is a best-effort assist on an already-degraded path. If a file
  // vanished since it was read, the forced round must still happen — throwing
  // here would turn a recoverable round into a dead session.
  it('skips unreadable files instead of throwing', () => {
    const out = buildForcedRoundGrounding(
      cacheWith([['gone.js', 2], ['here.js', 1]]),
      ROOT,
      (p) => {
        if (p.includes('gone.js')) throw new Error('ENOENT');
        return 'still here';
      },
    );
    expect(out).toContain('still here');
    expect(out).not.toContain('gone.js');
  });

  it('returns undefined when every candidate is unreadable', () => {
    const out = buildForcedRoundGrounding(cacheWith([['gone.js', 1]]), ROOT, () => {
      throw new Error('ENOENT');
    });
    expect(out).toBeUndefined();
  });

  it('tells the model to copy old_string verbatim and avoid whole-file rewrites', () => {
    // These two instructions target the measured failures: a 4-character
    // old_string that matched 20 places, and whole-file re-emission as the
    // recovery from a broken edit.
    const out = buildForcedRoundGrounding(cacheWith([['a.js', 1]]), ROOT, () => 'x') ?? '';
    expect(out).toMatch(/verbatim/i);
    expect(out).toMatch(/whole file/i);
  });
});
