/**
 * Hands-free config resolution — the master switch and active-model lookup for
 * the persistence machinery (Options A-D). Auto-ON by default: hands-free
 * persistence applies to any project with an active completion ledger unless
 * explicitly disabled via `UAP_HANDSFREE=0` or `.uap.json` handsfree.enabled=false.
 */

import { loadUapConfigRaw } from '../utils/config-loader.js';
import type { PersistenceConfig } from './persistence-profile.js';

/** Resolve the persistence config from env + .uap.json (fail-soft, default ON). */
export function loadPersistenceConfig(cwd: string = process.cwd()): PersistenceConfig {
  if (process.env.UAP_HANDSFREE === '0') return { enabled: false };
  let raw: Record<string, unknown> = {};
  try {
    raw = (loadUapConfigRaw(cwd) as Record<string, unknown>) ?? {};
  } catch {
    raw = {};
  }
  const hf = (raw.handsfree as PersistenceConfig | undefined) ?? {};
  const envIntensity = process.env.UAP_HANDSFREE_INTENSITY as PersistenceConfig['intensity'] | undefined;
  return {
    enabled: hf.enabled !== false && process.env.UAP_HANDSFREE !== '0',
    ...(envIntensity ? { intensity: envIntensity } : hf.intensity ? { intensity: hf.intensity } : {}),
    ...(hf.overrides ? { overrides: hf.overrides } : {}),
    // Fix C: pre-ledger nudge, default ON; disable via config or UAP_HANDSFREE_PRELEDGER=0.
    preLedgerNudge: hf.preLedgerNudge !== false && process.env.UAP_HANDSFREE_PRELEDGER !== '0',
  };
}

/** The model doing the work — env override, else the executor role, else unknown. */
export function resolveActiveModel(cwd: string = process.cwd()): string {
  if (process.env.UAP_ACTIVE_MODEL) return process.env.UAP_ACTIVE_MODEL;
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  try {
    const raw = (loadUapConfigRaw(cwd) as Record<string, unknown>) ?? {};
    const mm = raw.multiModel as { roles?: { executor?: string } } | undefined;
    if (mm?.roles?.executor) return mm.roles.executor;
  } catch {
    /* fall through */
  }
  return 'unknown';
}
