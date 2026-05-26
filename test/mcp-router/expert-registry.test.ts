/**
 * Expert Consultation Registry Tests
 *
 * Verifies that droids under .factory/droids/ are surfaced as virtual MCP
 * tools, that the tool path encoding round-trips, and that fuzzy search via
 * the existing MCP search index resolves the expected droid.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadExpertTools,
  isExpertToolPath,
  expertNameFromPath,
  EXPERT_SERVER_NAME,
} from '../../src/mcp-router/experts/registry.js';
import { ToolSearchIndex } from '../../src/mcp-router/search/fuzzy.js';

function makeDroid(dir: string, name: string, description: string): void {
  writeFileSync(
    join(dir, `${name}.md`),
    `---
name: ${name}
description: ${description}
model: inherit
---

# ${name}
`
  );
}

describe('expert consultation registry', () => {
  let workDir: string;
  let droidDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'uap-expert-registry-'));
    droidDir = join(workDir, '.factory', 'droids');
    mkdirSync(droidDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('surfaces every well-formed droid as a virtual tool', () => {
    makeDroid(droidDir, 'security-auditor', 'OWASP review and secret detection');
    makeDroid(droidDir, 'performance-reviewer', 'Per-diff performance regression review');

    const tools = loadExpertTools(workDir);
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set(['security-auditor', 'performance-reviewer'])
    );
    for (const t of tools) {
      expect(t.serverName).toBe(EXPERT_SERVER_NAME);
      expect(t.inputSchema.required).toEqual(['context']);
    }
  });

  it('skips test fixtures and malformed files without erroring', () => {
    makeDroid(droidDir, 'good-droid', 'A perfectly fine droid description');
    // test-droid-* should be ignored
    writeFileSync(
      join(droidDir, 'test-droid-1234567890.md'),
      `---
name: test-droid-1234567890
description: This fixture should be excluded
---
`
    );
    // Malformed YAML should be silently skipped (validator covers reporting)
    writeFileSync(join(droidDir, 'malformed.md'), 'no frontmatter here\n');

    const tools = loadExpertTools(workDir);
    expect(tools.map((t) => t.name)).toEqual(['good-droid']);
  });

  it('round-trips between path and droid name', () => {
    const path = `${EXPERT_SERVER_NAME}.security-auditor`;
    expect(isExpertToolPath(path)).toBe(true);
    expect(expertNameFromPath(path)).toBe('security-auditor');
    expect(isExpertToolPath('github.create_pr')).toBe(false);
    expect(expertNameFromPath('github.create_pr')).toBeNull();
  });

  it('is discoverable via fuzzy search index', () => {
    makeDroid(droidDir, 'security-auditor', 'OWASP review and secret detection');
    makeDroid(droidDir, 'performance-reviewer', 'Per-diff performance regression review');
    makeDroid(droidDir, 'code-quality-reviewer', 'Diff-focused code quality reviewer');

    const tools = loadExpertTools(workDir);
    const index = new ToolSearchIndex({ threshold: 0.2 });
    index.addTools(tools);

    const securityHits = index.search('security review');
    expect(securityHits.length).toBeGreaterThan(0);
    expect(securityHits[0].name).toBe('security-auditor');
    expect(securityHits[0].path).toBe(`${EXPERT_SERVER_NAME}.security-auditor`);
  });

  it('returns empty array when .factory/droids does not exist', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'uap-no-droids-'));
    try {
      expect(loadExpertTools(otherDir)).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
