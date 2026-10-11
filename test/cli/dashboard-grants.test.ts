/**
 * The dashboard's Sandbox Grants section (debt item 16 — the ADR 0011-named
 * operator surface: active authority per session, the trust-anchor verdict,
 * the revoke command per grant). Pure-render pins against a seeded ledger;
 * the tamper-evidence verdict travels to the dashboard exactly as it does
 * on `uap sandbox grants`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sandboxGrantsLines } from '../../src/cli/dashboard.js';
import { grantAuthority, sandboxGrantsPath } from '../../src/policies/sandbox-grants.js';

let dir: string;
let hole: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-dash-grants-'));
  hole = join(dir, 'hole');
  mkdirSync(hole);
  process.env.UAP_SANDBOX_GRANTS = join(dir, 'grants.json');
  process.env.UAP_SANDBOX_ANCHOR_DIR = join(dir, 'anchors');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.UAP_SANDBOX_GRANTS;
  delete process.env.UAP_SANDBOX_ANCHOR_DIR;
});

describe('sandboxGrantsLines — the operator authority surface', () => {
  it('lists an active grant with its session, TTL, reason, paths, and the revoke command', () => {
    const g = grantAuthority(dir, { sessionId: 'sess-1', paths: [hole], reason: 'build cache for the toolchain' });
    if (!g.ok) throw new Error(g.error);
    const { lines, mismatch } = sandboxGrantsLines(dir);
    expect(mismatch).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('Sandbox Grants (active authority)');
    expect(text).toContain(g.grant.id);
    expect(text).toContain("session 'sess-1'");
    expect(text).toContain('left'); // the humanized remaining TTL
    expect(text).toContain('reason: build cache for the toolchain');
    expect(text).toContain(hole);
    expect(text).toContain(`revoke: uap sandbox revoke ${g.grant.id}`);
    expect(text).toContain('ledger verified against its trust anchor');
  });

  it('caps paths at 3 and grants at the section cap, with honest counts', () => {
    const holes = [1, 2, 3, 4, 5].map((i) => {
      const h = join(dir, `h${i}`);
      mkdirSync(h);
      return h;
    });
    const g = grantAuthority(dir, { sessionId: 'sess-many', paths: holes, reason: 'wide grant' });
    if (!g.ok) throw new Error(g.error);
    const { lines } = sandboxGrantsLines(dir);
    const text = lines.join('\n');
    expect(text).toContain('… and 2 more path(s)');
    // A second grant: the section cap (2 > maxGrants=1 in this call)
    const h6 = join(dir, 'h6');
    mkdirSync(h6);
    const g2 = grantAuthority(dir, { sessionId: 'sess-2', paths: [h6], reason: 'second' });
    if (!g2.ok) throw new Error(g2.error);
    const capped = sandboxGrantsLines(dir, 1);
    expect(capped.lines.join('\n')).toContain('… and 1 more grant(s)');
  });

  it('says least-authority when nothing is granted', () => {
    const { lines, mismatch } = sandboxGrantsLines(dir);
    expect(mismatch).toBe(false);
    expect(lines.join('\n')).toContain('no active grants — the default is least authority');
    expect(lines.join('\n')).toContain('not yet anchored');
  });

  it('carries the tamper verdict: a ledger changed outside a recorded operation is UNVERIFIED', () => {
    const g = grantAuthority(dir, { sessionId: 'sess-1', paths: [hole], reason: 'seed' });
    if (!g.ok) throw new Error(g.error);
    // Checkout write reach rewrites the ledger under the anchor.
    const rows = JSON.parse(readFileSync(sandboxGrantsPath(dir), 'utf-8')) as Array<Record<string, unknown>>;
    rows[0].reason = 'rewritten by an unrecorded writer';
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify(rows));
    const { lines, mismatch } = sandboxGrantsLines(dir);
    expect(mismatch).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('INTEGRITY MISMATCH');
    expect(text).toContain('UNVERIFIED');
    // The row is still SHOWN (inspection), the verdict travels with it.
    expect(text).toContain(g.grant.id);
  });

  it('expired grants are inert on the dashboard too', () => {
    const g = grantAuthority(dir, { sessionId: 'sess-1', paths: [hole], reason: 'seed' });
    if (!g.ok) throw new Error(g.error);
    const rows = JSON.parse(readFileSync(sandboxGrantsPath(dir), 'utf-8')) as Array<{ expiresAt: string }>;
    rows[0].expiresAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify(rows));
    const { lines } = sandboxGrantsLines(dir);
    expect(lines.join('\n')).toContain('no active grants');
  });
});
