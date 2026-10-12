/**
 * The operator attention queue (the operator ask queue + AFK auto-decider).
 *
 * The delivery path never had an ask-the-operator rail: when a decision was
 * genuinely the operator's, the agent's only options were STOP (losing the
 * session's momentum — the "stops on any excuse" complaint) or GUESS (a
 * silent wrong turn). This queue is the third option: record the decision
 * with its SAFE DEFAULT, keep working, let the operator answer — and if
 * they are away past the grace window, the decider adopts the recorded
 * default and LOGS the adoption, so an AFK decision is never silent.
 *
 * Design rules (all inherited from the repo's store precedents):
 * - fail-open everywhere: an unreadable/corrupt/unwritable queue never
 *   blocks the work that wanted to ask (run-state.ts pattern);
 * - atomic writes: tmp-then-rename, so a crash mid-write cannot corrupt
 *   the queue (saveRunState pattern);
 * - bounded and sanitized twice: every operator-facing string is
 *   control-character-stripped and length-capped at INGEST, and the load
 *   path re-applies the same sanitizer — the file lives in shared-write
 *   `.uap/` and is a trust boundary in its own right, so a planted row
 *   must not reach terminals or the session-start prompt (P2 review
 *   lesson, hardened by the P3 security review);
 * - the decider never touches the SYSTEM it is asking about: it only
 *   records its own adoption of the safe default. The underlying surface
 *   (a placement TTL, a sandbox grant) keeps its own lifecycle — the queue
 *   is the legibility layer, not a second source of truth;
 * - `UAP_ATTENTION_OFF=1` is the kill switch: enqueue and sweep no-op.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import { loadUapConfigRaw } from '../utils/config-loader.js';
import { mainCheckoutRoot } from '../utils/checkout-root.js';

export type AttentionKind = 'blocking-question' | 'review-request' | 'grant-request';
export type AttentionStatus = 'pending' | 'acknowledged' | 'auto-decided' | 'decided' | 'escalated';

export interface SafeDefault {
  /** The decision adopted when the grace window lapses without an answer. */
  decision: string;
  /** WHY that decision is safe — the operator audits AFK adoptions by it. */
  rationale: string;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  /** Origin reference, e.g. 'placement:plc-9f2a1b' or 'deliver:run-x/task-y'. */
  source: string;
  safeDefault?: SafeDefault;
  createdAt: string;
  /** ISO timestamp after which the AFK decider may adopt the safe default. */
  graceDeadline: string;
  status: AttentionStatus;
  resolvedAt?: string;
  /** What happened + who decided (operator | auto | system). */
  resolution?: string;
}

export interface AttentionInput {
  kind: AttentionKind;
  title: string;
  detail: string;
  source: string;
  safeDefault?: SafeDefault;
  /** Site-known expiry for the ask (ISO string or Date). When present it
   *  REPLACES the generic grace window as the item's graceDeadline: a
   *  placement ask's decision window IS the pending entry's TTL, so the
   *  decider adopts at the moment the pending actually expires — never
   *  advertising an actionable swap after the underlying ask is dead, and
   *  never "adopting" an expiry that has not happened yet. */
  expiresAt?: string | Date;
}

export interface SweepResult {
  adopted: number;
  escalated: number;
}

/** Queue file: `<projectRoot>/.uap/attention.json`. */
/**
 * ONE queue per checkout, not per cwd. Three surfaces touch this file —
 * the dashboard (its process cwd), the session-start hook (the session's
 * worktree), and the CLI (wherever the operator is) — and in this repo's
 * mandated worktree workflow those are three different directories:
 * a per-cwd queue splits the rail into files no surface reads together
 * (the 2026-07-13 policy-liveness bug class; flagged BLOCKER by the
 * 2026-10-11 architecture review). Anchored to the MAIN checkout's .uap/,
 * mirroring how the placement ledger is machine-global for a machine-level
 * ask. `UAP_ATTENTION_QUEUE` pins an explicit file (tests, odd layouts);
 * non-git roots (unit fixtures, tmp dirs) fall through unchanged.
 */
export function attentionQueuePath(projectRoot: string): string {
  const override = process.env.UAP_ATTENTION_QUEUE;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(mainCheckoutRoot(projectRoot), '.uap', 'attention.json');
}

