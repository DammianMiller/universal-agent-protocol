import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { additiveTestEditRefusal, extractTestTitles } from '../../src/delivery/test-oracle-additive.js';
import { applyFileBlocks } from '../../src/delivery/applier.js';
import { captureIntegrity, verifyAndRestore } from '../../src/delivery/integrity.js';

/**
 * The additive test-edit carve-out: a mission that says "add tests to
 * test/foo.test.js" must be able to do so through EVERY write layer, while
 * edits that remove/rename/weaken existing tests stay refused everywhere.
 * Measured live (statlib runs 2–3, 2026-08-13): the flat refusal deadlocked
 * the write-nudge escalation against the only write the mission required.
 */

const BASE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean } from '../src/stats.js';

test('mean of simple values', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test('rejects bad input', () => {
  assert.throws(() => mean([]), TypeError);
});
`;

const ADDITIVE = `${BASE}
test('mode returns most frequent', () => {
  assert.equal(1, 1);
});
`;

const REMOVES_TEST = BASE.replace(/test\('rejects bad input'[\s\S]*?\}\);\n/, '');

describe('additiveTestEditRefusal', () => {
  it('sanctions a pure addition of new test cases', () => {
    expect(additiveTestEditRefusal(BASE, ADDITIVE)).toBeNull();
  });

  it('refuses ANY rewrite of existing content: removal, rename, hollowing, comment burial', () => {
    expect(additiveTestEditRefusal(BASE, REMOVES_TEST)).toMatch(/rewrites existing content/);
    expect(additiveTestEditRefusal(BASE, BASE.replace('mean of simple values', 'renamed'))).toMatch(
      /rewrites existing content/
    );
    // Assertion swap-to-tautology (security review CRITICAL): titles and
    // counts survive, but the byte-frozen prefix does not.
    const swapped = BASE.replace('assert.equal(mean([1, 2, 3, 4]), 2.5);', 'assert.equal(1, 1);');
    expect(additiveTestEditRefusal(BASE, swapped)).toMatch(/rewrites existing content/);
    // Comment burial: wrapping the old file in /* */ rewrites byte 0.
    expect(additiveTestEditRefusal(BASE, `/*${BASE}*/\ntest('t', () => assert.ok(1));\n`)).toMatch(
      /rewrites existing content/
    );
  });

  it('refuses when the old file has no recognizable tests (cannot verify)', () => {
    expect(additiveTestEditRefusal('// just a fixture\nconst x = 1;\n', 'anything')).toMatch(
      /no recognizable test cases/
    );
  });

  it('extracts python test titles too', () => {
    expect(extractTestTitles('def test_alpha():\n    assert 1\n')).toEqual(['test_alpha']);
  });

  it('refuses appended suppression, exits, assertion patches, and file-scope hooks/mocks', () => {
    // In vitest/jest a single .only silences every other test in the file.
    const append = (code: string) => `${BASE}\n${code}\n`;
    expect(additiveTestEditRefusal(BASE, append("test.only('t', () => assert.ok(1));"))).toMatch(/suppression/);
    // Chained form the adjacency-anchored regex used to miss (security review).
    expect(additiveTestEditRefusal(BASE, append("test.each([[1]]).only('t %s', () => assert.ok(1));"))).toMatch(
      /suppression/
    );
    expect(additiveTestEditRefusal(BASE, append('process.exit(0);'))).toMatch(/process\.exit/);
    expect(additiveTestEditRefusal(BASE, append('assert.equal = () => {};'))).toMatch(/assertion machinery/);
    expect(additiveTestEditRefusal(BASE, append("beforeEach(() => {});"))).toMatch(/hooks or module mocking/);
    // Editing a suppressor INTO the frozen prefix is a rewrite.
    const withSkip = BASE.replace("test('rejects bad input'", "test.skip('rejects bad input'");
    expect(additiveTestEditRefusal(BASE, withSkip)).toMatch(/rewrites existing content/);
  });
});

describe('applier: protected test target with additive content', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-additive-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/stats.test.js'), BASE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const options = { protectedFiles: new Set(['test/stats.test.js']) };

  it('applies an additive rewrite of a protected test file', () => {
    const output = '```file:test/stats.test.js\n' + ADDITIVE + '```\n';
    const result = applyFileBlocks(output, dir, options);
    expect(result.rejected).toEqual([]);
    expect(result.filesWritten).toContain('test/stats.test.js');
    expect(readFileSync(join(dir, 'test/stats.test.js'), 'utf-8')).toBe(ADDITIVE);
  });

  it('still rejects a weakening rewrite of a protected test file', () => {
    const output = '```file:test/stats.test.js\n' + REMOVES_TEST + '```\n';
    const result = applyFileBlocks(output, dir, options);
    expect(result.filesWritten).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/protected/);
    expect(readFileSync(join(dir, 'test/stats.test.js'), 'utf-8')).toBe(BASE);
  });
});

describe('integrity guard: additive test change is not tampering', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-integrity-additive-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/stats.test.js'), BASE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts an additive change without restoring, statelessly', () => {
    const snap = captureIntegrity(dir, ['test/stats.test.js']);
    writeFileSync(join(dir, 'test/stats.test.js'), ADDITIVE);
    const first = verifyAndRestore(dir, snap);
    expect(first.tampered).toEqual([]);
    expect(readFileSync(join(dir, 'test/stats.test.js'), 'utf-8')).toBe(ADDITIVE);
    // Stateless: a second verify against the SAME snapshot re-sanctions it.
    const second = verifyAndRestore(dir, snap);
    expect(second.tampered).toEqual([]);
    expect(readFileSync(join(dir, 'test/stats.test.js'), 'utf-8')).toBe(ADDITIVE);
  });

  it('still restores a weakening change and reports tampering', () => {
    const snap = captureIntegrity(dir, ['test/stats.test.js']);
    writeFileSync(join(dir, 'test/stats.test.js'), REMOVES_TEST);
    const check = verifyAndRestore(dir, snap);
    expect(check.tampered).toEqual(['test/stats.test.js']);
    expect(check.restored).toEqual(['test/stats.test.js']);
    expect(readFileSync(join(dir, 'test/stats.test.js'), 'utf-8')).toBe(BASE);
  });

  it('still restores non-test oracle files on ANY change', () => {
    writeFileSync(join(dir, 'test/fixture.json'), '{"a":1}');
    const snap = captureIntegrity(dir, ['test/fixture.json']);
    writeFileSync(join(dir, 'test/fixture.json'), '{"a":2}');
    const check = verifyAndRestore(dir, snap);
    expect(check.tampered).toEqual(['test/fixture.json']);
    expect(readFileSync(join(dir, 'test/fixture.json'), 'utf-8')).toBe('{"a":1}');
  });
});
