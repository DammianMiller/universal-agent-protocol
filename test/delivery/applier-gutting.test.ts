/**
 * The applier writes whole files with no gutting check. The agentic tool path
 * has one; the file-block path does not, so the SAME destructive write is
 * refused through one door and applied through the other.
 *
 * Measured live 2026-08-12. A crate verified hours earlier at 0 errors and 37
 * passing tests came back at 20 errors. The log showed `✓ applied write:` — the
 * applier — and the files on disk had collapsed:
 *
 *   lib.rs        6554B -> 2602B   (ratio 0.40)
 *   contracts.rs  1423B ->  144B   (ratio 0.10)
 *
 * The existing predicate would have missed BOTH even on the guarded path:
 * lib.rs sat above the 0.35 ratio, and contracts.rs — 90% destroyed — fell
 * under the 1500-byte floor by 77 bytes.
 *
 * Thresholds here are calibrated, not chosen. Across 187 real shrinking
 * file-changes from this repo's history, `prev >= 400 && new < 0.5 * prev`
 * refuses 3 of 86 implementation-file changes (3.5%) while catching both live
 * cases. The same rule on .sh files refuses 52% and on .md 41% — this repo
 * routinely replaces hook scripts with one-line delegating stubs and rewrites
 * docs wholesale, which is why the rule is restricted to code.
 */
import { describe, it, expect } from 'vitest';
import { isSuspectedGutting } from '../../src/delivery/agentic-executor.js';

describe('isSuspectedGutting, calibrated per file type', () => {
  it('catches the live lib.rs case (0.40 of a 6.5KB source file)', () => {
    expect(isSuspectedGutting(6554, 2602, 'src/lib.rs')).toBe(true);
  });

  it('catches the live contracts.rs case (90% gone, just under the old floor)', () => {
    expect(isSuspectedGutting(1423, 144, 'src/contracts.rs')).toBe(true);
  });

  it('is unchanged when no path is supplied — the old callers keep their rule', () => {
    // 0.40 ratio: refused for a code file, allowed under the legacy thresholds.
    expect(isSuspectedGutting(6554, 2602)).toBe(false);
    expect(isSuspectedGutting(120000, 20000)).toBe(true);
    expect(isSuspectedGutting(2000, 1900)).toBe(false);
  });

  it('leaves .sh alone — hook scripts are legitimately replaced by stubs', () => {
    // Measured: 52% of real .sh shrinks would be refused by the code rule.
    expect(isSuspectedGutting(8262, 39, '.claude/hooks/loop-protection.sh')).toBe(false);
  });

  it('leaves .md alone — docs get rewritten wholesale', () => {
    expect(isSuspectedGutting(9000, 900, 'docs/reference/CONFIGURATION.md')).toBe(false);
  });

  it('does not fire on a small file, whatever the ratio', () => {
    expect(isSuspectedGutting(300, 10, 'src/tiny.ts')).toBe(false);
  });

  it('does not fire on an ordinary edit that trims a file', () => {
    // The most aggressive REAL implementation-file shrink short of a refactor.
    expect(isSuspectedGutting(7169, 6610, 'test/cli/verify.test.ts')).toBe(false);
  });

  it('covers every implementation extension the delivery loop writes', () => {
    for (const ext of ['ts', 'tsx', 'js', 'mjs', 'rs', 'py', 'go', 'java']) {
      expect(isSuspectedGutting(5000, 1000, `src/x.${ext}`), ext).toBe(true);
    }
  });
});

describe('the applier refuses a gutting write', () => {
  it('rejects it, names the sizes, and leaves the file on disk intact', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { applyFileBlocks } = await import('../../src/delivery/applier.js');

    const root = mkdtempSync(join(tmpdir(), 'uap-applier-gut-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const original = `// a substantial module\n${'pub fn work() { let x = 1; }\n'.repeat(120)}`;
      writeFileSync(join(root, 'src', 'lib.rs'), original);

      const gutted = '// a substantial module\npub fn work() {}\n';
      const res = await applyFileBlocks(`\`\`\`file:src/lib.rs\n${gutted}\n\`\`\``, root);

      expect(res.filesWritten, 'nothing may be written').toEqual([]);
      expect(res.rejected.map((r) => r.path)).toEqual(['src/lib.rs']);
      expect(res.rejected[0]!.reason).toMatch(/gut|shrink|gutting/i);
      expect(readFileSync(join(root, 'src', 'lib.rs'), 'utf8'), 'the file must survive').toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses the live contracts.rs shape, which the LEGACY thresholds miss', async () => {
    // 1423B -> 144B: 90% destroyed, yet 77 bytes under the old 1500B floor, so
    // the pathless rule waves it through. This is the case that actually
    // happened, and it only fails if the applier passes the PATH.
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { applyFileBlocks } = await import('../../src/delivery/applier.js');

    const root = mkdtempSync(join(tmpdir(), 'uap-applier-legacy-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const original = `${'pub struct RelRecord { pub v: Option<i64> }\n'.repeat(33)}`; // ~1423B
      expect(original.length).toBeGreaterThan(1000);
      expect(original.length, 'must sit UNDER the legacy floor to be the right case').toBeLessThan(1500);
      writeFileSync(join(root, 'src', 'contracts.rs'), original);

      const res = await applyFileBlocks('```file:src/contracts.rs\npub struct RelRecord {}\n```', root);
      expect(res.filesWritten).toEqual([]);
      expect(res.rejected.map((r) => r.path)).toEqual(['src/contracts.rs']);
      expect(readFileSync(join(root, 'src', 'contracts.rs'), 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still applies an ordinary rewrite of the same file', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { applyFileBlocks } = await import('../../src/delivery/applier.js');

    const root = mkdtempSync(join(tmpdir(), 'uap-applier-ok-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'lib.rs'), `${'pub fn work() { let x = 1; }\n'.repeat(120)}`);
      const rewritten = `${'pub fn work() { let x = 2; }\n'.repeat(115)}`;
      const res = await applyFileBlocks(`\`\`\`file:src/lib.rs\n${rewritten}\n\`\`\``, root);

      expect(res.rejected).toEqual([]);
      expect(res.filesWritten).toEqual(['src/lib.rs']);
      expect(readFileSync(join(root, 'src', 'lib.rs'), 'utf8')).toContain('let x = 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still creates a NEW file — there is nothing to gut', async () => {
    const { mkdtempSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { applyFileBlocks } = await import('../../src/delivery/applier.js');

    const root = mkdtempSync(join(tmpdir(), 'uap-applier-new-'));
    try {
      const res = await applyFileBlocks('```file:src/fresh.rs\npub fn a() {}\n```', root);
      expect(res.rejected).toEqual([]);
      expect(res.filesWritten).toEqual(['src/fresh.rs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
