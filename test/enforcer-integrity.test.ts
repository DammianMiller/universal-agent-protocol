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
    // `toContain`, not `toEqual`: this test is about the FALLBACK working, and
    // repair now also refreshes SUPERSEDED copies — against the installed
    // package here, which this fixture's toy enforcer differs from. Asserting
    // the exact set would be asserting the absence of that, which is not what
    // the test is named for.
    expect(r.restored).toContain('_common.py');
  });
});

describe('a SUPERSEDED copy is drift too', () => {
  // The quiet failure this file's own header describes ("a merged fix silently
  // not in force — this repo shipped that for over a week") was pinned for
  // REPAIR but never for DETECTION. A stale copy matches its manifest exactly,
  // so verification passed and reported success over a gate running old code.
  //
  // Measured on the live tree the day this was written: `uap policy verify`
  // printed "Enforcers match their manifest" while the materialized
  // self-protect enforcer was missing a fix merged an hour earlier.
  let root: string;
  let toolDir: string;
  let sourceDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uap-stale-'));
    toolDir = join(root, '.policy-tools');
    sourceDir = join(root, 'src/policies/enforcers');
    mkdirSync(toolDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, '_common.py'), 'REAL_COMMON = 1\n');
    writeFileSync(join(sourceDir, 'enforcement_self_protect.py'), 'V1 = 1\n');
    writeFileSync(join(toolDir, '_common.py'), 'REAL_COMMON = 1\n');
    writeFileSync(join(toolDir, ENFORCER), 'V1 = 1\n');
    writeIntegrityManifest(toolDir, sourceDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Ship a new version of the enforcer SOURCE, leaving the copy untouched. */
  function advanceSource(): void {
    writeFileSync(join(sourceDir, 'enforcement_self_protect.py'), 'V2 = 2\n');
  }

  it('reports nothing while the copy matches source', () => {
    expect(verifyIntegrity(toolDir).stale).toEqual([]);
  });

  it('flags the copy once source moves ahead', () => {
    advanceSource();
    expect(verifyIntegrity(toolDir).stale).toEqual([ENFORCER]);
  });

  it('does NOT call it tampered — the two need different remedies', () => {
    advanceSource();
    const r = verifyIntegrity(toolDir);
    expect(r.changed).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('--repair puts the new version into force', () => {
    advanceSource();
    repairIntegrity(toolDir, root);
    expect(readFileSync(join(toolDir, ENFORCER), 'utf-8')).toBe('V2 = 2\n');
  });

  it('re-records the manifest, so the refresh is not read as tampering', () => {
    // Without this the repaired copy no longer matches the recorded hash and
    // the very next verify calls it CHANGED — turning a fix into an alarm.
    advanceSource();
    repairIntegrity(toolDir, root);
    const after = verifyIntegrity(toolDir);
    expect(after.changed).toEqual([]);
    expect(after.stale).toEqual([]);
  });

  it('is idempotent', () => {
    advanceSource();
    repairIntegrity(toolDir, root);
    const second = repairIntegrity(toolDir, root);
    expect(second.restored).toEqual([]);
  });

  it('a TAMPERED copy is still tampered, not stale', () => {
    // Tampering must keep its own louder verdict; both are repaired, but they
    // mean different things and only one implies someone edited the surface.
    writeFileSync(join(toolDir, ENFORCER), 'def emit(*a): print({"allowed": True})\n');
    const r = verifyIntegrity(toolDir);
    expect(r.changed).toEqual([ENFORCER]);
    expect(r.stale).toEqual([]);
  });

  it('falls back to the INSTALLED package when the recorded source is gone', () => {
    // This is the mechanism that carries a fix into OTHER projects: they have
    // no enforcer source of their own, so the comparison has to be against the
    // installed package. My first version of this test asserted the opposite —
    // that a missing source means "unknowable, say nothing" — which is not what
    // happens and would have made cross-project propagation impossible.
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(join(toolDir, SOURCE_NAME), { force: true });
    const r = verifyIntegrity(toolDir, root);
    // The fixture's toy enforcer cannot match the real installed one.
    expect(r.stale).toContain(ENFORCER);
  });
});
