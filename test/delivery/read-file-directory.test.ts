/**
 * An error the model cannot act on is a wasted turn — and it will retry it.
 *
 * `read_file` on a DIRECTORY threw a raw `EISDIR: illegal operation on a
 * directory`. The model could not do anything with that, so it tried again, and
 * the proxy's ERROR-LOOP guard fired on the repeat. Its intent was never in
 * doubt: it wanted to see what was in there.
 *
 * So serve the intent — return the listing and name the right tool. Same fix as
 * removing the phantom run_bash from the menu: stop punishing the model for a
 * reasonable move the harness handled badly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTool } from '../../src/delivery/agentic-executor.js';

const EMPTY = new Set<string>();
const call = (dir: string, name: string, args: Record<string, unknown>): string =>
  runTool(dir, name, args, 5_000, EMPTY, true, false, EMPTY);

describe('read_file on a directory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-eisdir-'));
    mkdirSync(join(dir, 'src', 'types'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.rs'), 'fn main() {}');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves the LISTING instead of a raw EISDIR the model cannot act on', () => {
    const out = call(dir, 'read_file', { path: 'src' });
    expect(out).not.toMatch(/EISDIR/i);
    expect(out).toContain('is a DIRECTORY');
    expect(out).toContain('main.rs');   // the intent: show me what is in there
    expect(out).toContain('types/');
  });

  it('names the right tool for next time', () => {
    expect(call(dir, 'read_file', { path: 'src' })).toContain('list_dir');
  });

  it('hides agent-internal dirs from that listing too', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    expect(call(dir, 'read_file', { path: '.' })).not.toContain('.uap');
  });

  it('reading a real FILE is unchanged', () => {
    expect(call(dir, 'read_file', { path: 'src/main.rs' })).toBe('fn main() {}');
  });

  it('a genuinely missing path still errors', () => {
    expect(call(dir, 'read_file', { path: 'nope.rs' })).toMatch(/not found/);
  });
});
