/**
 * DESIGN.md token model.
 *
 * Parses a project's DESIGN.md (the Google Labs DESIGN.md format: YAML token
 * front matter + markdown prose) into a structured token set, resolves
 * `{token.refs}`, and derives a flat allow-list that the (pure-stdlib) Python
 * design-token gate consumes from `.uap/design-tokens.json`.
 *
 * Spec: https://github.com/google-labs-code/design.md (docs/spec.md).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import yaml from 'js-yaml';

export interface TypographyToken {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string | number;
  lineHeight?: string | number;
  letterSpacing?: string;
  fontFeature?: string;
  fontVariation?: string;
}

export interface DesignTokens {
  version?: string;
  name?: string;
  description?: string;
  colors?: Record<string, string>;
  typography?: Record<string, TypographyToken>;
  rounded?: Record<string, string | number>;
  spacing?: Record<string, string | number>;
  components?: Record<string, Record<string, string>>;
}

export interface ParsedDesign {
  tokens: DesignTokens;
  /** Markdown body after the front matter. */
  prose: string;
  /** Section heading -> body text, keyed by lowercased `##` title. */
  sections: Record<string, string>;
}

/** Flat, JSON-serializable allow-list consumed by the Python gate. */
export interface TokenAllowList {
  name: string;
  colors: string[];
  spacing: string[];
  radii: string[];
  fontSizes: string[];
  fontFamilies: string[];
  generatedFrom: string;
}

const DESIGN_FILENAMES = ['DESIGN.md', 'design.md', 'Design.md'];

/** Locate a DESIGN.md in `dir` (project root). Returns absolute path or null. */
export function findDesignFile(dir: string): string | null {
  for (const name of DESIGN_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Split a DESIGN.md into YAML front matter + markdown body. */
export function parseDesignMd(content: string): ParsedDesign {
  let tokens: DesignTokens = {};
  let prose = content;

  // Front matter must open and close with a line that is exactly `---`.
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    try {
      tokens = (yaml.load(fm[1]) as DesignTokens) ?? {};
    } catch {
      tokens = {};
    }
    prose = content.slice(fm[0].length);
  }

  const sections: Record<string, string> = {};
  // Split on `##` headings (not `###`).
  const parts = prose.split(/^##\s+(?!#)/m);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const nl = block.indexOf('\n');
    const heading = (nl === -1 ? block : block.slice(0, nl)).trim().toLowerCase();
    const body = nl === -1 ? '' : block.slice(nl + 1).trim();
    sections[heading] = body;
  }

  return { tokens, prose: prose.trim(), sections };
}

/** Resolve a `{path.to.token}` reference against the token tree; returns the
 * raw string for non-references unchanged. */
export function resolveRef(tokens: DesignTokens, value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '');
  const m = value.match(/^\{([^}]+)\}$/);
  if (!m) return value;
  const path = m[1].split('.');
  let cur: unknown = tokens;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return value; // unresolved — leave as-is for the linter to flag
    }
  }
  return typeof cur === 'string' ? cur : value;
}

/** Normalize a CSS color for set-membership comparison: lowercase, trim, and
 * expand `#rgb`/`#rgba` shorthand to the 6/8-digit form. */
export function normalizeColor(c: string): string {
  let s = c.trim().toLowerCase();
  const short = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/);
  if (short) {
    const [, r, g, b, a] = short;
    s = `#${r}${r}${g}${g}${b}${b}${a ? a + a : ''}`;
  }
  return s.replace(/\s+/g, '');
}

function dimStr(v: string | number | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return `${v}px`;
  return String(v).trim();
}

