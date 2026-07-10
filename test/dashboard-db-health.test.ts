/**
 * Dashboard DB-health probe: a missing/incompatible better-sqlite3 native
 * binding makes every DB-backed panel silently read empty. The probe turns that
 * silent failure into an explicit `health` field (surfaced as a UI banner + a
 * loud startup warning), so it can never be invisible again.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { probeDatabaseHealth } from '../src/dashboard/data-service.js';
import { startDashboardServer } from '../src/dashboard/server.js';

describe('probeDatabaseHealth', () => {
  it('reports ok when the better-sqlite3 binding is present', () => {
    const h = probeDatabaseHealth(process.cwd());
    expect(h.ok).toBe(true);
    expect(h.error).toBeUndefined();
  });

  it('always returns a boolean ok (never throws)', () => {
    expect(typeof probeDatabaseHealth('/nonexistent/path').ok).toBe('boolean');
  });
});

describe('dashboard snapshot exposes health', () => {
  let server: { close: () => void; readonly port: number } | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  it('/api/dashboard includes a health field with ok:true in a working env', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never listened')), 5000);
      server = startDashboardServer({ port: 0, host: '127.0.0.1', onListening: ({ port }) => { clearTimeout(timer); resolve(port); } });
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    const d = (await r.json()) as { health?: { ok: boolean } };
    expect(d.health).toBeDefined();
    expect(d.health?.ok).toBe(true);
  }, 20000);
});
