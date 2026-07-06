/**
 * Dashboard live-server behavior: configurable bind host (A) and cross-process
 * live push over both WebSocket and named-SSE `snapshot` events (C).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { startDashboardServer } from '../src/dashboard/server.js';

let portSeq = 38510;
const HOST = '127.0.0.1';
const settle = () => new Promise((r) => setTimeout(r, 250));

let handle: { close: () => void } | null = null;
afterEach(() => { try { handle?.close(); } catch { /* ignore */ } handle = null; });

/** Read the SSE stream until `event: snapshot` with a data line arrives (or timeout). */
function waitForSnapshot(port: number, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path: '/api/events' }, (res) => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error('no snapshot event before timeout')); }, timeoutMs);
      res.on('data', (chunk) => {
        buf += chunk.toString();
        // Frames are separated by a blank line; find a `snapshot` frame.
        const frames = buf.split('\n\n');
        for (const f of frames) {
          if (f.includes('event: snapshot')) {
            const dataLine = f.split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) {
              clearTimeout(timer);
              req.destroy();
              try { resolve(JSON.parse(dataLine.slice(6))); } catch (e) { reject(e as Error); }
              return;
            }
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

describe('dashboard server — bind host (A) + live SSE snapshot push (C)', () => {
  it('binds to the requested host and serves /api/dashboard', async () => {
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST, updateIntervalMs: 150 });
    await settle();
    const code = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: HOST, port, path: '/api/dashboard' }, (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
      req.on('error', reject);
      setTimeout(() => reject(new Error('request timeout')), 4000);
    });
    expect(code).toBe(200);
  });

  it('pushes a full live snapshot to SSE clients as a named `snapshot` event (cross-process live)', async () => {
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST, updateIntervalMs: 150 });
    await settle();
    const snap = await waitForSnapshot(port, 6000);
    // The snapshot is the same shape as /api/dashboard, so SSE alone keeps the UI live.
    expect(snap).toBeTypeOf('object');
    expect(snap).toHaveProperty('timestamp');
    expect(snap).toHaveProperty('tasks');
  });

  it('still pushes live frames over the primary WebSocket path', async () => {
    const port = portSeq++;
    handle = startDashboardServer({ port, host: HOST, updateIntervalMs: 150 });
    await settle();
    const frame = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://${HOST}:${port}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('no WS frame')); }, 4000);
      ws.on('message', (m) => {
        clearTimeout(timer);
        ws.close();
        try { resolve(JSON.parse(m.toString())); } catch (e) { reject(e as Error); }
      });
      ws.on('error', reject);
    });
    expect(frame).toHaveProperty('timestamp');
  });
});
