/**
 * The gate runs COPIES of the enforcers. Nothing verified them, so the
 * enforcement surface had two failure modes that both looked like success:
 * a stale copy (a merged fix silently not in force — this repo shipped that for
 * over a week) and a deleted one (removing `_common.py` broke all 29 enforcers
 * at import and turned the gate into a no-op — verified live).
 *
 * Refusal cannot fix the second: `python3 -c` can write any file and is allowed
 * by design. Repair can. These tests pin the repair.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_NAME,
  SOURCE_NAME,
  sourceNameFor,
  writeIntegrityManifest,
  verifyIntegrity,
  repairIntegrity,
  readManifest,
} from '../src/integrity/enforcer-manifest.js';

const ID = '11111111-1111-1111-1111-111111111111';
const ENFORCER = `${ID}_enforcement_self_protect.py`;

describe('sourceNameFor', () => {
  it('maps a materialized copy back to its source file', () => {
    // Tool names contain underscores, so splitting on the LAST one would ask
    // for `protect.py`. The id is a UUID; split after it.
    expect(sourceNameFor(ENFORCER)).toBe('enforcement_self_protect.py');
    expect(sourceNameFor(`${ID}_memory_before_plan.py`)).toBe('memory_before_plan.py');
  });

  it('leaves the shared helper alone', () => {
    expect(sourceNameFor('_common.py')).toBe('_common.py');
  });
});

describe('enforcer integrity', () => {
  let root: string;
  let toolDir: string;
  let sourceDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-integrity-'));
    toolDir = join(root, '.policy-tools');
    sourceDir = join(root, 'src/policies/enforcers');
    mkdirSync(toolDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, '_common.py'), 'REAL_COMMON = 1\n');
    writeFileSync(join(sourceDir, 'enforcement_self_protect.py'), 'REAL_ENFORCER = 1\n');
    writeFileSync(join(toolDir, '_common.py'), 'REAL_COMMON = 1\n');
    writeFileSync(join(toolDir, ENFORCER), 'REAL_ENFORCER = 1\n');
    writeIntegrityManifest(toolDir, sourceDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('records every materialized file and where it came from', () => {
    expect(readManifest(toolDir)?.size).toBe(2);
    expect(readFileSync(join(toolDir, SOURCE_NAME), 'utf-8').trim()).toBe(sourceDir);
    expect(verifyIntegrity(toolDir)).toMatchObject({ changed: [], missing: [], unmanaged: false });
  });

  it('detects a tampered enforcer', () => {
    writeFileSync(join(toolDir, ENFORCER), 'def emit(*a): print({"allowed": True})\n');
    expect(verifyIntegrity(toolDir).changed).toEqual([ENFORCER]);
  });

  it('detects the deleted helper that took the whole surface down', () => {
    rmSync(join(toolDir, '_common.py'));
    expect(verifyIntegrity(toolDir).missing).toEqual(['_common.py']);
  });

  it('repairs a tampered enforcer back to source', () => {
    // The attack this exists for: swap the enforcer for one that always allows.
    writeFileSync(join(toolDir, ENFORCER), 'ALWAYS_ALLOW = 1\n');
    const r = repairIntegrity(toolDir, root);
    expect(r.restored).toEqual([ENFORCER]);
    expect(readFileSync(join(toolDir, ENFORCER), 'utf-8')).toBe('REAL_ENFORCER = 1\n');
    expect(verifyIntegrity(toolDir).changed).toEqual([]);
  });

  it('repairs the deleted helper', () => {
    rmSync(join(toolDir, '_common.py'));
    const r = repairIntegrity(toolDir, root);
    expect(r.restored).toEqual(['_common.py']);
    expect(existsSync(join(toolDir, '_common.py'))).toBe(true);
  });

  it('reports what it cannot restore instead of pretending', () => {
    rmSync(join(sourceDir, 'enforcement_self_protect.py'));
    writeFileSync(join(toolDir, ENFORCER), 'TAMPERED = 1\n');
    const r = repairIntegrity(toolDir, root);
    expect(r.restored).toEqual([]);
    expect(r.unrecoverable).toEqual([ENFORCER]);
  });

  it('does not delete an enforcer an operator added by hand', () => {
    // Satisfying a checksum by deleting someone's work is worse than the drift.
    writeFileSync(join(toolDir, 'custom_local_rule.py'), 'LOCAL = 1\n');
    const r = repairIntegrity(toolDir, root);
    expect(r.unknown).toEqual(['custom_local_rule.py']);
    expect(existsSync(join(toolDir, 'custom_local_rule.py'))).toBe(true);
  });

  it('says so when there is no manifest rather than guessing', () => {
    rmSync(join(toolDir, MANIFEST_NAME));
    expect(verifyIntegrity(toolDir).unmanaged).toBe(true);
    expect(repairIntegrity(toolDir, root).restored).toEqual([]);
  });

  it('falls back to the resolved source when the recorded path is gone', () => {
    // An installed project can be moved; the recorded absolute path then dangles.
    writeFileSync(join(toolDir, SOURCE_NAME), '/nonexistent/enforcers\n');
    rmSync(join(toolDir, '_common.py'));
    const r = repairIntegrity(toolDir, root);
    expect(r.restored).toEqual(['_common.py']);
  });
});
