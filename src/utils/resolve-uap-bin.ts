/**
 * Resolve the uap executable for detached child spawns (deliver launch/resume,
 * fleet dashboard spawn-on-demand).
 *
 * PATH often lacks the npm global bin, and a launch that silently died with
 * ENOENT was a real dash-audit hazard. Resolution order:
 *   1. UAP_BIN env override (operator/debug).
 *   2. This module's own install: <root>/dist/bin/cli.js run with the SAME
 *      node binary that runs the dashboard (no PATH, no shell).
 *   3. Bare 'uap' as the last resort (interactive PATH).
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export function resolveUapBin(): { cmd: string; preArgs: string[] } {
  if (process.env.UAP_BIN) return { cmd: process.env.UAP_BIN, preArgs: [] };
  try {
    // ESM: this file is <root>/dist/utils/resolve-uap-bin.js
    const selfUrl = import.meta.url;
    if (selfUrl.startsWith('file:')) {
      const here = fileURLToPath(selfUrl);
      const cli = join(dirname(here), '..', 'bin', 'cli.js');
      if (existsSync(cli)) return { cmd: process.execPath, preArgs: [cli] };
    }
  } catch {
    /* fall through to PATH */
  }
  return { cmd: 'uap', preArgs: [] };
}
