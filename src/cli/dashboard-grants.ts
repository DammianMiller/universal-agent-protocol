/**
 * The dashboard's Sandbox Grants section (the ADR 0011-named operator
 * surface: active authority per session, the trust-anchor verdict, and the
 * revoke command per grant).
 *
 * Split from src/cli/dashboard.ts: the dashboard module is the repo's worst
 * LOC offender, and new sections follow the export-for-test pattern — a
 * separate module keeps the render file
 * from growing with every surface and gives the tests a direct import.
 */

import { listAuthority, verifyLedgerIntegrity } from '../policies/sandbox-grants.js';

/** Humanize the remaining TTL of a grant (ISO expiry) for one glance. */
export function humanRemaining(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `~${Math.max(1, mins)}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `~${hours}h ${mins % 60}m left`;
  return `~${Math.floor(hours / 24)}d left`;
}

/**
 * The Sandbox Grants section as plain lines — active authority per session,
 * the trust-anchor verdict, and the revoke command per grant. The ADR
 * 0011-named surface ("a dashboard grants view... one click to revoke" — the
 * CLI's one click is the printed command). Pure w.r.t. projectRoot + the
 * env pins, so tests seed a ledger and call directly.
 * A line starting with ⚠ (after leading indent) is a warning the caller
 * colors red.
 */
export function sandboxGrantsLines(projectRoot: string, maxGrants = 6): { lines: string[]; mismatch: boolean } {
  const lines: string[] = [];
  const integrity = verifyLedgerIntegrity(projectRoot);
  const active = listAuthority(projectRoot);
  lines.push('Sandbox Grants (active authority)');
  if (active.length === 0) {
    lines.push('  no active grants — the default is least authority');
  } else {
    for (const g of active.slice(0, maxGrants)) {
      lines.push(
        `  ${g.id}  session '${g.sessionId}'  ${humanRemaining(g.expiresAt)}  (granted by ${g.grantedBy})`
      );
      lines.push(`    reason: ${g.reason}`);
      for (const p of g.paths.slice(0, 3)) lines.push(`      ${p}`);
      if (g.paths.length > 3) lines.push(`      … and ${g.paths.length - 3} more path(s)`);
      lines.push(`    revoke: uap sandbox revoke ${g.id}`);
    }
    if (active.length > maxGrants) lines.push(`  … and ${active.length - maxGrants} more grant(s)`);
  }
  if (integrity.state === 'ok') {
    lines.push('  ledger verified against its trust anchor');
  } else if (integrity.state === 'unanchored') {
    lines.push(`  ${integrity.detail}`);
  } else {
    lines.push(`  ⚠ INTEGRITY MISMATCH — ${integrity.detail}.`);
    lines.push('  ⚠ Rows above are listed but UNVERIFIED; a sandbox session opens ZERO grant-derived holes.');
  }
  return { lines, mismatch: integrity.state === 'mismatch' };
}
