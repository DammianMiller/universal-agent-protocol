/**
 * `uap sandbox -- <command...>` — run a command with ONLY the current working
 * directory (plus a small scratch/state allow-list) writable. The whole host is
 * mounted read-only via bubblewrap, with writable "holes" for the workdir + /tmp
 * + client/uap state, so a write/mkdir anywhere else fails with EROFS/EACCES at
 * the KERNEL — for Write/Edit tools, Bash, and any subprocess alike.
 *
 * This is the workdir boundary that `--dangerously-skip-permissions` cannot
 * bypass: the client can't escape the mount namespace.
 *
 * Bridge Phase 4 adds two authorities on top of that floor:
 *
 * - Per-session GRANTS (`uap sandbox grant`, D2): extra writable holes
 *   recorded in a consent ledger (session-scoped, TTL-bounded, reason-
 *   stated, audit-logged). The pre-P4 answer, `UAP_SANDBOX_ALLOW=path:path`,
 *   still works but is UNRECORDED authority — it is honored for backwards
 *   compatibility and named as unrecorded in the audit and the banner.
 *
 * - The NETWORK EGRESS BOUNDARY (`--net off`, D1): the sandbox gets its own
 *   network namespace (--unshare-net) and NOTHING is brought up — no TCP,
 *   no DNS, no loopback, no egress of any kind, at the kernel. This is the
 *   complete boundary, for untrusted code, evals, and data-only work; model
 *   access is impossible by design (a harness that needs the model will fail
 *   loudly with connection refused).
 *
 *   Why there is no "--net proxy" (netns cut with a single hole to the
 *   proxy): rootless Linux cannot express it. AF_UNIX pathname sockets are
 *   NETWORK-NAMESPACE-SCOPED — a socket bind-mounted across the netns wall
 *   is unreachable (empirically ECONNREFUSED, see ADR 0011), bwrap closes
 *   every inherited fd (so no SCM_RIGHTS broker), and the userspace network
 *   helpers (pasta/slirp4netns) provide no outbound port allowlist. A
 *   boundary that only works when the right helper is present would be a
 *   suggestion, not enforcement — so the shipped modes are the two REAL
 *   ones: shared (no claim) and off (kernel-complete). The proxy's own
 *   PROXY_SOCKET (0600 AF_UNIX) remains the model-path choke point for
 *   every non-sandboxed surface; `uap proxy connect` re-serves it on local
 *   TCP for clients that cannot speak AF_UNIX.
 *
 * Env:
 *   UAP_SANDBOX_WORKDIR   workdir to make writable (default: cwd)
 *   UAP_SANDBOX_ALLOW     extra writable paths, colon-separated (UNRECORDED)
 *   UAP_SANDBOX_NET       'off' to default the net mode (shared otherwise)
 *   UAP_SANDBOX_GRANTS    pins the grant ledger file (tests, odd layouts)
 *   UAP_SANDBOX_AUDIT     pins the audit JSONL file (tests, odd layouts)
 *   UAP_SANDBOX_GRANTS_OFF=1  resolve zero grants (escape hatch; the sandbox itself stays)
 *   UAP_SANDBOX_OFF=1     bypass the sandbox entirely (run the command as-is)
 */

import { spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import {
  grantAuthority,
  listAuthority,
  resolveSessionGrants,
  revokeAuthority,
  auditSandboxUse,
  sandboxGrantsPath,
  sandboxAuditPath,
  verifyLedgerIntegrity,
  type GrantInput,
  type ResolvedGrants,
} from '../policies/sandbox-grants.js';

function fail(msg: string, code = 2): never {
  console.error(`uap sandbox: ${msg}`);
  process.exit(code);
}

function hasBwrap(): boolean {
  const r = spawnSync('bwrap', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// ---------------------------------------------------------------------------
// Pure planner — unit-testable without bubblewrap.
// ---------------------------------------------------------------------------

export type SandboxNetMode = 'shared' | 'off';

export interface SandboxPlanInput {
  /** Command to run inside the sandbox. */
  command: string[];
  /** Session id (scopes the grant lookup; empty = no grants). */
  session?: string;
  /** Net mode: 'shared' (default) or 'off' (the kernel egress boundary).
   *  Undefined = fall back to `envNet`. */
  net?: SandboxNetMode;
  /** Writable workdir. */
  workdir: string;
  /** $HOME inside the sandbox. */
  home: string;
  /** Legacy unrecorded extra writable paths (UAP_SANDBOX_ALLOW, split). */
  legacyAllow: string[];
  /** Session-resolved grants (empty when the ledger is off/unreadable). */
  grants: ResolvedGrants;
  /** $UAP_SANDBOX_NET — the env default for the net mode (planner stays
   *  input-only: the CALLER resolves process.env, so the plan is a pure
   *  function of its inputs and unit tests need no env plumbing). */
  envNet?: string;
  /** $ANTHROPIC_CUSTOM_HEADERS — appended to, never clobbered. */
  existingCustomHeaders?: string;
  /** The grant-ledger file and audit JSONL, ro-bound into the namespace so
   *  a sandboxed agent can neither plant rows nor forge audit lines (a
   *  bind-mounted file cannot be unlinked or replaced inside the ns).
   *  Resolved by the CALLER (they honor the env overrides). P4 security
   *  review: without this, the consent store lives inside the writable
   *  hole and consent is forgeable by the very thing it guards against. */
  grantsLedgerPath?: string;
  auditLogPath?: string;
}

export interface SandboxPlan {
  /** Full bwrap argv (bwrap args first, then the inner command). */
  argv: string[];
  /** The command bwrap execs (argv tail) — the session command, verbatim. */
  inner: string[];
  /** Extra env delivered via --setenv. */
  setenv: Record<string, string>;
  /** The net mode actually engaged ('off' = kernel egress boundary). */
  netMode: SandboxNetMode;
  /** Granted writable holes actually opened for this run. */
  grantedPaths: string[];
  /** Human-readable lines for the launch banner (colored at the print site). */
  notes: string[];
}

function planError(msg: string): { error: string; plan?: undefined } {
  return { error: msg };
}

/** Compute the bwrap invocation. Pure: a function of its inputs only — the
 *  CALLER resolves process.env into `envNet`/`existingCustomHeaders`. */
export function planSandbox(input: SandboxPlanInput): { plan?: SandboxPlan; error?: string } {
  const workdir = input.workdir;
  // Guard: never sandbox with an over-broad workdir — it would expose the tree.
  if (workdir === input.home || workdir === '/' || workdir === '/home') {
    return planError(`refusing to sandbox with workdir='${workdir}' (too broad)`);
  }
  const netMode: SandboxNetMode =
    input.net === 'off' || input.net === 'shared'
      ? input.net
      : input.envNet === 'off'
        ? 'off'
        : 'shared';

  // Read-only root with writable "holes".
  const args: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/run',
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
  ];
  if (netMode === 'off') {
    // The egress boundary: a network namespace with NOTHING brought up —
    // not even loopback. Any connect() fails at the kernel.
    args.push('--unshare-net');
  }
  // writable holes:
  args.push('--bind', workdir, workdir, '--bind', '/tmp', '/tmp', '--tmpfs', '/var/tmp');
  for (const rel of ['.claude', '.cache', '.npm']) {
    const p = join(input.home, rel);
    if (existsSync(p)) args.push('--bind', p, p);
  }
  const grantedPaths: string[] = [];
  const boundPaths = new Set<string>([workdir, '/tmp']);
  for (const p of input.grants.paths) {
    // TOCTOU (security review): the row's path was realpath-validated at
    // LOAD; a concurrent writer could swap it for a symlink in the
    // load→exec window. Resolve AGAIN at plan time, re-check breadth on the
    // RESOLVED value, and bind what the resolution says — not the row's
    // word for it. (A microsecond window remains between this resolution
    // and bwrap's own; documented as residual in ADR 0011.)
    let resolved: string;
    try {
      resolved = realpathSync(p);
    } catch {
      continue; // vanished between load and plan — open nothing
    }
    if (resolved === '/' || resolved === '/home' || resolved === input.home) continue;
    grantedPaths.push(resolved);
    boundPaths.add(resolved);
    args.push('--bind', resolved, resolved);
  }
  const refusedLegacy: string[] = [];
  for (const p of input.legacyAllow) {
    // The legacy env is UNRECORDED authority — that is the whole complaint
    // — so it gets the SAME plan-time re-check recorded grants get
    // : resolve at plan time, refuse over-broad resolutions,
    // bind what the resolution says. An env var in a shell history is not
    // consent, and unrecorded must not mean unchecked.
    if (!p) continue;
    let resolved: string;
    try {
      resolved = realpathSync(p);
    } catch {
      continue; // nonexistent entries stay inert, as before
    }
    if (resolved === '/' || resolved === '/home' || resolved === input.home) {
      refusedLegacy.push(`${p} → ${resolved}`);
      continue;
    }
    if (boundPaths.has(resolved)) continue; // already a writable hole; no dup binds
    boundPaths.add(resolved);
    args.push('--bind', resolved, resolved);
  }
  // The consent store must be TAMPER-PROOF from the untrusted side: ro-bind
  // the ledger and audit files over their host paths so a sandboxed agent
  // can neither plant grant rows nor forge audit lines (security review
  // — a planted well-formed `paths:["/etc"]` row opened the hole for real).
  // A bind-mounted file cannot be unlinked or replaced inside the namespace;
  // a MISSING file gets /dev/null bound at its path so planting one is
  // equally impossible (it reads empty and refuses writes).
  for (const target of [input.grantsLedgerPath, input.auditLogPath]) {
    if (!target) continue;
    args.push('--ro-bind', existsSync(target) ? target : '/dev/null', target);
  }

  const setenv: Record<string, string> = {
    HOME: input.home,
    UAP_SANDBOX_ACTIVE: '1',
  };
  if (input.session) setenv.UAP_SESSION_ID = input.session;

  const notes: string[] = [];
  if (netMode === 'off') {
    notes.push('net: OFF (kernel egress boundary — no network at all, not even loopback; model access impossible by design)');
  } else {
    notes.push('net: shared (the sandbox has normal network)');
  }
  if (grantedPaths.length > 0) notes.push(`granted holes: ${grantedPaths.join(', ')}`);
  if (input.grants.paths.length > 0 && grantedPaths.length !== input.grants.paths.length) {
    notes.push('(some granted paths were not opened: no longer present, or their plan-time resolution is over-broad)');
  }
  if (refusedLegacy.length > 0) {
    notes.push(
      `refused over-broad UAP_SANDBOX_ALLOW entries: ${refusedLegacy.join(', ')} — /, /home, and $HOME are never writable holes`,
    );
  }
  if (input.legacyAllow.filter(Boolean).length > 0) {
    notes.push(`UNRECORDED allow (legacy env, consider 'uap sandbox grant'): ${input.legacyAllow.join(':')}`);
  }

  const argv = [...args];
  for (const [k, v] of Object.entries(setenv)) {
    argv.push('--setenv', k, v);
  }
  // Tell the proxy this session is sandboxed so it can strip MCP tools the
  // bubblewrap sandbox can't reach (the claude-in-chrome browser extension
  // socket is unreachable here — offering browser_batch guarantees dead-end
  // loops). Claude Code forwards ANTHROPIC_CUSTOM_HEADERS verbatim to its
  // endpoint; append rather than clobber any pre-existing value.
  const customHeaders = sandboxCustomHeaders(input.existingCustomHeaders);
  argv.push('--setenv', 'ANTHROPIC_CUSTOM_HEADERS', customHeaders);
  argv.push('--chdir', workdir, ...input.command);

  return {
    plan: {
      argv,
      inner: input.command,
      setenv: { ...setenv, ANTHROPIC_CUSTOM_HEADERS: customHeaders },
      netMode,
      grantedPaths,
      notes,
    },
  };
}

/**
 * Build the ANTHROPIC_CUSTOM_HEADERS value for a sandboxed session: append the
 * `X-Uap-Sandbox: 1` marker (which the proxy uses to strip sandbox-unreachable
 * MCP tools) to any pre-existing headers rather than clobbering them. Claude
 * Code forwards this env var verbatim to its endpoint as HTTP headers
 * (newline-separated "Name: Value" pairs).
 */
export function sandboxCustomHeaders(existing: string | undefined): string {
  const marker = 'X-Uap-Sandbox: 1';
  const prior = existing?.trim();
  if (!prior) return marker;
  // Idempotent: don't duplicate the marker (nested sandbox, or user pre-set it).
  const already = prior
    .split('\n')
    .some((h) => h.trim().toLowerCase() === marker.toLowerCase());
  return already ? prior : `${prior}\n${marker}`;
}

// ---------------------------------------------------------------------------
// Grant verbs (D2).
// ---------------------------------------------------------------------------

const GRANT_VERBS = new Set(['grant', 'grants', 'revoke']);

/**
 * Should `command[0]` be dispatched as a ledger verb? Only when the
 * invocation did NOT use the `--` separator: `uap sandbox -- revoke …` means
 * the operator wants to run a BINARY named `revoke`, and a positional
 * intercept that cannot be escaped would shadow legitimate commands (P4
 * review finding). Exposed for the CLI-surface tests.
 */
export function shouldDispatchGrantVerb(command: string[], argv: string[] = process.argv): boolean {
  if (!command.length || !GRANT_VERBS.has(command[0])) return false;
  return !argv.slice(2).includes('--');
}

function grantsDisabled(): boolean {
  const v = process.env.UAP_SANDBOX_GRANTS_OFF;
  return v === '1' || v === 'true' || v === 'yes';
}

function resolveSessionGrantsSafe(projectRoot: string, session: string): ResolvedGrants {
  const none: ResolvedGrants = { grants: [], paths: [] };
  if (!session || grantsDisabled()) return none;
  try {
    return resolveSessionGrants(projectRoot, session);
  } catch (err) {
    console.warn(
      `[sandbox] grant resolution failed (continuing with NO granted holes): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return none;
  }
}

async function grantVerb(args: string[], options: Record<string, unknown>): Promise<void> {
  const verb = args[0];
  const projectRoot = process.cwd();
  if ((verb === 'grant' || verb === 'revoke') && process.env.UAP_SANDBOX_ACTIVE === '1') {
    // Consent cannot come from the thing being guarded (P4 security
    // review): UAP_SANDBOX_ACTIVE is set by the sandbox itself, on the
    // UNTRUSTED side, so a shell inside a sandbox must not be able to
    // write new authority or remove the operator's. Listing stays
    // available (read-only — the agent can see what it was granted).
    fail('refusing to grant/revoke from inside a sandbox — consent must come from the operator (run it outside the sandbox)');
  }
  if (verb === 'grant') {
    const paths = args.slice(1);
    const input: GrantInput = {
      sessionId: String(options.session || process.env.UAP_SESSION_ID || process.env.CLAUDE_SESSION_ID || ''),
      paths,
      reason: String(options.reason || ''),
      ttlSecs: options.ttl === undefined ? undefined : Number(options.ttl),
    };
    const r = grantAuthority(projectRoot, input);
    if (!r.ok) fail(r.error);
    console.log(
      chalk.green(`✓ grant ${r.grant.id}`) +
        ` — session '${r.grant.sessionId}' may write:\n  ${r.grant.paths.join('\n  ')}` +
        chalk.dim(`\n  reason: ${r.grant.reason}\n  expires: ${r.grant.expiresAt} (granted by ${r.grant.grantedBy})`),
    );
    return;
  }
  if (verb === 'grants') {
    const sid = String(options.session || '');
    // Tamper evidence (ADR 0011 anchor): the listing is the inspection
    // surface, so the integrity verdict is stated here — on the human path
    // as a red banner, on --json via stderr so the data stays pure.
    const integrity = verifyLedgerIntegrity(projectRoot);
    if (integrity.state === 'mismatch') {
      const msg = `ledger INTEGRITY MISMATCH — ${integrity.detail}. Treat every listed row as unverified.`;
      if (options.json) console.error(`[sandbox] ${msg}`);
      else console.log(chalk.red(`⚠ ${msg}`));
    } else if (integrity.state === 'unanchored' && !options.json) {
      console.log(chalk.dim(`ℹ ${integrity.detail}`));
    }
    const all = listAuthority(projectRoot, sid || undefined);
    if (options.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    if (all.length === 0) {
      console.log(sid ? `No active grants for session '${sid}'.` : 'No active grants.');
      return;
    }
    for (const g of all) {
      console.log(
        `${chalk.green(g.id)} session '${g.sessionId}' expires ${g.expiresAt}` +
          `\n  ${g.paths.join('\n  ')}` +
          chalk.dim(`\n  reason: ${g.reason} (granted by ${g.grantedBy})`),
      );
    }
    return;
  }
  if (verb === 'revoke') {
    const id = args[1];
    if (!id) fail('usage: uap sandbox revoke <grantId>');
    if (!revokeAuthority(projectRoot, id)) {
      // Not found, or the ledger refused to persist the removal — either way
      // the grant may still be ACTIVE, so the refusal must not sound like
      // "nothing to do" (the persist failure already warned above).
      fail(`could not revoke '${id}' — it is not in the ledger, or the ledger failed to persist the removal`);
    }
    console.log(chalk.green(`✓ revoked ${id}`));
    return;
  }
  fail(`unknown sandbox grant verb '${verb}' (grant | grants | revoke)`);
}

// ---------------------------------------------------------------------------
// Command entry.
// ---------------------------------------------------------------------------

export async function sandboxCommand(command: string[], options: Record<string, unknown> = {}): Promise<void> {
  // Belt-and-braces: commander v12 strips the `--` separator itself (the
  // marker never reaches command[]), but older parsers and hand-built
  // invocations (tests) may pass it through — strip if it survived.
  if (command[0] === '--') command = command.slice(1);

  if (process.env.UAP_SANDBOX_OFF === '1') {
    if (command.length === 0) fail('no command given');
    const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
    process.exit(r.status ?? (r.error ? 127 : 0));
  }

  // Grant verbs are ledger operations, not sandbox runs — but only when the
  // invocation did NOT use the `--` separator (see shouldDispatchGrantVerb).
  if (shouldDispatchGrantVerb(command)) {
    await grantVerb(command, options);
    return;
  }

  if (command.length === 0) {
    fail(
      'no command given. Usage: uap sandbox [--session <id>] [--net shared|off] -- <command> [args...]; ' +
        `authority: uap sandbox grant <path...> --session <id> --reason "..." | grants | revoke <id>`,
    );
  }
  if (!hasBwrap()) {
    fail(
      'bwrap (bubblewrap) not found — refusing to run unsandboxed. ' +
        'Install bubblewrap, or set UAP_SANDBOX_OFF=1 to override.',
      127,
    );
  }

  const home = process.env.HOME || homedir();
  let workdir: string;
  try {
    workdir = realpathSync(process.env.UAP_SANDBOX_WORKDIR || process.cwd());
  } catch {
    workdir = process.env.UAP_SANDBOX_WORKDIR || process.cwd();
  }

  const session = String(options.session || process.env.UAP_SESSION_ID || process.env.CLAUDE_SESSION_ID || '');
  const rawNet = options.net;
  if (rawNet !== undefined && rawNet !== 'off' && rawNet !== 'shared') {
    // Loud, not silent: an unknown --net value (e.g. the documented-then-cut
    // 'proxy') silently downgrading to full network would be the exact hole
    // the boundary exists to close.
    fail(`unknown --net mode '${String(rawNet)}' (shared | off)`);
  }
  const netOpt: SandboxNetMode | undefined = rawNet === 'off' ? 'off' : rawNet === 'shared' ? 'shared' : undefined;
  // The env default is validated exactly like the flag (security review):
  // 'OFF', 'off ', '0ff' silently meaning FULL network is the exact hole
  // the boundary exists to close. Whitespace is trimmed (shell quirks),
  // anything else fails loud.
  const envNet = process.env.UAP_SANDBOX_NET?.trim();
  if (envNet && envNet !== 'shared' && envNet !== 'off') {
    fail(`unknown UAP_SANDBOX_NET value '${envNet}' (shared | off)`);
  }
  const legacyAllow = (process.env.UAP_SANDBOX_ALLOW || '').split(':');
  const grants = resolveSessionGrantsSafe(process.cwd(), session);

  const planned = planSandbox({
    command,
    session: session || undefined,
    net: netOpt,
    workdir,
    home,
    legacyAllow,
    grants,
    envNet,
    existingCustomHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS,
    // Ro-bound into the namespace by the planner: the consent store must be
    // untouchable from the sandboxed side (security review finding 1).
    grantsLedgerPath: sandboxGrantsPath(process.cwd()),
    auditLogPath: sandboxAuditPath(process.cwd()),
  });
  if (planned.error) fail(planned.error);
  const plan = planned.plan!;

  // The consent record: who granted, what was actually OPENED (not merely
  // resolved — a granted path that no longer exists opens nothing and must
  // not be recorded as authority exercised), what ran unrecorded, and the
  // net boundary actually engaged.
  const openedGrants = grants.grants.filter((g) => g.paths.some((p) => plan.grantedPaths.includes(p)));
  auditSandboxUse(
    process.cwd(),
    session,
    { grants: openedGrants, paths: plan.grantedPaths },
    legacyAllow.filter(Boolean),
    plan.netMode,
  );

  console.error(chalk.dim(`uap sandbox: workdir ${workdir} (writable); everything else is EROFS`));
  for (const n of plan.notes) console.error(chalk.dim(`  ${n}`));
  if (grantsDisabled()) console.error(chalk.dim('  grants: ledger off (UAP_SANDBOX_GRANTS_OFF=1)'));
  if (!session) {
    console.error(
      chalk.dim('  grants: none (no --session; grant one with: uap sandbox grant <path> --session <id> --reason "...")'),
    );
  }

  const r = spawnSync('bwrap', plan.argv, { stdio: 'inherit' });
  if (r.error) fail(`failed to launch bwrap: ${r.error.message}`, 127);
  process.exit(r.status ?? 1);
}