/** Resolved queue keeps a bounded audit trail; pending is never pruned. */
const MAX_ITEMS = 250;

export function attentionDisabled(): boolean {
  const v = process.env.UAP_ATTENTION_OFF;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Grace window in seconds before an unanswered item's safe default may be
 * adopted. Config `attention.graceSecs`, env `UAP_ATTENTION_GRACE_SECS`
 * overrides, default 300 (five minutes — long enough for a present operator
 * to intercede, short enough that an AFK run does not stall on it).
 */
export function attentionGraceSecs(projectRoot: string): number {
  // A cleared (`env VAR= ...`) variable is "unset", not zero — Number('') is
  // 0, and silently arming instant adoption on an empty string contradicts
  // the documented "set-but-invalid fails safe to the config value".
  const rawEnv = process.env.UAP_ATTENTION_GRACE_SECS;
  const env = rawEnv !== undefined && rawEnv.trim() !== '' ? Number(rawEnv) : Number.NaN;
  if (Number.isFinite(env) && env >= 0) return Math.min(Math.floor(env), 86_400);
  const raw: Record<string, unknown> | null = loadUapConfigRaw(projectRoot);
  const attention = raw?.attention as { graceSecs?: unknown } | undefined;
  const cfg = attention?.graceSecs;
  if (typeof cfg === 'number' && Number.isFinite(cfg) && cfg >= 0) return Math.min(Math.floor(cfg), 86_400);
  return 300;
}

// ---------------------------------------------------------------------------
// Sanitization — the queue is operator-facing output; ingested strings are
// untrusted by construction (P2's dial review closed this class at parse).
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- stripping control characters IS the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.replace(CONTROL_CHARS, ' ').trim().slice(0, max);
}

function isAttentionKind(v: string): v is AttentionKind {
  return v === 'blocking-question' || v === 'review-request' || v === 'grant-request';
}

function isAttentionStatus(v: string): v is AttentionStatus {
  return v === 'pending' || v === 'acknowledged' || v === 'auto-decided' || v === 'decided' || v === 'escalated';
}

