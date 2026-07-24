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
import { getDashboardData, probeDatabaseHealth } from './data-service.js';
import { seedDashboardData, cleanupSeeder } from './data-seeder.js';
import { getPolicyMemoryManager } from '../policies/policy-memory.js';
import { heuristicOrder, buildOrderPrompt, parseOrderResponse, type OrderablePolicy } from '../policies/policy-order.js';
import { readEventsSince, readRecentEvents } from '../utils/telemetry-store.js';

/** First prose sentence of a policy's markdown (its description), fail-soft. */
function policyPromptDescription(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const ruleIdx = lines.findIndex((l) => /^##\s+rule/i.test(l.trim()));
  const scan = ruleIdx >= 0 ? lines.slice(ruleIdx + 1) : lines;
  for (const raw of scan) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || /^\*\*[^*]+\*\*:/.test(l) || l.startsWith('- ') || l.startsWith('>')) continue;
    return l.replace(/`/g, '').replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

/**
 * Suggest a policy firing order. Always computes the deterministic heuristic;
 * when `useAi`, asks the local model to refine it (with a rationale) and falls
 * back to the heuristic on any failure. Returns ordered {id,name} pairs so the
 * caller can apply it via /api/policies/reorder.
 */
async function suggestPolicyOrder(useAi: boolean): Promise<{
  order: Array<{ id: string; name: string }>;
  rationale: string;
  source: 'ai' | 'heuristic';
}> {
  const all = await getPolicyMemoryManager().getAllPoliciesUnfiltered();
  const idByName = new Map(all.map((p) => [p.name, p.id]));
  const orderable: OrderablePolicy[] = all.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    level: p.level,
    stage: p.enforcementStage,
    description: policyPromptDescription(p.rawMarkdown),
  }));
  const heuristicNames = heuristicOrder(orderable).map((p) => p.name);
  let names = heuristicNames;
  let rationale = 'Ordered by stage (pre-exec first) → level (REQUIRED first) → cheap fail-fast category first.';
  let source: 'ai' | 'heuristic' = 'heuristic';

  if (useAi) {
    try {
      const endpoint = process.env.UAP_INFERENCE_ENDPOINT || 'http://127.0.0.1:8080/v1';
      const model = process.env.UAP_DELIVER_MODEL || 'local';
      const { fetchModelWithRetry } = await import('../models/long-fetch.js');
      const res = await fetchModelWithRetry(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: 'user', content: buildOrderPrompt(orderable) }] }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content ?? '';
        const suggestion = parseOrderResponse(content, orderable.map((p) => p.name));
        if (suggestion) {
          names = suggestion.order;
          rationale = suggestion.rationale || rationale;
          source = 'ai';
        }
      }
    } catch {
      /* fall back to heuristic */
    }
  }
  return {
    order: names.map((n) => ({ id: idByName.get(n) ?? '', name: n })).filter((x) => x.id),
    rationale,
    source,
  };
}
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

    // CORS. API reads stay open (localhost dashboard, read-only data); mutations
    // are gated by the token header below.
    //
    // The served PAGE is deliberately excluded: it carries the mutation token
    // inline, and a wildcard `Access-Control-Allow-Origin` on it let ANY page
    // the operator visited read the HTML, scrape the token, and then drive every
    // mutation route (policy toggles, `deliver` launches). The old comment here
    // claimed CORS blocked that read — it did not, because the wildcard was set
    // on every response before routing. Now the token-bearing page is same-origin
    // only, which is what the token control always assumed (CWE-942/CWE-352).
    // Since the dashboard now rides along with `uap proxy` and is up for the
    // whole session, that window is no longer momentary.
    const isTokenBearingPage = url === '/' || url === '/index.html';
    if (!isTokenBearingPage) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Uap-Dashboard-Token');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Liveness probe. Deliberately cheap — no DB reads, no snapshot build —
      // because `uap proxy ensure` polls it while waiting for a co-located
      // dashboard to come up, and that poll sits in the SessionStart hook path.
      // `root` is what makes adoption safe: the dashboard serves ONE project
      // (every panel reads `cwd`), while the proxy's client registry is
      // per-user. Without it a session in project B would adopt project A's
      // dashboard and print its URL as B's.
      if (url === '/health' || url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ok: true, service: 'uap-dashboard', port: boundPort, root: cwd })
        );
        return;
      }

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

      // API: List all policies (incl. inactive) with description + prompt,
      // ordered by priority (fires-earliest first) for the management panel.
      if (url === '/api/policies' && req.method === 'GET') {
        const memory = getPolicyMemoryManager();
        const all = await memory.getAllPoliciesUnfiltered();
        const list = all
          .map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            level: p.level,
            stage: p.enforcementStage,
            priority: p.priority ?? 50,
            isActive: p.isActive,
            description: policyPromptDescription(p.rawMarkdown),
          }))
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ policies: list }));
        return;
      }

      // API: Full policy incl. rawMarkdown (the prompt) for the detail drawer.
      if (url.startsWith('/api/policy/') && url.split('/').length === 4 && req.method === 'GET') {
        const id = url.split('/')[3];
        const policy = await getPolicyMemoryManager().getPolicy(id);
        if (!policy) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Policy not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: policy.id, name: policy.name, category: policy.category, level: policy.level,
          stage: policy.enforcementStage, priority: policy.priority ?? 50, isActive: policy.isActive,
          description: policyPromptDescription(policy.rawMarkdown), rawMarkdown: policy.rawMarkdown,
        }));
        return;
      }

      // API: Duplicate a policy
      if (url.startsWith('/api/policy/') && url.endsWith('/duplicate') && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const id = url.split('/')[3];
        const newId = await getPolicyMemoryManager().duplicatePolicy(id);
        if (!newId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Policy not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: newId }));
        return;
      }

      // API: Set a single policy's priority
      if (url.startsWith('/api/policy/') && url.endsWith('/priority') && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const id = url.split('/')[3];
        const parsed = parseJsonBody(await readBody(req));
        const priority = Number(parsed.priority);
        if (!Number.isFinite(priority)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'priority must be a number' }));
          return;
        }
        await getPolicyMemoryManager().setPolicyPriority(id, priority);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, priority }));
        return;
      }

      // API: Reorder policies (assign descending priorities from an id list)
      if (url === '/api/policies/reorder' && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const parsed = parseJsonBody(await readBody(req));
        const order = Array.isArray(parsed.order) ? (parsed.order as unknown[]).map(String) : [];
        await getPolicyMemoryManager().reorderPolicies(order);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reordered: order.length }));
        return;
      }

      // API: Export all policies as a portable bundle (download)
      if (url === '/api/policies/export' && req.method === 'GET') {
        const bundle = getPolicyMemoryManager().exportPolicies();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="uap-policies.json"',
        });
        res.end(JSON.stringify(bundle, null, 2));
        return;
      }

      // API: Import policies from a bundle
      if (url === '/api/policies/import' && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const bundle = parseJsonBody(await readBody(req)) as { policies?: Array<Record<string, unknown>> };
        const result = await getPolicyMemoryManager().importPolicies(bundle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // API: Dedupe policies
      if (url === '/api/policies/dedupe' && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const result = await getPolicyMemoryManager().dedupePolicies();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // API: Suggest an intelligent firing order (heuristic + optional AI refine)
      if (url === '/api/policies/suggest-order' && req.method === 'POST') {
        if (!mutationAuthorized(req)) return denyMutation(res);
        const parsed = parseJsonBody(await readBody(req));
        const useAi = parsed.ai !== false; // default: try AI, fall back to heuristic
        const result = await suggestPolicyOrder(useAi);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
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

  // WebSocket server for real-time updates.
  //
  // WebSockets are exempt from the same-origin policy AND from CORS, so without
  // an Origin check any page the operator visits could open ws://localhost:3847
  // and receive the full dashboard snapshot every tick — tasks, agents, model
  // usage and cost (CWE-1385). Browsers always send Origin on an upgrade;
  // non-browser clients (the CLI, tests, curl) send none, so requiring "no
  // Origin, or an Origin naming this server" costs nothing and closes the
  // cross-origin read. Always-on ride-along makes this worth enforcing.
  const originAllowed = (origin: string | undefined): boolean => {
    if (!origin) return true; // non-browser client
    try {
      const { hostname, port: originPort } = new URL(origin);
      const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      const sameHost = loopback || hostname === host;
      return sameHost && (originPort === '' || Number(originPort) === boundPort);
    } catch {
      return false;
    }
  };
  const wss = new WebSocketServer({
    server,
    verifyClient: ({ origin }: { origin?: string }) => originAllowed(origin),
  });

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
    //
    // NOT echoed when the proxy started us as a ride-along: our stdout is an
    // append-only log file, so printing would persist a live credential to disk
    // (0644 under a 0700 dir, never rotated — CWE-532) where nothing reads it
    // anyway. The UI still gets the token same-origin; automation should set
    // UAP_DASHBOARD_TOKEN explicitly.
    if (!process.env.UAP_DASHBOARD_TOKEN) {
      if (process.env.UAP_DASH_RIDE_ALONG === '1') {
        console.log('  policy-mutation token: generated (not logged — the UI receives it same-origin)');
      } else {
        console.log(`  policy-mutation token: ${mutationToken}`);
      }
    }

    // DB-layer health: a missing native binding makes every panel silently
    // empty — warn loudly with the fix so the operator isn't left guessing.
    try {
      const dbHealth = probeDatabaseHealth(cwd);
      if (!dbHealth.ok) {
        console.warn('\n\u26A0 UAP Dashboard: SQLite layer UNAVAILABLE — every DB-backed panel will read EMPTY.');
        console.warn(`  cause: ${dbHealth.error}`);
        console.warn(`  fix:   ${dbHealth.remediation}\n`);
      }
    } catch { /* never block startup on the probe */ }

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
