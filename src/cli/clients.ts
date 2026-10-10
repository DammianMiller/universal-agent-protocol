/**
 * `uap clients` — the fleet registry CLI.
 *
 * Terminal twin of the dashboard's Clients tab: list discovered client
 * folders with live summaries, pin/remove manual entries in
 * `~/.uap/clients.json`, and show what auto-scan finds. The registry feeds
 * both this command and the `GET /api/clients` route behind the tab.
 */
import { resolve } from 'path';
import {
  addManualClient,
  getClientSummaries,
  listClients,
  registryFilePath,
  removeManualClient,
  scanRootFor,
  stopClientDashboard,
} from '../dashboard/client-registry.js';

export interface ClientsOptions {
  name?: string;
  port?: string;
}

function pad(s: string, n: number): string {
  return (s + ' '.repeat(n)).slice(0, Math.max(n, s.length + 1));
}

export async function clientsCommand(
  action: string,
  pathArg: string | undefined,
  options: ClientsOptions = {}
): Promise<void> {
  const hostCwd = process.cwd();
  try {
    await dispatch(action, pathArg, options, hostCwd);
  } catch (e) {
    // Registry/stop rejections are operator errors ('client not in registry',
    // 'not a directory'), not stack traces.
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

async function dispatch(
  action: string,
  pathArg: string | undefined,
  options: ClientsOptions,
  hostCwd: string
): Promise<void> {
  switch (action) {
    case 'list':
      await listCmd(hostCwd);
      break;
    case 'add':
      addCmd(hostCwd, pathArg, options);
      break;
    case 'remove':
      removeCmd(pathArg);
      break;
    case 'scan':
      scanCmd(hostCwd);
      break;
    case 'stop':
      await stopCmd(hostCwd, pathArg);
      break;
    default:
      console.log(`Usage: uap clients <list|add|remove|scan|stop>

  list    Fleet summary for every discovered client (live reads: deliver
          runs, task queue, git, dashboard health probe)
  add     Pin a client folder manually: uap clients add <path> [--name n] [--port p]
  remove  Unpin a manually added client: uap clients remove <path>
  scan    Show what auto-scan discovers (managed + unmanaged folders)
  stop    Stop a client's spawned dashboard: uap clients stop <path>

Registry: ${registryFilePath()}`);
      break;
  }
}

async function listCmd(hostCwd: string): Promise<void> {
  console.log(`Scan root: ${scanRootFor(hostCwd)}`);
  console.log(`Registry:  ${registryFilePath()}`);
  const clients = await getClientSummaries(hostCwd, 0);
  if (!clients.length) {
    console.log('No client folders discovered.');
    return;
  }
  console.log('');
  console.log(
    pad('CLIENT', 22) + pad('STATE', 16) + pad('BRANCH', 14) + pad('QUEUE', 24) + pad('DELIVER', 24) + 'DASH'
  );
  for (const c of clients) {
    const state = c.host ? 'this host' : c.managed ? (c.dashboardAlive ? 'up' : 'down') : 'unmanaged';
    const queue = `${c.tasks.inProgress} ip · ${c.tasks.open} open · ${c.tasks.blocked} blocked`;
    const deliver = `${c.deliver.running} run · ${c.deliver.interrupted} int · ${c.deliver.failed} fail`;
    // The CLI doesn't know which port the host dashboard is live on (only the
    // server does), so the host row never claims a probe result.
    const dash = c.host ? 'this' : c.dashboardAlive ? `:${c.port}` : '-';
    console.log(
      pad(c.name, 22) + pad(state, 16) + pad(c.branch === '?' ? '-' : c.branch, 14) + pad(queue, 24) + pad(deliver, 24) +
        dash + (c.degraded ? '  (degraded)' : '')
    );
  }
  console.log('');
  console.log(`Open a client's dashboard from the web UI Clients tab, or: uap dashboard serve (inside the client).`);
}

function addCmd(hostCwd: string, pathArg: string | undefined, options: ClientsOptions): void {
  if (!pathArg) {
    console.error('Usage: uap clients add <path> [--name <name>] [--port <port>]');
    process.exitCode = 1;
    return;
  }
  const port = options.port ? Number(options.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    console.error('--port must be an integer in 1024..65535');
    process.exitCode = 1;
    return;
  }
  const entry = addManualClient(hostCwd, resolve(pathArg), { name: options.name, port });
  console.log(`Pinned client "${entry.name}" (${entry.path})${entry.port ? ` — dashboard port ${entry.port}` : ''}`);
}

function removeCmd(pathArg: string | undefined): void {
  if (!pathArg) {
    console.error('Usage: uap clients remove <path>');
    process.exitCode = 1;
    return;
  }
  if (removeManualClient(resolve(pathArg))) {
    console.log(`Unpinned ${resolve(pathArg)}`);
  } else {
    console.log(`No manual entry for ${resolve(pathArg)} (auto-scanned folders need no removal — they drop out when the folder moves or a pattern ignores them).`);
  }
}

function scanCmd(hostCwd: string): void {
  const entries = listClients(hostCwd);
  const root = scanRootFor(hostCwd);
  console.log(`Scanning ${root}`);
  if (!entries.length) {
    console.log('Nothing found.');
    return;
  }
  for (const c of entries) {
    const tags = [c.host ? 'this host' : '', c.managed ? 'managed' : 'unmanaged', c.manual ? 'pinned' : 'scanned']
      .filter(Boolean)
      .join(', ');
    console.log(`  ${pad(c.name, 26)} ${tags}${c.port ? `  (port ${c.port})` : ''}`);
  }
  console.log(`\n${entries.filter((c) => c.manual).length} pinned, ${entries.filter((c) => !c.manual).length} scanned.`);
}

async function stopCmd(hostCwd: string, pathArg: string | undefined): Promise<void> {
  if (!pathArg) {
    console.error('Usage: uap clients stop <path>');
    process.exitCode = 1;
    return;
  }
  const res = await stopClientDashboard(hostCwd, resolve(pathArg));
  if (res.stopped) {
    console.log(`Stopped client dashboard on :${res.port}`);
  } else if (!res.wasAlive) {
    console.log('No live dashboard for that client.');
  } else {
    console.error(`Could not stop: ${res.reason}`);
    process.exitCode = 1;
  }
}
