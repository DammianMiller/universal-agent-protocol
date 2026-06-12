/**
 * Spec Transitive-Import Protection
 *
 * A protected spec is only as trustworthy as its oracle material: helpers
 * that build expectations, fixtures/data files holding expected output, and
 * mocks shaping the environment. If those live OUTSIDE test directories the
 * applier's test-file protection misses them, and a model can satisfy the
 * spec by rewriting what it asserts against.
 *
 * This module walks each spec's import graph and protects what specs import
 * as oracle material:
 *
 *  - relative imports resolving into fixture/helper/mock-conventional
 *    locations (directory segments or basename markers)
 *  - data files (.json/.yaml/.txt/.csv/.snap/…) — referenced via imports OR
 *    quoted string literals (readFileSync paths), since a data file imported
 *    by a spec is expected-output material, never the unit under test
 *  - the transitive imports of anything protected above (helper chains)
 *
 * Deliberately NOT protected: plain code the spec imports (../src/duration)
 * — that is the unit under test, the very thing the model must write.
 * Distinguishing "helper" from "implementation" beyond naming conventions is
 * undecidable here; the conventional set keeps brownfield delivery possible
 * while closing the fixture/helper channel. All analysis is fail-soft.
 */

import { readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { isTestFilePath, listTestFiles } from './applier.js';

/** Directory names whose contents are oracle material when a spec imports them. */
const ORACLE_DIR_SEGMENTS = new Set([
  'fixtures',
  'fixture',
  '__fixtures__',
  'helpers',
  'helper',
  'mocks',
  'mock',
  '__mocks__',
  'stubs',
  'stub',
  'testdata',
  'test-data',
  'test-utils',
  'testutils',
  '__snapshots__',
  'snapshots',
  'golden',
  'goldens',
]);

/** Basename markers for oracle files outside conventional directories.
 * `setup`/`matchers` cover runner bootstrap files (vitest.setup.ts,
 * custom-matcher modules) that shape what "passing" means. */
const ORACLE_BASENAME_RE =
  /\.(fixture|fixtures|mock|mocks|stub|stubs|helper|helpers|setup|matchers?)\.[^.]+$/;

const DATA_EXTS = 'json|jsonc|json5|ya?ml|txt|csv|tsv|xml|html|snap|golden';

/** Data extensions: imported/referenced by a spec ⇒ expected-output material. */
const DATA_EXT_RE = new RegExp(`\\.(${DATA_EXTS})$`, 'i');

/** import/export-from/dynamic-import/require/side-effect-import specifiers.
 * Matches inside comments/strings too — over-protection only, accepted.
 * The clause length cap bounds regex cost on minified/pathological lines. */
const IMPORT_RE =
  /(?:import|export)\s[^'"`;]{0,2048}?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

/** Quoted relative-ish paths with data extensions (readFileSync etc.). */
const DATA_LITERAL_RE = new RegExp(`['"]([^'"\\n]{1,300}?\\.(?:${DATA_EXTS}))['"]`, 'gi');

const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_SPEC_BYTES = 2_000_000;
const MAX_GRAPH_FILES = 500;
const MAX_GRAPH_DEPTH = 8;
const MAX_GRAPH_BYTES = 20_000_000;

export interface ProtectionSnapshot {
  /** Lower-cased relative paths for the applier membership check */
  protectedFiles: Set<string>;
  /** Original-case paths for prompts/diagnostics */
  display: string[];
}

/** True when `rel` ('/'-separated) is oracle material by location or name. */
export function isOraclePath(rel: string): boolean {
  const segments = rel.split('/');
  const base = segments[segments.length - 1].toLowerCase();
  if (base === 'conftest.py') return true;
  if (segments.slice(0, -1).some((s) => ORACLE_DIR_SEGMENTS.has(s.toLowerCase()))) return true;
  if (ORACLE_BASENAME_RE.test(base)) return true;
  return DATA_EXT_RE.test(base);
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Expand a resolved base path the way bundlers/loaders do — exact file,
 * TS-style .js→.ts swap, appended extensions, directory index — returning
 * EVERY existing root-relative candidate ('/'-separated). This is
 * protection, not module resolution, so when both x.js and x.ts exist we
 * protect both rather than guess which one the runner loads.
 */
function resolveFromBase(baseAbs: string, projectRootAbs: string): string[] {
  const candidates: string[] = [baseAbs];
  // TS sources import emitted-name './x.js' while the file on disk is x.ts
  const jsSwap = baseAbs.match(/^(.*)\.([mc]?)js$/);
  if (jsSwap) {
    candidates.push(`${jsSwap[1]}.${jsSwap[2]}ts`, `${jsSwap[1]}.tsx`);
  }
  for (const ext of CODE_EXTS) candidates.push(baseAbs + ext);
  for (const ext of CODE_EXTS) candidates.push(resolve(baseAbs, `index${ext}`));

  const found: string[] = [];
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const rel = relative(projectRootAbs, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    found.push(rel.split(sep).join('/'));
  }
  return found;
}

/** Resolve a './' or '../' import specifier. See resolveFromBase. */
export function resolveRelativeImport(
  fromFileAbs: string,
  specifier: string,
  projectRootAbs: string
): string[] {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
  return resolveFromBase(resolve(dirname(fromFileAbs), specifier), projectRootAbs);
}

// ---------------------------------------------------------------------------
// tsconfig path aliases — '@fixtures/x' style specifiers are how TS projects
// commonly reference oracle material; without resolving them the alias is a
// protection bypass. Parsed fail-soft from tsconfig.json (JSONC tolerated,
// bounded `extends` chain), with each consumer pattern tried against every
// alias target.
// ---------------------------------------------------------------------------

export interface TsconfigAliases {
  /** Absolute baseUrl dir — null when the project never declared one */
  baseUrlAbs: string | null;
  /** paths patterns; baseAbs is where this entry's targets resolve from
   * (the effective baseUrl, else the declaring config's directory per
   * TS 4.1+ semantics) */
  paths: Array<{ pattern: string; targets: string[]; baseAbs: string }>;
}

const MAX_TSCONFIG_EXTENDS = 4;
const MAX_TSCONFIG_BYTES = 1_000_000;

/**
 * JSONC → JSON with a string-aware scanner: comments and trailing commas are
 * stripped only OUTSIDE string literals, so wildcard targets like
 * `packages/{star}/src` survive — a naive regex would treat the star-slash
 * inside the string as a comment terminator and splice the config.
 */
export function jsoncToJson(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === ',') {
      // Trailing comma: skip when the next non-whitespace closes a scope
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function parseJsonc(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return JSON.parse(jsoncToJson(text)) as Record<string, unknown>;
  }
}

/**
 * Load baseUrl/paths from <projectRoot>/tsconfig.json, following relative
 * `extends` chains (child wins). Returns null when there is no usable
 * tsconfig — alias resolution is then skipped entirely.
 */
export function loadTsconfigAliases(projectRoot: string): TsconfigAliases | null {
  const rootAbs = resolve(projectRoot);
  const merged: Array<{ dir: string; compilerOptions: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  // Child first; `extends` parents appended after (string or TS 5 array form,
  // relative entries only). The reverse walk below applies base → child so
  // child settings win.
  const pending: string[] = [resolve(rootAbs, 'tsconfig.json')];

  while (pending.length > 0 && merged.length < MAX_TSCONFIG_EXTENDS) {
    const configPath = pending.shift() as string;
    if (seen.has(configPath)) continue;
    seen.add(configPath);
    let parsed: Record<string, unknown>;
    try {
      const st = statSync(configPath);
      if (!st.isFile() || st.size > MAX_TSCONFIG_BYTES) continue;
      parsed = parseJsonc(readFileSync(configPath, 'utf-8'));
    } catch {
      continue;
    }
    const co = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
    merged.push({ dir: dirname(configPath), compilerOptions: co });
    const ext = parsed.extends;
    const extEntries = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
    for (const entry of extEntries) {
      // npm-package extends ("@tsconfig/node20") are skipped — bare names.
      if (typeof entry !== 'string' || (!entry.startsWith('./') && !entry.startsWith('../'))) {
        continue;
      }
      pending.push(resolve(dirname(configPath), entry.endsWith('.json') ? entry : `${entry}.json`));
    }
  }
  if (merged.length === 0) return null;

  // Effective baseUrl is the child-most declaration (merged[0] is the child).
  let baseUrlAbs: string | null = null;
  for (const { dir, compilerOptions } of merged) {
    if (typeof compilerOptions.baseUrl === 'string') {
      baseUrlAbs = resolve(dir, compilerOptions.baseUrl);
      break;
    }
  }

  // Per-key merge, child wins; each entry resolves its targets from the
  // effective baseUrl when declared, else from the declaring config's dir
  // (TS 4.1+ semantics). Keeping parent keys a child's paths object would
  // have replaced wholesale is deliberate over-protection.
  const paths = new Map<string, { targets: string[]; baseAbs: string }>();
  for (const { dir, compilerOptions } of [...merged].reverse()) {
    if (!compilerOptions.paths || typeof compilerOptions.paths !== 'object') continue;
    for (const [key, value] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const targets = value.filter((v): v is string => typeof v === 'string');
      if (targets.length === 0) continue;
      paths.set(key, { targets, baseAbs: baseUrlAbs ?? dir });
    }
  }

  const patternList = [...paths.entries()].map(([pattern, { targets, baseAbs }]) => ({
    pattern,
    targets,
    baseAbs,
  }));
  if (!baseUrlAbs && patternList.length === 0) return null;
  return { baseUrlAbs, paths: patternList };
}

/** Match `specifier` against one tsconfig paths pattern; null when no match. */
function matchAliasPattern(specifier: string, pattern: string): string | null {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return specifier === pattern ? '' : null;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  if (specifier.length < prefix.length + suffix.length) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/**
 * Resolve a non-relative specifier through tsconfig paths/baseUrl. Returns
 * every existing root-relative candidate (protection over-approximates).
 */
export function resolveAliasImport(
  specifier: string,
  aliases: TsconfigAliases,
  projectRootAbs: string
): string[] {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return [];
  if (specifier.startsWith('node:') || isAbsolute(specifier)) return [];

  const found = new Set<string>();
  for (const { pattern, targets, baseAbs } of aliases.paths) {
    const wildcard = matchAliasPattern(specifier, pattern);
    if (wildcard === null) continue;
    for (const target of targets) {
      const substituted = target.includes('*') ? target.replace('*', wildcard) : target;
      for (const rel of resolveFromBase(resolve(baseAbs, substituted), projectRootAbs)) {
        found.add(rel);
      }
    }
  }

  // ONLY an explicitly declared baseUrl makes bare specifiers resolvable
  // from it (TS semantics) — without the gate every `import 'react'` in
  // every spec would cost ~18 stat calls against the project root.
  if (found.size === 0 && aliases.baseUrlAbs !== null) {
    for (const rel of resolveFromBase(resolve(aliases.baseUrlAbs, specifier), projectRootAbs)) {
      found.add(rel);
    }
  }
  return [...found];
}

function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * Quoted data-file references (readFileSync paths), resolved against BOTH
 * the spec's dir and the root — runtimes read relative to cwd, authors write
 * relative to the spec, and protecting both is fail-safe. A literal under an
 * oracle-conventional directory is protected even when the file does NOT yet
 * exist ("reserved"): otherwise a spec reading a missing goldens/output.json
 * invites the model to fabricate the golden instead of the implementation.
 */
function extractDataLiterals(source: string, fromFileAbs: string, rootAbs: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(DATA_LITERAL_RE)) {
    const literal = match[1];
    if (literal.includes('://') || literal.startsWith('/')) continue;
    for (const baseDir of [dirname(fromFileAbs), rootAbs]) {
      const abs = resolve(baseDir, literal);
      const rel = relative(rootAbs, abs);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      const relPosix = rel.split(sep).join('/');
      const segments = relPosix.split('/');
      const inOracleDir = segments
        .slice(0, -1)
        .some((seg) => ORACLE_DIR_SEGMENTS.has(seg.toLowerCase()));
      if (isFile(abs) || inOracleDir) {
        found.push(relPosix);
      }
    }
  }
  return found;
}

/**
 * Expand a set of spec files (original-case, root-relative) to the oracle
 * material they transitively reference. Returns original-case paths,
 * EXCLUDING the seeds themselves. Bounded and fail-soft.
 */
export function expandSpecImports(projectRoot: string, specFiles: string[]): string[] {
  const rootAbs = resolve(projectRoot);
  const protectedExtra = new Set<string>();
  const visited = new Set<string>();
  let bytesRead = 0;
  let aliases: TsconfigAliases | null = null;
  try {
    aliases = loadTsconfigAliases(projectRoot);
  } catch {
    aliases = null;
  }
  // Queue entries: [relPath, depth] — we recurse through specs and oracle
  // files, never through plain implementation code.
  const queue: Array<[string, number]> = specFiles.map((f) => [f, 0]);

  while (queue.length > 0 && visited.size < MAX_GRAPH_FILES && bytesRead < MAX_GRAPH_BYTES) {
    const [rel, depth] = queue.shift() as [string, number];
    if (depth > MAX_GRAPH_DEPTH || visited.has(rel)) continue;
    visited.add(rel);
    // Data files are protected as leaves, never scanned: their contents are
    // arbitrary data, and code regexes over fixture JSON manufacture
    // second-order false positives.
    if (DATA_EXT_RE.test(rel)) continue;

    const abs = resolve(rootAbs, rel);
    let source: string;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_SPEC_BYTES) continue;
      bytesRead += st.size;
      source = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }

    const referenced = new Set<string>();
    for (const spec of extractImportSpecifiers(source)) {
      for (const resolved of resolveRelativeImport(abs, spec, rootAbs)) {
        referenced.add(resolved);
      }
      if (aliases) {
        for (const resolved of resolveAliasImport(spec, aliases, rootAbs)) {
          referenced.add(resolved);
        }
      }
    }
    for (const dataRel of extractDataLiterals(source, abs, rootAbs)) {
      referenced.add(dataRel);
    }

    for (const ref of referenced) {
      if (!isOraclePath(ref) && !isTestFilePath(ref)) continue; // unit under test stays writable
      // Added unconditionally: a test-path ref may live where the directory
      // walk cannot see it (hidden dir, skipped segment, beyond depth), so
      // relying on listTestFiles to have found it would leave a gap.
      protectedExtra.add(ref);
      // Helper chains: a protected file's own oracle imports are protected
      queue.push([ref, depth + 1]);
    }
  }

  return [...protectedExtra];
}

/**
 * Full gate-integrity snapshot: pre-existing test files plus the oracle
 * material their import graphs reference. The membership set is lower-cased
 * (case-insensitive matching); `display` keeps original casing for prompts.
 */
export function snapshotProtection(projectRoot: string): ProtectionSnapshot {
  let tests: string[] = [];
  try {
    tests = listTestFiles(projectRoot);
  } catch {
    tests = [];
  }
  let extra: string[] = [];
  try {
    extra = expandSpecImports(projectRoot, tests);
  } catch {
    extra = [];
  }
  const display = [...new Set([...tests, ...extra])].sort();
  return {
    protectedFiles: new Set(display.map((f) => f.toLowerCase())),
    display,
  };
}
