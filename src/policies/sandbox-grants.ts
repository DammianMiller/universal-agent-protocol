/**
 * Per-session sandbox grants (bridge Phase 4: D2 consent ledger).
 *
 * `uap sandbox` is all-or-nothing authority: the workdir + scratch are
 * writable, everything else is EROFS. That default is right, but real work
 * sometimes needs one more hole (a config dir, a build cache outside the
 * tree) — and the pre-P4 answer, `UAP_SANDBOX_ALLOW=path:path`, was
 * UNRECORDED authority: an env var nobody audited, invisible to the
 * operator, surviving in shell histories and hook templates forever.
 *
 * This ledger is the fix: every extra hole is a GRANT — bounded by a
 * session, a TTL, and a stated reason, recorded with who consented, and
 * audit-logged on use. "Every new authority must state who consented"
 * (EVOLUTION.md, the P4 bar).
 *
 * Design rules (inherited from the attention-queue store, P3 review-hardened):
 * - the ledger is shared-write state in `.uap/`, so every string is
 *   sanitized at INGEST and the load path re-applies the same sanitizer —
 *   a planted row must not become a kernel-writable hole or reach
 *   operator terminals;
 * - atomic writes with unique tmp names (no fixed `.tmp` in shared dirs);
 * - corrupt/unreadable ledger ⇒ EMPTY ledger: the safe direction for an
 *   authority store is least authority (the sandbox itself stays the real
 *   kernel boundary — a lost grant just means EROFS, not a breach);
 * - every grant expires (default 8h, hard cap 7d): authority is bounded
 *   by construction, and revocation is a single command;
 * - fail-OPEN for the sandbox, fail-CLOSED for the holes: load problems
 *   never crash a sandboxed run, they just yield no holes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { mainCheckoutRoot } from '../utils/checkout-root.js';

/** One consented extra authority for one session. */
export interface SandboxGrant {
  id: string;
  /** Session this grant is scoped to (UAP_SESSION_ID / --session). */
  sessionId: string;
  /** Absolute paths made writable inside the sandbox for this session. */
  paths: string[];
  /** WHY — operator-facing, required. Empty reason = refused at ingest. */
  reason: string;
  /** Who consented (username at grant time). */
  grantedBy: string;
  grantedAt: string;
  /** ISO timestamp after which the grant is inert (hard-bounded). */
  expiresAt: string;
}

export interface GrantInput {
  sessionId: string;
  paths: string[];
  reason: string;
  ttlSecs?: number;
}

/** A session's resolved, ACTIVE authority. */
export interface ResolvedGrants {
  grants: SandboxGrant[];
  paths: string[];
}

/** Default grant TTL: 8h — long enough for a working session, short enough
 *  that a forgotten hole closes itself before the next one. */
export const DEFAULT_GRANT_TTL_SECS = 28_800;
/** Hard cap on grant TTL: authority must be re-consented weekly at most. */
export const MAX_GRANT_TTL_SECS = 604_800;
/** Paths per grant cap: a grant is a scoped exception, not a hole list. */
export const MAX_PATHS_PER_GRANT = 8;

/**
 * Ledger file: `<mainCheckoutRoot>/.uap/sandbox-grants.json` — ONE ledger
 * per checkout, not per cwd, for the same three-surfaces reason as the
 * attention queue (dashboard / hook / CLI all resolve the same file).
 * `UAP_SANDBOX_GRANTS` pins an explicit file (tests, odd layouts).
 */
export function sandboxGrantsPath(projectRoot: string): string {
  const override = process.env.UAP_SANDBOX_GRANTS;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(mainCheckoutRoot(projectRoot), '.uap', 'sandbox-grants.json');
}

/** Audit trail: append-only JSONL, one line per grant/revoke/sandbox-use. */
export function sandboxAuditPath(projectRoot: string): string {
  const override = process.env.UAP_SANDBOX_AUDIT;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(mainCheckoutRoot(projectRoot), '.uap', 'sandbox-audit.jsonl');
}

// ---------------------------------------------------------------------------
// Sanitization — the ledger grants KERNEL-WRITABLE HOLES and feeds operator
// terminals; ingested strings are untrusted by construction.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- stripping control characters IS the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.replace(CONTROL_CHARS, ' ').trim().slice(0, max);
}

