import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nearestPathHint } from '../../src/delivery/path-hints';
import { classifyToolResult } from '../../src/telemetry/tool-failure';

let roots: string[] = [];

function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'path-hints-'));
  roots.push(r);
  return r;
}

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('nearestPathHint', () => {
  it('suggests the near-miss basename in the right directory', () => {
    const r = root();
    mkdirSync(join(r, 'src', 'types'), { recursive: true });
    writeFileSync(join(r, 'src', 'types', 'audit.ts'), 'export {};\n');
    const hint = nearestPathHint(r, 'src/types/audits.ts');
    expect(hint).toContain('did you mean');
    expect(hint).toContain('src/types/audit.ts');
  });

  it('matches case-insensitively', () => {
    const r = root();
    writeFileSync(join(r, 'big.js'), 'x\n');
    const hint = nearestPathHint(r, 'BIG.js');
    expect(hint).toContain('big.js');
  });

  it('falls back to listing the nearest existing directory when nothing is close', () => {
    const r = root();
    mkdirSync(join(r, 'apps', 'api', 'src'), { recursive: true });
    writeFileSync(join(r, 'apps', 'api', 'src', 'server.ts'), 'x\n');
    const hint = nearestPathHint(r, 'apps/api/v1/infra/gateway-routes.tf');
    expect(hint).toContain('nearest existing directory apps/api/');
    // The anchor's IMMEDIATE entries — the next path the model sends should be
    // a fact under this dir, not another guess in a missing one.
    expect(hint).toContain('src/');
    expect(hint).not.toContain('did you mean');
  });

  it('returns null when no ancestor exists within the walk-up bound', () => {
    const r = root();
    expect(nearestPathHint(r, 'totally/bogus/deeper/than/bound/x.ts')).toBeNull();
  });

  it('returns null for empty and dot paths', () => {
    const r = root();
    expect(nearestPathHint(r, '')).toBeNull();
    expect(nearestPathHint(r, '.')).toBeNull();
  });

  it('caps suggestions and directory entries (bounded output)', () => {
    const r = root();
    mkdirSync(join(r, 'src'), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(r, 'src', `file${i}.ts`), 'x\n');
    const hint = nearestPathHint(r, 'src/file39.tsx', { maxSuggestions: 2 });
    expect(hint).toBeTruthy();
    // ≤ 2 suggestions requested, each a comma-separated pair bound.
    const commas = (hint?.match(/,/g) ?? []).length;
    expect(commas).toBeLessThanOrEqual(1);
  });

  it('never throws on a path that is a bare filename with no project files', () => {
    const r = root();
    expect(nearestPathHint(r, 'package.json')).toBeNull();
  });

  it('keeps the not-found error classified as path-not-found once the hint is appended', () => {
    const r = root();
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'audit.ts'), 'x\n');
    const hint = nearestPathHint(r, 'src/audits.ts') ?? '';
    const error = `ERROR: src/audits.ts does not exist — use write_file to create new files.${hint}`;
    expect(classifyToolResult('edit_file', error)).toBe('path-not-found');
  });
});
