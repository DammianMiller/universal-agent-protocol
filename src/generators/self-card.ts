/**
 * S2 · Self-knowledge card — UAP's own manual, generated from the docs that
 * ship inside the installed package.
 *
 * After Lynch's "agents have never heard of agents" (mtlynch.io, "Why Are
 * Coding Agents So Dumb?"): an agent that must search online to learn its own
 * features wastes turns and self-describes from stale sources. The card is the
 * fix: a small, version-pinned digest of the command surface and feature
 * catalog, built offline from `docs/reference/CLI.md` and
 * `docs/reference/FEATURES.md` (both inside the npm package's `files`), cached
 * in the project's `.uap/`, and searchable locally with `uap self query`.
 *
 * Contract notes:
 * - Fail-open, like every session-surface helper: missing or unreadable docs
 *   return an `ok: false` result, never a throw.
 * - The cache is pinned by (installed version + sha256 of the source docs);
 *   editing a shipped doc or upgrading UAP regenerates it on next touch.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface SelfCardCommand {
  command: string;
  /** Backticked aliases from the index row (e.g. `hf` for handsfree). */
  aliases: string[];
  purpose: string;
}

export interface SelfCardFeature {
  subsystem: string;
  feature: string;
  description: string;
}

export interface SelfCard {
  version: string;
  commands: SelfCardCommand[];
  features: SelfCardFeature[];
  markdown: string;
  /** sha256 over version + both source docs — the cache pin. */
  fingerprint: string;
}

export type SelfCardBuildResult =
  | { ok: true; card: SelfCard }
  | { ok: false; reason: string };

export type SelfCardEnsureResult =
  | { ok: true; card: SelfCard; path: string; fresh: boolean }
  | { ok: false; reason: string; path: string; fresh: boolean };

/** Longest feature description kept in the card — protects the size budget. */
const MAX_FEATURE_CHARS = 220;

/** ESM-safe package root (src/generators → repo; dist/generators → package). */
export function selfCardPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function installedUapVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Source parsers (both shipped docs are markdown tables — kept tolerant)
// ---------------------------------------------------------------------------

