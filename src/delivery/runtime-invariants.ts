/**
 * Requirement-to-Runtime Anti-Hollowness Gate (Option B3)
 *
 * Catches compile-green but runtime-hollow defects across ANY language/domain:
 *   - Undefined key reads on static constant lookup tables (e.g. `PAL.water`
 *     when `PAL` only defines `stone`, `roof`, `wood`) — works both within a
 *     file and across ESM imports/exports with high precision (dynamic or
 *     mutated tables are excluded to avoid false positives).
 *   - Stubbed / unimplemented exported handlers or explicitly TODO-emptied
 *     subsystem collections.
 *   - Blueprint runtime invariant checklist loaded from `.uap/blueprint.json`
 *     (including linked git worktrees).
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { linkedWorktreeRoots } from './acceptance-judge.js';
import { loadOutcomeBlueprint, type BlueprintRuntimeInvariant } from './outcome-blueprint.js';

export type HollownessFindingKind = 'undefined-table-key' | 'empty-subsystem-stub';

export interface StaticHollownessFinding {
  kind: HollownessFindingKind;
  file: string;
  line: number;
  symbol: string;
  detail: string;
}

interface ConstTableDef {
  name: string;
  keys: Set<string>;
  exported: boolean;
  file: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.uap', '.uap-deliver', 'agents', '.worktrees', '__pycache__', '.venv', 'target',
]);
const JS_TS_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i;
const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[a-z]+$/i;
const OBJECT_PROTO_KEYS = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toLocaleString', 'constructor', '__proto__', 'length', 'prototype',
  'keys', 'values', 'entries', 'assign', 'freeze', 'fromEntries',
]);
const MAX_SCAN_FILES = 150;
const MAX_FILE_BYTES = 250_000;

function collectSourceFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= MAX_SCAN_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_SCAN_FILES) return;
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const abs = join(dir, entry);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, depth + 1);
      } else if (st.isFile() && JS_TS_EXT.test(entry) && st.size <= MAX_FILE_BYTES) {
        const rel = relative(projectRoot, abs).replace(/\\/g, '/');
        if (!TEST_FILE_RE.test(rel)) out.push(abs);
      }
    }
  };
  walk(projectRoot, 0);
  return out;
}

/** Extract top-level literal property keys of a balanced `{ ... }` object body. */
function extractTopLevelLiteralKeys(body: string): Set<string> | null {
  const keys = new Set<string>();
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  let lineComment = false;
  let blockComment = false;
  let tokenStart = 0;

  const inspectSegment = (seg: string): boolean => {
    const trimmed = seg.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith('...')) return false; // spread makes key set dynamic
    if (trimmed.startsWith('[')) return false; // computed key makes key set dynamic
    const keyMatch = /^(?:['"]([A-Za-z_$][\w$-]*)['"]|([A-Za-z_$][\w$]*))\s*(?::|\(|,|$)/.exec(trimmed);
    if (!keyMatch) return false;
    const key = keyMatch[1] ?? keyMatch[2];
    if (key) keys.add(key);
    return true;
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1] ?? '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      if (!inspectSegment(body.slice(tokenStart, i))) return null;
      tokenStart = i + 1;
    }
  }
  if (!inspectSegment(body.slice(tokenStart))) return null;
  return keys.size >= 1 ? keys : null;
}

/** Find matching closing brace index for `{` at `openIdx`, respecting strings/comments. */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1] ?? '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Blank strings and comments (preserving newlines) so regex scans never hit prose/literals. */
function stripStringsAndComments(src: string): string {
  let out = '';
  let inStr: string | null = null;
  let esc = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1] ?? '';
    if (lineComment) {
      if (ch === '\n') { lineComment = false; out += '\n'; } else out += ' ';
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; out += '  '; i++; }
      else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (inStr) {
      if (esc) { esc = false; out += ' '; }
      else if (ch === '\\') { esc = true; out += ' '; }
      else if (ch === inStr) { inStr = null; out += ' '; }
      else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; out += '  '; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; out += '  '; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
}

