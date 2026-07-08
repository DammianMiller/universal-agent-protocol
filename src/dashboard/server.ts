/**
 * Dashboard Server
 *
 * Lightweight HTTP + WebSocket server for the web overlay.
 * Serves JSON data from getDashboardData() and pushes real-time updates.
 * Includes SSE endpoint for live event streaming.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDashboardData } from './data-service.js';
import { seedDashboardData, cleanupSeeder } from './data-seeder.js';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { readEventsSince, readRecentEvents } from '../utils/telemetry-store.js';

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
  port?: number;
  host?: string;
  updateIntervalMs?: number;
}

export function startDashboardServer(options: DashboardServerOptions = {}): { close: () => void } {
  const port = options.port || 3847;
  const host = options.host || 'localhost';
  const updateInterval = options.updateIntervalMs || 2000;

  // Track SSE clients for live event streaming
  const sseClients = new Set<ServerResponse>();
  const cwd = process.cwd();

  // The Live Events feed is fed CROSS-PROCESS from the persisted dashboard_events
  // table (telemetry.db), not the in-process event bus — emitters fire in the
  // mcp-router/executor processes, whose in-memory bus this `dash serve` process
  // can never see. A single poller reads new rows and fans them out to SSE
  // clients. lastEventId starts at the current max so we don't replay old rows to
  // the poller (fresh clients still get a recent-history burst on connect).
  let lastEventId = (readRecentEvents(cwd, 1)[0]?.id) ?? 0;
  const eventPoller = setInterval(() => {
    if (sseClients.size === 0) return;
    let fresh;
    try {
      fresh = readEventsSince(cwd, lastEventId, 200);
    } catch {
      return;
    }
    if (!fresh.length) return;
    lastEventId = fresh[fresh.length - 1].id;
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

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
        const urlObj = new URL(url, `http://${host}:${port}`);
        const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
        const sinceId = parseInt(urlObj.searchParams.get('since') || '0', 10);

        const events = sinceId > 0 ? readEventsSince(cwd, sinceId, limit) : readRecentEvents(cwd, limit);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
        return;
      }

      // API: Toggle policy
      if (url.startsWith('/api/policy/') && url.endsWith('/toggle') && req.method === 'POST') {
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
      if (url.startsWith('/vendor/') && WEB_DIR) {
        const rel = decodeURIComponent(url.split('?')[0].replace(/^\/+/, ''));
        const abs = join(WEB_DIR, rel);
        const vendorRoot = join(WEB_DIR, 'vendor');
        if (!abs.startsWith(vendorRoot) || !existsSync(abs)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'asset not found' }));
          return;
        }
        const ext = abs.slice(abs.lastIndexOf('.'));
        res.writeHead(200, {
          'Content-Type': STATIC_CONTENT_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(readFileSync(abs));
        return;
      }

      // Serve HTML dashboard
      if (url === '/' || url === '/index.html') {
        if (DASHBOARD_HTML_PATH) {
          const html = readFileSync(DASHBOARD_HTML_PATH, 'utf-8');
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

  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`UAP Dashboard server running at http://${shown}:${port}`);
    if (host === '0.0.0.0') {
      console.log(`  bound to all interfaces (0.0.0.0) — reachable on the LAN at http://<this-host-ip>:${port}`);
    } else if (host === 'localhost' || host === '127.0.0.1') {
      console.log(`  loopback only — for remote/LAN access restart with: uap dash serve --host 0.0.0.0`);
    }
    console.log(`WebSocket + SSE live updates at ws://${shown}:${port} and http://${shown}:${port}/api/events`);

    // Seed dashboard data from project state
    try {
      const state = seedDashboardData(cwd);
      console.log(
        `Dashboard seeder: ${state.tasksCreated} tasks, ${state.deploysQueued} deploys, ${state.batchesCreated} batches, ${state.policyChecksRun} policies`
      );
    } catch {
      /* seeder failure is non-fatal */
    }
  });

  return {
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
