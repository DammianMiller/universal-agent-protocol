/**
 * Content-hash de-duplication for read_file results (Harness-Loop-Graph state
 * hashing): a repeat read of a window whose bytes are unchanged since this
 * conversation already received them collapses to a compact reference instead
 * of paying full tool-result tokens again.
 *
 * The hard constraints these tests pin down:
 *
 *  1. The reference is served ONLY when this conversation has already received
 *     the full content (the `served` set). v1.148.21 collapsed unconditionally
 *     and deadlocked runs — a model without the content cannot act on a
 *     pointer to it. See dedup-serves-content.test.ts.
 *  2. Any successful write/edit invalidates the path, and an EXTERNAL edit
 *     between reads is caught by the hash itself (the read still happens —
 *     the saving is in the result, never in skipped I/O).
 *  3. Files below UAP_DELIVER_STATE_HASH_MIN_BYTES are re-served in full:
 *     tiny files are cheaper to repeat than to reference.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runTool,
  newStateHashStore,
  isStateHashReference,
  STATE_HASH_REF_PREFIX,
  type StateHashStore,
} from '../../src/delivery/agentic-executor.js';

const EMPTY = new Set<string>();
// Comfortably above the 1024-byte default floor.
const BIG = Array.from({ length: 60 }, (_, i) => `line ${i}: ${'x'.repeat(20)}`).join('\n') + '\n';

function call(
  root: string,
  store: StateHashStore,
  name: string,
  args: Record<string, unknown>,
  round: number,
  turn = 1,
): string {
  return runTool(
    root, name, args, 5000, EMPTY, /* protectGateConfigs */ true, /* allowBash */ false,
    EMPTY, /* sweep */ undefined, /* protectIac */ false, /* writeLedger */ undefined,
    { store, round, turn },
  );
}