/** Derive the flat allow-list from a parsed DESIGN.md. */
export function buildAllowList(
  parsed: ParsedDesign,
  designPath: string,
  projectDir: string
): TokenAllowList {
  const t = parsed.tokens;
  const colors = new Set<string>();
  const spacing = new Set<string>();
  const radii = new Set<string>();
  const fontSizes = new Set<string>();
  const fontFamilies = new Set<string>();

  for (const v of Object.values(t.colors ?? {})) {
    const resolved = resolveRef(t, v);
    if (resolved) colors.add(normalizeColor(resolved));
  }
  for (const v of Object.values(t.spacing ?? {})) {
    const d = dimStr(v);
    if (d) spacing.add(d);
  }
  for (const v of Object.values(t.rounded ?? {})) {
    const d = dimStr(v);
    if (d) radii.add(d);
  }
  for (const ty of Object.values(t.typography ?? {})) {
    if (ty?.fontSize) fontSizes.add(dimStr(ty.fontSize) ?? '');
    if (ty?.fontFamily) fontFamilies.add(String(ty.fontFamily).trim().toLowerCase());
  }
  // Component tokens may inline literal colors/dimensions too.
  for (const comp of Object.values(t.components ?? {})) {
    for (const v of Object.values(comp ?? {})) {
      const resolved = resolveRef(t, v);
      if (/^#|^rgb|^hsl|^oklch|^oklab|^lab|^lch|^hwb|^color-mix/i.test(resolved.trim())) {
        colors.add(normalizeColor(resolved));
      }
    }
  }

  return {
    name: t.name ?? 'Untitled',
    colors: [...colors].filter(Boolean).sort(),
    spacing: [...spacing].filter(Boolean).sort(),
    radii: [...radii].filter(Boolean).sort(),
    fontSizes: [...fontSizes].filter(Boolean).sort(),
    fontFamilies: [...fontFamilies].filter(Boolean).sort(),
    generatedFrom: relative(projectDir, designPath) || 'DESIGN.md',
  };
}

export function allowListPath(projectDir: string): string {
  return join(projectDir, '.uap', 'design-tokens.json');
}

/** Write `.uap/design-tokens.json` (the gate's source of truth). */
export function writeAllowList(projectDir: string, allow: TokenAllowList): string {
  const out = allowListPath(projectDir);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(allow, null, 2) + '\n');
  return out;
}

/** Load + parse the project DESIGN.md, or null if none exists. */
export function loadDesign(projectDir: string): { parsed: ParsedDesign; path: string } | null {
  const p = findDesignFile(projectDir);
  if (!p) return null;
  return { parsed: parseDesignMd(readFileSync(p, 'utf-8')), path: p };
}

/**
 * Compact guidance string injected by the reactor when UI/UX work is detected.
 * Keeps the agent on-token for new UI without re-reading the whole DESIGN.md.
 */
export function summarizeForReactor(parsed: ParsedDesign, maxChars = 900): string {
  const t = parsed.tokens;
  const lines: string[] = [];
  lines.push(`Apply the project design system "${t.name ?? 'DESIGN.md'}". Use ONLY these tokens for new UI:`);

  const colorRoles = Object.entries(t.colors ?? {})
    .slice(0, 8)
    .map(([k, v]) => `${k}=${resolveRef(t, v)}`);
  if (colorRoles.length) lines.push(`  colors: ${colorRoles.join(', ')}`);

  const fams = [...new Set(Object.values(t.typography ?? {}).map((x) => x.fontFamily).filter(Boolean))];
  if (fams.length) lines.push(`  fonts: ${fams.join(', ')}`);

  const sp = Object.values(t.spacing ?? {}).map((v) => (typeof v === 'number' ? `${v}px` : v));
  if (sp.length) lines.push(`  spacing: ${sp.join(', ')}`);

  const donts = parsed.sections["do's and don'ts"] || parsed.sections['dos and donts'];
  if (donts) {
    const firstDont = donts.split('\n').find((l) => /don'?t|avoid|never/i.test(l));
    if (firstDont) lines.push(`  rule: ${firstDont.replace(/^[-*]\s*/, '').trim()}`);
  }
  lines.push('  Hardcoding off-token colors/spacing in UI files is BLOCKED by the design gate.');

  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}
