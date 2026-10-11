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

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import { homedir } from 'os';
import { dirname, join } from 'path';
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
 * per checkout, not per cwd, anchored at the main checkout root like the
 * attention queue (ADR 0010): the CLI can be invoked from any worktree
 * subdir, and a per-cwd ledger would give the same session different
 * authority depending on where the operator happened to stand. Today the
 * CLI is the only consumer; the anchoring also keeps a future dashboard
 * grants view (a natural P5 surface) reading the same file.
 * `UAP_SANDBOX_GRANTS` pins an explicit file (tests, odd layouts).
 */
export function sandboxGrantsPath(projectRoot: string): string {
  const override = process.env.UAP_SANDBOX_GRANTS;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(mainCheckoutRoot(projectRoot), '.uap', 'sandbox-grants.json');
}

/** Audit trail: append-only JSONL, one line per grant/revoke/sandbox-use. */
export function sandboxAuditPath(projectRoot: string): string {
  const override = process.env.UAP_SANDBOX_AUDIT;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
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
 * a speculative one), and must not be an over-broad root — checked AFTER
 * symlink resolution: `/tmp/link -> $HOME` passes a string-only refusal and
 * bwrap's `--bind` follows the link, so the check that matters is against
 * the REALPATH (`/`, `/home`, $HOME itself — the same refusal the sandbox
 * applies to a too-broad workdir: an over-broad grant IS a sandbox escape).
 * Returns the RESOLVED path (what the bind will actually target), or null.
 */
export function validateGrantPath(p: string): string | null {
  if (!p.startsWith('/')) return null;
  const home = process.env.HOME || homedir();
  let resolved: string;
  try {
    if (!existsSync(p)) return null;
    resolved = realpathSync(p);
  } catch {
    return null;
  }
  if (resolved === '/' || resolved === '/home' || resolved === home) return null;
  return resolved;
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
  const paths: string[] = [];
  const rawPaths = Array.isArray(raw.paths) ? raw.paths : [];
  for (const rp of rawPaths) {
    if (typeof rp !== 'string') return null;
    // The load path re-applies the FULL grantable-path validation, not just
    // a string prefix: a planted well-formed row with `paths:["/"]` would
    // otherwise become a real `--bind / /` hole (the string-only check was
    // the P4 review BLOCKER — the bind follows the row, so the row must
    // carry nothing the operator would have refused). A row with ANY
    // ungrantable path is dropped whole: least authority, and a half-row
    // is a forged consent record.
    const p = validateGrantPath(clean(rp, 512));
    if (!p) return null;
    if (!paths.includes(p)) paths.push(p);
  }
  if (paths.length === 0) return null; // a grant must grant something
  // Timestamps must parse, and the expiry must respect the hard TTL bound —
  // a planted `expiresAt: "9999"` never lapses under the lexicographic
  // compare in listAuthority, which is exactly the "forever grant" this
  // ledger exists to prevent. `grantedAt` is kept as written (history), but
  // must be a parseable instant.
  if (!Number.isFinite(Date.parse(raw.grantedAt))) return null;
  const expiresMs = Date.parse(raw.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs > Date.now() + MAX_GRANT_TTL_SECS * 1000) return null;
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
    // Create the TARGET's directory (not <cwd>/.uap): the ledger may live at
    // the main checkout root while cwd is a worktree subdir, or at a
    // UAP_SANDBOX_GRANTS override — mkdir-ing the wrong place fails the
    // write it was supposed to enable.
    mkdirSync(dirname(path), { recursive: true });
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
    mkdirSync(dirname(path), { recursive: true });
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

  // TTL is FAIL-CLOSED on garbage: undefined → the 8h default, but a
  // non-numeric or negative --ttl is REFUSED outright (the P4 security
  // review caught the old expression silently treating bad input as "give
  // 8h anyway" — the wrong direction for authority). 0 floors to 1s: a
  // zero-second grant is a recorded consent that expires immediately.
  let ttl: number;
  if (input.ttlSecs === undefined) {
    ttl = DEFAULT_GRANT_TTL_SECS;
  } else if (!Number.isFinite(input.ttlSecs) || input.ttlSecs < 0) {
    return { ok: false, error: `--ttl must be a non-negative number of seconds (got '${input.ttlSecs}')` };
  } else {
    ttl = Math.min(Math.max(1, Math.floor(input.ttlSecs)), MAX_GRANT_TTL_SECS);
  }
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

  for (let attempt = 0; ; attempt++) {
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
      // A failed persist must not be reported as a renewal: the OLD expiry
      // stays active (the safe direction), and the operator keeps the truth.
      if (!persistGrants(projectRoot, existing)) {
        return { ok: false, error: 'ledger persist failed — the renewal is NOT active (the previous expiry stands)' };
      }
      // Lost-update guard: load→modify→persist has no lock, and the atomic
      // rename prevents corruption, not lost updates — a concurrent writer
      // landing after ours drops our renewal while we report success.
      // Verify ours survived; retry once against the fresh state.
      const after = loadGrants(projectRoot).find((g) => g.id === twin.id);
      if (!after || after.expiresAt !== twin.expiresAt) {
        if (attempt === 0) continue;
        return { ok: false, error: 'ledger changed under a concurrent writer — renewal not confirmed; retry the grant' };
      }
      audit(projectRoot, { ts: grant.grantedAt, action: 'grant-renewed', grantId: twin.id, sessionId, paths, reason });
      return { ok: true, grant: twin };
    }
    const all = [...existing, grant];
    if (!persistGrants(projectRoot, all)) {
      return { ok: false, error: 'ledger persist failed — the grant is NOT active (refusing to report success)' };
    }
    // Lost-update guard (same shape as the renewal path): two concurrent
    // grants can both read-modify-write and silently drop the loser's row
    // while its CLI reports success — verify the row survived before
    // claiming the grant active.
    if (!loadGrants(projectRoot).some((g) => g.id === grant.id)) {
      if (attempt === 0) continue;
      return { ok: false, error: 'ledger changed under a concurrent writer — the grant is NOT confirmed; retry' };
    }
    audit(projectRoot, { ts: grant.grantedAt, action: 'grant', grantId: grant.id, sessionId, paths, reason, ttlSecs: ttl });
    return { ok: true, grant };
  }
}

