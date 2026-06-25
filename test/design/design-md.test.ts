import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseDesignMd,
  buildAllowList,
  resolveRef,
  normalizeColor,
  summarizeForReactor,
} from '../../src/design/tokens.js';
import { scanOffToken, isUiFile } from '../../src/design/gate.js';
import { interrogate, renderDesignMd } from '../../src/design/interrogate.js';

const DESIGN = `---
name: Heritage
colors:
  primary: "#1A1C1E"
  tertiary: "#B8422E"
  cta: "{colors.tertiary}"
spacing:
  md: 16px
  lg: 24px
rounded:
  md: 8px
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 48px
---

## Overview
Architectural minimalism.

## Do's and Don'ts
- **Don't** use pure white backgrounds.
`;

describe('DESIGN.md token model', () => {
  it('parses front matter + sections and resolves token references', () => {
    const parsed = parseDesignMd(DESIGN);
    expect(parsed.tokens.name).toBe('Heritage');
    expect(parsed.tokens.colors?.primary).toBe('#1A1C1E');
    expect(resolveRef(parsed.tokens, parsed.tokens.colors?.cta)).toBe('#B8422E');
    expect(parsed.sections['overview']).toContain('minimalism');
    expect(parsed.sections["do's and don'ts"]).toContain('white');
  });

  it('builds a flat allow-list with resolved colors, spacing, radii, fonts', () => {
    const parsed = parseDesignMd(DESIGN);
    const allow = buildAllowList(parsed, '/proj/DESIGN.md', '/proj');
    expect(allow.colors).toContain('#1a1c1e');
    expect(allow.colors).toContain('#b8422e'); // resolved {colors.tertiary}
    expect(allow.spacing).toEqual(expect.arrayContaining(['16px', '24px']));
    expect(allow.radii).toContain('8px');
    expect(allow.fontSizes).toContain('48px');
    expect(allow.fontFamilies).toContain('public sans');
  });

  it('normalizes shorthand hex colors', () => {
    expect(normalizeColor('#FFF')).toBe('#ffffff');
    expect(normalizeColor('#1A1C1E')).toBe('#1a1c1e');
  });

  it('summarizeForReactor includes the system name and a token hint', () => {
    const s = summarizeForReactor(parseDesignMd(DESIGN));
    expect(s).toMatch(/Heritage/);
    expect(s).toMatch(/BLOCKED/);
  });
});

describe('off-token scanner (gate.ts)', () => {
  const allow = buildAllowList(parseDesignMd(DESIGN), '/p/DESIGN.md', '/p');

  it('only treats UI files as in-scope', () => {
    expect(isUiFile('a/b.css')).toBe(true);
    expect(isUiFile('a/b.tsx')).toBe(true);
    expect(isUiFile('a/b.py')).toBe(false);
  });

  it('flags off-token colors and off-scale spacing', () => {
    const findings = scanOffToken('.x{color:#ff00ff;padding:7px;}', 'x.css', allow);
    expect(findings.some((f) => f.kind === 'color' && f.value === '#ff00ff')).toBe(true);
    expect(findings.some((f) => f.kind === 'spacing' && f.value === '7px')).toBe(true);
  });

  it('allows on-token values, var() refs, {token.refs}, and hairlines', () => {
    expect(scanOffToken('.x{color:#1A1C1E;padding:16px;}', 'x.css', allow)).toHaveLength(0);
    expect(scanOffToken('.x{color:var(--anything);border:1px;}', 'x.css', allow)).toHaveLength(0);
    expect(scanOffToken('.x{color:{colors.primary};}', 'x.css', allow)).toHaveLength(0);
  });

  it('does not flag non-UI files', () => {
    expect(scanOffToken('const c = "#ff00ff"', 'x.py', allow)).toHaveLength(0);
  });
});

describe('interrogate (reverse-engineer DESIGN.md from code)', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('derives tokens from CSS vars, fonts, and spacing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-interro-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'package.json'), '{"name":"acme-web"}');
    writeFileSync(
      join(dir, 'src', 'theme.css'),
      ':root{--color-primary:#1A1C1E;--space-md:16px;}\n.b{background:#1A1C1E;padding:16px;font-family:"Public Sans";}'
    );
    const result = interrogate(dir);
    expect(result.stats.source).toBe('css-vars');
    const md = renderDesignMd(result);
    expect(md).toMatch(/^---/);
    const parsed = parseDesignMd(md);
    const colorVals = Object.values(parsed.tokens.colors ?? {}).map(normalizeColor);
    expect(colorVals).toContain('#1a1c1e');
    expect(parsed.tokens.name).toBe('Acme Web');
  });
});