/** Rows of CLI.md's `## Command index` table. */
export function parseCliIndex(cliMd: string): SelfCardCommand[] {
  const commands: SelfCardCommand[] = [];
  let inIndex = false;
  for (const line of cliMd.split('\n')) {
    if (/^## /.test(line)) inIndex = /^## Command index/i.test(line);
    if (!inIndex || !line.startsWith('|')) continue;
    if (/^\|[\s:-]+\|[\s|:-]*$/.test(line)) continue; // separator row
    const row = line.replace(/^\|/, '').replace(/\|\s*$/, '');
    const sep = row.indexOf('|');
    if (sep === -1) continue;
    const cmdCell = row.slice(0, sep);
    const purpose = row
      .slice(sep + 1)
      .replace(/[\`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const tokens = [...cmdCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (tokens.length > 0) commands.push({ command: tokens[0], aliases: tokens.slice(1), purpose });
  }
  return commands;
}

/** FEATURES.md subsystem headings + feature tables. */
export function parseFeatures(featuresMd: string): SelfCardFeature[] {
  const features: SelfCardFeature[] = [];
  let subsystem = '';
  // The FIRST non-separator table row under each heading is the markdown
  // header ("| Feature | Description |", "| Subsystem | Description |") —
  // not a feature. Skipping it by position (not by guessing header words)
  // keeps real doc restructures from injecting junk entries into the card.
  let tableHeaderSeen = false;
  for (const line of featuresMd.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      subsystem = h[1].trim();
      tableHeaderSeen = false;
      continue;
    }
    if (!subsystem || !line.startsWith('|')) continue;
    if (/^\|[\s:-]+\|[\s|:-]*$/.test(line)) continue;
    if (!tableHeaderSeen) {
      tableHeaderSeen = true; // consume the header row
      continue;
    }
    const row = line.replace(/^\|/, '').replace(/\|\s*$/, '');
    const sep = row.indexOf('|');
    if (sep === -1) continue;
    const feature = row.slice(0, sep).replace(/[\`*]/g, '').replace(/\s+/g, ' ').trim();
    let description = row
      .slice(sep + 1)
      .replace(/[\`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (description.length > MAX_FEATURE_CHARS) {
      description = description.slice(0, MAX_FEATURE_CHARS - 1).trimEnd() + '…';
    }
    if (feature && description) features.push({ subsystem, feature, description });
  }
  return features;
}

// ---------------------------------------------------------------------------
// Card assembly
// ---------------------------------------------------------------------------

export function buildSelfCard(packageRoot: string = selfCardPackageRoot()): SelfCardBuildResult {
  const cliPath = join(packageRoot, 'docs', 'reference', 'CLI.md');
  const featuresPath = join(packageRoot, 'docs', 'reference', 'FEATURES.md');
  if (!existsSync(cliPath) && !existsSync(featuresPath)) {
    return { ok: false, reason: 'shipped docs not found (CLI.md and FEATURES.md absent)' };
  }
  const cliMd = existsSync(cliPath) ? readFileSync(cliPath, 'utf-8') : '';
  const featuresMd = existsSync(featuresPath) ? readFileSync(featuresPath, 'utf-8') : '';
  const commands = parseCliIndex(cliMd);
  const features = parseFeatures(featuresMd);
  if (commands.length === 0 && features.length === 0) {
    return { ok: false, reason: 'shipped docs parse to an empty card (no commands, no features)' };
  }
  const version = installedUapVersion(packageRoot);
  const fingerprint = createHash('sha256')
    .update(`${version}\n${cliMd}\n\x00${featuresMd}\n`)
    .digest('hex');

  const lines: string[] = [
    `<!-- uap-self-card version=${version} fingerprint=${fingerprint} do-not-hand-edit -->`,
    `# UAP self-card — v${version}`,
    '',
    "UAP's own manual, generated offline from the docs shipped inside the package.",
    "Query it: `uap self query \"<question>\"`. A stale pin regenerates automatically.",
    '',
    `## Command index (${commands.length})`,
    '',
  ];
  for (const c of commands) {
    const alias = c.aliases.length > 0 ? ` (${c.aliases.join(' ')})` : '';
    lines.push(`- \`${c.command}\`${alias} — ${c.purpose}`);
  }
  lines.push('', `## Feature catalog (${features.length})`, '');
  let subsystem = '';
  for (const f of features) {
    if (f.subsystem !== subsystem) {
      subsystem = f.subsystem;
      lines.push(`### ${subsystem}`, '');
    }
    lines.push(`- **${f.feature}** — ${f.description}`);
  }
  lines.push('');
  return {
    ok: true,
    card: { version, commands, features, markdown: lines.join('\n'), fingerprint },
  };
}

// ---------------------------------------------------------------------------
// Version-pinned cache
// ---------------------------------------------------------------------------

/**
 * State dir shared with plan.ts's stateDir convention: UAP_STATE_DIR may be
 * ABSOLUTE (the gate hook exports $MAIN_ROOT/.uap), and a naive join would
 * concatenate the absolute segment onto cwd.
 */
function stateDir(cwd: string): string {
  const dir = process.env.UAP_STATE_DIR || '.uap';
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

export function selfCardPath(cwd: string): string {
  return join(stateDir(cwd), 'self-card.md');
}

const PIN_RE = /<!-- uap-self-card version=([^\s]+) fingerprint=([a-f0-9]+) /;

export interface EnsureSelfCardOptions {
  /** Force a rebuild even when the cached pin matches. */
  refresh?: boolean;
  /** Override the package root (tests point this at fixture docs). */
  packageRoot?: string;
}

export function ensureSelfCard(
  cwd: string,
  options: EnsureSelfCardOptions = {}
): SelfCardEnsureResult {
  const path = selfCardPath(cwd);
  const build = buildSelfCard(options.packageRoot ?? selfCardPackageRoot());
  if (!build.ok) return { ...build, path, fresh: false };
  const { card } = build;
  let cached = '';
  try {
    cached = readFileSync(path, 'utf-8');
  } catch {
    cached = '';
  }
  const pin = cached.match(PIN_RE);
  if (!options.refresh && pin && pin[2] === card.fingerprint) {
    return { ok: true, card, path, fresh: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, card.markdown);
  return { ok: true, card, path, fresh: true };
}

// ---------------------------------------------------------------------------
// Offline search
// ---------------------------------------------------------------------------

export interface SelfCardHit {
  heading: string;
  text: string;
  score: number;
}

const STOPWORDS = new Set([
  'how', 'do', 'does', 'i', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'is',
  'are', 'what', 'which', 'my', 'me', 'can', 'uap', 'with', 'and', 'on',
]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\w-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function occurrences(haystack: string, escapedTerm: string): number {
  const re = new RegExp(`\\b${escapedTerm}\\b`, 'gi');
  return (haystack.match(re) ?? []).length;
}

function escapeRe(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ranked keyword search over the card's bullet chunks (commands + features),
 * with heading context. Deterministic, offline, stateless. Pure function of
 * the markdown, so it also serves the cached card without rebuilds.
 */
export function searchSelfCard(markdown: string, query: string, limit = 5): SelfCardHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const hits: SelfCardHit[] = [];
  let heading = '';
  for (const line of markdown.split('\n')) {
    const h = line.match(/^#{1,3} (.+)$/);
    if (h) {
      heading = h[1].replace(/^uap self-card.*$/i, 'UAP self-card').trim();
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const cmdMatch = line.match(/^- `([^`]+)`(?: \(([^)]*)\))?/);
    // Command names AND aliases compete for the exact/prefix bonus, so `hf`
    // lands on the handsfree command just like the full name does.
    const names = cmdMatch
      ? [cmdMatch[1], ...(cmdMatch[2] ? cmdMatch[2].split(/\s+/) : [])]
      : [];
    const score = terms.reduce((acc, raw) => {
      const t = escapeRe(raw);
      const prefixBonus = names.some(
        (n) => n.toLowerCase().startsWith(raw) || raw.startsWith(n.toLowerCase())
      )
        ? 3
        : 0;
      return (
        acc +
        occurrences(heading, t) * 4 +
        occurrences(line, t) * 2 +
        prefixBonus +
        (names.includes(raw) ? 3 : 0)
      );
    }, 0);
    if (score > 0) hits.push({ heading, text: line.slice(2).trim(), score });
  }
  // Array#sort is stable, so equal scores keep card order — deterministic.
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, limit));
}
