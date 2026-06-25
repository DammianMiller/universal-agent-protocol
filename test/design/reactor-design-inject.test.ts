import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolve } from '../../src/coordination/reactor.js';
import { isUiWork, maybeDesignInjection } from '../../src/design/reactor-inject.js';

const DESIGN = `---
name: Heritage
colors:
  primary: "#1A1C1E"
spacing:
  md: 16px
---
## Overview
Minimal.
`;

describe('reactor DESIGN.md injection ("guide new")', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function projectWithDesign(): string {
    const d = mkdtempSync(join(tmpdir(), 'uap-rdi-'));
    dirs.push(d);
    writeFileSync(join(d, 'DESIGN.md'), DESIGN);
    return d;
  }

  it('detects UI work from prompt keywords and changed files', () => {
    expect(isUiWork('add a new button component', [])).toBe(true);
    expect(isUiWork('restyle the navbar colors', [])).toBe(true);
    expect(isUiWork('', ['src/App.css'])).toBe(true);
    expect(isUiWork('fix the database migration', ['src/db.ts'])).toBe(false);
  });

  it('injects the design summary for UI work when a DESIGN.md exists', () => {
    const dir = projectWithDesign();
    expect(maybeDesignInjection(dir, 'style the hero section')).toMatch(/Heritage/);

    const result = resolve({ event: 'user-prompt', promptText: 'design a new card component', cwd: dir });
    expect(result.inject).toMatch(/Design system \(DESIGN\.md\)/);
    expect(result.inject).toMatch(/Heritage/);
    expect(result.surfacedKeys).toContain('design:system');
  });

  it('stays silent for non-UI work', () => {
    const dir = projectWithDesign();
    const result = resolve({ event: 'user-prompt', promptText: 'optimize the SQL query planner', cwd: dir });
    expect(result.inject).not.toMatch(/Design system/);
  });

  it('does not re-inject when already surfaced this session', () => {
    const dir = projectWithDesign();
    const result = resolve({
      event: 'user-prompt',
      promptText: 'tweak the button styling',
      cwd: dir,
      surfaced: ['design:system'],
    });
    expect(result.inject).not.toMatch(/Design system/);
  });

  it('returns no injection when the project has no DESIGN.md', () => {
    const empty = mkdtempSync(join(tmpdir(), 'uap-rdi-empty-'));
    dirs.push(empty);
    expect(maybeDesignInjection(empty, 'style the page')).toBeNull();
  });
});
