/**
 * Droid Validator Tests
 *
 * Verifies the `uap droid validate` logic detects:
 *  - droids referenced by capability-router that do not exist on disk
 *  - frontmatter parse failures
 *  - duplicate droid names
 *  - missing required fields
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateDroids } from '../../src/cli/droids.js';
import { DEFAULT_CAPABILITY_MAPPINGS } from '../../src/coordination/capability-router.js';

function expectedDroidNames(): string[] {
  const set = new Set<string>();
  for (const m of DEFAULT_CAPABILITY_MAPPINGS) {
    for (const d of m.droids) set.add(d);
  }
  return [...set];
}

function makeDroidFile(dir: string, name: string, body?: string): void {
  const content =
    body ??
    `---
name: ${name}
description: Stub droid used in tests for validator coverage
model: inherit
---

# ${name}
`;
  writeFileSync(join(dir, `${name}.md`), content);
}

describe('validateDroids', () => {
  let workDir: string;
  let droidDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'uap-droid-validate-'));
    droidDir = join(workDir, '.factory', 'droids');
    mkdirSync(droidDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reports every router-referenced droid as missing when directory is empty', async () => {
    const result = await validateDroids(workDir);
    const expected = expectedDroidNames();

    expect(result.ok).toBe(false);
    const missing = result.issues.filter((i) => i.type === 'missing-droid');
    expect(missing.length).toBe(expected.length);
    expect(new Set(missing.map((i) => i.droidName))).toEqual(new Set(expected));
  });

  it('passes when every router-referenced droid exists with valid frontmatter', async () => {
    for (const name of expectedDroidNames()) {
      makeDroidFile(droidDir, name);
    }
    const result = await validateDroids(workDir);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('detects malformed frontmatter as an error', async () => {
    // Write a file with no frontmatter delimiters at all
    writeFileSync(
      join(droidDir, 'broken-droid.md'),
      'this file has no frontmatter at all\njust prose\n'
    );
    const result = await validateDroids(workDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'invalid-frontmatter')).toBe(true);
  });

  it('detects duplicate droid names across files', async () => {
    // Two files declaring the same name
    makeDroidFile(droidDir, 'typescript-node-expert');
    writeFileSync(
      join(droidDir, 'duplicate-copy.md'),
      `---
name: typescript-node-expert
description: Duplicate name to trigger validator
model: inherit
---
# duplicate
`
    );
    const result = await validateDroids(workDir);
    expect(result.ok).toBe(false);
    const dup = result.issues.find((i) => i.type === 'duplicate-name');
    expect(dup).toBeDefined();
    expect(dup?.droidName).toBe('typescript-node-expert');
  });

  it('flags droids with descriptions shorter than 5 chars', async () => {
    const shortDescFile = `---
name: typescript-node-expert
description: hi
model: inherit
---
# short
`;
    makeDroidFile(droidDir, 'typescript-node-expert', shortDescFile);
    const result = await validateDroids(workDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'missing-description')).toBe(true);
  });

  it('skips test-droid-* files (test fixtures)', async () => {
    // Author the full expected set, then drop a malformed test-droid file in.
    for (const name of expectedDroidNames()) {
      makeDroidFile(droidDir, name);
    }
    writeFileSync(
      join(droidDir, 'test-droid-1234567890.md'),
      'no frontmatter — would normally fail validation\n'
    );
    const result = await validateDroids(workDir);
    // Should still pass: test-droid-* files are excluded from validation
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