/** List grants, optionally scoped to one session. Expired rows are inert. */
export function listAuthority(projectRoot: string, sessionId?: string): SandboxGrant[] {
  const nowIso = new Date().toISOString();
  const sid = sessionId ? clean(sessionId, 64) : '';
  return loadGrants(projectRoot).filter((g) => g.expiresAt > nowIso && (!sid || g.sessionId === sid));
}

/** Revoke one grant by id. Returns true only when it was found AND removed
 *  from the ledger — a failed persist leaves the grant active, and reporting
 *  success over a live grant would be a false consent record. */
export function revokeAuthority(projectRoot: string, grantId: string): boolean {
  const id = clean(grantId, 64);
  for (let attempt = 0; ; attempt++) {
    const all = loadGrants(projectRoot);
    const keep = all.filter((g) => g.id !== id);
    if (keep.length === all.length) return false;
    if (!persistGrants(projectRoot, keep)) return false;
    // Lost-update guard (P4 security review): a concurrent writer landing
    // after our persist can resurrect the row; verify the removal actually
    // landed before reporting success, retrying once against fresh state.
    if (loadGrants(projectRoot).some((g) => g.id === id)) {
      if (attempt === 0) continue;
      return false;
    }
    audit(projectRoot, { ts: new Date().toISOString(), action: 'revoke', grantId: id });
    return true;
  }
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
    // Control chars are cleaned here too — the audit line is operator-
    // terminal output as much as JSONL.
    unrecordedAllow: legacyAllow.map((p) => clean(p, 512)),
  });
}
