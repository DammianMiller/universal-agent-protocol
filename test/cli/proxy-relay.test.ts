/**
 * `uap proxy connect` (bridge P4: D1) — the standalone TCP→unix relay that
 * re-serves the proxy's AF_UNIX socket for TCP-only clients. Bytes must
 * cross unmodified in both directions; an upstream failure must DESTROY
 * the client connection (fail-closed: the client sees refused, not a
 * hang); a missing --socket must be an error; and a bind failure must land
 * as a clean CLI error, never an unhandled rejection.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startProxyRelay, proxyConnectCommand } from '../../src/cli/proxy-relay.js';

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

  it('touches the ready-file once listening, recording the REAL bound port', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-relay-'));
    const sockPath = join(dir, 'proxy.sock');
    await mockProxySocket(sockPath);
    const readyFile = join(dir, 'ready');
    const relay = await startProxyRelay({ socket: sockPath, listenPort: 0, quiet: true, readyFile });
    servers.push(relay);
    expect(existsSync(readyFile)).toBe(true);
    // With an ephemeral --listen 0 the requested port is meaningless; the
    // file must carry the port the relay ACTUALLY bound (the P4 review
    // caught it recording the request instead — a wrapper would dial 0).
    const boundPort = (relay.address() as net.AddressInfo).port;
    expect(readFileSync(readyFile, 'utf-8')).toBe(`${boundPort}\n`);
  });
});

describe('proxyConnectCommand (the CLI surface)', () => {
  it('refuses without --allow-anyone: the relay voids the socket gate, so consent is explicit', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-relay-'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prevCode = process.exitCode;
    try {
      await proxyConnectCommand({ socket: join(dir, 'x.sock'), quiet: true });
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.flat().join(' ')).toContain('--allow-anyone');
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/every local user/i);
    } finally {
      process.exitCode = prevCode;
      errSpy.mockRestore();
    }
  });

  it('with --allow-anyone, a bind failure lands as a clean error + exit 1, not an unhandled rejection', async () => {
    dir = mkdtempSync(join(tmpdir(), 'uap-relay-'));
    const sockPath = join(dir, 'proxy.sock');
    await mockProxySocket(sockPath);
    // Occupy a fixed port with a live server, then ask the relay for the
    // same one: listen must fail, and the command must catch it.
    const squatter = await new Promise<net.Server>((resolve) => {
      const s = net.createServer(() => {});
      s.listen(0, '127.0.0.1', () => resolve(s));
      servers.push(s);
    });
    const takenPort = (squatter.address() as net.AddressInfo).port;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prevCode = process.exitCode;
    try {
      await proxyConnectCommand({ socket: sockPath, listenPort: takenPort, quiet: true, allowAnyone: true });
      // A rejected listen promise escaping here would fail the test as an
      // unhandled rejection; reaching this line means it was caught.
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.flat().join(' ')).toContain('uap proxy connect:');
    } finally {
      process.exitCode = prevCode;
      errSpy.mockRestore();
    }
  });

  it('refuses a missing --socket the same way (clean error + exit 1)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prevCode = process.exitCode;
    try {
      await proxyConnectCommand({ socket: '', allowAnyone: true });
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/--socket/);
    } finally {
      process.exitCode = prevCode;
      errSpy.mockRestore();
    }
  });
});
