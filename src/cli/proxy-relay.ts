/**
 * `uap proxy connect` — the in-sandbox TCP→unix relay (bridge P4: D1).
 *
 * A `uap sandbox --net=proxy` session runs in its own network namespace:
 * no TCP, no DNS, no direct egress of any kind. Its one network reach is
 * the proxy's AF_UNIX socket, bind-mounted across the namespace wall. But
 * harness clients speak HTTP to a URL — they cannot dial a unix socket —
 * so the sandbox runs this tiny relay INSIDE the namespace: it brings
 * loopback up, binds 127.0.0.1:<port> (namespace-local: nothing outside
 * can reach it), and pipes every byte to the socket.
 *
 * Fail-closed both ways: an upstream (socket) failure destroys the client
 * connection instead of hanging it — the agent sees a refused connection
 * and stops, it never spins on a half-open pipe. One hop, no parsing,
 * no buffering policy of its own: the proxy keeps every guardrail.
 */

import { writeFileSync } from 'fs';
import net from 'net';

export interface RelayOptions {
  /** AF_UNIX socket path of the proxy (required). */
  socket: string;
  /** Namespace-local TCP port to accept on (default: 4000, the proxy port). */
  listenPort?: number;
  /** Bind host (default 127.0.0.1 — namespace-local loopback only). */
  listenHost?: string;
  /** Suppress the startup line (used by the sandbox's inner wrapper). */
  quiet?: boolean;
  /** Touch this file once the TCP listener is bound (readiness handshake —
   *  the sandbox wrapper waits on it so the session command never races
   *  the relay's node-boot and sees a premature ECONNREFUSED). */
  readyFile?: string;
}

/**
 * Start the relay. Resolves once the TCP listener is bound. The returned
 * server never exits on its own: `uap sandbox` kills it (the process group
 * gets the signal) when the session command ends.
 */
export function startProxyRelay(opts: RelayOptions): Promise<net.Server> {
  const socketPath = opts.socket?.trim();
  if (!socketPath) {
    return Promise.reject(new Error('uap proxy connect: --socket <path> is required'));
  }
  const listenPort = Number.isFinite(opts.listenPort) ? (opts.listenPort as number) : 4000;
  const listenHost = opts.listenHost || '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.createConnection(socketPath);
      // Fail-closed: any upstream error tears the client down immediately —
      // a sandboxed agent must see connection-refused, never a hang.
      upstream.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      client.on('error', () => {
        upstream.destroy();
      });
      client.pipe(upstream);
      upstream.pipe(client);
    });

    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.removeListener('error', reject);
      if (opts.readyFile) {
        try {
          writeFileSync(opts.readyFile, `${listenPort}\n`, 'utf-8');
        } catch {
          // Readiness handshake is best-effort; the wrapper's timeout still
          // bounds the wait if the file could not be written.
        }
      }
      if (!opts.quiet) {
        // Intentionally on stdout: one line, greppable in wrapper logs.
        console.log(
          `uap proxy connect: 127.0.0.1:${listenPort} -> ${socketPath} (namespace-local relay)`,
        );
      }
      resolve(server);
    });
  });
}

/** CLI entry: run the relay in the foreground until killed. */
export async function proxyConnectCommand(opts: RelayOptions): Promise<void> {
  const server = await startProxyRelay(opts);
  // Foreground until SIGINT/SIGTERM (the sandbox wrapper and the process
  // group deliver both); exit 0 on a clean shutdown signal, because the
  // wrapper's exit status must belong to the SESSION command, not the relay.
  const stop = (sig: string) => {
    server.close(() => process.exit(0));
    // A stuck open connection must not wedge the wrapper's exit.
    setTimeout(() => process.exit(0), 250).unref();
    void sig;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