function lineNumberAt(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

function extractConstTablesFromFile(src: string, relFile: string): ConstTableDef[] {
  const defs: ConstTableDef[] = [];
  const declRe = /(?:^|[\n;])\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*(?:Object\.freeze\(\s*)?\{/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(src)) !== null) {
    const exported = Boolean(match[1]);
    const name = match[2];
    const openBrace = match.index + match[0].length - 1;
    const closeBrace = findMatchingBrace(src, openBrace);
    if (closeBrace < 0) continue;
    const body = src.slice(openBrace + 1, closeBrace);
    const keys = extractTopLevelLiteralKeys(body);
    if (keys) {
      defs.push({ name, keys, exported, file: relFile });
    }
  }
  return defs;
}

function isTableMutated(codeSurface: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignRe = new RegExp(`\\b${escaped}(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])\\s*(?:=|\\|\\|=|&&=|\\?\\?=)(?!=)`);
  if (assignRe.test(codeSurface)) return true;
  const objAssignRe = new RegExp(`Object\\.assign\\(\\s*${escaped}\\b`);
  return objAssignRe.test(codeSurface);
}

function scanStubbedExports(src: string, relFile: string): StaticHollownessFinding[] {
  const findings: StaticHollownessFinding[] = [];
  const stubRe =
    /export\s+(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*\{[^}]{0,220}?(?:throw\s+new\s+Error\(\s*['"`][^'"`]*(?:todo|not\s+implemented|stub)|\/\/\s*(?:TODO|FIXME|STUB)\b[^}\n]*\n\s*(?:return(?:\s+(?:null|undefined|\[\]|\{\}))?;?\s*)?\})/gi;
  let m: RegExpExecArray | null;
  while ((m = stubRe.exec(src)) !== null) {
    const sym = m[1] ?? m[2] ?? 'export';
    findings.push({
      kind: 'empty-subsystem-stub',
      file: relFile,
      line: lineNumberAt(src, m.index),
      symbol: sym,
      detail: `exported '${sym}' appears to be an unimplemented stub or TODO placeholder`,
    });
  }
  return findings;
}

function parseNamedImports(src: string): Map<string, string> {
  // Maps localName -> importedExportName
  const map = new Map<string, string>();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(cleaned);
      if (asMatch) map.set(asMatch[2], asMatch[1]);
      else if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) map.set(cleaned, cleaned);
    }
  }
  return map;
}

/**
 * Deterministic static anti-hollowness scan over project source files.
 * High precision: reports only provably undefined keys on unmutated constant
 * object tables and explicitly stubbed exports.
 */
export function scanStaticHollowness(projectRoot: string): StaticHollownessFinding[] {
  const absFiles = collectSourceFiles(projectRoot);
  if (absFiles.length === 0) return [];

  const fileContents = absFiles.map((abs) => {
    const rel = relative(projectRoot, abs).replace(/\\/g, '/');
    const raw = readFileSync(abs, 'utf-8');
    return { rel, raw, surface: stripStringsAndComments(raw) };
  });

  // Collect all local and uniquely-exported constant lookup tables.
  const exportedByName = new Map<string, ConstTableDef | null>();
  const localByFile = new Map<string, Map<string, ConstTableDef>>();
  for (const f of fileContents) {
    const defs = extractConstTablesFromFile(f.raw, f.rel);
    const localMap = new Map<string, ConstTableDef>();
    for (const def of defs) {
      localMap.set(def.name, def);
      if (def.exported) {
        // Only track unambiguously named exported tables (if two files export
        // the same table name with different shapes, mark null to avoid false positives).
        exportedByName.set(def.name, exportedByName.has(def.name) ? null : def);
      }
    }
    localByFile.set(f.rel, localMap);
  }

  // Drop any table that is dynamically mutated in any scanned file.
  for (const [name, def] of [...exportedByName.entries()]) {
    if (def && fileContents.some((f) => isTableMutated(f.surface, name))) {
      exportedByName.set(name, null);
    }
  }

  const findings: StaticHollownessFinding[] = [];
  const seen = new Set<string>();

  for (const f of fileContents) {
    const localMap = localByFile.get(f.rel) ?? new Map<string, ConstTableDef>();
    const imports = parseNamedImports(f.raw);

    // Build effective table map in scope for this file.
    const inScope = new Map<string, ConstTableDef>();
    for (const [name, def] of localMap) {
      if (!isTableMutated(f.surface, name)) inScope.set(name, def);
    }
    for (const [localName, exportedName] of imports) {
      if (inScope.has(localName)) continue;
      const exp = exportedByName.get(exportedName);
      if (exp && !isTableMutated(f.surface, localName)) {
        inScope.set(localName, exp);
      }
    }

    for (const [varName, def] of inScope) {
      const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const accessRe = new RegExp(`(?<![.\\w$])${escaped}\\.([A-Za-z_$][\\w$]*)\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = accessRe.exec(f.surface)) !== null) {
        const key = m[1];
        if (def.keys.has(key) || OBJECT_PROTO_KEYS.has(key)) continue;
        // Skip optional-chaining/existence guards like `typeof PAL.water` or `'water' in PAL`
        const before = f.surface.slice(Math.max(0, m.index - 12), m.index);
        if (/\btypeof\s+$/.test(before)) continue;
        const line = lineNumberAt(f.raw, m.index);
        const dedup = `${f.rel}:${line}:${varName}.${key}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        const sampleKeys = [...def.keys].slice(0, 8).join(', ');
        findings.push({
          kind: 'undefined-table-key',
          file: f.rel,
          line,
          symbol: `${varName}.${key}`,
          detail: `reads undefined key '${key}' on constant table '${varName}' from ${def.file} (defined keys: ${sampleKeys})`,
        });
      }
    }

    findings.push(...scanStubbedExports(f.raw, f.rel));
  }

  return findings.slice(0, 20);
}

/** Load Blueprint runtime invariants from projectRoot (or linked worktree fallback). */
export function loadBlueprintInvariants(projectRoot: string): BlueprintRuntimeInvariant[] {
  const direct = loadOutcomeBlueprint(projectRoot);
  if (direct && direct.runtimeInvariants.length > 0) {
    return direct.runtimeInvariants;
  }
  for (const wt of linkedWorktreeRoots(projectRoot)) {
    const wtBp = loadOutcomeBlueprint(wt);
    if (wtBp && wtBp.runtimeInvariants.length > 0) {
      return wtBp.runtimeInvariants;
    }
  }
  return [];
}

/** Load `.uap/blueprint.md` (if present in projectRoot or linked worktree). */
export function loadBlueprintMarkdown(projectRoot: string): string | null {
  const candidates = [projectRoot, ...linkedWorktreeRoots(projectRoot)];
  for (const dir of candidates) {
    const mdPath = join(dir, '.uap', 'blueprint.md');
    if (existsSync(mdPath)) {
      try {
        const text = readFileSync(mdPath, 'utf-8').trim();
        if (text) return text;
      } catch {
        /* ignore unreadable */
      }
    }
  }
  return null;
}

export interface RuntimeHollownessNoteInput {
  execNote?: string;
  visualNote?: string;
  interactionNote?: string;
}

/**
 * Combine static hollowness findings + runtime observations + Blueprint
 * runtime invariants into a high-priority section for acceptance-judge and
 * adversarial-critic.
 */
export function buildRuntimeHollownessNote(
  projectRoot: string,
  input: RuntimeHollownessNoteInput = {}
): string {
  const parts: string[] = [];
  const findings = scanStaticHollowness(projectRoot);
  if (findings.length > 0) {
    parts.push(
      'STATIC HOLLOWNESS / RUNTIME DEFECTS DETECTED (treat as real defects unless disproven):\n' +
        findings
          .map((f) => `  - [${f.kind}] ${f.file}:${f.line} (${f.symbol}): ${f.detail}`)
          .join('\n')
    );
  }
  const invariants = loadBlueprintInvariants(projectRoot);
  if (invariants.length > 0) {
    parts.push(
      'BLUEPRINT RUNTIME INVARIANTS (verify each holds at runtime, not just compiles):\n' +
        invariants
          .map((i) => `  - [${i.subsystem}] ${i.invariant} (verify: ${i.howToVerify})`)
          .join('\n')
    );
  }
  const obs = [input.execNote, input.interactionNote, input.visualNote]
    .filter((s): s is string => Boolean(s && s.trim()));
  if (obs.length > 0) {
    parts.push('RUNTIME / INTERACTION / VISUAL TELEMETRY:\n' + obs.join('\n'));
  }
  return parts.join('\n\n');
}
