/**
 * Dashboard Server
 *
 * Lightweight HTTP + WebSocket server for the web overlay.
 * Serves JSON data from getDashboardData() and pushes real-time updates.
 * Includes SSE endpoint for live event streaming.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';
import { getDashboardData } from './data-service.js';
import { seedDashboardData, cleanupSeeder } from './data-seeder.js';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { readEventsSince, readRecentEvents } from '../utils/telemetry-store.js';
import {
  handleTaskCreate, handleTaskUpdate, handleTaskClose, handleTaskDelete, handleTaskClaim,
  handleLedgerItem, handleLedgerReset, handleLedgerInit, handleOrchestratorToggle,
  handleAgentDeregister, handleAgentCleanStale,
  handleDeliverLaunch, handleDeliverCancel, handleDeliverResume,
} from './controls.js';

/**
 * Resolve the dashboard HTML file using multiple strategies.
 * Tries in order:
 *   1. Relative to this module's directory (works in-place and installed)
 *   2. Relative to import.meta.url via fileURLToPath (ESM-safe)
 *   3. Relative to process.cwd() (works when run from project root)
 *   4. Relative to package.json location (works for global/npx installs)
 */
function resolveDashboardHtml(): string | null {
  const candidates: string[] = [];

  // Strategy 1: import.meta.dirname (Node >= 21.2, always set for ESM)
  if (import.meta.dirname) {
    candidates.push(join(import.meta.dirname, '../../web/dashboard.html'));
  }

  // Strategy 2: import.meta.url -> fileURLToPath (works in all ESM Node versions)
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(thisDir, '../../web/dashboard.html'));
  } catch {
    // import.meta.url may not be a file:// URL in some bundlers
  }

  // Strategy 3: process.cwd() (works when invoked from project root)
  candidates.push(join(process.cwd(), 'web/dashboard.html'));

  // Strategy 4: Walk up from this file to find package.json, then resolve web/
  try {
    const thisDir = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
    let dir = thisDir;
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'web/dashboard.html'))) {
        candidates.push(join(dir, 'web/dashboard.html'));
        break;
      }
      dir = dirname(dir);
    }
  } catch {
    // Fallback exhausted
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const DASHBOARD_HTML_PATH = resolveDashboardHtml();

/** Directory of static dashboard assets (vendored libs, e.g. uPlot), resolved
 * next to the dashboard HTML so it works in-place and in a global install. */
const WEB_DIR = DASHBOARD_HTML_PATH ? dirname(DASHBOARD_HTML_PATH) : null;

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface DashboardServerOptions {
  /** Port to bind. Pass 0 for an OS-assigned ephemeral port (read the actual
   *  port back via `onListening` or the returned `.port`). Default 3847. */
  port?: number;
  host?: string;
  updateIntervalMs?: number;
  /** Fired once the server is listening, with the actually-bound port — the only
   *  reliable way to learn the port when `port: 0` was requested. */
  onListening?: (info: { port: number; host: string }) => void;
}

export function startDashboardServer(
  options: DashboardServerOptions = {}
): { close: () => void; readonly port: number } {
  // `??` not `||`: port 0 is a valid request (OS-assigned ephemeral) and must
  // not collapse to the 3847 default.
  const requestedPort = options.port ?? 3847;
  // Updated to the real bound port once the server is listening.
  let boundPort = requestedPort;
  const host = options.host || 'localhost';
  // Precedence: explicit option (--refresh) > UAP_DASH_REFRESH_MS > 2000.
  // Floor 250ms — getDashboardData reads several DBs per snapshot, so a
  // too-small interval would peg the event loop. Ceiling 1h — past 2^31-1ms,
  // setInterval overflows and spins at 1ms, the exact opposite of "slow".
  const envRefresh = Number(process.env.UAP_DASH_REFRESH_MS);
  const updateInterval = Math.min(
    3_600_000,
    Math.max(250, options.updateIntervalMs || (envRefresh > 0 ? envRefresh : 0) || 2000)
  );

  // Track SSE clients for live event streaming
  const sseClients = new Set<ServerResponse>();
  const cwd = process.cwd();

  // Mutation auth (security audit D1): the policy-mutation POST routes disable
  // security controls (delivery-enforcement, self-protect) and persist the
  // change to the DB. Without a gate, any LAN host (--host 0.0.0.0) or any web
  // page the operator visits (CORS was `*`, and /toggle reads no body → a
  // no-cors simple POST fires it) could neutralize enforcement. Fix: require an
  // unguessable per-session token in a CUSTOM header on every mutation. A
  // cross-origin page can't read it (same-origin-only injection into the served
  // HTML) and can't set a custom header on a simple request; a LAN attacker
  // can't read it (printed to the operator's console only). Override for
  // automation via UAP_DASHBOARD_TOKEN. Read routes stay open (localhost).
  const mutationToken = process.env.UAP_DASHBOARD_TOKEN || randomBytes(24).toString('hex');
  const mutationAuthorized = (req: IncomingMessage): boolean => {
    const provided = req.headers['x-uap-dashboard-token'];
    return typeof provided === 'string' && provided === mutationToken;
  };
  const denyMutation = (res: ServerResponse): void => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: dashboard mutation requires the session token (see the console where `uap dashboard serve` was started).' }));
  };

  // The Live Events feed is fed CROSS-PROCESS from the persisted dashboard_events
  // table (telemetry.db), not the in-process event bus — emitters fire in the
  // mcp-router/executor processes, whose in-memory bus this `dash serve` process
  // can never see. A single poller reads new rows and fans them out to SSE
  // clients. lastEventId starts at the current max so we don't replay old rows to
  // the poller (fresh clients still get a recent-history burst on connect).
  let lastEventId = (readRecentEvents(cwd, 1)[0]?.id) ?? 0;
  const eventPoller = setInterval(() => {
    let fresh;
    try {
      fresh = readEventsSince(cwd, lastEventId, 200);
    } catch {
      return;
    }
    if (!fresh.length) return;
    // Advance the watermark UNCONDITIONALLY (even with no clients) so it never
    // freezes at the server-start max. A frozen watermark makes the first client
    // that connects after an idle period receive the connect-burst AND a poller
    // resend of the same rows. Advancing here keeps the poller strictly ahead of
    // the burst; the client-side id-dedup covers the residual one-tick window.
    lastEventId = fresh[fresh.length - 1].id;
    if (sseClients.size === 0) return;
    for (const event of fresh) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(data);
        } catch {
          sseClients.delete(client);
        }
      }
    }
  }, updateInterval);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';

    // CORS headers. Reads stay open (localhost dashboard, read-only data), but
    // mutations are gated by the token header below — the token, not the origin,
    // is the real defense (a foreign origin can neither read the token nor,
    // therefore, forge the header).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Uap-Dashboard-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API: Get dashboard data
      if (url === '/api/dashboard') {
        const data = await getDashboardData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // API: SSE event stream
      if (url === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        // Send recent event history as initial burst — from the persisted store
        // (cross-process), not the always-empty in-process bus.
        const history = readRecentEvents(cwd, 50);
        for (const event of history) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        // Keep-alive ping every 30s
        const keepAlive = setInterval(() => {
          try {
            res.write(': keepalive\n\n');
          } catch {
            clearInterval(keepAlive);
            sseClients.delete(res);
          }
        }, 30000);

        sseClients.add(res);

        req.on('close', () => {
          clearInterval(keepAlive);
          sseClients.delete(res);
        });

        return;
      }

      // API: Get event history
      if (url.startsWith('/api/events/history')) {
        const urlObj = new URL(url, `http://${host}:${boundPort}`);
        const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
        const sinceId = parseInt(urlObj.searchParams.get('since') || '0', 10);

        const events = sinceId > 0 ? readEventsSince(cwd, sinceId, limit) : readRecentEvents(cwd, limit);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
        return;
      }

      // API: Toggle policy
      if (url.startsWith('/api/policy/') && url.endsWith('/toggle') && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const id = url.split('/')[3];
        const memory = getPolicyMemoryManager();
        const policy = await memory.getPolicy(id);
        if (!policy) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Policy not found' }));
          return;
        }
        await memory.togglePolicy(id, !policy.isActive);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, isActive: !policy.isActive }));
        return;
      }

      // API: Set policy stage
      if (url.startsWith('/api/policy/') && url.endsWith('/stage') && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const id = url.split('/')[3];
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        const stage = parsed.stage as string;
        const validStages = ['pre-exec', 'post-exec', 'review', 'always'];
        if (!validStages.includes(stage)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid stage. Must be: ${validStages.join(', ')}` }));
          return;
        }
        const memory = getPolicyMemoryManager();
        await memory.setEnforcementStage(
          id,
          stage as 'pre-exec' | 'post-exec' | 'review' | 'always'
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, enforcementStage: stage }));
        return;
      }

      // API: Set policy level
      if (url.startsWith('/api/policy/') && url.endsWith('/level') && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const id = url.split('/')[3];
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        const level = parsed.level as string;
        const validLevels = ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'];
        if (!validLevels.includes(level)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid level. Must be: ${validLevels.join(', ')}` }));
          return;
        }
        const memory = getPolicyMemoryManager();
        await memory.setLevel(id, level as 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, level }));
        return;
      }

      // Static vendored assets (e.g. /vendor/uPlot.iife.min.js). Served from the
      // web dir so the dashboard has ZERO external/CDN dependencies and its
      // charts work fully offline. Path-traversal guarded to the vendor dir.
      if ((url.startsWith('/vendor/') || url.startsWith('/dash/')) && WEB_DIR) {
        const rel = decodeURIComponent(url.split('?')[0].replace(/^\/+/, ''));
        const abs = join(WEB_DIR, rel);
        // Guard with a trailing separator so sibling dirs whose name merely
        // starts with "vendor" (e.g. web/vendor-secret/) are NOT served — a
        // bare `startsWith(vendorRoot)` prefix match let them through (audit D1b).
        const staticRoot = join(WEB_DIR, url.startsWith('/dash/') ? 'dash' : 'vendor') + sep;
        if (!abs.startsWith(staticRoot) || !existsSync(abs)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'asset not found' }));
          return;
        }
        const ext = abs.slice(abs.lastIndexOf('.'));
        // /vendor/ is immutable (pinned lib versions) → cache hard. /dash/ is the
        // app code that changes every release → no-store so an upgraded dashboard
        // shows immediately instead of serving a day-stale bundle.
        const cacheControl = url.startsWith('/dash/') ? 'no-store' : 'public, max-age=86400';
        res.writeHead(200, {
          'Content-Type': STATIC_CONTENT_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': cacheControl,
        });
        res.end(readFileSync(abs));
        return;
      }

      // ── Control mutations (dashboard write surface) — ALL token-gated ──
      if (req.method === 'POST' && CONTROL_PREFIXES.some((p) => url === p || url.startsWith(p + '/'))) {
        if (!mutationAuthorized(req)) return denyMutation(res);
        try {
          const raw = await readBody(req);
          const parsedBody = raw && raw.trim() ? parseJsonBody(raw) : {};
          const result = await routeControl(url.split('?')[0], cwd, parsedBody);
          if (result === undefined) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unknown control route' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'error';
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }

      // Serve HTML dashboard
      if (url === '/' || url === '/index.html') {
        if (DASHBOARD_HTML_PATH) {
          // Inject the per-session mutation token so the SAME-ORIGIN UI can send
          // it on policy mutations. A cross-origin page cannot read this HTML
          // (CORS blocks the cross-origin read), so it never sees the token.
          const html = readFileSync(DASHBOARD_HTML_PATH, 'utf-8')
            .replace(/__UAP_DASHBOARD_TOKEN__/g, mutationToken)
            // The client's fallback poll should tick at the same cadence the
            // server pushes; injected so one --refresh flag governs both.
            .replace(/__UAP_DASH_REFRESH_MS__/g, String(updateInterval));
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } else {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>UAP Dashboard</h1><p>web/dashboard.html not found. Searched relative to module, import.meta.url, cwd, and package.json. Ensure the UAP package is intact or run from the project root.</p></body></html>'
          );
        }
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      const isClientError = message.includes('Invalid JSON') || message.includes('too large');
      res.writeHead(isClientError ? 400 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({ server });

  const pushInterval = setInterval(async () => {
    if (wss.clients.size === 0 && sseClients.size === 0) return;
    try {
      const data = await getDashboardData();
      const payload = JSON.stringify(data);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
      // Also push the live snapshot to SSE clients as a NAMED `snapshot` event so
      // /api/events is a genuine live cross-process path for the main dashboard
      // (the event bus alone only carries in-process activity events). Named so it
      // does not collide with the default-`message` activity feed. (C)
      if (sseClients.size > 0) {
        const frame = `event: snapshot\ndata: ${payload}\n\n`;
        for (const res of sseClients) {
          try {
            res.write(frame);
          } catch {
            sseClients.delete(res);
          }
        }
      }
    } catch {
      /* ignore push errors */
    }
  }, updateInterval);

  wss.on('connection', async (ws: WebSocket) => {
    // Send initial state immediately
    try {
      const data = await getDashboardData();
      ws.send(JSON.stringify(data));
    } catch {
      /* ignore */
    }
  });

  server.listen(requestedPort, host, () => {
    // Resolve the real port now that we're listening (matters when port 0 was
    // requested — the OS picked a free one).
    const addr = server.address();
    if (addr && typeof addr === 'object') boundPort = addr.port;
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`UAP Dashboard server running at http://${shown}:${boundPort}`);
    if (host === '0.0.0.0') {
      console.log(`  bound to all interfaces (0.0.0.0) — reachable on the LAN at http://<this-host-ip>:${boundPort}`);
    } else if (host === 'localhost' || host === '127.0.0.1') {
      console.log(`  loopback only — for remote/LAN access restart with: uap dash serve --host 0.0.0.0`);
    }
    console.log(`WebSocket + SSE live updates at ws://${shown}:${boundPort} and http://${shown}:${boundPort}/api/events`);
    // Policy mutations (enable/disable/stage/level) require this token. The
    // dashboard UI gets it automatically (injected into the served page); any
    // other client must send it as `X-Uap-Dashboard-Token`. Override with
    // UAP_DASHBOARD_TOKEN. Without it, an unauthenticated caller cannot disable
    // enforcement (security audit D1).
    if (!process.env.UAP_DASHBOARD_TOKEN) {
      console.log(`  policy-mutation token: ${mutationToken}`);
    }

    // Seed dashboard data from project state
    try {
      const state = seedDashboardData(cwd);
      console.log(
        `Dashboard seeder: ${state.tasksCreated} tasks, ${state.deploysQueued} deploys, ${state.batchesCreated} batches, ${state.policyChecksRun} policies`
      );
    } catch {
      /* seeder failure is non-fatal */
    }

    // Signal readiness with the actually-bound port (essential for port: 0).
    options.onListening?.({ port: boundPort, host });
  });

  return {
    // Reflects the real bound port after listening (the requested port before).
    get port() {
      return boundPort;
    },
    close: () => {
      clearInterval(eventPoller);
      clearInterval(pushInterval);
      // Cleanup seeder (clear heartbeat, mark agent completed)
      try {
        cleanupSeeder(cwd);
      } catch {
        /* ignore */
      }
      // Close all SSE clients
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      wss.close();
      server.close();
    },
  };
}

