/**
 * The sandbox-consent trust anchor (ADR 0011's named follow-up, shipped).
 *
 * The grant ledger and audit trail live under the MAIN checkout root —
 * writable by the operator side of every run. The kernel ro-bind closes the
 * *sandboxed* side (P4), and the load path re-validates shape, but neither
 * can prove WHO wrote a row: a process with the checkout's write reach can
 * plant a well-formed grant and claim the operator consented.
 *
 * This module is the honest increment: **tamper-evidence, not tamper-proofing**.
 * A 0600 anchor file OUTSIDE the checkout's write reach records the hash of
 * the sanitized ledger as of the last recorded consent operation. On load,
 * the on-disk ledger is re-hashed and compared: a match proves the ledger is
 * exactly the state a recorded grant/renew/revoke produced; a mismatch means
 * something with checkout write access altered it — which fails CLOSED (no
 * extra holes, loud warning) at the sandbox launch and refuses new grants.
 *
 * What this does NOT do (kept explicit, not hidden): the anchor lives in the
 * user's state dir, so a *same-user* process outside the checkout can still
 * write it. The boundary it draws is exactly the ADR's frame — the
 * checkout's write reach vs. outside it. True origin proof (a different uid
 * or a hardware key) remains open and is not claimed.
 */

import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import { randomBytes } from 'crypto';
import { mainCheckoutRoot } from '../utils/checkout-root.js';
import { termSafe } from '../utils/terminal-safe.js';
import type { SandboxGrant } from './sandbox-grants.js';

/** Anchor file version — future shape changes bump this and re-anchor. */
export const ANCHOR_VERSION = 1;

export interface AnchorState {
  v: number;
  /** sha256 of the sanitized ledger array as of the last recorded mutation. */
  ledgerHead: string;
  /** Monotonic count of recorded ledger mutations (context for the operator). */
  mutations: number;
  /** High-water of audit seqs this anchor has WITNESSED: seq continuity then
   *  survives not just compaction but audit-file DELETION — a trail whose
   *  numbering can restart from 0 is a forgeable trail (line N twice means
   * one of them is planted). Additive optional v1 field: anchors written
   * before it existed simply lack it, and pre-field anchors stay valid. */
  seqHi?: number;
  updatedAt: string;
  updatedBy: string;
}

