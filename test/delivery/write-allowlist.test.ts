import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyFileBlocks } from '../../src/delivery/applier.js';

/**
 * U1/U3 write narrowing at the applier: when the loop restricts a turn's
 * writable set, a write outside it is refused with the allowed list spelled
 * out. An allowlisted path is EXEMPT from the protected-segment block — that
 * is the sanctioned route into .uap-deliver/verify.sh for a diagnosed gate
 * repair — but never from protectedFiles.
 */
describe('applier writeAllowlist (U1/U3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-allowlist-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'bench.rs'), 'fn bench() {}\n');
    writeFileSync(join(dir, 'src', 'm1-bench.rs'), 'fn m1() {}\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const block = (path: string, content: string): string =>
    '```file:' + path + '\n' + content + '\n```';

  it('refuses a write outside the narrowed set and names the allowed files', () => {
    const res = applyFileBlocks(
      block('src/m1-bench.rs', 'fn m1() { /* wrong file again */ }'),
      dir,
      { writeAllowlist: new Set(['src/bench.rs']) }
    );
    expect(res.filesWritten).toHaveLength(0);
    expect(res.rejected[0].path).toBe('src/m1-bench.rs');
    expect(res.rejected[0].reason).toContain('only these files may be edited');
    expect(res.rejected[0].reason).toContain('src/bench.rs');
    expect(readFileSync(join(dir, 'src', 'm1-bench.rs'), 'utf-8')).toBe('fn m1() {}\n');
  });

  it('allows a write to an allowlisted file', () => {
    const res = applyFileBlocks(
      block('src/bench.rs', 'fn bench() { /* fixed at last */ }\n'),
      dir,
      { writeAllowlist: new Set(['src/bench.rs']) }
    );
    expect(res.filesWritten).toContain('src/bench.rs');
    expect(res.rejected).toHaveLength(0);
  });

  it('an allowlisted path is EXEMPT from the protected-segment block (sanctioned gate repair)', () => {
    // .uap-deliver/verify.sh is protected — the gate-repair turn must still
    // reach it through the allowlist, or U3's repair route is dead on arrival.
    const res = applyFileBlocks(
      block('.uap-deliver/verify.sh', 'echo "repaired extraction"\n'),
      dir,
      { writeAllowlist: new Set(['.uap-deliver/verify.sh']) }
    );
    expect(res.filesWritten).toContain('.uap-deliver/verify.sh');
    expect(existsSync(join(dir, '.uap-deliver', 'verify.sh'))).toBe(true);
  });

  it('the exemption does NOT apply without an allowlist (protection intact by default)', () => {
    const res = applyFileBlocks(block('.uap-deliver/verify.sh', 'echo tampered\n'), dir, {});
    expect(res.filesWritten).toHaveLength(0);
    expect(res.rejected[0].reason).toContain('not allowed');
  });

  it('the allowlist NEVER exempts protectedFiles (no narrowing makes oracle rewriting legitimate)', () => {
    const res = applyFileBlocks(
      block('src/bench.rs', 'fn bench() {}\n'),
      dir,
      {
        writeAllowlist: new Set(['src/bench.rs']),
        protectedFiles: new Set(['src/bench.rs']),
      }
    );
    expect(res.filesWritten).toHaveLength(0);
    // Blocked by the protected-file reason, not the narrowing reason — the
    // allowlist lifts the SEGMENT block only, never the oracle protection.
    expect(res.rejected[0].reason).toContain('protected');
  });

  it('no allowlist means no narrowing (default behavior unchanged)', () => {
    const res = applyFileBlocks(
      block('src/m1-bench.rs', 'fn m1() { /* ordinary turn */ }\n'),
      dir,
      {}
    );
    expect(res.filesWritten).toContain('src/m1-bench.rs');
  });
});
