/**
 * `uap sandbox -- <command...>` — run a command with ONLY the current working
 * directory (plus a small scratch/state allow-list) writable. The whole host is
 * mounted read-only via bubblewrap, with writable "holes" for the workdir + /tmp
 * + client/uap state, so a write/mkdir anywhere else fails with EROFS/EACCES at
 * the KERNEL — for Write/Edit tools, Bash, and any subprocess alike.
 *
 * This is the workdir boundary that `--dangerously-skip-permissions` cannot
 * bypass: the client can't escape the mount namespace. Network is shared so the
 * agent still reaches the local proxy (127.0.0.1:4000).
 *
 * Env:
 *   UAP_SANDBOX_WORKDIR   workdir to make writable (default: cwd)
 *   UAP_SANDBOX_ALLOW     extra writable paths, colon-separated
 *   UAP_SANDBOX_OFF=1     bypass the sandbox entirely (run the command as-is)
 */

import { spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

function fail(msg: string, code = 2): never {
  console.error(`uap sandbox: ${msg}`);
  process.exit(code);
}

function hasBwrap(): boolean {
  const r = spawnSync('bwrap', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

export async function sandboxCommand(command: string[]): Promise<void> {
  // Strip a leading '--' separator if commander passed it through.
  if (command[0] === '--') command = command.slice(1);

  if (process.env.UAP_SANDBOX_OFF === '1') {
    if (command.length === 0) fail('no command given');
    const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
    process.exit(r.status ?? (r.error ? 127 : 0));
  }

  if (command.length === 0) {
    fail('no command given. Usage: uap sandbox -- <command> [args...]');
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

  // Guard: never sandbox with an over-broad workdir — it would expose the tree.
  if (workdir === home || workdir === '/' || workdir === '/home') {
    fail(`refusing to sandbox with workdir='${workdir}' (too broad)`);
  }

  // Read-only root with writable "holes".
  const args: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/run',
    '--die-with-parent',
    '--unshare-pid',
    '--new-session',
    // writable holes:
    '--bind', workdir, workdir,
    '--bind', '/tmp', '/tmp',
    '--tmpfs', '/var/tmp',
  ];
  for (const rel of ['.claude', '.cache', '.npm']) {
    const p = join(home, rel);
    if (existsSync(p)) args.push('--bind', p, p);
  }
  for (const p of (process.env.UAP_SANDBOX_ALLOW || '').split(':')) {
    if (p && existsSync(p)) args.push('--bind', p, p);
  }
  // Tell the proxy this session is sandboxed so it can strip MCP tools the
  // bubblewrap sandbox can't reach (the claude-in-chrome browser extension
  // socket is unreachable here — offering browser_batch guarantees dead-end
  // loops). Claude Code forwards ANTHROPIC_CUSTOM_HEADERS verbatim to its
  // endpoint; append rather than clobber any pre-existing value.
  const customHeaders = sandboxCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS);
  args.push(
    '--setenv', 'HOME', home,
    '--setenv', 'UAP_SANDBOX_ACTIVE', '1',
    '--setenv', 'ANTHROPIC_CUSTOM_HEADERS', customHeaders,
    '--chdir', workdir,
  );

  const r = spawnSync('bwrap', [...args, ...command], { stdio: 'inherit' });
  if (r.error) fail(`failed to launch bwrap: ${r.error.message}`, 127);
  process.exit(r.status ?? 1);
}
