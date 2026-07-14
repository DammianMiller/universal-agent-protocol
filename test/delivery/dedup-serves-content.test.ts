/**
 * A repeated read gets a NUDGE, never a denial.
 *
 * The dedup guard (v1.148.21) replaced the file content with "UNCHANGED — act on
 * what you have". That was a deadlock. The model re-reads a file for a REASON:
 * its context was pruned, or this is a fresh agent session and it never had the
 * content in the first place. Answering "you already read that" while WITHHOLDING
 * the content leaves it unable to proceed — so it asks again.
 *
 * Live result: 76 re-reads of one file, 64 nudges fired, ZERO writes in 36
 * minutes. The guard caught the loop and then guaranteed it.
 *
 * This is the same failure as the phantom run_bash, the unreadable acceptance
 * gate, the "stop writing" order and the raw EISDIR — the harness punishing a
 * reasonable move. This one was self-inflicted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { newReadCache, repeatReadNote } from '../../src/delivery/agentic-executor.js';

describe('repeatReadNote — nudge, never deny', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-dd-')); writeFileSync(join(dir, 'a.txt'), 'IMPORTANT CONTENT'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the note is a NOTE, not a refusal — it must not read as a denial', () => {
    const c = newReadCache();
    expect(repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 1)).toBeNull();
    const note = repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 2)!;
    expect(note).toMatch(/content follows anyway/i);
    expect(note).not.toMatch(/cannot tell you anything new\.\s*Act on what you already have/);
  });

  it('still identifies the repeat so the caller can prepend it', () => {
    const c = newReadCache();
    repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 1);
    expect(repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 7)).toMatch(/round 1/);
  });

  it('a CHANGED file is never nudged — it is genuinely new information', () => {
    const c = newReadCache();
    repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 1);
    writeFileSync(join(dir, 'a.txt'), 'DIFFERENT');
    // mtime granularity: force a distinct timestamp
    const later = new Date(Date.now() + 4000);
    require('fs').utimesSync(join(dir, 'a.txt'), later, later);
    expect(repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 2)).toBeNull();
  });
});