function sanitizeInput(input: AttentionInput): AttentionInput {
  return {
    kind: input.kind,
    title: clean(input.title, 120),
    detail: clean(input.detail, 600),
    source: clean(input.source, 120),
    safeDefault: input.safeDefault
      ? {
          decision: clean(input.safeDefault.decision, 200),
          rationale: clean(input.safeDefault.rationale, 300),
        }
      : undefined,
    expiresAt: input.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Store — fail-open load, atomic persist (saveRunState pattern).
// ---------------------------------------------------------------------------

function loadQueue(projectRoot: string): AttentionItem[] {
  try {
    const path = attentionQueuePath(projectRoot);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    const items: AttentionItem[] = [];
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null) continue;
      const it = raw as Partial<AttentionItem>;
      // The file is SHARED-WRITE state (.uap/ is writable by every agent on
      // the project, and a cloned third-party repo need not gitignore it), so
      // the load path re-applies the ingest sanitizer instead of trusting
      // the disk: a planted row with ANSI escapes, forged newlines, or a
      // 50KB title must not reach operator terminals or the session-start
      // prompt, and a planted `safeDefault` must not ride a sweep wearing
      // the sweep's system-vouched `[auto]` label.
      if (
        typeof it.id !== 'string' ||
        !it.id ||
        typeof it.kind !== 'string' ||
        !isAttentionKind(it.kind) ||
        typeof it.status !== 'string' ||
        !isAttentionStatus(it.status) ||
        typeof it.title !== 'string' ||
        typeof it.createdAt !== 'string' ||
        typeof it.graceDeadline !== 'string'
      ) {
        continue; // a malformed row is dropped, never fatal
      }
      items.push({
        id: it.id.slice(0, 64),
        kind: it.kind,
        title: clean(it.title, 120),
        detail: clean(it.detail, 600),
        source: clean(it.source, 120),
        safeDefault:
          it.safeDefault && typeof it.safeDefault === 'object'
            ? {
                decision: clean(it.safeDefault.decision, 200),
                rationale: clean(it.safeDefault.rationale, 300),
              }
            : undefined,
        createdAt: it.createdAt,
        graceDeadline: it.graceDeadline,
        status: it.status,
        resolution: typeof it.resolution === 'string' ? clean(it.resolution, 600) : undefined,
        resolvedAt: typeof it.resolvedAt === 'string' ? it.resolvedAt : undefined,
      });
    }
    return items;
  } catch (err) {
    console.warn(
      `[attention] queue unreadable, treating as empty (continuing without it): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return []; // unreadable queue = empty queue; the ask must never crash work
  }
}

function persistQueue(projectRoot: string, items: AttentionItem[]): boolean {
  try {
    const path = attentionQueuePath(projectRoot);
    // Create the TARGET's directory (not <projectRoot>/.uap): the queue may
    // live at the MAIN checkout root while cwd is a worktree subdir, or at
    // a UAP_ATTENTION_QUEUE override — mkdir-ing somewhere other than the
    // write target fails the write it was supposed to enable (the same
    // finding the P5 review fixed in persistGrants).
    mkdirSync(dirname(path), { recursive: true });
    // Unique tmp name: two writers sharing a fixed `.tmp` can interleave-
    // truncate each other's file across the rename, and a predictable name
    // in the shared .uap/ root is a symlink-clobber target. The unique
    // suffix removes both; the queue stays atomic per writer.
    const tmp = `${path}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.warn(
      `[attention] queue persist failed (continuing without it): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false; // unwritable queue: the caller's work continues without it
  }
}

/** Keep the file bounded: prune oldest RESOLVED entries beyond MAX_ITEMS.
 *  Open items (pending/acknowledged/escalated) are never pruned — an
 *  unresolved ask must stay visible. */
function prune(items: AttentionItem[]): AttentionItem[] {
  if (items.length <= MAX_ITEMS) return items;
  const resolved = items.filter((i) => !isOpen(i));
  const live = items.filter(isOpen);
  const keep = resolved.sort((a, b) => (a.resolvedAt ?? a.createdAt).localeCompare(b.resolvedAt ?? b.createdAt)).slice(resolved.length + live.length - MAX_ITEMS);
  return [...live, ...keep];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * An item is OPEN while it still wants an answer: pending, acknowledged
 * (seen ≠ answered), or escalated (loudly unresolved — no safe default).
 * This is the set every "what is waiting" surface shows and the set the
 * decider sweeps; a resolved item (decided | auto-decided) is history.
 */
function isOpen(i: AttentionItem): boolean {
  return i.status === 'pending' || i.status === 'acknowledged' || i.status === 'escalated';
}

/**
 * Record an operator decision. Dedupes on `source` (the placement ledger's
 * rule, applied to asks) AND on (kind, title) while an identical ask is
 * still open: an expired-pending client that retries every TTL mints a new
 * placement id — and without the content dedupe, a weekend of retries
 * would mint one never-pruned ask per retry (pending items are never
 * pruned). One open ask per question is the whole point; each still
 * self-resolves at its own pinned deadline.
 */
export function enqueueAttention(projectRoot: string, input: AttentionInput): AttentionItem | null {
  if (attentionDisabled()) return null;
  const ask = sanitizeInput(input);
  if (!ask.title || !ask.source) return null; // nothing to ask about
  const items = loadQueue(projectRoot);
  const existing = items.find(
    (i) => isOpen(i) && (i.source === ask.source || (i.kind === ask.kind && i.title === ask.title)),
  );
  if (existing) return existing;
  const now = new Date();
  // Site-known expiry (a placement pending's TTL) overrides the generic
  // grace window: the ask's decision window IS the underlying deadline.
  const pinned = ask.expiresAt instanceof Date ? ask.expiresAt.toISOString() : ask.expiresAt;
  const deadline = pinned !== undefined && pinned.trim() !== '' && !Number.isNaN(Date.parse(pinned))
    ? pinned
    : new Date(now.getTime() + attentionGraceSecs(projectRoot) * 1000).toISOString();
  const item: AttentionItem = {
    id: `att-${randomBytes(3).toString('hex')}`,
    kind: ask.kind,
    title: ask.title,
    detail: ask.detail,
    source: ask.source,
    ...(ask.safeDefault ? { safeDefault: ask.safeDefault } : {}),
    createdAt: now.toISOString(),
    graceDeadline: deadline,
    status: 'pending',
  };
  const next = prune([...items, item]);
  return persistQueue(projectRoot, next) ? item : null; // never claim an ask that did not land
}

/** Newest first, optionally filtered by status. The kill switch silences the
 *  rail end-to-end — an off rail shows nothing on any surface (the
 *  session-start hint included); unset the variable to inspect the file. */
export function listAttention(projectRoot: string, status?: AttentionStatus): AttentionItem[] {
  if (attentionDisabled()) return [];
  return loadQueue(projectRoot)
    .filter((i) => (status ? i.status === status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Operator saw the ask; the grace clock keeps running (seen ≠ answered). */
export function ackAttention(projectRoot: string, id: string): AttentionItem | null {
  const items = loadQueue(projectRoot);
  const item = items.find((i) => i.id === id);
  if (!item || item.status !== 'pending') return null;
  item.status = 'acknowledged';
  return persistQueue(projectRoot, items) ? item : null; // a lost ack is retriable, never phantom
}

/** Operator (or a system caller) answers the ask. Idempotent per item. */
export function decideAttention(
  projectRoot: string,
  id: string,
  decision: string,
  decidedBy: 'operator' | 'system' = 'operator'
): AttentionItem | null {
  const items = loadQueue(projectRoot);
  const item = items.find((i) => i.id === id);
  if (!item || item.status === 'decided' || item.status === 'auto-decided') return null;
  item.status = 'decided';
  item.resolvedAt = new Date().toISOString();
  item.resolution = `[${decidedBy}] ${clean(decision, 280)}`;
  return persistQueue(projectRoot, items) ? item : null;
}

/**
 * Resolve an ask BY ORIGIN: the operator answered through the asking
 * surface itself (approved the swap with `uap models apply`, dismissed
 * the pending) rather than through this queue — and the queue must learn,
 * or a later sweep would falsely record an AFK adoption over a decision
 * that was actually made (the M1 review lesson). Idempotent by
 * construction: no matching open item → null (already resolved elsewhere).
 */
export function resolveAttentionBySource(
  projectRoot: string,
  source: string,
  decision: string,
  decidedBy: 'operator' | 'system' = 'operator'
): AttentionItem | null {
  const items = loadQueue(projectRoot);
  const item = items.find((i) => i.source === source && (i.status === 'pending' || i.status === 'acknowledged'));
  if (!item) return null;
  item.status = 'decided';
  item.resolvedAt = new Date().toISOString();
  item.resolution = `[${decidedBy}] ${clean(decision, 280)}`;
  return persistQueue(projectRoot, items) ? item : null;
}

/**
 * A1 — the AFK auto-decider. Items past their grace deadline with no
 * operator answer: adopt the recorded safe default (logged), or — when the
 * ask had no safe default — ESCALATE so it stays loudly visible instead of
 * silently expiring. The decider records its own adoption; it never
 * mutates the underlying system the ask was about.
 */
export function sweepExpired(
  projectRoot: string,
  opts: { now?: () => Date } = {}
): SweepResult {
  if (attentionDisabled()) return { adopted: 0, escalated: 0 };
  const now = (opts.now?.() ?? new Date()).toISOString();
  const items = loadQueue(projectRoot);
  let adopted = 0;
  let escalated = 0;
  for (const item of items) {
    if (item.status !== 'pending' && item.status !== 'acknowledged') continue;
    if (item.graceDeadline > now) continue; // still inside the grace window
    item.resolvedAt = now;
    if (item.safeDefault && item.safeDefault.decision) {
      item.status = 'auto-decided';
      item.resolution = `[auto] ${item.safeDefault.decision} — AFK grace elapsed; safe default: ${item.safeDefault.rationale}`;
      adopted++;
    } else {
      item.status = 'escalated';
      item.resolution = '[auto] no answer and no safe default — operator decision still required';
      escalated++;
    }
  }
  if (adopted + escalated > 0) persistQueue(projectRoot, items);
  return { adopted, escalated };
}
