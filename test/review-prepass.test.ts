import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  scanFileContent,
  runPrePass,
  branchSlug,
  writePrePassArtifact,
} from '../src/review/prepass.js';
import { reviewCommand } from '../src/cli/review.js';

// Fixture strings are assembled at runtime so this test file does not itself
// trip the pre-pass scanner — otherwise every edit to the scanner's tests
// would inherit mandatory HIGH-finding adjudications of its own fixtures,
// training exactly the dismiss-without-reading habit the pass exists to avoid.
const VULNERABLE_TS = [
  'export const AWS_KEY = "AKIA' + 'IOSFODNN7EXAMPLE";',
  'const pass' + 'word = "hunter2-is-a-bad-password";',
  'export function run(cmd: string) { return ev' + 'al(cmd); }',
  'const f = new Fun' + 'ction("x", "return x");',
  'app.get("/x", (req, res) => { res.set("Access-Control-Allow-Or' + 'igin", "*"); });',
  'function q(name: string) { return db.query(`SEL' + 'ECT * FROM users WHERE name = \'${name}\'`); }',
  'try { doThing(); } cat' + 'ch (e) {}',
  '} cat' + 'ch (e) {',
  '}',
  'execSy' + 'nc("ls " + dir);',
  'el.dangerouslySet' + 'InnerHTML = undefined; node.inner' + 'HTML = x;',
  'document.wr' + 'ite("<p>" + x);',
  'list.insertAdjacent' + 'HTML("beforeend", x);',
  'app.use(cors({ origin: ' + '"*" }));',
  'const gh = "ghp_' + 'abcdefghij1234567890ABCD";',
  'const jwt = "eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0fQ.Sfl' + 'KxwRJSMeKKF2QT4f";',
  '',
].join('\n');

const VULNERABLE_PY = [
  'import subprocess',
  'import threading',
  '',
  'subprocess.run(user_input, shell=Tr' + 'ue)',
  '',
  'def load():',
  '    try:',
  '        risky()',
  '    except Exception:',
  '        pa' + 'ss',
  '',
  'threading.Thr' + 'ead(target=load).start()',
  '',
].join('\n');

const CLEAN_TS = `export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  const password = process.env.SERVICE_PASSWORD;
  return \`hello \${name}\${password ? '!' : ''}\`;
}
`;

