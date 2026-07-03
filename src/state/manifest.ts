/**
 * Implementation-State Manifest — a machine-generated snapshot of what this
 * project IS and where its implementation actually stands, derived from
 * ground truth (package.json, CHANGELOG, git branch, .factory registries)
 * rather than hand-maintained docs that drift.
 *
 * Written to `.uap/state-manifest.json`; the reactor injects a one-line
 * digest per session so every agent starts with real knowledge of the
 * project's exact state. Regeneration is cheap (fs-only, no model calls) and
 * fail-soft.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface StateManifest {
  name: string;
  version: string;
  generatedAt: string;
  branch?: string;
  /** Latest CHANGELOG headings, newest first — the real "what shipped lately". */
  recentChanges: string[];
  /** Registry counts when the project has them (skills/droids/patterns). */
  counts?: Record<string, number>;
}

const RECENT_CHANGES = 5;
/** Digest re-generation threshold: a manifest older than this is stale. */
const STALE_MS = 24 * 60 * 60 * 1000;

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, '.uap', 'state-manifest.json');
}

function gitBranch(projectRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Never inherit a poisoned GIT_DIR from a hook environment.
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    });
    const branch = out.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function countEntries(dir: string): number | undefined {
  try {
    if (!existsSync(dir)) return undefined;
    return readdirSync(dir).filter((f) => !f.startsWith('.')).length;
  } catch {
    return undefined;
  }
}

/**
 * Build the manifest from project ground truth. Returns null when the
 * directory has no package.json (nothing authoritative to report).
 */
export function generateStateManifest(projectRoot: string): StateManifest | null {
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  const name = typeof pkg.name === 'string' ? pkg.name : 'unknown';
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

  const recentChanges: string[] = [];
  try {
    const changelog = readFileSync(join(projectRoot, 'CHANGELOG.md'), 'utf-8');
    for (const line of changelog.split('\n')) {
      if (line.startsWith('## ')) {
        recentChanges.push(line.slice(3).trim().slice(0, 160));
        if (recentChanges.length >= RECENT_CHANGES) break;
      }
    }
  } catch {
    // no changelog — manifest still useful
  }

  const counts: Record<string, number> = {};
  const skillCount = countEntries(join(projectRoot, '.factory', 'skills'));
  const droidCount = countEntries(join(projectRoot, '.factory', 'droids'));
  if (skillCount !== undefined) counts.skills = skillCount;
  if (droidCount !== undefined) counts.droids = droidCount;
  try {
    const patterns = JSON.parse(
      readFileSync(join(projectRoot, '.factory', 'patterns', 'index.json'), 'utf-8')
    ) as { patterns?: unknown[] };
    if (Array.isArray(patterns.patterns)) counts.patterns = patterns.patterns.length;
  } catch {
    // optional registry
  }

  return {
    name,
    version,
    generatedAt: new Date().toISOString(),
    branch: gitBranch(projectRoot),
    recentChanges,
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
  };
}

/** Generate + persist the manifest atomically. Returns it, or null on failure. */
export function writeStateManifest(projectRoot: string): StateManifest | null {
  const manifest = generateStateManifest(projectRoot);
  if (!manifest) return null;
  // Persist only where the project already carries UAP state — never scaffold
  // .uap/ into an arbitrary repo as a session side effect. The in-memory
  // manifest is still returned for injection either way.
  if (!existsSync(join(projectRoot, '.uap'))) return manifest;
  try {
    const path = manifestPath(projectRoot);
    mkdirSync(join(projectRoot, '.uap'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
    renameSync(tmp, path);
    return manifest;
  } catch {
    return manifest; // manifest is still usable in-memory even if persist failed
  }
}

/** Read the persisted manifest; regenerate when missing or stale. */
export function readOrRefreshManifest(projectRoot: string): StateManifest | null {
  const path = manifestPath(projectRoot);
  try {
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs < STALE_MS) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StateManifest;
      if (parsed && typeof parsed.version === 'string') return parsed;
    }
  } catch {
    // fall through to regeneration
  }
  return writeStateManifest(projectRoot);
}

/** Compact single-block digest for prompt injection (≤ ~400 chars). */
export function manifestDigest(manifest: StateManifest): string {
  const lines = [
    `${manifest.name} v${manifest.version}${manifest.branch ? ` (branch: ${manifest.branch})` : ''}`,
  ];
  if (manifest.recentChanges.length > 0) {
    lines.push(`Recently shipped: ${manifest.recentChanges.slice(0, 3).join(' | ')}`.slice(0, 240));
  }
  if (manifest.counts) {
    lines.push(
      Object.entries(manifest.counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')
    );
  }
  return lines.join('\n');
}
