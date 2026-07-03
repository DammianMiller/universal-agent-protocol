/**
 * Reactor injection for the implementation-state manifest: give every agent
 * session real knowledge of what the project is and its exact implementation
 * state (version, branch, latest shipped changes) — machine-derived, so it
 * cannot drift the way hand-written docs do.
 *
 * Deduped per session via the `state:manifest` surfaced key; fail-soft.
 */

import { readOrRefreshManifest, manifestDigest } from './manifest.js';

/**
 * Return the project-state digest for injection, or null when the directory
 * has no manifest-worthy ground truth (no package.json) or anything fails.
 */
export function maybeStateInjection(cwd: string): string | null {
  try {
    const manifest = readOrRefreshManifest(cwd);
    if (!manifest) return null;
    return manifestDigest(manifest);
  } catch {
    return null;
  }
}
