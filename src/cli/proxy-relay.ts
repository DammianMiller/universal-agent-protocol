/**
 * `uap proxy connect` — a small TCP→unix relay for the proxy's AF_UNIX
 * surface (bridge P4).
 *
 * The proxy can serve its model gateway on a permission-gated AF_UNIX socket
 * (`PROXY_SOCKET`, 0600 — see ADR 0011): tighter than a TCP port anyone on
 * the box can dial. But most harness clients speak HTTP to a URL and cannot
 * dial a unix socket. This relay re-serves that socket on a local TCP port:
 * it accepts on `--listen` (default 127.0.0.1:4000) and pipes every byte,
 * unmodified, to the socket — one hop, no parsing, no buffering policy of
 * its own: the proxy keeps every guardrail.
 *
 * Run it by hand wherever a TCP-only client must reach a socket-served
 * proxy. (An in-sandbox auto-wired version — a `--net proxy` mode that ran
 * this relay inside a cut network namespace — was designed and then CUT:
 * rootless Linux cannot express that boundary; see ADR 0011 for the
 * empirical reasoning.)
 *
 * Fail-closed both ways: an upstream (socket) failure destroys the client
 * connection instead of hanging it — the client sees a refused connection
 * and stops, it never spins on a half-open pipe.
 */

import { writeFileSync } from 'fs';
import net from 'net';

export interface RelayOptions {
  /** AF_UNIX socket path of the proxy (required). */
  socket: string;
  /** Namespace-local TCP port to accept on (default: 4000, the proxy port). */
  listenPort?: number;
  /** Bind host (default 127.0.0.1 — loopback only). */
  listenHost?: string;
  /** Suppress the startup line (scripts, wrappers). */
  quiet?: boolean;
  /** Touch this file (containing the bound port) once the TCP listener is
   *  bound — a readiness handshake for wrappers that must not race the
   *  relay's boot. The file records the ACTUAL bound port, so an ephemeral
   *  `--listen 0` handshake carries a dialable number. */
  readyFile?: string;
}

/**
 * Start the relay. Resolves once the TCP listener is bound. The returned
 * server never exits on its own: run the command in the foreground and
 * signal it when the surrounding work is done.
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
      // the client must see connection-refused, never a hang.
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
      const boundPort = (server.address() as net.AddressInfo | null)?.port ?? listenPort;
      if (opts.readyFile) {
        try {
          writeFileSync(opts.readyFile, `${boundPort}\n`, 'utf-8');
        } catch {
          // Readiness handshake is best-effort; the caller's own timeout
          // still bounds the wait if the file could not be written.
        }
      }
      if (!opts.quiet) {
        // Intentionally on stdout: one line, greppable in wrapper logs.
        console.log(
          `uap proxy connect: ${listenHost}:${boundPort} -> ${socketPath} (TCP->unix relay)`,
        );
      }
      resolve(server);
    });
  });
}

/** CLI entry: run the relay in the foreground until killed. */
export async function proxyConnectCommand(opts: RelayOptions): Promise<void> {
  let server: net.Server;
  try {
    server = await startProxyRelay(opts);
  } catch (err) {
    // A bind failure (port taken) or a bad --socket arrives here as a clean
    // one-line error with exit 1, not an unhandled rejection stack — the
    // CLI's parse path is synchronous, so nobody else would catch it.
    console.error(`uap proxy connect: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  // Foreground until SIGINT/SIGTERM; exit 0 on a clean shutdown signal so a
  // wrapping script's status belongs to the work, not the relay.
  const stop = () => {
    server.close(() => process.exit(0));
    // A stuck open connection must not wedge the exit.
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
