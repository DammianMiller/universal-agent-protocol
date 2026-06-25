/**
 * Auto-interrogation: reverse-engineer a DESIGN.md from an existing UI codebase.
 *
 * Scans the common sources of a project's visual identity — CSS custom
 * properties, Tailwind theme config, theme/token modules, and raw color/spacing
 * usage in components — then synthesizes a best-effort DESIGN.md (token front
 * matter + prose scaffold) for the agent to refine. This is the "autointerrogate
 * existing" half; Google's CLI only lints/diffs, it does not derive.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import yaml from 'js-yaml';
import { normalizeColor, type DesignTokens } from './tokens.js';

const UI_EXT = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.vue', '.svelte', '.html', '.ts', '.js']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '.worktrees', 'vendor', '.cache', 'out', '.uap-backups',
]);
const MAX_FILES = 4000;

export interface InterrogationResult {
  tokens: DesignTokens;
  prose: string;
  /** Diagnostic counts for the CLI summary. */
  stats: {
    filesScanned: number;
    colorsFound: number;
    fontsFound: number;
    spacingFound: number;
    source: string; // dominant source: tailwind | css-vars | usage | mixed
  };
}

function walk(dir: string, acc: string[], depth = 0): void {
  if (acc.length >= MAX_FILES || depth > 12) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return;
    if (e.startsWith('.') && e !== '.') {
      if (SKIP_DIRS.has(e)) continue;
    }
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      walk(full, acc, depth + 1);
    } else if (UI_EXT.has(extname(e))) {
      acc.push(full);
    }
  }
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = /\brgba?\([^)]*\)/g;
const PX_RE = /\b(\d{1,4})px\b/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;{}\n]+)/gi;

/** Pull the Tailwind theme (colors/fontFamily/spacing/borderRadius) if present. */
function readTailwind(projectDir: string): Partial<DesignTokens> | null {
  for (const name of ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.ts', 'tailwind.config.mjs']) {
    const p = join(projectDir, name);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf-8');
    const out: Partial<DesignTokens> = {};
    // Colors: capture "key": "#hex" or key: '#hex' pairs anywhere in the theme.
    const colors: Record<string, string> = {};
    for (const m of src.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))['"]/g)) {
      colors[m[1]] = m[2];
    }
    if (Object.keys(colors).length) out.colors = colors;
    return out;
  }
  return null;
}

/** Parse `--name: value;` CSS custom properties into colors/spacing buckets. */
function readCssVars(text: string, colors: Record<string, string>, spacing: Record<string, string>): void {
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;}{]+);/g)) {
    const name = m[1];
    const val = m[2].trim();
    if (/#[0-9a-fA-F]{3,8}\b/.test(val) || /\brgba?\(/.test(val)) {
      colors[name] = val;
    } else if (/^\d{1,4}px$/.test(val) && /space|gap|size|pad|margin|spacing/i.test(name)) {
      spacing[name] = val;
    }
  }
}

function topN<T>(counts: Map<T, number>, n: number): T[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
}

