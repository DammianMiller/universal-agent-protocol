/**
 * ROUTING CORPUS — loads the routable surfaces (patterns, droids, skills)
 * into a uniform entry list for the routing eval harness.
 *
 * The eval measures whether each entry's description keeps it rank-1
 * separable as the registry grows (agent-dev-team precedent: routing evals
 * with planted traps, CI-enforced).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type RoutingKind = 'pattern' | 'droid' | 'skill';

export interface RoutingEntry {
  /** Unique key: "<kind>:<id>" — e.g. "pattern:12", "droid:qa-expert". */
  key: string;
  kind: RoutingKind;
  /** Bare id within the kind (pattern id, droid/skill name). */
  id: string;
  name: string;
  /** Text the ranker embeds: name + description (+ keywords for patterns). */
  text: string;
  /** True when a real frontmatter description was found (false = body fallback). */
  hasDescription: boolean;
  /** Repo-relative source path. */
  source: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
}

/** Minimal frontmatter parser — single-line `key: value` for name/description only. */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.+)$/);
    if (kv) out[kv[1] as keyof Frontmatter] = kv[2].trim();
  }
  return out;
}

/** First non-heading, non-empty body paragraph, for entries without a description. */
export function bodyFallback(content: string, maxLen = 300): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 20) continue;
    if (line.startsWith('#') || line.startsWith('>') || line.startsWith('-') || line.startsWith('|')) continue;
    return line.slice(0, maxLen);
  }
  return '';
}

function loadPatterns(projectDir: string): RoutingEntry[] {
  const indexPath = join(projectDir, '.factory/patterns/index.json');
  if (!existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      patterns: Array<{
        id: string | number;
        title: string;
        category: string;
        keywords: string[];
      }>;
    };
    return data.patterns.map((p) => ({
      key: `pattern:${p.id}`,
      kind: 'pattern' as const,
      id: String(p.id),
      name: p.title,
      text: `${p.title} ${p.category} ${(p.keywords ?? []).join(' ')}`,
      hasDescription: true,
      source: '.factory/patterns/index.json',
    }));
  } catch (error) {
    // A malformed index.json must fail loudly with context — swallowing it
    // resurfaces later as a misleading "corpus is empty" error.
    throw new Error(
      `failed to parse ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadMarkdownEntry(
  kind: RoutingKind,
  filePath: string,
  source: string,
  fallbackName: string,
): RoutingEntry | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);
  const name = fm.name ?? fallbackName;
  const description = fm.description ?? bodyFallback(content);
  if (!description) return null; // unroutable: no text to embed at all
  return {
    key: `${kind}:${name}`,
    kind,
    id: name,
    name,
    text: `${name} ${description}`,
    hasDescription: fm.description !== undefined,
    source,
  };
}

function loadDroids(projectDir: string): RoutingEntry[] {
  const dir = join(projectDir, '.factory/droids');
  if (!existsSync(dir)) return [];
  const entries: RoutingEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const entry = loadMarkdownEntry(
      'droid',
      join(dir, file),
      `.factory/droids/${file}`,
      file.replace(/\.md$/, ''),
    );
    if (entry) entries.push(entry);
  }
  return entries;
}

function loadSkills(projectDir: string): RoutingEntry[] {
  const dir = join(projectDir, '.factory/skills');
  if (!existsSync(dir)) return [];
  const entries: RoutingEntry[] = [];
  for (const item of readdirSync(dir)) {
    const full = join(dir, item);
    // throwIfNoEntry: a dangling symlink or vanished entry skips, not crashes.
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      const skillFile = join(full, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const entry = loadMarkdownEntry('skill', skillFile, `.factory/skills/${item}/SKILL.md`, item);
      if (entry) entries.push(entry);
    } else if (item.endsWith('.md') && item !== 'SKILL-TEMPLATE.md') {
      const entry = loadMarkdownEntry(
        'skill',
        full,
        `.factory/skills/${item}`,
        item.replace(/\.md$/, ''),
      );
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

const LOADERS: Record<RoutingKind, (projectDir: string) => RoutingEntry[]> = {
  pattern: loadPatterns,
  droid: loadDroids,
  skill: loadSkills,
};

/** Load all (or selected) routing surfaces from a project directory. */
export function loadRoutingCorpus(
  projectDir: string,
  kinds: RoutingKind[] = ['pattern', 'droid', 'skill'],
): RoutingEntry[] {
  const seen = new Set<string>();
  const entries: RoutingEntry[] = [];
  for (const kind of kinds) {
    for (const entry of LOADERS[kind](projectDir)) {
      if (seen.has(entry.key)) continue; // e.g. duplicate droid name
      seen.add(entry.key);
      entries.push(entry);
    }
  }
  return entries;
}
