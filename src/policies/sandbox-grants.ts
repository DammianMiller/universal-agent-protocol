/**
 * Per-session sandbox grants (the D2 consent ledger).
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
 * Design rules (inherited from the attention-queue store, review-hardened):
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
import { ledgerHeadOf, pathCoversAnchorDir, readAnchor, verifyLedger, writeAnchor } from './sandbox-anchor.js';
import type { Verification } from './sandbox-anchor.js';

/** Audit-log retention: the trail is append-only history, but an unbounded
 *  JSONL under the shared-write `.uap/` grows forever  — past
 *  the trigger it is compacted to the newest AUDIT_MAX_LINES event lines
 *  (plus the triggering event and one `audit-compaction` marker), so the
 *  file lands at AUDIT_MAX_LINES + 2. The compaction is itself audited, so
 *  a pruned trail is an EXPECTED state, never a silent one. */
export const AUDIT_MAX_LINES = 10_000;
export const AUDIT_PRUNE_TRIGGER = 12_000;

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
  // `id` goes through the SAME clean() as every other string field: the row is
  // rendered on operator terminals (the grants listing, the dashboard section,
  // the revoke command line), and a planted id carrying ANSI/OSC bytes would
  // fire exactly when the operator is drawn to inspect a tamper alarm
  // (review M1, 2026-10-11). trim() alone was the one gap.
  const id = clean(raw.id, 64);
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
    // otherwise become a real `--bind / /` hole (the bind follows the row,
    // so the row must carry nothing the operator would have refused — the
    // review's blocker finding). A row with ANY
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
    // interleave-truncate and symlink-clobber target (review finding).
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

/** Append one audit line. Append-only, best-effort, never throws. Every line
 *  carries a monotonic `seq` — recovered as the max of the file's last
 *  parseable seq and the ANCHOR's witnessed high-water, so numbering
 *  survives compaction AND file deletion (a trail whose numbering can
 *  restart is a forgeable trail). The file is compacted past
 *  AUDIT_PRUNE_TRIGGER with the drop recorded in an `audit-compaction`
 *  marker. */
/** The last parseable seq in an audit line list (0 when none parse): seqs
 *  are monotonic, so the last parseable line IS the high-water. A malformed
 *  tail degrades to the last good seq, never to a collision. */
function scanHighWater(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const last = JSON.parse(lines[i]) as { seq?: unknown };
      if (typeof last.seq === 'number' && Number.isFinite(last.seq)) return last.seq;
    } catch {
      /* keep scanning */
    }
  }
  return 0;
}

/** The audit file's high-water seq (0 when the file is absent, empty, or
 *  wholly malformed) — what anchorMutation witnesses after an operation's
 *  line has landed. */
function auditHighWater(projectRoot: string): number {
  try {
    const path = sandboxAuditPath(projectRoot);
    if (!existsSync(path)) return 0;
    const text = readFileSync(path, 'utf-8');
    if (text.length === 0) return 0;
    return scanHighWater(text.split('\n').filter((l) => l.length > 0));
  } catch {
    return 0;
  }
}

