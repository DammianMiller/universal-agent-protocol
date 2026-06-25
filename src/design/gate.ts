/**
 * Off-token scanner shared by `uap design check` and (mirrored in pure stdlib)
 * the Python design-token gate. Detects hardcoded colors / spacing in UI files
 * that are not part of the project's DESIGN.md token allow-list.
 *
 * Colors are gated strictly (highest signal). Spacing is gated with a small
 * ignore set (0–4px borders/hairlines, token values) to avoid false blocks.
 */
import { extname } from 'path';
import type { TokenAllowList } from './tokens.js';
import { normalizeColor } from './tokens.js';

const UI_EXT = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.vue', '.svelte', '.html', '.astro']);

/** Spacing px values that are structural, not design-scale (borders, hairlines). */
const SPACING_IGNORE = new Set(['0px', '1px', '2px', '3px', '4px']);

export interface OffTokenFinding {
  line: number;
  value: string;
  kind: 'color' | 'spacing';
}

export function isUiFile(path: string): boolean {
  return UI_EXT.has(extname(path).toLowerCase());
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_COLOR_RE = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab)\([^)]*\)/gi;
const PX_RE = /\b\d{1,4}px\b/g;

/** Lines that are pure comments or token/var references should be ignored. */
function isIgnorableLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Scan `content` for off-token colors/spacing. Returns findings; empty = clean.
 * Values that appear in the allow-list, inside `var(--…)`, or as `{token.ref}`
 * are considered on-token.
 */
export function scanOffToken(
  content: string,
  filePath: string,
  allow: TokenAllowList
): OffTokenFinding[] {
  if (!isUiFile(filePath)) return [];

  const allowColors = new Set(allow.colors.map(normalizeColor));
  const allowSpacing = new Set([...allow.spacing, ...allow.radii, ...allow.fontSizes]);
  const findings: OffTokenFinding[] = [];
  const lines = content.split('\n');

  lines.forEach((raw, i) => {
    if (isIgnorableLine(raw)) return;
    // Strip var(--x) and {token.ref} usages so their inner text isn't matched.
    // The ref pattern is a dotted path only — it must NOT match CSS `{...}`
    // declaration blocks (those contain `:` / `;`), or whole rules vanish.
    const line = raw.replace(/var\(--[^)]*\)/g, '').replace(/\{[\w.-]+\}/g, '');

    for (const m of line.matchAll(HEX_RE)) {
      const c = normalizeColor(m[0]);
      if (!allowColors.has(c)) findings.push({ line: i + 1, value: m[0], kind: 'color' });
    }
    for (const m of line.matchAll(FUNC_COLOR_RE)) {
      const c = m[0].replace(/\s+/g, '').toLowerCase();
      if (!allowColors.has(c)) findings.push({ line: i + 1, value: m[0], kind: 'color' });
    }
    for (const m of line.matchAll(PX_RE)) {
      const px = m[0];
      if (!SPACING_IGNORE.has(px) && !allowSpacing.has(px)) {
        findings.push({ line: i + 1, value: px, kind: 'spacing' });
      }
    }
  });

  return findings;
}

/** Human-readable block message for the gate. */
export function formatGateMessage(findings: OffTokenFinding[], allow: TokenAllowList): string {
  const colors = findings.filter((f) => f.kind === 'color');
  const spacing = findings.filter((f) => f.kind === 'spacing');
  const parts: string[] = [
    `design-token gate: this UI edit introduces values not in the "${allow.name}" design system.`,
  ];
  if (colors.length) {
    parts.push(
      `  off-token colors: ${[...new Set(colors.map((c) => c.value))].slice(0, 6).join(', ')}`,
      `  → use a DESIGN.md color token (${allow.colors.slice(0, 5).join(', ')}${allow.colors.length > 5 ? ', …' : ''}) or a CSS var.`
    );
  }
  if (spacing.length) {
    parts.push(
      `  off-scale spacing: ${[...new Set(spacing.map((s) => s.value))].slice(0, 6).join(', ')}`,
      `  → use a spacing token (${allow.spacing.join(', ') || 'define spacing in DESIGN.md'}).`
    );
  }
  parts.push(
    '  Add the value to DESIGN.md (then run `uap design sync`), reference an existing token,',
    '  or bypass once with UAP_DESIGN_GATE_OFF=1.'
  );
  return parts.join('\n');
}
