/**
 * Shared UAP config loading utility.
 * Replaces 20+ duplicate config-loading patterns across CLI modules.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { AgentContextConfigSchema } from '../types/index.js';
import type { AgentContextConfig } from '../types/index.js';

/**
 * Find the .uap.json config file path, searching cwd and parent directories.
 * Supports worktree layouts where .uap.json is in the project root above .worktrees/.
 */
export function findUapConfigPath(cwd: string = process.cwd()): string | null {
  // Check cwd first
  const direct = join(cwd, '.uap.json');
  if (existsSync(direct)) return direct;

  // Check parent directories (for worktree support: .worktrees/NNN-slug/../../.uap.json)
  let dir = dirname(cwd);
  for (let i = 0; i < 3; i++) {
    const parentPath = join(dir, '.uap.json');
    if (existsSync(parentPath)) return parentPath;
    const nextDir = dirname(dir);
    if (nextDir === dir) break; // reached filesystem root
    dir = nextDir;
  }

  return null;
}

/**
 * Load and parse .uap.json config from a project directory.
 * Returns null if the config file doesn't exist or fails to parse.
 * Searches parent directories for worktree support.
 */
export function loadUapConfig(cwd: string = process.cwd()): AgentContextConfig | null {
  const configPath = findUapConfigPath(cwd);
  if (!configPath) return null;

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return AgentContextConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Load .uap.json config or return a minimal default config.
 * Never returns null — always provides a usable config object.
 */
export function loadUapConfigOrDefault(cwd: string = process.cwd()): AgentContextConfig {
  return (
    loadUapConfig(cwd) ??
    AgentContextConfigSchema.parse({
      version: '1.0.0',
      project: { name: 'unknown' },
    })
  );
}

/**
 * Load raw .uap.json as untyped JSON (for read-modify-write operations).
 * Preserves unknown fields that AgentContextConfigSchema.parse() would strip.
 * Returns null if the file doesn't exist.
 */
export function loadUapConfigRaw(cwd: string = process.cwd()): Record<string, unknown> | null {
  const configPath = findUapConfigPath(cwd);
  if (!configPath) return null;

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Load, modify, and save .uap.json (for read-modify-write operations).
 * The modifier function receives the raw JSON and returns the modified version.
 * Preserves unknown fields and formatting.
 */
export function modifyUapConfig(
  cwd: string,
  modifier: (config: Record<string, unknown>) => Record<string, unknown>
): void {
  const configPath = findUapConfigPath(cwd) || join(cwd, '.uap.json');
  let raw: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Start fresh if parse fails
    }
  }

  const modified = modifier(raw);
  writeFileSync(configPath, JSON.stringify(modified, null, 2) + '\n');
}