function audit(projectRoot: string, event: Record<string, unknown>): void {
  try {
    const path = sandboxAuditPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    let lines: string[] = [];
    let fileHi = 0;
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf-8');
      if (text.length > 0) {
        lines = text.split('\n').filter((l) => l.length > 0);
        // Scan BACKWARDS for the last parseable line: after a compaction the
        // file holds 10k lines with seqs up in the 12k+ range, so the old
        // `lines.length` fallback could REUSE a live seq number. A malformed
        // tail degrades to (last good seq + 1), never to a collision.
        fileHi = scanHighWater(lines);
      }
    }
    // The anchor's seqHi covers what the FILE cannot: deletion. The anchor
    // only witnesses seqs at recorded mutations, so a file grown past the
    // anchor (e.g. by sandbox-run lines) still numbers correctly — max of
    // both.
    const seq = Math.max(fileHi, readAnchor(projectRoot)?.seqHi ?? 0) + 1;
    if (lines.length + 1 > AUDIT_PRUNE_TRIGGER) {
      const kept = lines.slice(-AUDIT_MAX_LINES);
      kept.push(JSON.stringify({ ...event, seq }));
      kept.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          action: 'audit-compaction',
          dropped: lines.length + 1 - kept.length,
          seq: seq + 1,
        }),
      );
      const tmp = `${path}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`;
      writeFileSync(tmp, kept.map((l) => `${l}\n`).join(''), 'utf-8');
      renameSync(tmp, path);
      return;
    }
    appendFileSync(path, `${JSON.stringify({ ...event, seq })}\n`, 'utf-8');
  } catch (err) {
    console.warn(
      `[sandbox-grants] audit append failed (grant/revoke still applied): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Trust anchor (ADR 0011 follow-up, shipped): see sandbox-anchor.ts.
// ---------------------------------------------------------------------------

/** Verify the SANITIZED on-disk ledger against the out-of-checkout anchor.
 *  'unanchored' is the pre-bootstrap state, not a failure. When `grants` is
 *  passed (an already-loaded sanitized snapshot), the SAME snapshot is
 *  verified and then acted on — the torn-read fix: loading the
 *  file twice left a window where the hash saw one state and the resolver
 *  acted on another. */
export function verifyLedgerIntegrity(projectRoot: string, grants?: SandboxGrant[]): Verification {
  const onDisk = grants ?? loadGrants(projectRoot);
  return verifyLedger(projectRoot, ledgerHeadOf(onDisk));
}

/** Advance the anchor to a CONFIRMED on-disk state (called only after the
 *  lost-update guard proved the persist landed, and AFTER the operation's
 *  audit line is written, so the seq high-water the anchor witnesses
 *  includes it). A failed anchor write is loud but never fatal: the ledger
 *  stays operative; verification is simply not possible until the next
 *  recorded mutation succeeds. */
function anchorMutation(projectRoot: string, confirmed: SandboxGrant[]): void {
  const prior = readAnchor(projectRoot);
  const seqHi = Math.max(prior?.seqHi ?? 0, auditHighWater(projectRoot));
  if (!writeAnchor(projectRoot, ledgerHeadOf(confirmed), (prior?.mutations ?? 0) + 1, seqHi)) {
    console.warn(
      '[sandbox-grants] trust-anchor write failed — the ledger is active but NOT verifiable; ' +
        'the next successful grant/renew/revoke will try to anchor it',
    );
    return;
  }
  // Verify-after-write (review interleave finding): a concurrent writer's
  // anchor landing between ours and the ledger read leaves a persistent
  // false mismatch on a healthy ledger. Confirm ours is what the disk now
  // holds; if not, say so — never a silent divergence.
  const after = verifyLedgerIntegrity(projectRoot);
  if (after.state !== 'ok') {
    console.warn(
      `[sandbox-grants] the trust anchor moved to a concurrent writer's state after this mutation (${after.state}) — ` +
        'if `uap sandbox grants` reports a mismatch you did not cause, re-run the last grant/revoke',
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
    // The one hole that must never open: a grant covering the trust-anchor
    // dir lets the sandboxed side delete or corrupt the tamper evidence
    // itself (the anchor is ro-bound by default, but a hole
    // over it makes it writable).
    if (pathCoversAnchorDir(v)) {
      return { ok: false, error: `not grantable: '${p}' covers the sandbox trust-anchor directory — a hole there could destroy the tamper evidence itself` };
    }
    if (!paths.includes(v)) paths.push(v);
    if (paths.length > MAX_PATHS_PER_GRANT) return { ok: false, error: `more than ${MAX_PATHS_PER_GRANT} paths in one grant — split it` };
  }
  if (paths.length === 0) {
    return { ok: false, error: 'a grant grants something: pass at least one writable path' };
  }

  // TTL is FAIL-CLOSED on garbage: undefined → the 8h default, but a
  // non-numeric or negative --ttl is REFUSED outright (the security
  // review caught bad input silently meaning "give 8h anyway" — the wrong
  // direction for authority). 0 floors to 1s: a
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
    // ONE load, ONE hash, one array to act on (the torn-read fix, review
    // m2): verifying a separate read left a window where the hash saw one
    // state and the mint acted on another.
    const loaded = loadGrants(projectRoot);
    const integrity = verifyLedgerIntegrity(projectRoot, loaded);
    if (integrity.state === 'mismatch') {
      // A tampered ledger must not mint legitimacy: refuse to RECORD new
      // consent on top of a state that failed integrity verification.
      return {
        ok: false,
        error: `ledger failed integrity verification — ${integrity.detail}; refusing to record new consent until it is resolved`,
      };
    }
    const existing = loaded.filter((g) => g.expiresAt > now.toISOString());
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
      const confirmedAll = loadGrants(projectRoot);
      const after = confirmedAll.find((g) => g.id === twin.id);
      if (!after || after.expiresAt !== twin.expiresAt) {
        if (attempt === 0) continue;
        return { ok: false, error: 'ledger changed under a concurrent writer — renewal not confirmed; retry the grant' };
      }
      // Audit FIRST, then anchor: the anchor witnesses the audit high-water,
      // and it must include this operation's line (audit-then-anchor is what
      // makes seq survive audit-file deletion — the anchor's seqHi is the
      // floor the next line numbers from).
      audit(projectRoot, { ts: grant.grantedAt, action: 'grant-renewed', grantId: twin.id, sessionId, paths, reason });
      anchorMutation(projectRoot, confirmedAll);
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
    const confirmedAll = loadGrants(projectRoot);
    if (!confirmedAll.some((g) => g.id === grant.id)) {
      if (attempt === 0) continue;
      return { ok: false, error: 'ledger changed under a concurrent writer — the grant is NOT confirmed; retry' };
    }
    // Audit FIRST, then anchor — same reason as the renewal path above.
    audit(projectRoot, { ts: grant.grantedAt, action: 'grant', grantId: grant.id, sessionId, paths, reason, ttlSecs: ttl });
    anchorMutation(projectRoot, confirmedAll);
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
  // A mismatched ledger may still LOSE authority (revoking is the safe
  // direction) — but the revoke re-anchors the remaining rows as the new
  // baseline, so a pre-existing mismatch is named loudly at the exact
  // moment it stops being detectable.
  const preIntegrity = verifyLedgerIntegrity(projectRoot);
  for (let attempt = 0; ; attempt++) {
    const all = loadGrants(projectRoot);
    const keep = all.filter((g) => g.id !== id);
    if (keep.length === all.length) return false;
    if (!persistGrants(projectRoot, keep)) return false;
    // Lost-update guard (security review): a concurrent writer landing
    // after our persist can resurrect the row; verify the removal actually
    // landed before reporting success, retrying once against fresh state.
    const confirmedAll = loadGrants(projectRoot);
    if (confirmedAll.some((g) => g.id === id)) {
      if (attempt === 0) continue;
      return false;
    }
    // Audit FIRST, then anchor — same reason as the grant/renew paths.
    audit(projectRoot, { ts: new Date().toISOString(), action: 'revoke', grantId: id });
    anchorMutation(projectRoot, confirmedAll);
    if (preIntegrity.state === 'mismatch') {
      console.warn(
        `[sandbox-grants] NOTE: the ledger had failed integrity verification before this revoke — ${preIntegrity.detail}. ` +
          'The remaining rows are now anchored as the new baseline; inspect them with `uap sandbox grants`.',
      );
    }
    return true;
  }
}