export function interrogate(projectDir: string): InterrogationResult {
  const files: string[] = [];
  walk(projectDir, files);

  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  const spacingCounts = new Map<string, number>();
  const cssVarColors: Record<string, string> = {};
  const cssVarSpacing: Record<string, string> = {};

  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    if (text.length > 600_000) continue;
    if (extname(f) === '.css' || extname(f) === '.scss' || extname(f) === '.less' || extname(f) === '.sass') {
      readCssVars(text, cssVarColors, cssVarSpacing);
    }
    for (const m of text.matchAll(HEX_RE)) colorCounts.set(normalizeColor(m[0]), (colorCounts.get(normalizeColor(m[0])) ?? 0) + 1);
    for (const m of text.matchAll(RGB_RE)) {
      const c = m[0].replace(/\s+/g, '').toLowerCase();
      colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
    }
    for (const m of text.matchAll(PX_RE)) {
      const px = `${m[1]}px`;
      spacingCounts.set(px, (spacingCounts.get(px) ?? 0) + 1);
    }
    for (const m of text.matchAll(FONT_FAMILY_RE)) {
      const fam = m[1].split(',')[0].replace(/['"]/g, '').trim();
      if (fam && !/^var\(|^inherit|^initial|^unset/.test(fam)) {
        fontCounts.set(fam, (fontCounts.get(fam) ?? 0) + 1);
      }
    }
  }

  const tw = readTailwind(projectDir);

  // ---- Assemble colors ----
  const colors: Record<string, string> = {};
  const roleNames = ['primary', 'secondary', 'tertiary', 'neutral', 'accent', 'surface'];
  // Prefer named sources (tailwind, css vars) then fall back to frequency.
  const named = { ...(tw?.colors ?? {}), ...cssVarColors };
  for (const [k, v] of Object.entries(named)) colors[k] = v;
  // Fill role slots from the most-used raw colors not already present.
  const usedVals = new Set(Object.values(colors).map((v) => normalizeColor(v)));
  const freqColors = topN(colorCounts, 12).filter((c) => !usedVals.has(c));
  let roleIdx = 0;
  for (const c of freqColors) {
    if (roleIdx >= roleNames.length) break;
    while (roleIdx < roleNames.length && colors[roleNames[roleIdx]]) roleIdx++;
    if (roleIdx < roleNames.length) {
      colors[roleNames[roleIdx]] = c;
      roleIdx++;
    }
  }

  // ---- Typography ----
  const fonts = topN(fontCounts, 2);
  const typography: DesignTokens['typography'] = {};
  if (fonts[0]) {
    typography['h1'] = { fontFamily: fonts[0], fontSize: '32px', fontWeight: 700, lineHeight: 1.2 };
    typography['body-md'] = { fontFamily: fonts[0], fontSize: '16px', fontWeight: 400, lineHeight: 1.5 };
  }
  if (fonts[1]) {
    typography['label'] = { fontFamily: fonts[1], fontSize: '12px', fontWeight: 500 };
  }

  // ---- Spacing & radius ----
  const spacing: Record<string, string> = {};
  const scaleNames = ['xs', 'sm', 'md', 'lg', 'xl'];
  const cssSpacingVals = Object.values(cssVarSpacing);
  const freqSpacing = (cssSpacingVals.length ? cssSpacingVals : topN(spacingCounts, 6))
    .map((s) => parseInt(String(s), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 128)
    .sort((a, b) => a - b);
  const uniqSpacing = [...new Set(freqSpacing)].slice(0, scaleNames.length);
  uniqSpacing.forEach((n, i) => {
    spacing[scaleNames[i]] = `${n}px`;
  });

  const tokens: DesignTokens = {
    version: 'alpha',
    name: guessName(projectDir),
    description: 'Auto-interrogated from existing UI. Refine the prose and token roles.',
  };
  if (Object.keys(colors).length) tokens.colors = colors;
  if (typography && Object.keys(typography).length) tokens.typography = typography;
  if (Object.keys(spacing).length) tokens.spacing = spacing;

  const source = tw?.colors
    ? 'tailwind'
    : Object.keys(cssVarColors).length
      ? 'css-vars'
      : colorCounts.size
        ? 'usage'
        : 'none';

  return {
    tokens,
    prose: renderProse(tokens, source),
    stats: {
      filesScanned: files.length,
      colorsFound: colorCounts.size,
      fontsFound: fontCounts.size,
      spacingFound: spacingCounts.size,
      source,
    },
  };
}

function guessName(projectDir: string): string {
  try {
    const pkg = join(projectDir, 'package.json');
    if (existsSync(pkg)) {
      const name = JSON.parse(readFileSync(pkg, 'utf-8')).name;
      if (name) return String(name).replace(/^@[^/]+\//, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  } catch {
    /* ignore */
  }
  return basename(projectDir).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Render the DESIGN.md prose scaffold from the derived tokens. */
function renderProse(tokens: DesignTokens, source: string): string {
  const colorLines = Object.entries(tokens.colors ?? {})
    .map(([k, v]) => `- **${k} (${v}):** _describe the role of this color._`)
    .join('\n');
  const fontList = [...new Set(Object.values(tokens.typography ?? {}).map((t) => t.fontFamily).filter(Boolean))];
  return [
    '## Overview',
    '',
    `_Auto-interrogated from existing UI (source: ${source}). This is a starting point —`,
    'describe the brand personality, audience, and the feeling the UI should evoke, then',
    'correct any mis-assigned token roles above._',
    '',
    '## Colors',
    '',
    'The palette below was derived from the most prevalent colors in the codebase.',
    'Re-map roles (primary/secondary/tertiary/neutral) to match the real design intent.',
    '',
    colorLines || '_No colors detected._',
    '',
    '## Typography',
    '',
    fontList.length
      ? `Primary typeface: **${fontList[0]}**.${fontList[1] ? ` Secondary: **${fontList[1]}**.` : ''} Refine the type scale in the front matter.`
      : '_No font families detected — set them in the front matter._',
    '',
    "## Do's and Don'ts",
    '',
    "- **Do** use the tokens above for all new UI.",
    "- **Don't** hardcode off-token colors or spacing — the UAP design gate blocks them.",
    '',
  ].join('\n');
}

/** Serialize an InterrogationResult to a full DESIGN.md string. */
export function renderDesignMd(result: InterrogationResult): string {
  const fm = yaml.dump(result.tokens, { lineWidth: 100, quotingType: '"', forceQuotes: false }).trimEnd();
  return `---\n${fm}\n---\n\n# ${result.tokens.name}\n\n${result.prose}`;
}
