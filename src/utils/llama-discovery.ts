/**
 * Discovery of locally running llama.cpp servers.
 *
 * The upstream is not a fixed port. Unsloth Studio restarts its bundled
 * llama-server on a NEW random port every launch (:50047 -> :34407 -> :59879
 * observed), so every hardcoded `127.0.0.1:8080` fallback in the codebase is a
 * guess that is wrong most of the time — silently, because the callers all
 * fail soft ("vision not configured", "endpoint unreachable").
 *
 * This asks the OS which ports a llama-server is actually listening on, so the
 * fallback is a fact rather than a convention.
 *
 * Loopback and wildcard binds only. A llama-server bound to a specific
 * non-loopback address is REJECTED rather than assumed to also be on
 * 127.0.0.1: that assumption would hand the endpoint to whichever local user
 * happened to bind loopback on the same port.
 *
 * The shell counterpart used by the proxy launcher is
 * `scripts/lib/llama-upstream.sh`. The two MUST agree — the same `ss` parse,
 * the same address rule, the same numeric ordering. test/llama-upstream-parity
 * runs both over one fixture and asserts they match.
 */
import { execFileSync } from 'child_process';

/**
 * Ports of locally listening llama-server processes, as OpenAI-compatible
 * bases (`http://127.0.0.1:<port>/v1`). Empty when none is running, `ss` is
 * unavailable, or the platform is not Linux — never throws.
 *
 * `ss -ltnp` only attributes a process to sockets the caller owns, which is
 * exactly the case here (the server runs as the same user).
 */
export function discoverLocalLlamaBases(): string[] {
  let out: string;
  try {
    out = execFileSync('ss', ['-ltnp'], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const found = new Map<number, string>();
  for (const line of out.split('\n')) {
    // Anchored to the process field: an unanchored /llama-server/ also matches
    // a path or a shim named "my-llama-server-x" appearing anywhere on the line.
    if (!/users:\(\("llama-server"/i.test(line)) continue;
    // Column 4 is Local Address:Port. Take the segment after the LAST colon so
    // IPv6 listeners ([::1]:59879) are parsed correctly.
    const local = line.trim().split(/\s+/)[3] ?? '';
    const cut = local.lastIndexOf(':');
    if (cut < 0) continue;
    const port = Number(local.slice(cut + 1));
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;

    const addr = local.slice(0, cut);
    // A wildcard bind covers loopback, so 127.0.0.1 reaches the same socket.
    // A specific non-loopback address does not imply loopback at all.
    if (addr === '0.0.0.0' || addr === '*' || addr === '127.0.0.1') {
      found.set(port, `http://127.0.0.1:${port}/v1`);
    } else if (addr === '[::]' || addr === '[::1]') {
      if (!found.has(port)) found.set(port, `http://[::1]:${port}/v1`);
    }
  }

  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, base]) => base);
}
