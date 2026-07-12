import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { snapshotProtection } from '../../src/delivery/spec-imports.js';

describe('user-paths manifest protection', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-manifestprotect-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('protects .uap/user-paths.json when present (model cannot weaken its own journeys)', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'user-paths.json'), '{"version":1,"paths":[]}');
    const snap = snapshotProtection(dir);
    expect(snap.protectedFiles.has(join('.uap', 'user-paths.json').toLowerCase())).toBe(true);
  });

  it('does not fabricate protection when no manifest exists', () => {
    const snap = snapshotProtection(dir);
    expect([...snap.protectedFiles].some((f) => f.includes('user-paths'))).toBe(false);
  });
});
