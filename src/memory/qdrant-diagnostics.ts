/**
 * Qdrant container diagnostics (2026-11-21): `uap memory status` printed the
 * raw docker status line ("Restarting (101) 32 seconds ago") with no cause and
 * no remediation while the container was panic-looping on a poisoned shard
 * WAL — every restart re-opened the same WAL, panicked, and looped forever.
 * This module turns that string into a diagnosis: the container state, the
 * panic line from the logs, and — when the panic matches a known fix — the
 * exact remediation steps with the concrete paths parsed out of the panic
 * itself.
 *
 * The docker IO (ps/logs/inspect) is a best-effort thin shell; everything
 * downstream of the raw strings is pure and unit-tested. This is the same
 * known-fix-table pattern the proxy uses for LOCKSTEP_CLASS_FIXES: honest
 * failure classes with the fix attached, not a silent red badge.
 */
import { execSync } from 'node:child_process';

export type QdrantContainerState = 'up' | 'restarting' | 'exited' | 'absent' | 'unavailable';

export interface QdrantKnownFix {
  label: string;
  steps: string[];
}

export interface QdrantContainerDiagnostic {
  state: QdrantContainerState;
  /** Raw `docker ps` status line, shown to the operator as-is. */
  statusLine: string;
  exitCode?: number;
  /** Last ERROR/panic line from the container logs, when the state is not up. */
  panicLine?: string;
  /** The in-container path the panic names (e.g. collections/agent_memory/0). */
  panicPath?: string;
  knownFix?: QdrantKnownFix;
}

/** Run a docker query; ok:false means docker could not be asked at all. */
function runOr(cmd: string): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(),
    };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Parse a `docker ps` status line. `absent` means no container matched;
 * `unavailable` means docker itself could not be asked (or answered in a
 * format we do not recognize — the raw line is preserved either way).
 */
export function parseDockerStatus(raw: string): {
  state: QdrantContainerState;
  exitCode?: number;
  statusLine: string;
} {
  const statusLine = raw.trim();
  if (!statusLine) return { state: 'absent', statusLine };
  const restarting = /^Restarting \((\d+)\)/.exec(statusLine);
  if (restarting) return { state: 'restarting', exitCode: Number(restarting[1]), statusLine };
  const exited = /^Exited \((\d+)\)/.exec(statusLine);
  if (exited) return { state: 'exited', exitCode: Number(exited[1]), statusLine };
  if (/^Up /.test(statusLine)) return { state: 'up', statusLine };
  return { state: 'unavailable', statusLine };
}

/** The last ERROR/panic line of a docker log dump, if there is one. Pure. */
export function extractPanicLine(logs: string): string | undefined {
  const hits = logs.split('\n').filter((l) => /panic|ERROR/i.test(l.trim()));
  return hits.length > 0 ? hits[hits.length - 1].trim() : undefined;
}

/**
 * The collection/shard path a Qdrant panic names, normalized to the form it
 * holds INSIDE the storage mount ("./storage/collections/x/0" →
 * "collections/x/0"). Pure.
 */
export function parsePanicPath(panicLine: string): string | undefined {
  const m = /(?:^|[\s"'])\.?\/?(?:qdrant\/)?storage\/(\S+?)(?=["'\s]|$)/.exec(panicLine);
  return m ? m[1].replace(/["',]+$/, '') : undefined;
}

interface KnownFixEntry {
  match: RegExp;
  label: string;
  stepsFor: (panicPath: string | undefined) => string[];
}

/**
 * The known-fix table. Each entry is an error signature observed live with
 * its verified remediation; the steps are concrete commands an operator can
 * run, with the panic's own path substituted in when it parsed.
 */
const KNOWN_FIXES: KnownFixEntry[] = [
  {
    // Seen live 2026-11-21: "Can't init WAL: Kind(WouldBlock)" loading
    // ./storage/collections/agent_memory/0 — a stale "open" WAL segment (two
    // open-* files from different crashes) poisoned the shard, and every
    // restart re-panicked on it (exit 101, forever). Verified fix: clear the
    // WAL contents AND recreate the directory empty — Qdrant panics on the
    // wal path being absent too (kind: NotFound), so a bare rm -rf of the
    // dir just trades one panic for another (both falsified live).
    // NOTE: /healthz answers during each startup phase BEFORE the shard
    // loads, so it is NOT sufficient verification for this class — the
    // /collections/<name> endpoint (or a stable Up) is.
    match: /Can'?t init WAL|Wal error/i,
    label: 'poisoned shard WAL — the container re-panics on it at every start',
    stepsFor: (p) => {
      const shard = p ?? 'collections/<collection>/<shard>';
      return [
        'docker stop uap-qdrant',
        '# Back the shard up first if the collection holds irreplaceable data',
        '# (the WAL holds only un-flushed writes; committed points live in segments):',
        'rm -rf <qdrant-storage>/' + shard + '/wal   # then recreate it EMPTY:',
        'mkdir -p <qdrant-storage>/' + shard + '/wal',
        'docker start uap-qdrant',
        'curl -fsS localhost:6333/collections/<collection>   # status must be green',
      ];
    },
  },
];

/** Match a panic line against the known-fix table. Pure. */
export function matchKnownFix(panicLine: string): QdrantKnownFix | undefined {
  for (const entry of KNOWN_FIXES) {
    if (entry.match.test(panicLine)) {
      return { label: entry.label, steps: entry.stepsFor(parsePanicPath(panicLine)) };
    }
  }
  return undefined;
}

/**
 * Inspect the machine's Qdrant container: one best-effort pass over docker
 * ps/logs. Never throws — an unanswerable question is a diagnostic with
 * state 'unavailable', not a broken status command.
 */
export function inspectQdrantContainer(): QdrantContainerDiagnostic {
  // Docker unanswerable (binary missing, daemon down) is NOT "no container":
  // the status line must say docker itself is unavailable.
  const names = runOr('docker ps -a --filter name=qdrant --format "{{.Names}}"');
  if (!names.ok) return { state: 'unavailable', statusLine: '' };
  if (!names.out) return { state: 'absent', statusLine: '' };
  const container = names.out.split('\n')[0];
  const statusLine = runOr(`docker ps -a --filter name=${container} --format "{{.Status}}"`);
  if (!statusLine.ok) return { state: 'unavailable', statusLine: '' };
  const parsed = parseDockerStatus(statusLine.out);
  if (parsed.state === 'up' || parsed.state === 'absent') {
    return { ...parsed };
  }
  const logs = runOr(`docker logs --tail 60 ${container} 2>&1`);
  const panicLine = logs.ok ? extractPanicLine(logs.out) : undefined;
  return {
    ...parsed,
    panicLine,
    panicPath: panicLine ? parsePanicPath(panicLine) : undefined,
    knownFix: panicLine ? matchKnownFix(panicLine) : undefined,
  };
}