const MAX_BODY_SIZE = 10240; // 10 KB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseJsonBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON in request body');
  }
}

const CONTROL_PREFIXES = ['/api/tasks', '/api/ledger', '/api/orchestrator', '/api/agents', '/api/deliver'];

async function routeControl(url: string, cwd: string, body: Record<string, unknown>): Promise<unknown> {
  const seg = url.split('/').filter(Boolean); // ['api','tasks','<id>','update']
  const dec = (s: string): string => decodeURIComponent(s);
  if (url === '/api/tasks') return handleTaskCreate(body);
  if (seg[1] === 'tasks' && seg.length === 4) {
    const id = dec(seg[2]);
    if (seg[3] === 'update') return handleTaskUpdate(id, body);
    if (seg[3] === 'close') return handleTaskClose(id, body);
    if (seg[3] === 'delete') return handleTaskDelete(id);
    if (seg[3] === 'claim') return handleTaskClaim(id, body);
  }
  if (url === '/api/ledger/reset') return handleLedgerReset(cwd);
  if (url === '/api/ledger/init') return handleLedgerInit(cwd, body);
  if (seg[1] === 'ledger' && seg[2] === 'item' && seg[3]) return handleLedgerItem(cwd, dec(seg[3]), body);
  if (url === '/api/orchestrator') return handleOrchestratorToggle(cwd, body);
  if (url === '/api/agents/clean') return handleAgentCleanStale();
  if (seg[1] === 'agents' && seg.length === 4 && seg[3] === 'deregister') return handleAgentDeregister(dec(seg[2]));
  if (url === '/api/deliver/launch') return handleDeliverLaunch(cwd, body);
  if (seg[1] === 'deliver' && seg.length === 4 && seg[3] === 'cancel') return handleDeliverCancel(cwd, dec(seg[2]));
  if (seg[1] === 'deliver' && seg.length === 4 && seg[3] === 'resume') return handleDeliverResume(cwd, dec(seg[2]));
  return undefined;
}
