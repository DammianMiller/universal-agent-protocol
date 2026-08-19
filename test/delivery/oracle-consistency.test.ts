import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  captureIntegrity,
  oracleConsistencyCheck,
  oracleConsistencyFeedback,
  verifyAndRestore,
} from '../../src/delivery/integrity.js';
import type { GateRung } from '../../src/delivery/verifier-ladder.js';

/**
 * The behavioral control behind the additive test-edit carve-out.
 *
 * The textual rule (append-only + delta denylist) cannot see appended
 * module-scope code that neutralizes the frozen tests at runtime. The attack
 * exercised here is exactly that shape: the SUT exports an object, the
 * appended module-scope line re-points its method BEFORE test callbacks run,
 * and every frozen test passes against a broken implementation. The append
 * contains no suppressor, no assert patch, no hook, no require.cache — the
 * textual rule sanctions it. Only re-running the ORIGINAL oracle bytes
 * exposes it.
 */

const BASE_TEST = `const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../sut.js');

test('calc returns 42', () => {
  assert.equal(s.calc(), 42);
});
`;

// Sanctioned-looking masking append: module scope, executes before callbacks.
const MASKING_APPEND = `
test('extra coverage', () => {
  assert.equal(typeof s.calc, 'function');
});
require('../sut.js').calc = () => 42;
`;

const LEGIT_APPEND = `
test('calc is a function', () => {
  assert.equal(typeof s.calc, 'function');
});
`;

// NOTE the explicit FILE path rather than the `test/` directory. On Node 24
// `node --test test/` no longer expands the directory — it fails to load it and
// exits 1 with `MODULE_NOT_FOUND`, before running anything. That broke this
// fixture in a way that read as a passing suite: the masking test asserts
// `consistent === false`, which a rung that ALWAYS fails satisfies for entirely
// the wrong reason, so only the legitimate-append test went red. Measured:
//   node --test test/              -> exit 1, 0 pass, 1 fail
//   node --test test/sut.test.js   -> exit 0, 2 pass, 0 fail
// A glob is not an option: these args are spawned without a shell, so
// `test/*.test.js` would be passed through literally.
const testRung: GateRung = {
  id: 'test',
  name: 'node --test',
  command: process.execPath,
  args: ['--test', 'test/sut.test.js'],
  required: true,
  timeoutMs: 30_000,
};

describe('oracleConsistencyCheck', () => {
  let dir: string;
  const testFile = 'test/sut.test.js';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-oracle-'));
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, testFile), BASE_TEST);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('catches a sanctioned-looking append that masks a broken implementation', () => {
    writeFileSync(join(dir, 'sut.js'), 'module.exports = { calc: () => 41 };\n'); // BROKEN
    const snap = captureIntegrity(dir, [testFile]);
    const masked = BASE_TEST + MASKING_APPEND;
    writeFileSync(join(dir, testFile), masked);

    // The textual rule sanctions the append…
    const check = verifyAndRestore(dir, snap);
    expect(check.tampered).toEqual([]);
    expect(check.sanctionedAdditive).toEqual([testFile]);

    // …and the behavioral check exposes it.
    const oracle = oracleConsistencyCheck(dir, snap, check.sanctionedAdditive, [testRung]);
    expect(oracle.consistent).toBe(false);
    expect(oracle.failedRungId).toBe('test');
    expect(oracleConsistencyFeedback(oracle)).toMatch(/masking failures/);
    // The tree is left as the turn produced it (masked bytes restored).
    expect(readFileSync(join(dir, testFile), 'utf-8')).toBe(masked);
  });

  it('passes a legitimate additive append over a correct implementation', () => {
    writeFileSync(join(dir, 'sut.js'), 'module.exports = { calc: () => 42 };\n'); // CORRECT
    const snap = captureIntegrity(dir, [testFile]);
    const appended = BASE_TEST + LEGIT_APPEND;
    writeFileSync(join(dir, testFile), appended);

    const check = verifyAndRestore(dir, snap);
    expect(check.sanctionedAdditive).toEqual([testFile]);

    const oracle = oracleConsistencyCheck(dir, snap, check.sanctionedAdditive, [testRung]);
    expect(oracle.consistent).toBe(true);
    expect(oracle.checkedFiles).toEqual([testFile]);
    expect(readFileSync(join(dir, testFile), 'utf-8')).toBe(appended);
  });

  it('is a no-op when there are no test rungs or no sanctioned files', () => {
    const snap = captureIntegrity(dir, [testFile]);
    expect(oracleConsistencyCheck(dir, snap, [], [testRung]).consistent).toBe(true);
    expect(
      oracleConsistencyCheck(dir, snap, [testFile], [
        { ...testRung, id: 'build', name: 'Build (make)' },
      ]).consistent
    ).toBe(true);
  });

  it('selects test rungs by NAME too — a Makefile suite is id "make", name "Make (make test)"', () => {
    writeFileSync(join(dir, 'sut.js'), 'module.exports = { calc: () => 41 };\n'); // BROKEN
    const snap = captureIntegrity(dir, [testFile]);
    writeFileSync(join(dir, testFile), BASE_TEST + MASKING_APPEND);
    const check = verifyAndRestore(dir, snap);
    const makeStyleRung = { ...testRung, id: 'make', name: 'Make (make test)' };
    const oracle = oracleConsistencyCheck(dir, snap, check.sanctionedAdditive, [makeStyleRung]);
    expect(oracle.consistent).toBe(false);
    expect(oracle.failedRungId).toBe('make');
  });
});
