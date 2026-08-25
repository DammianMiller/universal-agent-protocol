import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildForcedRoundGrounding,
  clipAroundAnchor,
  newReadCache,
  repeatReadNote,
  FORCED_GROUNDING_MAX_FILES,
  FORCED_GROUNDING_MAX_BYTES,
  FORCED_GROUNDING_MIN_WINDOW_BYTES,
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

/**
 * A cache entry standing in for a windowed read: the key carries the offset the
 * way repeatReadNote writes it, and so does the entry.
 */
function cacheWithWindow(path: string, round: number, offset: number) {
  const c = newReadCache();
  c.seen.set(`read_file:${path}@${offset}`, { mtimeMs: 1, round, path, offset });
  return c;
}

/**
 * A file with the geometry that produced the measured failure: long enough that
 * the byte budget cannot hold it, with the region under review well past the
 * point a head clip reaches.
 */
function longFile(lines: number) {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}: ${'x'.repeat(30)}`).join('\n');
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
    // Match the LABEL, not the bare word: the closing instructions now say
    // "truncated" on every output, so `toContain('truncated')` passes even for
    // a four-byte file and asserts nothing.
    expect(out).toMatch(/of \d+ — truncated/);
  });

  it('a body that fits is not labelled truncated', () => {
    // Guards the assertion above against sliding back into vacuity.
    const out = buildForcedRoundGrounding(cacheWith([['t.js', 1]]), ROOT, () => 'tiny') ?? '';
    expect(out).not.toMatch(/of \d+ — truncated/);
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

  // The measured failure (2026-08-25): a 952-line file, the region under review
  // at lines 725-732, and the model paging toward it from line 431 when the read
  // cap stripped its tools. A head-anchored clip stopped at line 615, so the
  // grounding could not contain the answer and the run reported "the file is
  // truncated before line 725" ten times before giving up.
  it('anchors the clip on the window the model was last reading, not the head', () => {
    const body = longFile(952);
    expect(body.length).toBeGreaterThan(FORCED_GROUNDING_MAX_BYTES);

    const out =
      buildForcedRoundGrounding(cacheWithWindow('pg-server.rs', 7, 431), ROOT, () => body) ?? '';

    expect(out).toContain('line 725:');
    expect(out).toContain('line 732:');
    // and it is genuinely a window, not the file smuggled in whole
    expect(out).not.toContain('line 1: ');
  });

  it('names the line range it holds so the block is not mistaken for a bad read', () => {
    const out =
      buildForcedRoundGrounding(cacheWithWindow('pg-server.rs', 7, 431), ROOT, () => longFile(952)) ??
      '';
    expect(out).toMatch(/lines \d+-\d+ of 952/);
    expect(out).toContain('last read at line 431');
    // The refusal this replaces: the model declared the whole file unreadable.
    expect(out).toMatch(/do not report the whole file as unreadable/i);
  });

  it('still grounds from the head when the model never used an offset', () => {
    const out = buildForcedRoundGrounding(cacheWith([['a.js', 1]]), ROOT, () => longFile(952)) ?? '';
    expect(out).toContain('line 1: ');
  });

  it('labels a whole file that fits without a spurious line range', () => {
    const out = buildForcedRoundGrounding(cacheWith([['a.js', 1]]), ROOT, () => 'const a = 1;') ?? '';
    expect(out).toContain('(current content)');
    expect(out).not.toMatch(/lines \d+-\d+ of/);
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

describe('clipAroundAnchor', () => {
  const body = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join('\n');

  it('returns the whole body untouched when it fits', () => {
    const w = clipAroundAnchor(body, 10_000, 50);
    expect(w.clipped).toBe(false);
    expect(w.text).toBe(body);
    expect(w).toMatchObject({ from: 1, to: 100, total: 100, anchor: 50 });
  });

  // THE invariant. An earlier version reserved a fixed lead-in above the anchor
  // before growing forward, so on a tight budget the window stopped short of
  // the anchor: 88% of clipped results did not contain the line they claimed to
  // be centred on. Sweeping the budget is the only way to catch that — a single
  // generous case passes either way.
  it('always contains its anchor, at every budget', () => {
    let clipped = 0;
    for (let maxBytes = 1; maxBytes <= body.length; maxBytes += 1) {
      for (const anchor of [1, 2, 37, 50, 99, 100]) {
        const w = clipAroundAnchor(body, maxBytes, anchor);
        if (!w.clipped) continue;
        clipped += 1;
        expect(w.anchor).toBeGreaterThanOrEqual(w.from);
        expect(w.anchor).toBeLessThanOrEqual(w.to);
      }
    }
    expect(clipped).toBeGreaterThan(100);
  });

  it('never returns more than the budget', () => {
    for (let maxBytes = 1; maxBytes <= body.length; maxBytes += 1) {
      const w = clipAroundAnchor(body, maxBytes, 50);
      if (w.clipped) expect(w.text.length).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('from/to name exactly the lines it returned', () => {
    const lines = body.split('\n');
    for (const maxBytes of [40, 120, 300, 600]) {
      const w = clipAroundAnchor(body, maxBytes, 50);
      expect(w.text).toBe(lines.slice(w.from - 1, w.to).join('\n'));
    }
  });

  it('grows forward from the anchor before spending budget backward', () => {
    // The model reads downward, so the lines it has not seen are the ones
    // worth buying first.
    const w = clipAroundAnchor(body, 40, 50);
    expect(w.from).toBe(50);
    expect(w.to).toBeGreaterThan(50);
  });

  it('spends leftover budget backward when the anchor is near the end', () => {
    // Anchored at the last line, forward growth yields one line; the rest of
    // the budget must buy context above it rather than go unused.
    const w = clipAroundAnchor(body, 200, 100);
    expect(w.to).toBe(100);
    expect(w.from).toBeLessThan(80);
  });

  it('clamps an anchor past the end of the file and reports the clamped one', () => {
    const w = clipAroundAnchor(body, 120, 5_000);
    expect(w.to).toBe(100);
    expect(w.anchor).toBe(100);
    expect(w.text).toContain('L100');
  });

  it('clamps a zero, negative or NaN anchor to the first line', () => {
    // The function is exported and its offset comes from a cache entry no
    // caller validates. A NaN anchor used to escape both clamps and return an
    // empty window labelled "lines NaN-NaN".
    for (const bad of [0, -5, Number.NaN]) {
      const w = clipAroundAnchor(body, 40, bad);
      expect(w.anchor).toBe(1);
      expect(w.from).toBe(1);
      expect(w.text).not.toBe('');
    }
  });

  it('does not count the phantom line a trailing newline splits into', () => {
    // Nearly every source file ends in a newline. Counting the empty tail
    // element inflates `total` and lets `to` name a line that does not exist,
    // desyncing these numbers from the ones read_file shows the model.
    expect(clipAroundAnchor('a\nb\nc\n', 100, 1)).toMatchObject({ total: 3, to: 3 });
    expect(clipAroundAnchor('a\nb\nc', 100, 1)).toMatchObject({ total: 3, to: 3 });
  });

  it('emits the head of the ANCHOR line when that line is wider than the budget', () => {
    const wide = ['short', 'z'.repeat(500), 'short'].join('\n');
    const w = clipAroundAnchor(wide, 100, 2);
    expect(w.partialLine).toBe(true);
    expect(w.text).toBe('z'.repeat(100));
    expect(w).toMatchObject({ from: 2, to: 2, anchor: 2, total: 3 });
  });

  it('treats an empty body as one line that fits', () => {
    expect(clipAroundAnchor('', 100, 1)).toMatchObject({
      text: '', total: 1, clipped: false, partialLine: false,
    });
  });
});


/**
 * Which of several windows of ONE file the grounding anchors on.
 *
 * This is the whole claim of the feature, and it was wrong twice: strict `>`
 * on the round let a same-round batch pick the earliest read, and the repeat
 * check returned before recording, so re-reading a deep window never refreshed
 * its recency. Both landed back on the head clip.
 */
describe('buildForcedRoundGrounding — which window wins', () => {
  function tempRootWith(rel: string, body: string) {
    const root = mkdtempSync(join(tmpdir(), 'grounding-'));
    writeFileSync(join(root, rel), body);
    return root;
  }

  it('picks the deeper window when both reads land in the SAME round', () => {
    // One round issues many tool calls, so both entries carry its number.
    const root = tempRootWith('big.rs', longFile(952));
    const c = newReadCache();
    repeatReadNote(c, root, 'read_file', { path: 'big.rs' }, 7);
    repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset: 431 }, 7);
    const out = buildForcedRoundGrounding(c, root) ?? '';
    expect(out).toContain('last read at line 431');
    expect(out).toContain('line 725:');
  });

  it('a re-read of a window refreshes its recency', () => {
    // The read-forever profile: the model hammers one deep window. Under the
    // old early-return that window kept the round of its first read and lost
    // to a single stray head read.
    const root = tempRootWith('big.rs', longFile(952));
    const c = newReadCache();
    repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset: 725 }, 3);
    repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset: 60 }, 5);
    const note = repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset: 725 }, 9);
    expect(note).toMatch(/unchanged since you read/); // still nudges on a repeat
    expect(note).toContain('at round 3'); // and still names the ORIGINAL round
    const out = buildForcedRoundGrounding(c, root) ?? '';
    expect(out).toContain('last read at line 725');
    expect(out).toContain('line 725:');
  });

  // Belt and braces: `seq` and the `>=` tie-break each fix the same-round case
  // on their own, so a single test lets either regress silently. These two pin
  // them separately.
  it('a re-read that updates an entry in place still wins on recency', () => {
    // Map.set on an existing key keeps the ORIGINAL insertion position, so
    // iteration order stops being chronological the moment a window is
    // re-read — and iteration order is all a round-only rule has to go on.
    const root = tempRootWith('big.rs', longFile(952));
    const c = newReadCache();
    repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset: 431 }, 7);
    repeatReadNote(c, root, 'read_file', { path: 'big.rs' }, 7);
    repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset: 431 }, 7);
    const out = buildForcedRoundGrounding(c, root) ?? '';
    expect(out).toContain('last read at line 431');
  });

  it('falls back to insertion order for entries carrying no seq', () => {
    // Hand-built caches (tests, and any caller filling the map directly) have
    // no seq, so the round tie-break is the only rule left and must not be
    // strict — within one round the LATER call is the model's latest.
    const c = newReadCache();
    c.seen.set('read_file:big.rs', { mtimeMs: 1, round: 7, path: 'big.rs', offset: 1 });
    c.seen.set('read_file:big.rs@431', { mtimeMs: 1, round: 7, path: 'big.rs', offset: 431 });
    const out = buildForcedRoundGrounding(c, ROOT, () => longFile(952)) ?? '';
    expect(out).toContain('last read at line 431');
  });

  it('grounds one block per file however many windows were read', () => {
    const root = tempRootWith('big.rs', longFile(952));
    const c = newReadCache();
    for (const offset of [1, 200, 431, 700]) {
      repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset }, 7);
    }
    const out = buildForcedRoundGrounding(c, root) ?? '';
    expect((out.match(/^--- /gm) ?? []).length).toBe(1);
  });

  // repeatReadNote is the ONLY production writer of the offset the whole
  // feature reads. Deleting `offset:` from that write used to leave the entire
  // delivery suite green while every real run reverted to head-clipping.
  it('records the read offset through the real write path', () => {
    const root = tempRootWith('big.rs', longFile(952));
    const c = newReadCache();
    repeatReadNote(c, root, 'read_file', { path: 'big.rs', offset: 700 }, 3);
    const out = buildForcedRoundGrounding(c, root) ?? '';
    expect(out).toContain('centred on your last read at line 700');
    expect(out).toContain('line 700:');
  });

  it('clamps a past-EOF offset in the label instead of quoting it back', () => {
    // read_file refuses an offset past the end, but repeatReadNote caches it
    // first — the label must not claim a line the file does not have.
    const out =
      buildForcedRoundGrounding(cacheWithWindow('big.rs', 7, 5_000), ROOT, () => longFile(952)) ??
      '';
    expect(out).toContain('last read at line 952');
    expect(out).not.toContain('line 5000');
  });
});

describe('buildForcedRoundGrounding — sharing the byte budget', () => {
  it('gives a second file a usable window instead of a fragment', () => {
    // A greedy first-come split let file 1 take the whole budget and handed
    // file 2 a mid-word fragment under a confident line-range label.
    const out =
      buildForcedRoundGrounding(
        (() => {
          const c = newReadCache();
          c.seen.set('read_file:a.rs@800', { mtimeMs: 1, round: 9, path: 'a.rs', offset: 800 });
          c.seen.set('read_file:b.rs@700', { mtimeMs: 1, round: 8, path: 'b.rs', offset: 700 });
          return c;
        })(),
        ROOT,
        () => longFile(2_000),
      ) ?? '';
    const bBody = out.slice(out.indexOf('--- b.rs')).split('\n').slice(1);
    expect(bBody.length).toBeGreaterThan(10);
    // and it is anchored on its OWN offset, not the first file's
    expect(out).toContain('--- b.rs (current content, lines');
    expect(out.slice(out.indexOf('--- b.rs'))).toContain('last read at line 700');
  });

  it('keeps every emitted body inside the total budget', () => {
    const c = newReadCache();
    for (const [i, path] of ['a.rs', 'b.rs', 'c.rs'].entries()) {
      c.seen.set(`read_file:${path}@800`, { mtimeMs: 1, round: 9 - i, path, offset: 800 });
    }
    const out = buildForcedRoundGrounding(c, ROOT, () => longFile(2_000)) ?? '';
    // Slice out the block bodies only: the preamble and the trailing
    // instruction paragraph are fixed overhead, not part of the file budget.
    const bodyBytes = out
      .split(/^--- .* ---$/m)
      .slice(1)
      .map((chunk, i, all) => (i === all.length - 1 ? chunk.split('\n\n')[0] : chunk))
      .reduce((n, chunk) => n + chunk.trim().length, 0);
    expect(bodyBytes).toBeLessThanOrEqual(FORCED_GROUNDING_MAX_BYTES);
  });

  it('omits a file rather than grounding it with an unusable sliver', () => {
    const c = newReadCache();
    // Far more candidates than the budget can serve well; the cap admits 3.
    for (const [i, path] of ['a.rs', 'b.rs', 'c.rs'].entries()) {
      c.seen.set(`read_file:${path}@800`, { mtimeMs: 1, round: 9 - i, path, offset: 800 });
    }
    const out = buildForcedRoundGrounding(c, ROOT, () => longFile(2_000)) ?? '';
    for (const chunk of out.split(/^--- .* ---$/m).slice(1, -1)) {
      expect(chunk.trim().length).toBeGreaterThanOrEqual(FORCED_GROUNDING_MIN_WINDOW_BYTES / 4);
    }
  });
});