describe('review pre-pass scanner', () => {
  it('catches planted vulnerabilities without any LLM', () => {
    const findings = scanFileContent('src/vuln.ts', VULNERABLE_TS);
    const rules = new Set(findings.map((f) => f.rule));
    expect(rules.has('aws-access-key')).toBe(true);
    expect(rules.has('hardcoded-secret')).toBe(true);
    expect(rules.has('eval-call')).toBe(true);
    expect(rules.has('new-function')).toBe(true);
    expect(rules.has('cors-wildcard')).toBe(true);
    expect(rules.has('sql-template-interpolation')).toBe(true);
    expect(rules.has('empty-catch')).toBe(true);
    expect(rules.has('exec-concat')).toBe(true);
    expect(rules.has('dangerously-set-innerhtml')).toBe(true);
    expect(rules.has('document-write')).toBe(true);
    expect(rules.has('insert-adjacent-html')).toBe(true);
    expect(rules.has('cors-origin-wildcard')).toBe(true);
    expect(rules.has('github-token')).toBe(true);
    expect(rules.has('jwt-token')).toBe(true);
    // the acceptance bar: >= 2 fixture vulnerabilities caught deterministically
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it('catches the multi-line empty catch form (line-rule evasion)', () => {
    const findings = scanFileContent('src/vuln.ts', VULNERABLE_TS);
    const catches = findings.filter((f) => f.rule === 'empty-catch');
    // single-line form on line 7 AND the multi-line form starting line 8
    expect(catches.map((f) => f.line).sort()).toEqual([7, 8]);
  });

  it('redacts secret material from snippets (artifacts feed LLM prompts)', () => {
    const findings = scanFileContent('src/vuln.ts', VULNERABLE_TS);
    const secretFindings = findings.filter((f) => f.category === 'secrets');
    expect(secretFindings.length).toBeGreaterThanOrEqual(3);
    for (const f of secretFindings) {
      expect(f.snippet).toContain('***redacted***');
      expect(f.snippet).not.toContain('AKIA' + 'IOSFODNN7EXAMPLE');
      expect(f.snippet).not.toContain('hunter2');
      expect(f.snippet).not.toContain('abcdefghij1234567890ABCD');
    }
    // non-secret findings keep their snippets intact for reviewer context
    const evalFinding = findings.find((f) => f.rule === 'eval-call');
    expect(evalFinding?.snippet).toContain('cmd');
  });

  it('anchors findings to the correct line numbers', () => {
    const findings = scanFileContent('src/vuln.ts', VULNERABLE_TS);
    const evalFinding = findings.find((f) => f.rule === 'eval-call');
    expect(evalFinding?.line).toBe(3);
    const awsFinding = findings.find((f) => f.rule === 'aws-access-key');
    expect(awsFinding?.line).toBe(1);
  });

  it('catches python shell flag, except-pass, and threading without a lock', () => {
    const findings = scanFileContent('worker/job.py', VULNERABLE_PY);
    const rules = new Set(findings.map((f) => f.rule));
    expect(rules.has('shell-true')).toBe(true);
    expect(rules.has('except-pass')).toBe(true);
    expect(rules.has('threading-no-lock')).toBe(true);
  });

  it('catches the single-line except-pass form', () => {
    const src = 'def f():\n    try: x()\n    except Exception: pa' + 'ss\n';
    const findings = scanFileContent('a.py', src);
    expect(findings.map((f) => f.rule)).toContain('except-pass');
    expect(findings.find((f) => f.rule === 'except-pass')?.line).toBe(3);
  });

  it('produces zero findings on clean code (env-var secret refs are not findings)', () => {
    expect(scanFileContent('src/clean.ts', CLEAN_TS)).toHaveLength(0);
  });

  it('does not fire code rules on prose files, but still scans them for secrets', () => {
    const md = '# Notes\nUse ev' + 'al(cmd) carefully in this example.\n';
    expect(scanFileContent('docs/notes.md', md)).toHaveLength(0);
    const leaked = '# Config\n-----BEGIN PRIVATE ' + 'KEY-----\n';
    expect(scanFileContent('docs/leak.md', leaked).map((f) => f.rule)).toContain('private-key-block');
  });

  it('branchSlug matches the expert-review enforcer encoding (injective)', () => {
    expect(branchSlug('feature/296-routing-evals')).toBe('feature%2F296-routing-evals');
    expect(branchSlug('feature-foo')).toBe('feature-foo');
    expect(branchSlug('a%b/c')).toBe('a%25b%2Fc');
  });
});

describe('pre-pass artifact', () => {
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'uap-prepass-'));
    execSync('git init -q -b feature/test-branch', { cwd: dir });
    execSync('git config user.email t@t.t && git config user.name t', { cwd: dir });
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    execSync('git add -A && git commit -qm init', { cwd: dir });
    return dir;
  }

  it('writes a SIBLING artifact, never the enforcer-watched <slug>.json', () => {
    const dir = makeRepo();
    const artifactDir = join(dir, '.uap', 'reviews');
    mkdirSync(artifactDir, { recursive: true });
    // The enforcer's artifact path must remain untouched by the pre-pass:
    // its mere existence would satisfy the expert-review gate with zero
    // reviewers (all enforcer checks are conditional on keys we don't write).
    const enforcerPath = join(artifactDir, 'feature%2Ftest-branch.json');
    const prepassPath = join(artifactDir, 'feature%2Ftest-branch.pre-pass.json');

    const findings = scanFileContent('src/vuln.ts', VULNERABLE_TS);
    const written = writePrePassArtifact(dir, findings, 3);
    expect(written?.path).toBe(prepassPath);
    expect(existsSync(enforcerPath)).toBe(false);

    const written2 = JSON.parse(readFileSync(prepassPath, 'utf-8'));
    expect(written2.pre_pass.finding_count).toBe(findings.length);
    expect(written2.pre_pass.files_scanned).toBe(3);
    expect(written2.pre_pass.head).toMatch(/^[0-9a-f]{40}$/);

    // re-running preserves a pre-existing sibling's foreign keys
    writeFileSync(prepassPath, JSON.stringify({ custom: 'kept' }));
    writePrePassArtifact(dir, findings, 3);
    const merged = JSON.parse(readFileSync(prepassPath, 'utf-8'));
    expect(merged.custom).toBe('kept');
    expect(merged.pre_pass.finding_count).toBe(findings.length);
  });

  it('returns null outside a git repo instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-prepass-nogit-'));
    expect(writePrePassArtifact(dir, [], 0)).toBeNull();
  });

  it('runPrePass scans only resolvable existing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-prepass-run-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'v.ts'), VULNERABLE_TS);
    const { findings, filesScanned } = runPrePass({
      projectDir: dir,
      files: ['src/v.ts', 'src/missing.ts'],
    });
    expect(filesScanned).toEqual(['src/v.ts']);
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('pre-pass CLI contract', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('exits 1 on HIGH findings even on the --json path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-prepass-cli-'));
    writeFileSync(join(dir, 'v.ts'), VULNERABLE_TS);
    await reviewCommand('prepass', { projectDir: dir, files: 'v.ts', json: true });
    expect(process.exitCode).toBe(1);
  });

  it('exits clean on a clean file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-prepass-cli-'));
    writeFileSync(join(dir, 'c.ts'), CLEAN_TS);
    await reviewCommand('prepass', { projectDir: dir, files: 'c.ts', json: true });
    expect(process.exitCode).toBeUndefined();
  });
});
