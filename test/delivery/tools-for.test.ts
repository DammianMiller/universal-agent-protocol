/**
 * Never advertise a tool you will refuse to run.
 *
 * run_bash was offered in the schema unconditionally and then REFUSED at
 * execution time whenever the run was not sandboxed. The model does what the
 * menu says: on a live mission it spent 58 of 79 tool calls on run_bash — every
 * one bounced — and managed only 21 writes. Nearly three quarters of the turn
 * budget burned on a tool that was never going to run.
 *
 * And it was not probing the sandbox: every attempt was read-only (`cat` ×44,
 * `wc`, `find`, `ls`, `head`). It simply reached for the shell it had been shown.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toolsFor, newReadCache, repeatReadNote } from '../../src/delivery/agentic-executor.js';

const names = (allowBash: boolean): string[] => toolsFor(allowBash).map((t) => t.function.name);

describe('toolsFor — the menu must match what we will actually execute', () => {
  it('HIDES run_bash when bash is disabled (the 58-wasted-calls bug)', () => {
    expect(names(false)).not.toContain('run_bash');
  });

  it('offers run_bash when it is genuinely allowed (sandboxed)', () => {
    expect(names(true)).toContain('run_bash');
  });

  it('keeps every other tool in both modes — read/list/write must never be dropped', () => {
    for (const t of ['read_file', 'list_dir', 'write_file']) {
      expect(names(false), `${t} missing when bash disabled`).toContain(t);
      expect(names(true), `${t} missing when bash allowed`).toContain(t);
    }
  });

  it('hiding run_bash removes exactly one tool, nothing else', () => {
    expect(names(true).length - names(false).length).toBe(1);
  });

  it('does not mutate the shared TOOLS list (filtering must not be destructive)', () => {
    toolsFor(false);
    expect(names(true)).toContain('run_bash');
  });
});

// NOTE: the guard NUDGES, it does not deny. Withholding the content was a
// deadlock — the model re-reads because its context was pruned or the agent
// session is fresh, so denying it the content meant it could never proceed
// (live: 76 re-reads, 64 nudges, ZERO writes). The caller now serves the content
// with the nudge prepended.
describe('repeatReadNote — nudge a repeated read (content is still served)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-rr-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('suppresses an IDENTICAL unchanged read (the 46x-same-list_dir thrash)', () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const c = newReadCache();
    expect(repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 1)).toBeNull(); // first: serve it
    const note = repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 2);       // second: nudge
    expect(note).toMatch(/unchanged/i);
    expect(note).toMatch(/content follows anyway/i);
    expect(note).toMatch(/round 1/);
  });

  it('ALWAYS re-serves after the file changes — a stale view of its own edit is far worse', () => {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'v1');
    const c = newReadCache();
    expect(repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 1)).toBeNull();
    // The agent edits the file; the next read MUST go through.
    utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    writeFileSync(f, 'v2');
    expect(repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 3)).toBeNull();
  });

  it('applies to list_dir too (171 calls, 46 of them the same path)', () => {
    mkdirSync(join(dir, 'src'));
    const c = newReadCache();
    expect(repeatReadNote(c, dir, 'list_dir', { path: 'src' }, 1)).toBeNull();
    expect(repeatReadNote(c, dir, 'list_dir', { path: 'src' }, 2)).toMatch(/unchanged/i);
  });

  it('never suppresses a WRITE, or a non-path tool', () => {
    writeFileSync(join(dir, 'a.txt'), 'x');
    const c = newReadCache();
    expect(repeatReadNote(c, dir, 'write_file', { path: 'a.txt' }, 1)).toBeNull();
    expect(repeatReadNote(c, dir, 'write_file', { path: 'a.txt' }, 2)).toBeNull();
    expect(repeatReadNote(c, dir, 'run_bash', { command: 'ls' }, 2)).toBeNull();
  });

  it('a missing path is never cached (so it is re-checked once created)', () => {
    const c = newReadCache();
    expect(repeatReadNote(c, dir, 'read_file', { path: 'nope.txt' }, 1)).toBeNull();
    expect(repeatReadNote(c, dir, 'read_file', { path: 'nope.txt' }, 2)).toBeNull();
  });

  it('different paths never collide', () => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    const c = newReadCache();
    expect(repeatReadNote(c, dir, 'read_file', { path: 'a.txt' }, 1)).toBeNull();
    expect(repeatReadNote(c, dir, 'read_file', { path: 'b.txt' }, 2)).toBeNull();
  });
});
