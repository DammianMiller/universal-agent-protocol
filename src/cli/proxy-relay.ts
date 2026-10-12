/**
 * `uap proxy connect` — a small TCP→unix relay for the proxy's AF_UNIX
 * surface.
 *
 * The proxy can serve its model gateway on a permission-gated AF_UNIX socket
 * (`PROXY_SOCKET`, 0600 — see ADR 0011): tighter than a TCP port anyone on
 * the box can dial. But most harness clients speak HTTP to a URL and cannot
 * dial a unix socket. This relay re-serves that socket on a local TCP port:
 * it accepts on `--listen` (default 127.0.0.1:4000) and pipes every byte,
 * unmodified, to the socket — one hop, no parsing, no buffering policy of
 * its own: the proxy keeps every guardrail.
 *
 * THE GATE IT VOIDS, STATED PLAINLY (security review): the 0600 socket
 * exists precisely so that only the owning USER can reach the model path.
 * The relay re-serves it on loopback TCP, and on a multi-user box every
 * local user can dial a loopback port. So the relay refuses to run unless
 * the operator passes `--allow-anyone`, and while it runs it says so on
 * stderr every start: the TCP surface is the socket's gate, temporarily
 * turned inside out. Stop the relay when the work is done.
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
  /** Suppress the startup line (scripts, wrappers). The multi-user warning
   *  still prints on stderr — it is the operator's informed-consent line. */
  quiet?: boolean;
  /** Touch this file (containing the bound port) once the TCP listener is
   *  bound — a readiness handshake for wrappers that must not race the
   *  relay's boot. The file records the ACTUAL bound port, so an ephemeral
   *  `--listen 0` handshake carries a dialable number. */
  readyFile?: string;
  /** Informed consent for voiding the socket's 0600 user gate (P4 security
   *  review): the relay is a TCP re-serve of a per-user socket, and while it
   *  runs every local user can reach the model path through it. The CLI
   *  refuses to start without this. */
  allowAnyone?: boolean;
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
  if (!opts.allowAnyone) {
    // Informed consent, not a speed bump: the 0600 socket's whole point is
    // that only the owning user reaches the model path; a loopback TCP
    // re-serve is that gate, inverted, for anyone local. Refusing without
    // the explicit flag keeps "uap proxy connect" from quietly reintroducing
    // the port ADR 0011 took away (security review).
    console.error(
      'uap proxy connect: refusing without --allow-anyone.\n' +
        'The relay re-serves the 0600 unix socket on a local TCP port — while it runs,\n' +
        'EVERY local user can reach the model path through it (the per-user gate is void).\n' +
        'Pass --allow-anyone to accept that, and stop the relay when the work is done.',
    );
    process.exitCode = 1;
    return;
  }
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
  // The consent line for what is now running: not suppressed by --quiet —
  // quiet is for scripts capturing stdout; this is the operator's warning.
  const boundPort = (server.address() as net.AddressInfo | null)?.port ?? opts.listenPort ?? 4000;
  console.error(
    `uap proxy connect: WARNING — while this relay runs, every local user can reach the model path via 127.0.0.1:${boundPort}.`,
  );
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
