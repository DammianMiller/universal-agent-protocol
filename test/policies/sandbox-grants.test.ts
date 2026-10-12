/**
 * Per-session sandbox grants (bridge P4: D2 consent ledger) — every extra
 * writable hole must be a recorded, bounded, revocable consent. Covers the
 * ledger contract (sanitize-at-load + FULL re-validation of planted paths
 * and expiries, least-authority failures, atomic persist), the validation
 * refusals, dedupe/renewal, expiry, revocation, session scoping, and the
 * audit trail.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  grantAuthority,
  listAuthority,
  revokeAuthority,
  resolveSessionGrants,
  auditSandboxUse,
  validateGrantPath,
  sandboxGrantsPath,
  sandboxAuditPath,
  verifyLedgerIntegrity,
  AUDIT_MAX_LINES,
  AUDIT_PRUNE_TRIGGER,
  DEFAULT_GRANT_TTL_SECS,
  MAX_GRANT_TTL_SECS,
} from '../../src/policies/sandbox-grants.js';
import { anchorPath, readAnchor } from '../../src/policies/sandbox-anchor.js';

let dir: string;
let hole: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-grants-'));
  mkdirSync(join(dir, '.uap')); // the ledger home the store persists into
  hole = join(dir, 'hole');
  mkdirSync(hole);
  delete process.env.UAP_SANDBOX_GRANTS;
  delete process.env.UAP_SANDBOX_AUDIT;
  delete process.env.UAP_SANDBOX_GRANTS_OFF;
  // Pin the trust anchor into the per-test tmp dir: without this, every
  // mutation test would write a REAL anchor into the operator's state dir.
  process.env.UAP_SANDBOX_ANCHOR_DIR = join(dir, 'anchors');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.UAP_SANDBOX_GRANTS;
  delete process.env.UAP_SANDBOX_AUDIT;
  delete process.env.UAP_SANDBOX_GRANTS_OFF;
  delete process.env.UAP_SANDBOX_ANCHOR_DIR;
});

const INPUT = {
  sessionId: 'sess-abc',
  paths: [] as string[],
  reason: 'build cache for the native toolchain',
};

describe('grant validation — authority is refused, not guessed', () => {
  it('refuses a grant without a session, a reason, or a grantable target', () => {
    expect(grantAuthority(dir, { ...INPUT, sessionId: '' }).ok).toBe(false);
    expect(grantAuthority(dir, { ...INPUT, reason: '' }).ok).toBe(false);
    expect(grantAuthority(dir, { ...INPUT, paths: [join(dir, 'missing')] }).ok).toBe(false);
    expect(grantAuthority(dir, { ...INPUT, paths: ['relative/path'] }).ok).toBe(false);
    expect(grantAuthority(dir, { ...INPUT, paths: ['/'] }).ok).toBe(false);
    expect(grantAuthority(dir, { ...INPUT, paths: [process.env.HOME || '/home'] }).ok).toBe(false);
    // a grant grants something
    expect(grantAuthority(dir, { ...INPUT, paths: [] }).ok).toBe(false);
  });

  it('grants an existing absolute path with the consent record attached', () => {
    const r = grantAuthority(dir, { ...INPUT, paths: [hole] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.grant.id).toMatch(/^sbg-/);
      expect(r.grant.paths).toEqual([hole]);
      expect(r.grant.reason).toBe(INPUT.reason);
      expect(r.grant.grantedBy.length).toBeGreaterThan(0);
      const ttl = (Date.parse(r.grant.expiresAt) - Date.parse(r.grant.grantedAt)) / 1000;
      expect(ttl).toBe(DEFAULT_GRANT_TTL_SECS);
    }
  });

  it('caps the TTL at the hard bound', () => {
    const r = grantAuthority(dir, { ...INPUT, paths: [hole], ttlSecs: 9_999_999 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ttl = (Date.parse(r.grant.expiresAt) - Date.parse(r.grant.grantedAt)) / 1000;
      expect(ttl).toBe(MAX_GRANT_TTL_SECS);
      expect(r.grant.paths).toEqual([hole]);
    }
  });

  it('floors the TTL at 1s (a fractional or zero TTL still yields a grant that expires)', () => {
    const r = grantAuthority(dir, { ...INPUT, paths: [hole], ttlSecs: 0.5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ttl = (Date.parse(r.grant.expiresAt) - Date.parse(r.grant.grantedAt)) / 1000;
      expect(ttl).toBeGreaterThanOrEqual(1);
    }
    const z = grantAuthority(dir, { ...INPUT, paths: [hole], ttlSecs: 0 });
    expect(z.ok).toBe(true);
    if (z.ok) {
      const ttl = (Date.parse(z.grant.expiresAt) - Date.parse(z.grant.grantedAt)) / 1000;
      expect(ttl).toBe(1); // 0s means "expires immediately", NEVER "8h default"
    }
  });

  it('fails CLOSED on garbage or negative TTLs (the P4 security-review fix)', () => {
    // 'abc' → NaN from the CLI parse; -5 is a demand for negative
    // authority. Both must be REFUSED, not silently upgraded to the 8h
    // default (the old expression failed open — the wrong direction for
    // an authority store).
    const nan = grantAuthority(dir, { ...INPUT, paths: [hole], ttlSecs: Number('abc') });
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.error).toMatch(/--ttl/);
    const neg = grantAuthority(dir, { ...INPUT, paths: [hole], ttlSecs: -5 });
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.error).toMatch(/--ttl/);
  });
});

describe('dedupe + renewal', () => {
  it('renews an identical open grant instead of duplicating it', () => {
    const first = grantAuthority(dir, { ...INPUT, paths: [hole], ttlSecs: 60 })!;
    if (!first.ok) throw new Error(first.error);
    const second = grantAuthority(dir, { ...INPUT, paths: [hole], ttlSecs: 3600 })!;
    if (!second.ok) throw new Error(second.error);
    expect(second.grant.id).toBe(first.grant.id);
    const list = listAuthority(dir, 'sess-abc');
    expect(list.length).toBe(1);
    if (second.ok) {
      const ttl = (Date.parse(second.grant.expiresAt) - Date.parse(second.grant.grantedAt)) / 1000;
      expect(ttl).toBe(3600);
    }
  });
});

describe('session scoping + expiry + revocation', () => {
  it('resolves ONLY the named session, and only unexpired grants', async () => {
    grantAuthority(dir, { ...INPUT, paths: [hole] });
    mkdirSync(join(dir, 'other-hole'));
    grantAuthority(dir, { ...INPUT, sessionId: 'sess-other', paths: [join(dir, 'other-hole')], reason: 'other' });

    const mine = resolveSessionGrants(dir, 'sess-abc');
    expect(mine.paths).toEqual([hole]);
    expect(resolveSessionGrants(dir, 'sess-other').paths).toEqual([join(dir, 'other-hole')]);
    expect(resolveSessionGrants(dir, 'sess-nobody').paths).toEqual([]);

    // Expired: write a grant that lapsed a minute ago directly to the ledger.
    // The anchor is removed first so this plants an EXPIRY scenario, not a
    // tamper scenario (a planted row over an anchored state fails the
    // integrity check — covered in the trust-anchor block below).
    rmSync(anchorPath(dir), { force: true });
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      {
        id: 'sbg-dead', sessionId: 'sess-abc', paths: [hole], net: 'none',
        reason: 'already lapsed', grantedBy: 'tester',
        grantedAt: new Date(Date.now() - 7200_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ]));
    expect(resolveSessionGrants(dir, 'sess-abc').paths).toEqual([]);
  });

  it('revokes by id and reports a miss truthfully', () => {
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    expect(revokeAuthority(dir, g.grant.id)).toBe(true);
    expect(listAuthority(dir).length).toBe(0);
    expect(revokeAuthority(dir, g.grant.id)).toBe(false);
  });
});

describe('the ledger is a trust boundary (P3 lessons applied)', () => {
  // A planted row must survive only when the OPERATOR could have written it:
  // every fixture expiry below is within the hard TTL bound.
  const soon = () => new Date(Date.now() + 3600_000).toISOString();

  it('drops malformed and planted rows at load — least authority', () => {
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      { id: 'sbg-x', sessionId: 'sess-abc', paths: ['/etc'], reason: '', grantedBy: 'attacker', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() }, // no reason
      { id: 'sbg-y', sessionId: 'sess-abc', paths: [hole], reason: 'ok', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon(), extra: true },
      'not an object',
      null,
      { paths: [hole] }, // no id/session
      { id: 'sbg-z', sessionId: 'sess-abc', paths: [], reason: 'empty paths', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() }, // grants nothing
    ]));
    const resolved = resolveSessionGrants(dir, 'sess-abc');
    expect(resolved.grants.length).toBe(1);
    expect(resolved.grants[0].id).toBe('sbg-y');
    expect(resolved.grants[0].paths).toEqual([hole]);
    expect('extra' in (resolved.grants[0] as object)).toBe(false);
    expect('net' in (resolved.grants[0] as object)).toBe(false);
  });

  it('refuses a planted well-formed row whose path IS the root (the P4 BLOCKER pin)', () => {
    // A well-formed row with paths:["/"] must not become a `--bind / /`
    // hole: the load path re-validates with the FULL grantable-path rule,
    // so the row is dropped whole (a half-row is a forged consent record).
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      { id: 'sbg-evil', sessionId: 'sess-abc', paths: ['/'], reason: 'planted full authority', grantedBy: 'root', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() },
      { id: 'sbg-home', sessionId: 'sess-abc', paths: [process.env.HOME || '/'], reason: 'planted home', grantedBy: 'root', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() },
    ]));
    expect(resolveSessionGrants(dir, 'sess-abc').grants).toEqual([]);
    // Ingest refuses the same shape outright:
    expect(grantAuthority(dir, { ...INPUT, paths: [hole, '/'] }).ok).toBe(false);
  });

  it('refuses a symlink to $HOME at ingest AND at load (the check is on the realpath)', () => {
    const home = process.env.HOME || '';
    const link = join(dir, 'innocuous-link');
    symlinkSync(home, link);
    // Ingest: the link resolves to $HOME → refused.
    expect(grantAuthority(dir, { ...INPUT, paths: [link] }).ok).toBe(false);
    // Load: a planted row pointing at the link is dropped whole.
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      { id: 'sbg-link', sessionId: 'sess-abc', paths: [link], reason: 'via a harmless name', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() },
    ]));
    expect(resolveSessionGrants(dir, 'sess-abc').grants).toEqual([]);
  });

  it('refuses a planted expiry beyond the hard TTL bound (a "forever grant")', () => {
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      { id: 'sbg-y2099', sessionId: 'sess-abc', paths: [hole], reason: 'forever', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
      { id: 'sbg-badts', sessionId: 'sess-abc', paths: [hole], reason: 'not a timestamp', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: '9999' },
      { id: 'sbg-ok', sessionId: 'sess-abc', paths: [hole], reason: 'bounded', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() },
    ]));
    const resolved = resolveSessionGrants(dir, 'sess-abc');
    expect(resolved.grants.map((g) => g.id)).toEqual(['sbg-ok']);
  });

  it('sanitizes control characters at load (planted ANSI cannot reach terminals)', () => {
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      {
        id: 'sbg-esc', sessionId: 'sess-abc', paths: [hole],
        reason: 'x\x1b[31mred\x07beep', grantedBy: 't',
        grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon(),
      },
    ]));
    const g = resolveSessionGrants(dir, 'sess-abc').grants[0];
    // eslint-disable-next-line no-control-regex -- asserting their absence IS the point
    expect(g.reason).not.toMatch(/[\x1b\x07]/);
  });

  it('cleans control chars out of planted PATHS before re-validating them', () => {
    // The path is cleaned FIRST, then the FULL grantable-path rule runs on
    // the cleaned value: whatever survives must be an existing, grantable
    // path with zero control characters left in it (control bytes must never
    // reach bwrap's argv). `${hole}\x07` cleans+trims to the real hole —
    // grantable, so the row survives ON THE CLEAN PATH; a control-char path
    // that cleans to something nonexistent is dropped whole.
    const laundered = `${hole}\x07`;
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      { id: 'sbg-ctrl', sessionId: 'sess-abc', paths: [`${join(dir, 'nope')}\x07`], reason: 'cleans to nothing', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() },
      { id: 'sbg-clean', sessionId: 'sess-abc', paths: [laundered], reason: 'laundered path', grantedBy: 't', grantedAt: '2026-10-11T00:00:00Z', expiresAt: soon() },
    ]));
    const resolved = resolveSessionGrants(dir, 'sess-abc');
    expect(resolved.grants.map((g) => g.id)).toEqual(['sbg-clean']);
    expect(resolved.paths).toEqual([hole]);
    // eslint-disable-next-line no-control-regex -- asserting their absence IS the point
    expect(JSON.stringify(resolved.paths)).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('treats an unreadable ledger as EMPTY (no holes), with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(sandboxGrantsPath(dir), '{not json');
    expect(resolveSessionGrants(dir, 'sess-abc').paths).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('honors the file override and keeps grants per-checkout-root anchored', () => {
    process.env.UAP_SANDBOX_GRANTS = join(dir, 'elsewhere.json');
    expect(sandboxGrantsPath(dir)).toBe(join(dir, 'elsewhere.json'));
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    expect(g.ok && existsSync(join(dir, 'elsewhere.json'))).toBe(true);
  });
});

describe('audit trail — the "who consented" record', () => {
  it('appends one JSONL line per grant, revoke, and sandbox-run — legacy bound vs refused recorded distinctly', () => {
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    revokeAuthority(dir, g.grant.id);
    const used = resolveSessionGrants(dir, 'sess-abc');
    // The legacy-env record states what actually OPENED separately from
    // what plan time REFUSED — a refused entry recorded under the run's
    // allow would attribute authority the run never had.
    auditSandboxUse(dir, 'sess-abc', used, ['/unrecorded/legacy'], ['/etc → /etc'], 'off');
    const lines = readFileSync(sandboxAuditPath(dir), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0].action).toBe('grant');
    expect(parsed[1].action).toBe('revoke');
    expect(parsed[2].action).toBe('sandbox-run');
    expect(parsed[2].netMode).toBe('off');
    expect(parsed[2].unrecordedAllow).toEqual(['/unrecorded/legacy']);
    expect(parsed[2].unrecordedRefused).toEqual(['/etc → /etc']);
  });
});

describe('validateGrantPath', () => {
  it('accepts existing absolute paths and refuses everything else', () => {
    expect(validateGrantPath(hole)).toBe(hole);
    expect(validateGrantPath('relative')).toBeNull();
    expect(validateGrantPath('/')).toBeNull();
    expect(validateGrantPath(join(dir, 'nope'))).toBeNull();
  });
});

describe('trust anchor — tamper evidence (ADR 0011 follow-up, shipped)', () => {
  const soon = () => new Date(Date.now() + 3600_000).toISOString();

  it('bootstraps on the first recorded mutation and then verifies ok', () => {
    // Pre-bootstrap: no anchor, verification is honest about it.
    expect(verifyLedgerIntegrity(dir).state).toBe('unanchored');
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    expect(verifyLedgerIntegrity(dir).state).toBe('ok');
    const anchor = readAnchor(dir);
    expect(anchor).not.toBeNull();
    expect(anchor?.ledgerHead).toMatch(/^[0-9a-f]{64}$/);
    expect(anchor?.mutations).toBe(1);
    expect(anchor?.updatedBy.length).toBeGreaterThan(0);
    // The anchor is per-checkout-root and OUTSIDE the checkout. With the
    // pin cleared (path COMPUTATION only — nothing is written), the default
    // must live under the user's state dir, keyed by a hash of the root,
    // never its literal path.
    process.env.UAP_SANDBOX_ANCHOR_DIR = '';
    const defaultPath = anchorPath(dir);
    process.env.UAP_SANDBOX_ANCHOR_DIR = join(dir, 'anchors');
    expect(defaultPath).not.toContain(dir);
    expect(defaultPath).toMatch(/sandbox-anchors\/[0-9a-f]+\.json$/);
  });

  it('detects a ledger changed outside a recorded consent operation', () => {
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    // A planted well-formed row lands via checkout write reach (the ADR's
    // exact threat): shape-valid, TTL-valid, grantable path — only the
    // out-of-checkout anchor catches it.
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      {
        id: 'sbg-planted', sessionId: 'sess-abc', paths: [hole], reason: 'planted consent',
        grantedBy: 'attacker', grantedAt: new Date().toISOString(), expiresAt: soon(),
      },
    ]));
    const v = verifyLedgerIntegrity(dir);
    expect(v.state).toBe('mismatch');
    expect(v.detail).toMatch(/anchor/);
    // Fail-CLOSED at the launch surface: zero grant-derived holes.
    expect(resolveSessionGrants(dir, 'sess-abc').paths).toEqual([]);
    // The inspection surface still SHOWS the rows (they are unverified, not
    // invisible) — the CLI stamps them; the policy returns them.
    expect(listAuthority(dir).map((x) => x.id)).toEqual(['sbg-planted']);
  });

  it('refuses to mint new consent on a tampered ledger', () => {
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    writeFileSync(sandboxGrantsPath(dir), '[]');
    const r = grantAuthority(dir, { ...INPUT, sessionId: 'sess-new', paths: [hole] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/integrity/);
  });

  it('fail-closes the launch surface loudly on mismatch', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    writeFileSync(sandboxGrantsPath(dir), '[]');
    expect(resolveSessionGrants(dir, 'sess-abc').paths).toEqual([]);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toMatch(/INTEGRITY MISMATCH/);
    err.mockRestore();
  });

  it('revoke still works on a tampered ledger (least authority) and re-anchors the baseline loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    // Tamper: swap the reason out from under the anchored state.
    const rows = JSON.parse(readFileSync(sandboxGrantsPath(dir), 'utf-8')) as { id: string }[];
    rows[0].reason = 'rewritten';
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify(rows));
    expect(revokeAuthority(dir, g.grant.id)).toBe(true);
    // The revoke re-anchored the post-revoke state, and named the laundering.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/integrity verification/);
    expect(verifyLedgerIntegrity(dir).state).toBe('ok');
    expect(listAuthority(dir).length).toBe(0);
    warn.mockRestore();
  });

  it('keeps the ledger operative when the anchor cannot be written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A FILE where the anchor dir should be: the anchor write fails loudly,
    // the grant still lands (the ledger is the operative record).
    writeFileSync(join(dir, 'anchors'), 'in the way');
    process.env.UAP_SANDBOX_ANCHOR_DIR = join(dir, 'anchors');
    const r = grantAuthority(dir, { ...INPUT, paths: [hole] });
    expect(r.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/trust-anchor write failed/);
    expect(verifyLedgerIntegrity(dir).state).toBe('unanchored');
    expect(listAuthority(dir).length).toBe(1);
    warn.mockRestore();
  });

  it('keys the anchor by the MAIN checkout root, not the raw cwd (review round, all three reviewers)', () => {
    // The repo mandates worktrees: a grant recorded from the main root must
    // verify 'ok' from a .worktrees/NNN-* cwd of the same checkout — keying
    // by the raw cwd string gave the shared ledger one anchor per cwd
    // (worktree sessions silently UNANCHORED, cross-cwd false mismatches).
    // A real git checkout, not a bare tmp dir: mainCheckoutRoot passes
    // non-git roots through unchanged, which is exactly what must NOT
    // happen for a worktree cwd of a real checkout.
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    const wt = join(dir, '.worktrees', '123-review');
    mkdirSync(wt, { recursive: true });
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    expect(verifyLedgerIntegrity(dir).state).toBe('ok');
    expect(verifyLedgerIntegrity(wt).state).toBe('ok'); // same checkout → same anchor
    // And a tamper seen from the main root is seen from the worktree too.
    writeFileSync(sandboxGrantsPath(dir), '[]');
    expect(verifyLedgerIntegrity(wt).state).toBe('mismatch');
  });

  it('sanitizes control characters out of the grant id at load (review M1)', () => {
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      {
        id: 'sbg-evil\u001b]0;pwned-title\u0007', sessionId: 'sess-abc', paths: [hole], reason: 'ok',
        grantedBy: 'attacker', grantedAt: new Date().toISOString(), expiresAt: soon(),
      },
    ]));
    const rows = listAuthority(dir);
    expect(rows).toHaveLength(1);
    // eslint-disable-next-line no-control-regex -- asserting their absence IS the point
    expect(rows[0].id).not.toMatch(/[\x00-\x1f\x7f]/);
    // and the planted row is REMOVABLE by either spelling: the revoke input
    // goes through the same clean(), so the raw hostile id and the cleaned
    // id both hit the sanitized row.
    expect(revokeAuthority(dir, 'sbg-evil\u001b]0;pwned-title\u0007')).toBe(true);
    expect(listAuthority(dir)).toHaveLength(0);
  });

  it('refuses a grant that would cover the trust-anchor directory (review m1)', () => {
    const anchorParent = join(dir, 'anchors');
    mkdirSync(anchorParent, { recursive: true });
    process.env.UAP_SANDBOX_ANCHOR_DIR = anchorParent;
    try {
      const r = grantAuthority(dir, { ...INPUT, paths: [anchorParent] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/trust-anchor/);
      // A grant that merely sits INSIDE the anchor dir (a deeper path) does
      // not unlock the anchor file's directory — still grantable.
      const deep = join(anchorParent, 'sub-project');
      mkdirSync(deep, { recursive: true });
      const ok = grantAuthority(dir, { ...INPUT, paths: [deep] });
      expect(ok.ok).toBe(true);
    } finally {
      delete process.env.UAP_SANDBOX_ANCHOR_DIR;
    }
  });

  it('warns loudly when grants exist but the anchor is missing (the quiet dangerous state)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(sandboxGrantsPath(dir), JSON.stringify([
      {
        id: 'sbg-orphan', sessionId: 'sess-abc', paths: [hole], reason: 'seeded without anchor',
        grantedBy: 't', grantedAt: new Date().toISOString(), expiresAt: soon(),
      },
    ]));
    // Grants resolve (fail-open is the ledger's rule) but NOT silently.
    expect(resolveSessionGrants(dir, 'sess-abc').paths).toEqual([hole]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/NO trust anchor/);
    warn.mockRestore();
  });
});

describe('audit trail — sequence stamping + bounded retention (debt item 3)', () => {
  it('stamps every line with a monotonic seq', () => {
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    revokeAuthority(dir, g.grant.id);
    const seqs = readFileSync(sandboxAuditPath(dir), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
  });

  it('compacts past the trigger, records the drop, and never reuses a seq', () => {
    const seed = Array.from(
      { length: AUDIT_PRUNE_TRIGGER },
      (_, i) => JSON.stringify({ ts: new Date().toISOString(), action: 'noop', seq: i + 1 }),
    );
    writeFileSync(sandboxAuditPath(dir), `${seed.join('\n')}\n`);
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    const lines = readFileSync(sandboxAuditPath(dir), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(AUDIT_MAX_LINES + 2); // kept window + new grant + marker
    const parsed = lines.map((l) => JSON.parse(l) as { seq: number; action?: string; dropped?: number });
    const marker = parsed[parsed.length - 1];
    expect(marker.action).toBe('audit-compaction');
    // Dropped = everything beyond the kept window: the 12,000 seed + the
    // new grant line = 12,001 written; the newest 10,000 + the grant line
    // survive = 10,001; the marker itself is NEW content, not dropped.
    expect(marker.dropped).toBe(seed.length + 1 - (AUDIT_MAX_LINES + 1));
    expect(marker.seq).toBe(seed.length + 2); // the grant got seed+1, the marker seed+2
    // The kept window preserves order, and the newest line is the marker.
    expect(parsed[0].seq).toBe(seed.length - AUDIT_MAX_LINES + 1);
    // A post-compaction append continues the sequence, never reusing a seq.
    revokeAuthority(dir, g.grant.id);
    const after = readFileSync(sandboxAuditPath(dir), 'utf-8').trim().split('\n');
    const lastSeq = (JSON.parse(after[after.length - 1]) as { seq: number }).seq;
    expect(lastSeq).toBe(seed.length + 3);
  });

  it('the anchor witnesses the seq high-water: numbering survives audit-file DELETION', () => {
    // The residual the reviewers named: the backward file scan covered
    // compaction, but a DELETED audit file would restart numbering at 1 —
    // seq N recorded twice means one of the lines is planted. The anchor's
    // seqHi is the floor the next line numbers from.
    const g1 = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g1.ok) throw new Error(g1.error);
    revokeAuthority(dir, g1.grant.id); // seqs 1..2; the anchor witnessed the high-water
    const before = readAnchor(dir);
    expect(before?.seqHi).toBe(2);
    rmSync(sandboxAuditPath(dir));
    const g2 = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g2.ok) throw new Error(g2.error);
    const lines = readFileSync(sandboxAuditPath(dir), 'utf-8').trim().split('\n');
    const seqs = lines.map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs[0]).toBe(3); // NOT 1 — the deleted file's numbering is not reused
    expect(readAnchor(dir)?.seqHi).toBeGreaterThanOrEqual(3);
  });

  it('a pre-field anchor (no seqHi) stays valid and numbering falls back to the file', () => {
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    // Rewrite the anchor by hand in the OLD v1 shape (before seqHi existed)
    // — additive fields must not strand existing anchors.
    const old = readAnchor(dir)!;
    const { seqHi: _omit, ...legacyShape } = old;
    void _omit;
    writeFileSync(anchorPath(dir), JSON.stringify({ ...legacyShape }, null, 2));
    const reread = readAnchor(dir);
    expect(reread?.ledgerHead).toBe(old.ledgerHead);
    expect(reread?.seqHi).toBeUndefined();
    expect(verifyLedgerIntegrity(dir).state).toBe('ok');
    // A planted seqHi must be a safe integer or it is ignored: 2^53 would
    // freeze the seq column (2^53 + 1 === 2^53 — every line the same seq),
    // and a fractional seqHi would mint fractional seqs.
    const anchorObj = JSON.parse(readFileSync(anchorPath(dir), 'utf-8')) as Record<string, unknown>;
    for (const hostile of [2.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
      writeFileSync(anchorPath(dir), JSON.stringify({ ...anchorObj, seqHi: hostile }, null, 2));
      expect(readAnchor(dir)?.seqHi).toBeUndefined();
    }
    // Numbering continues from the FILE's high-water (the anchor contributes 0).
    revokeAuthority(dir, g.grant.id);
    const seqs = readFileSync(sandboxAuditPath(dir), 'utf-8').trim().split('\n')
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
  });
});
