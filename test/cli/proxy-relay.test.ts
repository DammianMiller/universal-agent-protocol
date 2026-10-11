/**
 * `uap proxy connect` (bridge P4: D1) — the in-sandbox TCP→unix relay.
 * Bytes must cross unmodified in both directions; an upstream failure must
 * DESTROY the client connection (fail-closed: the agent sees refused, not a
 * hang); and a missing --socket must be an error.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startProxyRelay } from '../../src/cli/proxy-relay.js';

let dir: string;
const servers: net.Server[] = [];

function cleanup(): void {
  for (const s of servers.splice(0)) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}
afterEach(cleanup);

/** Start a mock proxy on an AF_UNIX socket that echoes bytes uppercased. */
function mockProxySocket(path: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      conn.on('data', (buf) => conn.write(buf.toString('utf-8').toUpperCase()));
    });
    server.listen(path, () => resolve(server));
    servers.push(server);
  });
}

function onceReadable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.connect(port, '127.0.0.1');
    probe.on('connect', () => {
      probe.destroy();
      resolve();
    });
    probe.on('error', reject);
  });
}

describe('startProxyRelay', () => {
  it('pipes bytes both ways between TCP and the unix socket', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-relay-'));
    const sockPath = join(dir, 'proxy.sock');
    await mockProxySocket(sockPath);

    const relay = await startProxyRelay({ socket: sockPath, listenPort: 0, quiet: true });
    servers.push(relay);
    const port = (relay.address() as net.AddressInfo).port;
    await onceReadable(port);

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1', () => client.write('ping'));
      client.on('data', (buf) => {
        expect(buf.toString('utf-8')).toBe('PING');
        client.end();
        resolve();
      });
      client.on('error', reject);
    });
  });

  it('destroys the client when the upstream socket is gone (fail-closed, no hang)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-relay-'));
    const relay = await startProxyRelay({ socket: join(dir, 'not-there.sock'), listenPort: 0, quiet: true });
    servers.push(relay);
    const port = (relay.address() as net.AddressInfo).port;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client hung instead of failing closed')), 3000);
      const client = net.connect(port, '127.0.0.1', () => client.write('hello'));
      client.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      client.on('error', () => {
        clearTimeout(timer);
        client.destroy();
        resolve();
      });
    });
  });

  it('requires --socket', async () => {
    await expect(startProxyRelay({ socket: '' })).rejects.toThrow(/--socket/);
  });

  it('touches the ready-file once listening (the wrapper readiness handshake)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-relay-'));
    const sockPath = join(dir, 'proxy.sock');
    await mockProxySocket(sockPath);
    const readyFile = join(dir, 'ready');
    const relay = await startProxyRelay({ socket: sockPath, listenPort: 0, quiet: true, readyFile });
    servers.push(relay);
    expect(existsSync(readyFile)).toBe(true);
    expect(readFileSync(readyFile, 'utf-8')).toMatch(/^\d+\n$/);
  });
});