/** The anchor dir: OUTSIDE the checkout's write reach by construction. */
export function anchorDir(): string {
  const pinned = process.env.UAP_SANDBOX_ANCHOR_DIR;
  if (pinned) {
    warnIfPinnedInsideCheckout(pinned);
    return pinned;
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg || join(homedir(), '.local', 'state');
  return join(base, 'uap', 'sandbox-anchors');
}

/** Warn once when the pin points INSIDE the checkout the anchor vouches for:
 *  the "verified against its trust anchor" verdict would then be false
 *  assurance — the anchor is exactly as tamperable as the ledger it hashes.
 *  The pin exists for tests and non-standard layouts; a real checkout root
 *  (a dir whose git toplevel resolves) using it in-tree is operator error
 *  worth a loud line, not a silent green. */
let warnedPinInside = false;
function warnIfPinnedInsideCheckout(pinned: string): void {
  if (warnedPinInside) return;
  try {
    const root = mainCheckoutRoot(pinned);
    // Only meaningful for a real git checkout; non-git tmp pins (tests) pass.
    const isGitCheckout = existsSync(join(root, '.git')) || root !== pinned;
    const inside = pinned === root || pinned.startsWith(root + sep);
    if (isGitCheckout && inside && root.length > 1) {
      warnedPinInside = true;
      console.warn(
        `[sandbox-anchor] UAP_SANDBOX_ANCHOR_DIR is INSIDE the checkout (${root}) it vouches for — ` +
          'the tamper-evidence verdict is meaningless for this session; pin a dir outside the tree',
      );
    }
  } catch {
    /* the pin still works; this is advisory */
  }
}

/** One anchor per MAIN-checkout root (keyed by its hash, never its literal
 *  path — the path can contain spaces/usernames that must not reach a
 *  filename). Keying by `mainCheckoutRoot` — NOT the raw argument — is the
 *  whole point: every surface passes a cwd (often a `.worktrees/NNN-*`
 *  subdir), and the LEDGER already resolves through the same helper, so
 *  keying the anchor by the raw cwd would give the shared ledger one anchor
 *  per cwd string: worktree sessions would silently run UNANCHORED, and a
 *  grant recorded from one cwd would look tampered from another. All three
 *  P-debt reviewers caught this independently; the fix is to key exactly
 *  the way the ledger does. */
export function anchorPath(projectRoot: string): string {
  const key = createHash('sha256').update(mainCheckoutRoot(projectRoot)).digest('hex').slice(0, 16);
  return join(anchorDir(), `${key}.json`);
}

/** True when a granted writable path would cover the anchor dir — the one
 *  grant that must be refused, because a hole over the anchor lets the
 *  sandboxed side delete or corrupt the tamper evidence itself. */
export function pathCoversAnchorDir(grantPath: string): boolean {
  const dir = anchorDir();
  return dir === grantPath || dir.startsWith(grantPath + sep);
}

/** The tamper-evidence hash of a ledger state: over the SANITIZED rows (the
 *  same shape the load path enforces), in stored order. */
export function ledgerHeadOf(grants: SandboxGrant[]): string {
  return createHash('sha256').update(JSON.stringify(grants)).digest('hex');
}

/** Read the anchor; null when absent or malformed (absent = unanchored).
 *  The metadata fields are termSafe'd here — they are interpolated into the
 *  mismatch banners on the dashboard/CLI/launch stderr, and whoever can
 *  write the anchor can plant control bytes in them. */
export function readAnchor(projectRoot: string): AnchorState | null {
  try {
    const raw = JSON.parse(readFileSync(anchorPath(projectRoot), 'utf-8')) as Partial<AnchorState>;
    // Unknown future versions read as unanchored rather than being coerced
    // into v1 shape — the anchor's own honesty rule.
    if (raw.v !== ANCHOR_VERSION) return null;
    if (typeof raw.ledgerHead !== 'string' || !/^[0-9a-f]{64}$/.test(raw.ledgerHead)) return null;
    return {
      v: ANCHOR_VERSION,
      ledgerHead: raw.ledgerHead,
      mutations: typeof raw.mutations === 'number' ? raw.mutations : 0,
      seqHi:
        typeof raw.seqHi === 'number' && Number.isFinite(raw.seqHi) && raw.seqHi >= 0
          ? raw.seqHi
          : undefined,
      updatedAt: typeof raw.updatedAt === 'string' ? termSafe(raw.updatedAt).slice(0, 64) : '',
      updatedBy: typeof raw.updatedBy === 'string' ? termSafe(raw.updatedBy).slice(0, 64) : '',
    };
  } catch {
    return null;
  }
}

/** Write the anchor atomically with tight permissions (0600, 0700 dirs).
 *  Best-effort: a failure is reported by return value, never a throw — the
 *  ledger itself stays the operative record; without an anchor there is
 *  simply nothing to verify against yet. `seqHi` is the audit high-water the
 *  caller witnessed AFTER the operation's audit line landed (the recorded
 *  mutations run audit-then-anchor for exactly this reason). */
export function writeAnchor(projectRoot: string, ledgerHead: string, mutations: number, seqHi: number): boolean {
  try {
    const dir = anchorDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      chmodSync(dir, 0o700); // pin the dir every time — a pre-existing loose-perm dir must not stay loose
    } catch {
      /* non-fatal: the write still lands */
    }
    const state: AnchorState = {
      v: ANCHOR_VERSION,
      ledgerHead,
      mutations,
      seqHi,
      updatedAt: new Date().toISOString(),
      updatedBy: process.env.USER || process.env.LOGNAME || 'unknown',
    };
    const path = anchorPath(projectRoot);
    const tmp = `${path}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try {
      chmodSync(tmp, 0o600); // pin against umask
    } catch {
      /* non-fatal */
    }
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export type LedgerIntegrity = 'ok' | 'unanchored' | 'mismatch';

export interface Verification {
  state: LedgerIntegrity;
  /** Operator-facing explanation, set for every non-ok state. */
  detail: string;
}

/**
 * Verify the on-disk ledger against the anchor. 'unanchored' is not a
 * failure — it is the pre-bootstrap state (existing ledgers predate the
 * anchor; the first recorded mutation anchors them). 'mismatch' is the
 * tamper signal: something changed the ledger outside a recorded consent
 * operation.
 */
export function verifyLedger(projectRoot: string, onDiskHead: string): Verification {
  const anchor = readAnchor(projectRoot);
  if (!anchor) {
    return {
      state: 'unanchored',
      detail: 'ledger not yet anchored — the first grant/renew/revoke records the trust anchor',
    };
  }
  if (anchor.ledgerHead === onDiskHead) return { state: 'ok', detail: '' };
  return {
    state: 'mismatch',
    detail: `ledger does not match its trust anchor (anchored ${anchor.updatedAt} by ${anchor.updatedBy}) — it was changed outside a recorded consent operation`,
  };
}
