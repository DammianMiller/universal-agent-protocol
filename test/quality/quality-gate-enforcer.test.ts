import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { defaultConfig } from '../../src/quality/config.js';
import { scanContent } from '../../src/quality/scanner.js';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'quality_metrics_gate.py');

let proj: string;

const BAD_TS = [
  'export function tangle(a: number, b: number, c: number): any {',
  '  let x: any = a;',
  '  if (a > 0) { if (b > 0) { if (c > 0) { if (x) { if (b) { x = a + b + c; } } } } }',
  '  for (let i = 0; i < a; i++) { while (b > 0) { if (c && i) { b--; } else if (i) { b -= 2; } } }',
  '  return x as any;',
  '}',
].join('\n');

const CLEAN_TS = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';

beforeAll(() => {
  proj = mkdtempSync(join(tmpdir(), 'uap-qg-'));
  mkdirSync(join(proj, '.uap'));
  mkdirSync(join(proj, 'src'));
  writeFileSync(
    join(proj, '.uap', 'quality-metrics.json'),
    JSON.stringify(defaultConfig(), null, 2)
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
  delete baseEnv.UAP_QUALITY_GATE_OFF;
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

describe('quality-metrics gate enforcer', () => {
  it('BLOCKS a Write introducing new complexity + any-type debt (exit 2)', () => {
    const r = run('Write', { file_path: join(proj, 'src', 'bad.ts'), content: BAD_TS });
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/NEW or WORSENED metric debt/);
    expect(r.reason).toMatch(/cognitive/);
    expect(r.reason).toMatch(/any\/unknown/);
  });

  it('ALLOWS a clean Write (exit 0)', () => {
    const r = run('Write', { file_path: join(proj, 'src', 'ok.ts'), content: CLEAN_TS });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it('is INACTIVE without .uap/quality-metrics.json (fail-open, opt-in)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'uap-qg-bare-'));
    try {
      const r = run('Write', { file_path: join(bare, 'x.ts'), content: BAD_TS }, {}, bare);
      expect(r.exit).toBe(0);
      expect(r.reason).toMatch(/quality gate inactive/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('ignores non-source files', () => {
    const r = run('Write', { file_path: join(proj, 'README.md'), content: BAD_TS });
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/not a scannable source file/);
  });

  it('honours UAP_QUALITY_GATE_OFF=1', () => {
    const r = run(
      'Write',
      { file_path: join(proj, 'src', 'bad.ts'), content: BAD_TS },
      { UAP_QUALITY_GATE_OFF: '1' }
    );
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/override/);
  });

  it('respects the config excludeDirs (a Write into dist/ is not gated)', () => {
    const r = run('Write', { file_path: join(proj, 'dist', 'bundle.js'), content: BAD_TS });
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/excluded dir/);
  });

  it('grandfathers baseline-recorded debt but BLOCKS worsening it', () => {
    // Freeze the bad file's debt in the baseline…
    const target = join(proj, 'src', 'based.ts');
    writeFileSync(target, BAD_TS);
    const config = defaultConfig();
    const violations = scanContent('src/based.ts', BAD_TS, config);
    expect(violations.length).toBeGreaterThan(0);
    writeFileSync(
      join(proj, '.uap', 'quality-baseline.json'),
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        entries: violations.map((v) => ({ signature: v.signature, value: v.value })),
      })
    );

    // …an identical re-write is grandfathered…
    const same = run('Write', { file_path: target, content: BAD_TS });
    expect(same.exit).toBe(0);
    expect(same.reason).toMatch(/grandfathered/);

    // …but one more `as any` worsens anyTypes and re-blocks.
    const worse = run('Write', { file_path: target, content: BAD_TS + '\nexport const more = x as any;\n' });
    expect(worse.exit).toBe(2);
    expect(worse.reason).toMatch(/any\/unknown/);
  });

  it('TS scanner and Python enforcer produce the SAME violation signatures (parity corpus)', () => {
    // The CLI writes the baseline with TS signatures; the enforcer ratchets
    // with Python-computed ones. Drift between them false-blocks edits, so
    // lock the parity in a test — across a FIXTURE CORPUS, not one happy
    // path: a one-line function followed by a second function (the region
    // swallow regression), module-level decisions (<module> pseudo-function),
    // and an indent-based python def.
    const corpus: Array<{ rel: string; content: string }> = [
      { rel: 'src/parity.ts', content: BAD_TS },
      {
        rel: 'src/oneline.ts',
        content: [
          'export function one(): any { return 1 as any; }',
          'export function two(a: number) {',
          '  if (a > 0) { return 1; }',
          '  return 0;',
          '}',
        ].join('\n'),
      },
      {
        rel: 'src/modulelevel.ts',
        content: [
          'const x: any = process.env.A;',
          'if (x) {',
          '  for (const c of x) { if (c > "a" && c < "z") console.log(c); }',
          '}',
        ].join('\n'),
      },
      {
        rel: 'src/parity.py',
        content: [
          'def f(a, b):',
          '    if a and b:',
          '        for i in range(b):',
          '            while a or i:',
          '                if i:',
          '                    return i',
          '    return 0',
        ].join('\n'),
      },
      {
        // Multi-line signature: the `{` is on a later line. A regression
        // here scores the header alone as 1/0 and dumps the body into
        // <module> — discovered when the gate scanned its own codebase.
        rel: 'src/multiline.ts',
        content: [
          'export function split(',
          '  a: number,',
          '  b: number,',
          '): number {',
          '  if (a > 0 && b > 0) {',
          '    for (let i = 0; i < a; i++) {',
          '      if (i === b) { return i; }',
          '    }',
          '  }',
          '  return 0;',
          '}',
          'export const after = (n: number) => {',
          '  while (n > 1) { n = n - 1; }',
          '  return n;',
          '};',
        ].join('\n'),
      },
    ];
    const thresholdsJson = JSON.stringify(defaultConfig().thresholds);
    for (const { rel, content } of corpus) {
      const tsSigs = scanContent(rel, content, defaultConfig())
        .map((v) => v.signature)
        .sort();
      const pyProgram = [
        'import sys, json, importlib.util',
        `spec = importlib.util.spec_from_file_location("qg", ${JSON.stringify(ENFORCER)})`,
        'qg = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(qg)',
        'content = sys.stdin.read()',
        `thresholds = json.loads(${JSON.stringify(thresholdsJson)})`,
        `vs = qg._violations(${JSON.stringify(rel)}, content, thresholds)`,
        'print(json.dumps(sorted(v["signature"] for v in vs)))',
      ].join('\n');
      const r = spawnSync('python3', ['-c', pyProgram], { input: content, encoding: 'utf8' });
      expect(r.status, `python enforcer crashed on ${rel}: ${r.stderr}`).toBe(0);
      const pySigs = JSON.parse(r.stdout.trim());
      expect(pySigs, `signature parity mismatch on ${rel}`).toEqual(tsSigs);
    }
  });
});