/**
 * Resolve the ACTIVE authority for a session — what `uap sandbox` will
 * actually open. Expired or malformed rows are invisible here; the sandbox
 * never has to reason about them.
 */
export function resolveSessionGrants(projectRoot: string, sessionId: string): ResolvedGrants {
  // ONE load: the snapshot that gets verified is the SAME snapshot that
  // resolves the holes (the torn-read fix).
  const loaded = loadGrants(projectRoot);
  // Fail-CLOSED on tamper evidence (ADR 0011): a ledger that fails anchor
  // verification opens ZERO grant-derived holes. The sandbox's own kernel
  // boundary is unaffected — only the extra holes close (the safe direction
  // for authority, same rule as an unreadable ledger).
  const integrity = verifyLedgerIntegrity(projectRoot, loaded);
  if (integrity.state === 'mismatch') {
    console.error(
      `[sandbox-grants] INTEGRITY MISMATCH — ${integrity.detail}. ` +
        'Opening NO grant-derived writable holes for this session; the sandbox boundary itself is unaffected. ' +
        'Run `uap sandbox grants` to inspect the ledger.',
    );
    return { grants: [], paths: [] };
  }
  if (integrity.state === 'unanchored' && loaded.length > 0) {
    // The quiet dangerous state ): grants exist but the anchor is
    // gone/never written, so tamper evidence is OFF. Never silent.
    console.warn(
      `[sandbox-grants] ${loaded.length} grant(s) on disk but NO trust anchor — tamper evidence is inactive; ` +
        'the next successful grant/renew/revoke (re-)anchors the ledger',
    );
  }
  const nowIso = new Date().toISOString();
  const sid = clean(sessionId, 64);
  const active = loaded.filter((g) => g.expiresAt > nowIso && (!sid || g.sessionId === sid));
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
