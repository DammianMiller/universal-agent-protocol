/**
 * Shared proxy-env resolution for the placement domain (spec §4.3/§4.6).
 *
 * Lives in src/placement/ — NOT imported from src/cli/ — so the domain layer
 * (consumed by both the CLI and the dashboard) never reaches into a surface
 * layer. src/cli/systemd-services.ts re-exports readProxyEnvVar for its
 * existing callers.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Absolute path to the proxy's systemd EnvironmentFile. */
export function proxyEnvPath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'uap', 'anthropic-proxy.env');
}

/**
 * Read the last (last-wins) value of KEY in the proxy env file, or null if the
 * file is missing or the key is unset. Used to honor an operator local-only pin
 * before overwriting ANTHROPIC_PASSTHROUGH_MODELS.
 */
export function readProxyEnvVar(key: string, homeDir: string = homedir()): string | null {
  const path = proxyEnvPath(homeDir);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(`${key}=`)) return lines[i].slice(key.length + 1);
  }
  return null;
}

/**
 * One resolution of the loopback proxy base URL + auth headers (process env
 * wins, then the proxy env file, then the loopback default). Previously two
 * copies in enforce.ts drifted silently; one composer now.
 */
export function proxyBaseAndHeaders(
  opts: { proxyBaseUrl?: string; proxyToken?: string } = {},
): { base: string; headers: Record<string, string> } {
  const base = (opts.proxyBaseUrl ?? process.env.UAP_PROXY_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
  const token = opts.proxyToken ?? process.env.PROXY_AUTH_TOKEN ?? readProxyEnvVar('PROXY_AUTH_TOKEN') ?? '';
  return { base, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}
