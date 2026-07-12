/**
 * LLM Self-Tuning — the Flag Writer (P1): atomic, validated, rollback-safe
 * application of a tuning proposal to the real UAP configuration.
 *
 * A tuning step applies a `FlagChange[]` across three destinations:
 *   - `.uap.json`      — json-kind settings (recipes.*, memory.*, delivery.*, …)
 *   - `.uap/proxy.env` — proxyEnv-kind settings (PROXY_* the proxy loads at start)
 *   - a `shellEnv` map — shell-kind runtime toggles the orchestrator injects into
 *                        the benchmark child process (no file the proxy sources)
 *
 * It reuses the registry's `applySetting` so every write goes through the SAME
 * bounds/enum validation as `uap config set` — an out-of-range value can never
 * corrupt `.uap.json` and trigger the strict-parse config wipe. Before touching
 * anything it snapshots the raw bytes of both files, so `rollback()` restores
 * the exact prior state (including "file did not exist") after a rejected trial.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { findUapConfigPath } from '../utils/config-loader.js';
import { applySetting } from '../cli/config-command.js';
import { getSetting } from '../config/settings-registry.js';
import { FlagChange, FlagConfig, coerceToDomain, configToChanges, getTunableFlag } from './flags.js';

/** Resolve the two files a flag write can touch, given a cwd. */
function targetPaths(cwd: string): { uapJson: string; proxyEnv: string } {
  const uapJson = findUapConfigPath(cwd) ?? join(cwd, '.uap.json');
  const root = dirname(uapJson);
  return { uapJson, proxyEnv: join(root, '.uap', 'proxy.env') };
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content: string | null;
}

function snapshot(path: string): FileSnapshot {
  const existed = existsSync(path);
  return { path, existed, content: existed ? readFileSync(path, 'utf-8') : null };
}

function restore(snap: FileSnapshot): void {
  if (snap.existed && snap.content != null) {
    mkdirSync(dirname(snap.path), { recursive: true });
    writeFileSync(snap.path, snap.content, 'utf-8');
  } else if (!snap.existed && existsSync(snap.path)) {
    rmSync(snap.path, { force: true });
  }
}

export interface ApplyFlagsResult {
  /** Changes that were validated and persisted (or staged into shellEnv). */
  applied: FlagChange[];
  /** Changes that could not be applied, with the reason. */
  skipped: { change: FlagChange; reason: string }[];
  /**
   * Env vars for shell-kind flags. These are NOT persisted to a file (nothing
   * sources them); the orchestrator injects them into the benchmark child env.
   */
  shellEnv: Record<string, string>;
  /** Restore `.uap.json` + `.uap/proxy.env` to their exact pre-apply bytes. */
  rollback(): void;
}

export interface ApplyFlagsOptions {
  /** Validate + compute effects without writing anything (rollback is a no-op). */
  dryRun?: boolean;
}

/**
 * Apply a set of flag changes. json/proxyEnv writes go through `applySetting`
 * (validated); shell flags are collected for the child env. Every change is
 * value-coerced to its flag domain first, so a proposal that overshoots a range
 * is clamped rather than rejected. Returns a `rollback()` that undoes all file
 * writes atomically.
 */
export function applyFlagChanges(
  cwd: string,
  changes: FlagChange[],
  opts: ApplyFlagsOptions = {},
): ApplyFlagsResult {
  const { uapJson, proxyEnv } = targetPaths(cwd);
  const snaps = [snapshot(uapJson), snapshot(proxyEnv)];

  const applied: FlagChange[] = [];
  const skipped: { change: FlagChange; reason: string }[] = [];
  const shellEnv: Record<string, string> = {};

  for (const change of changes) {
    const flag = getTunableFlag(change.key);
    const setting = getSetting(change.key);
    if (!flag || !setting) {
      skipped.push({ change, reason: `not a tunable/registry flag: ${change.key}` });
      continue;
    }
    const coerced = coerceToDomain(change.key, change.to);
    if (coerced === null) {
      skipped.push({ change, reason: `value out of domain: ${String(change.to)}` });
      continue;
    }
    const rawValue = String(coerced);

    // Shell-kind flags never persist to a file — stage them for the child env.
    if (setting.kind === 'env' && setting.target === 'shell') {
      shellEnv[setting.key] = rawValue;
      applied.push({ ...change, to: coerced });
      continue;
    }

    if (opts.dryRun) {
      applied.push({ ...change, to: coerced });
      continue;
    }

    const res = applySetting(cwd, setting, rawValue);
    if (res.ok) {
      applied.push({ ...change, to: coerced });
    } else {
      skipped.push({ change, reason: res.message });
    }
  }

  return {
    applied,
    skipped,
    shellEnv,
    rollback(): void {
      if (opts.dryRun) return;
      for (const s of snaps) restore(s);
    },
  };
}

/** Apply an entire FlagConfig (every flag → its value). Returns the same handle. */
export function applyFlagConfig(
  cwd: string,
  config: FlagConfig,
  opts: ApplyFlagsOptions = {},
): ApplyFlagsResult {
  return applyFlagChanges(cwd, configToChanges(config), opts);
}
