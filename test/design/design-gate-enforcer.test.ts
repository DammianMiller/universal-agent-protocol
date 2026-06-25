import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'design_token_gate.py');

let proj: string;

beforeAll(() => {
  proj = mkdtempSync(join(tmpdir(), 'uap-dtg-'));
  mkdirSync(join(proj, '.uap'));
  // Allow-list as `uap design sync` would write it.
  writeFileSync(
    join(proj, '.uap', 'design-tokens.json'),
    JSON.stringify({
      name: 'Heritage',
      colors: ['#1a1c1e', '#b8422e'],
      spacing: ['16px', '24px'],
      radii: ['8px'],
      fontSizes: ['48px'],
      fontFamilies: ['public sans'],
      generatedFrom: 'DESIGN.md',
    })
  );
});
afterAll(() => rmSync(proj, { recursive: true, force: true }));

function run(
  op: string,
  args: Record<string, unknown>,
  env: Record<string, string> = {},
  root = proj
): { exit: number; allowed: boolean; reason: string } {
  const baseEnv = { ...process.env };
  delete baseEnv.UAP_DESIGN_GATE_OFF;
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify(args)], {
    env: { ...baseEnv, UAP_REPO_ROOT: root, UAP_WORKTREE_ROOT: root, ...env },
    encoding: 'utf8',
  });
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

describe('design-token gate enforcer', () => {
  it('BLOCKS a UI write with an off-token color (exit 2)', () => {
    const r = run('Write', { file_path: 'src/new.css', content: '.x{color:#ff00ff;}' });
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/off-token colors/);
  });

  it('BLOCKS off-scale spacing', () => {
    const r = run('Write', { file_path: 'a.scss', content: '.x{padding:7px;}' });
    expect(r.exit).toBe(2);
    expect(r.reason).toMatch(/off-scale spacing/);
  });

  it('ALLOWS on-token colors, var() refs and scale spacing (exit 0)', () => {
    const r = run('Write', {
      file_path: 'src/new.css',
      content: '.x{color:#1A1C1E;background:var(--y);padding:16px;border:1px;}',
    });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it('ALLOWS a translucent rgba() overlay of a token color (#1a1c1e = rgb(26,28,30))', () => {
    expect(run('Write', { file_path: 'a.css', content: '.x{background:rgba(26,28,30,0.15);}' }).exit).toBe(0);
    // A different base RGB is still blocked.
    expect(run('Write', { file_path: 'a.css', content: '.x{background:rgba(1,2,3,0.5);}' }).exit).toBe(2);
  });

  it('ALLOWS an Edit insert (new_string) that is on-token', () => {
    const r = run('Edit', { file_path: 'a.tsx', new_string: 'style={{color:"#b8422e"}}' });
    expect(r.exit).toBe(0);
  });

  it('ignores non-UI files', () => {
    const r = run('Write', { file_path: 'src/logic.ts', content: 'const c = "#ff00ff";' });
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/not a UI file/);
  });

  it('fails OPEN when the project has no allow-list', () => {
    const empty = mkdtempSync(join(tmpdir(), 'uap-dtg-empty-'));
    try {
      const r = run('Write', { file_path: 'x.css', content: '.x{color:#ff00ff;}' }, {}, empty);
      expect(r.exit).toBe(0);
      expect(r.reason).toMatch(/gate inactive/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('honors the UAP_DESIGN_GATE_OFF escape hatch', () => {
    const r = run('Write', { file_path: 'x.css', content: '.x{color:#ff00ff;}' }, { UAP_DESIGN_GATE_OFF: '1' });
    expect(r.exit).toBe(0);
  });
});
