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
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { SandboxGrant } from './sandbox-grants.js';

/** Anchor file version — future shape changes bump this and re-anchor. */
export const ANCHOR_VERSION = 1;

export interface AnchorState {
  v: number;
  /** sha256 of the sanitized ledger array as of the last recorded mutation. */
  ledgerHead: string;
  /** Monotonic count of recorded ledger mutations (context for the operator). */
  mutations: number;
  updatedAt: string;
  updatedBy: string;
}

/** The anchor dir: OUTSIDE the checkout's write reach by construction. */
export function anchorDir(): string {
  const pinned = process.env.UAP_SANDBOX_ANCHOR_DIR;
  if (pinned) return pinned;
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg || join(homedir(), '.local', 'state');
  return join(base, 'uap', 'sandbox-anchors');
}

/** One anchor per main-checkout root (keyed by its hash, never its literal
 *  path — the path can contain spaces/usernames that must not reach a
 *  filename). */
export function anchorPath(projectRoot: string): string {
  const key = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return join(anchorDir(), `${key}.json`);
}

/** The tamper-evidence hash of a ledger state: over the SANITIZED rows (the
 *  same shape the load path enforces), in stored order. */
export function ledgerHeadOf(grants: SandboxGrant[]): string {
  return createHash('sha256').update(JSON.stringify(grants)).digest('hex');
}

/** Read the anchor; null when absent or malformed (absent = unanchored). */
export function readAnchor(projectRoot: string): AnchorState | null {
  try {
    const raw = JSON.parse(readFileSync(anchorPath(projectRoot), 'utf-8')) as Partial<AnchorState>;
    if (typeof raw.ledgerHead !== 'string' || !/^[0-9a-f]{64}$/.test(raw.ledgerHead)) return null;
    return {
      v: ANCHOR_VERSION,
      ledgerHead: raw.ledgerHead,
      mutations: typeof raw.mutations === 'number' ? raw.mutations : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : '',
    };
  } catch {
    return null;
  }
}

/** Write the anchor atomically with tight permissions (0600, 0700 dirs).
 *  Best-effort: a failure is reported by return value, never a throw — the
 *  ledger itself stays the operative record; without an anchor there is
 *  simply nothing to verify against yet. */
export function writeAnchor(projectRoot: string, ledgerHead: string, mutations: number): boolean {
  try {
    const dir = anchorDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700); // mkdir mode is masked by umask; pin it
      } catch {
        /* non-fatal: the write still lands */
      }
    }
    const state: AnchorState = {
      v: ANCHOR_VERSION,
      ledgerHead,
      mutations,
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
