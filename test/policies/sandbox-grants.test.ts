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
  DEFAULT_GRANT_TTL_SECS,
  MAX_GRANT_TTL_SECS,
} from '../../src/policies/sandbox-grants.js';

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
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.UAP_SANDBOX_GRANTS;
  delete process.env.UAP_SANDBOX_AUDIT;
  delete process.env.UAP_SANDBOX_GRANTS_OFF;
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
  it('appends one JSONL line per grant, revoke, and sandbox-run', () => {
    const g = grantAuthority(dir, { ...INPUT, paths: [hole] })!;
    if (!g.ok) throw new Error(g.error);
    revokeAuthority(dir, g.grant.id);
    const used = resolveSessionGrants(dir, 'sess-abc');
    auditSandboxUse(dir, 'sess-abc', used, ['/unrecorded/legacy'], 'off');
    const lines = readFileSync(sandboxAuditPath(dir), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0].action).toBe('grant');
    expect(parsed[1].action).toBe('revoke');
    expect(parsed[2].action).toBe('sandbox-run');
    expect(parsed[2].netMode).toBe('off');
    expect(parsed[2].unrecordedAllow).toEqual(['/unrecorded/legacy']);
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
