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
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { getDashboardEventBus, type DashboardEvent } from './event-stream.js';

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

  // Subscribe to dashboard events and forward to SSE clients
  const eventBus = getDashboardEventBus();
  const unsubscribe = eventBus.subscribe((event: DashboardEvent) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(data);
      } catch {
        sseClients.delete(client);
      }
    }
  });

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

        // Send recent event history as initial burst
        const history = eventBus.getHistory(50);
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

        const events = sinceId > 0 ? eventBus.getEventsSince(sinceId) : eventBus.getHistory(limit);

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
    if (wss.clients.size === 0) return;
    try {
      const data = await getDashboardData();
      const payload = JSON.stringify(data);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
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
    console.log(`UAP Dashboard server running at http://${host}:${port}`);
    console.log(`WebSocket available at ws://${host}:${port}`);
    console.log(`SSE event stream at http://${host}:${port}/api/events`);
  });

  return {
    close: () => {
      unsubscribe();
      clearInterval(pushInterval);
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
