/**
 * Shared resolver for default-ON delivery toggles — one implementation of
 * the precedence contract so the per-feature resolvers cannot drift
 * (correctness-review findings 8/13, evidence-gates uplift):
 *
 *   env (exact var) > caller-provided deliverCfg key > config file > ON
 *
 * The caller-provided vs config-file distinction matters: when a caller
 * passes a `deliverCfg` it already loaded from the MISSION root (deliver.ts
 * loads `projectRoot`'s .uap.json for the banner readout), a missing key
 * means "unset → default", NOT "re-read a different root's config". The
 * config file is only consulted when no deliverCfg was provided at all —
 * the in-pipeline call sites (epic-mission, mission-acceptance) resolve
 * against the mission root they are executing in.
 *
 * Any of `0|false|off|no` (case-insensitive) disables; everything else
 * (including set-but-invalid) fails safe to ON, matching the delivery
 * layer's convention.
 */

import { loadUapConfigRaw } from '../utils/config-loader.js';

const OFF = /^(0|false|off|no)$/i;

export function resolveDeliverToggle(
  env: NodeJS.ProcessEnv,
  envVar: string,
  deliverCfg: Record<string, unknown> | undefined,
  cfgKey: string,
  cwd: string = process.cwd()
): boolean {
  const envRaw = env[envVar];
  if (envRaw !== undefined) return !OFF.test(envRaw);
  if (deliverCfg !== undefined) {
    const raw = deliverCfg[cfgKey];
    return raw === undefined ? true : !OFF.test(String(raw));
  }
  let fromFile: unknown;
  try {
    const deliver = ((loadUapConfigRaw(cwd) ?? {}) as Record<string, unknown>).deliver as
      | Record<string, unknown>
      | undefined;
    fromFile = deliver?.[cfgKey];
  } catch {
    fromFile = undefined;
  }
  return fromFile === undefined ? true : !OFF.test(String(fromFile));
}