/**
 * A grantable path must be ABSOLUTE, must exist (you grant a real hole, not
 * a speculative one), and must not be an over-broad root (/, /home, $HOME
 * itself — the same refusal the sandbox applies to a too-broad workdir:
 * an over-broad grant IS a sandbox escape).
 */
export function validateGrantPath(p: string): string | null {
  if (!p.startsWith('/')) return null;
  const home = process.env.HOME || homedir();
  if (p === '/' || p === '/home' || p === home) return null;
  try {
    if (!existsSync(p)) return null;
    const st = statSync(p);
    if (!st.isDirectory()) return p; // files are fine (tighter than dirs)
    return p;
  } catch {
    return null;
  }
}

function sanitizeGrant(raw: Partial<SandboxGrant> & { [k: string]: unknown }): SandboxGrant | null {
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 64) : '';
  const sessionId = clean(raw.sessionId, 64);
  const reason = clean(raw.reason, 300);
  const grantedBy = clean(raw.grantedBy, 64);
  if (
    !id ||
    !sessionId ||
    !reason || // a grant without a stated reason is exactly what this ledger exists to refuse
    !grantedBy ||
    typeof raw.grantedAt !== 'string' ||
    typeof raw.expiresAt !== 'string'
  ) {
    return null;
  }
  const paths = Array.isArray(raw.paths)
    ? raw.paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/')).map((p) => p.slice(0, 512))
    : [];
  if (paths.length === 0) return null; // a grant must grant something
  return {
    id,
    sessionId,
    paths,
    reason,
    grantedBy,
    grantedAt: raw.grantedAt,
    expiresAt: raw.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Store — least-authority load, atomic persist.
// ---------------------------------------------------------------------------

function loadGrants(projectRoot: string): SandboxGrant[] {
  try {
    const path = sandboxGrantsPath(projectRoot);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    const grants: SandboxGrant[] = [];
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null) continue;
      const g = sanitizeGrant(raw as Partial<SandboxGrant>);
      if (g) grants.push(g); // malformed rows are dropped, never fatal
    }
    return grants;
  } catch (err) {
    // Unreadable ledger = empty ledger: the SAFE direction for authority.
    // The sandbox keeps its kernel boundary; only the extra holes vanish.
    console.warn(
      `[sandbox-grants] ledger unreadable, treating as empty (no extra holes): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

function persistGrants(projectRoot: string, grants: SandboxGrant[]): boolean {
  try {
    const path = sandboxGrantsPath(projectRoot);
    mkdirSync(join(projectRoot, '.uap'), { recursive: true });
    // Unique tmp name: a fixed `.tmp` in shared-write .uap/ is an
    // interleave-truncate and symlink-clobber target (P3 review finding).
    const tmp = `${path}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(grants, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch (err) {
    // A failed persist is reported, never silent — but it must not throw:
    // the caller (sandbox launch) treats "no persisted grants" as safe.
    console.warn(
      `[sandbox-grants] ledger persist failed (grants NOT active for this session): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** Append one audit line. Append-only, best-effort, never throws. */
function audit(projectRoot: string, event: Record<string, unknown>): void {
  try {
    const path = sandboxAuditPath(projectRoot);
    mkdirSync(join(projectRoot, '.uap'), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (err) {
    console.warn(
      `[sandbox-grants] audit append failed (grant/revoke still applied): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Operations.
// ---------------------------------------------------------------------------

/** Create a grant. Returns the grant, or a refusal reason. */
export function grantAuthority(projectRoot: string, input: GrantInput): { ok: true; grant: SandboxGrant } | { ok: false; error: string } {
  const sessionId = clean(input.sessionId, 64);
  if (!sessionId) return { ok: false, error: 'a grant requires --session <id> (the session this authority is scoped to)' };
  const reason = clean(input.reason, 300);
  if (!reason) return { ok: false, error: 'a grant requires --reason "..." — consent must be stated, not implied' };

  const paths: string[] = [];
  for (const p of input.paths) {
    const v = validateGrantPath(p);
    if (!v) return { ok: false, error: `not grantable: '${p}' (must be an existing absolute path, and not / , /home, or $HOME itself)` };
    if (!paths.includes(v)) paths.push(v);
    if (paths.length > MAX_PATHS_PER_GRANT) return { ok: false, error: `more than ${MAX_PATHS_PER_GRANT} paths in one grant — split it` };
  }
  if (paths.length === 0) {
    return { ok: false, error: 'a grant grants something: pass at least one writable path' };
  }

  const ttl = Math.min(
    Number.isFinite(input.ttlSecs) && (input.ttlSecs as number) > 0 ? Math.floor(input.ttlSecs as number) : DEFAULT_GRANT_TTL_SECS,
    MAX_GRANT_TTL_SECS,
  );
  const now = new Date();
  const grant: SandboxGrant = {
    id: `sbg-${randomUUID().slice(0, 8)}`,
    sessionId,
    paths,
    reason,
    grantedBy: process.env.USER || process.env.LOGNAME || 'unknown',
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };

  const existing = loadGrants(projectRoot).filter((g) => g.expiresAt > now.toISOString());
  // Dedupe: an identical open grant (same session + same paths) is refreshed,
  // not duplicated — a second `grant` for the same hole renews its TTL.
  const twin = existing.find(
    (g) => g.sessionId === grant.sessionId && g.paths.length === grant.paths.length && grant.paths.every((p) => g.paths.includes(p)),
  );
  if (twin) {
    twin.expiresAt = grant.expiresAt;
    twin.reason = grant.reason;
    twin.grantedAt = grant.grantedAt;
    persistGrants(projectRoot, existing);
    audit(projectRoot, { ts: grant.grantedAt, action: 'grant-renewed', grantId: twin.id, sessionId, paths, reason });
    return { ok: true, grant: twin };
  }
  const all = [...existing, grant];
  if (!persistGrants(projectRoot, all)) {
    return { ok: false, error: 'ledger persist failed — the grant is NOT active (refusing to report success)' };
  }
  audit(projectRoot, { ts: grant.grantedAt, action: 'grant', grantId: grant.id, sessionId, paths, reason, ttlSecs: ttl });
  return { ok: true, grant };
}

/** List grants, optionally scoped to one session. Expired rows are inert. */
export function listAuthority(projectRoot: string, sessionId?: string): SandboxGrant[] {
  const nowIso = new Date().toISOString();
  const sid = sessionId ? clean(sessionId, 64) : '';
  return loadGrants(projectRoot).filter((g) => g.expiresAt > nowIso && (!sid || g.sessionId === sid));
}

/** Revoke one grant by id. Returns true when it was found and removed. */
export function revokeAuthority(projectRoot: string, grantId: string): boolean {
  const id = clean(grantId, 64);
  const all = loadGrants(projectRoot);
  const keep = all.filter((g) => g.id !== id);
  if (keep.length === all.length) return false;
  persistGrants(projectRoot, keep);
  audit(projectRoot, { ts: new Date().toISOString(), action: 'revoke', grantId: id });
  return true;
}

/**
 * Resolve the ACTIVE authority for a session — what `uap sandbox` will
 * actually open. Expired or malformed rows are invisible here; the sandbox
 * never has to reason about them.
 */
export function resolveSessionGrants(projectRoot: string, sessionId: string): ResolvedGrants {
  const active = listAuthority(projectRoot, sessionId);
  const paths: string[] = [];
  for (const g of active) for (const p of g.paths) if (!paths.includes(p)) paths.push(p);
  return { grants: active, paths };
}

/** Record that a sandbox run USED its grants (the "who consented, when used" line).
 *  `netMode` is the network mode the run ACTUALLY engaged ('off' = the kernel
 *  egress boundary): the audit line is the consent record, so it must state
 *  the boundary that was really on. */
export function auditSandboxUse(
  projectRoot: string,
  sessionId: string,
  used: ResolvedGrants,
  legacyAllow: string[],
  netMode: 'shared' | 'off',
): void {
  audit(projectRoot, {
    ts: new Date().toISOString(),
    action: 'sandbox-run',
    sessionId: clean(sessionId, 64),
    grantIds: used.grants.map((g) => g.id),
    paths: used.paths,
    netMode,
    // The legacy env is still honored (backwards compatibility) but named in
    // the audit: unrecorded authority is exactly what this ledger replaced.
    unrecordedAllow: legacyAllow,
  });
}