describe('state-hash read dedup (harness loop graph)', () => {
  let dir: string;
  let store: StateHashStore;
  // Save/restore, not bare delete: a developer-exported value must neither
  // leak INTO the assertions (a shell-exported UAP_DELIVER_STATE_HASH=0 would
  // break the collapse tests) nor be clobbered on the way out.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['UAP_DELIVER_STATE_HASH', 'UAP_DELIVER_STATE_HASH_MIN_BYTES'];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-sh-'));
    store = newStateHashStore();
    writeFileSync(join(dir, 'big.txt'), BIG);
    writeFileSync(join(dir, 'tiny.txt'), 'small\n');
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second read of an unchanged file returns the compact reference, not the content', () => {
    const first = call(dir, store, 'read_file', { path: 'big.txt' }, 1);
    expect(isStateHashReference(first)).toBe(false);
    expect(first).toContain('line 0:');
    const second = call(dir, store, 'read_file', { path: 'big.txt' }, 2);
    expect(second.startsWith(STATE_HASH_REF_PREFIX)).toBe(true);
    expect(second).toMatch(/sha256:[0-9a-f]{12}/);
    expect(second).toMatch(/turn 1 round 1/);
    expect(second).toMatch(/unchanged since/);
    expect(second.length).toBeLessThan(first.length);
    expect(second).not.toContain('line 0:');
  });

  it('a read after an edit_file serves the fresh full content, never the stale reference', () => {
    call(dir, store, 'read_file', { path: 'big.txt' }, 1);
    const edit = call(dir, store, 'edit_file',
      { path: 'big.txt', old_string: 'line 0: xxxxxxxxxxxxxxxxxxxx', new_string: 'line 0: EDITED' }, 2);
    expect(edit).toMatch(/^OK: edited/);
    const reread = call(dir, store, 'read_file', { path: 'big.txt' }, 3);
    expect(isStateHashReference(reread)).toBe(false);
    expect(reread).toContain('line 0: EDITED');
    // And the NEXT repeat of the new content collapses again — the store
    // re-recorded the post-edit hash rather than disabling the path.
    const repeat = call(dir, store, 'read_file', { path: 'big.txt' }, 4);
    expect(repeat.startsWith(STATE_HASH_REF_PREFIX)).toBe(true);
  });

  it('a read after write_file serves fresh full content', () => {
    call(dir, store, 'read_file', { path: 'big.txt' }, 1);
    const rewritten = BIG + 'trailing new line\n';
    const write = call(dir, store, 'write_file', { path: 'big.txt', content: rewritten }, 2);
    expect(write).toMatch(/^OK: wrote/);
    const reread = call(dir, store, 'read_file', { path: 'big.txt' }, 3);
    expect(isStateHashReference(reread)).toBe(false);
    expect(reread).toContain('trailing new line');
  });

  it('files below the size floor are served in full on every read', () => {
    const first = call(dir, store, 'read_file', { path: 'tiny.txt' }, 1);
    const second = call(dir, store, 'read_file', { path: 'tiny.txt' }, 2);
    expect(isStateHashReference(first)).toBe(false);
    expect(isStateHashReference(second)).toBe(false);
    expect(second).toContain('small');
  });

  it('an external modification between reads is caught by the hash, not served stale', () => {
    call(dir, store, 'read_file', { path: 'big.txt' }, 1);
    // Bypass the tools entirely — run_bash or another process changed the file.
    writeFileSync(join(dir, 'big.txt'), BIG + 'externally appended\n');
    const reread = call(dir, store, 'read_file', { path: 'big.txt' }, 2);
    expect(isStateHashReference(reread)).toBe(false);
    expect(reread).toContain('externally appended');
  });

  it('a fresh conversation (new turn, served cleared) pays full content again even when unchanged', () => {
    call(dir, store, 'read_file', { path: 'big.txt' }, 1, 1);
    // Turn boundary: runTurn clears `served` because the new conversation has
    // never received the content a reference would point at.
    store.served.clear();
    const firstOfTurn2 = call(dir, store, 'read_file', { path: 'big.txt' }, 1, 2);
    expect(isStateHashReference(firstOfTurn2)).toBe(false);
    expect(firstOfTurn2).toContain('line 0:');
    // ...but a repeat WITHIN turn 2 collapses again.
    const repeatOfTurn2 = call(dir, store, 'read_file', { path: 'big.txt' }, 2, 2);
    expect(repeatOfTurn2.startsWith(STATE_HASH_REF_PREFIX)).toBe(true);
    expect(repeatOfTurn2).toMatch(/turn 1 round 1/);
  });

  it('a different window (offset) of the same file is not collapsed as a repeat', () => {
    call(dir, store, 'read_file', { path: 'big.txt' }, 1);
    const paged = call(dir, store, 'read_file', { path: 'big.txt', offset: 30 }, 2);
    expect(isStateHashReference(paged)).toBe(false);
    expect(paged).toContain('line 29:');
  });

  it('UAP_DELIVER_STATE_HASH=0 disables collapsing entirely', () => {
    process.env.UAP_DELIVER_STATE_HASH = '0';
    call(dir, store, 'read_file', { path: 'big.txt' }, 1);
    const second = call(dir, store, 'read_file', { path: 'big.txt' }, 2);
    expect(isStateHashReference(second)).toBe(false);
    expect(second).toContain('line 0:');
  });

  it('a past-EOF read serves no content, so it never marks the window served', () => {
    // First sight of this window is BEYOND EOF: the model gets only the
    // "offset past the end" note — no bytes. Recording that as "served"
    // would let a repeat serve a reference claiming content is in the
    // conversation when the model only ever saw the note.
    const pastEof = call(dir, store, 'read_file', { path: 'big.txt', offset: 10_000 }, 1);
    expect(pastEof).toMatch(/past the end/);
    const repeatNote = call(dir, store, 'read_file', { path: 'big.txt', offset: 10_000 }, 2);
    expect(isStateHashReference(repeatNote)).toBe(false);
    expect(repeatNote).toMatch(/past the end/);
    // And the in-range window is unaffected: full content first, then the
    // reference on a real repeat.
    const first = call(dir, store, 'read_file', { path: 'big.txt' }, 3);
    expect(first).toContain('line 0:');
    const second = call(dir, store, 'read_file', { path: 'big.txt' }, 4);
    expect(second.startsWith(STATE_HASH_REF_PREFIX)).toBe(true);
  });

  it('UAP_DELIVER_STATE_HASH_MIN_BYTES raises the floor', () => {
    process.env.UAP_DELIVER_STATE_HASH_MIN_BYTES = String(BIG.length + 100);
    call(dir, store, 'read_file', { path: 'big.txt' }, 1);
    const second = call(dir, store, 'read_file', { path: 'big.txt' }, 2);
    expect(isStateHashReference(second)).toBe(false);
  });
});
