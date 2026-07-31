/**
 * Cumulative-aware trivial-edit fast-path (fastpath_gate.py via uap-policy-gate.sh).
 *
 * The fast-path lets small source edits through directly so iteration stays fast.
 * Unbounded, that's an escape hatch: a weak model can assemble a whole broken
 * feature out of dozens of sub-threshold edits, none of which routes to deliver.
 * fastpath_gate.py bounds cumulative un-routed change per file — after CUM_EDITS
 * trivial edits (or CUM_CHARS chars) the next edit is NOT fast-pathed and falls
 * through to the delivery-enforcement gate (exit 2 = route through deliver).
 *
 * These run the real gate + real fastpath_gate.py + real delivery_enforcement
 * enforcer end-to-end.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const GATE_SRC = join(REPO, 'templates', 'hooks', 'uap-policy-gate.sh');
const FASTPATH_SRC = join(REPO, 'templates', 'hooks', 'fastpath_gate.py');
const ENFORCER_SRC = join(REPO, 'src', 'policies', 'enforcers', 'delivery_enforcement.py');
// Source, not a materialised copy — see e2e-gate-to-deliver-spawn.test.ts.
const COMMON_SRC = join(REPO, 'src', 'policies', 'enforcers', '_common.py');

/** A project whose .uap.json routes source edits through deliver (block). */
function makeProject(): string {
  const proj = mkdtempSync(join(tmpdir(), 'uap-cumfp-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(join(proj, 'agents', 'data', 'memory'), { recursive: true });
  mkdirSync(join(proj, '.policy-tools'), { recursive: true });
  mkdirSync(join(proj, '.factory', 'hooks'), { recursive: true });
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, '.uap'), { recursive: true });

  writeFileSync(join(proj, '.uap.json'), JSON.stringify({ delivery: { enforcement: 'block' } }));

  const db = join(proj, 'agents', 'data', 'memory', 'policies.db');
  const sql =
    'CREATE TABLE policies(id TEXT, name TEXT, isActive INT, priority INT);' +
    'CREATE TABLE executable_tools(policyId TEXT, toolName TEXT);' +
    "INSERT INTO policies VALUES('p1','delivery-enforcement',1,100);" +
    "INSERT INTO executable_tools VALUES('p1','dlv');";
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 setup failed: ' + r.stderr);

  copyFileSync(ENFORCER_SRC, join(proj, '.policy-tools', 'p1_dlv.py'));
  copyFileSync(COMMON_SRC, join(proj, '.policy-tools', '_common.py'));
  copyFileSync(GATE_SRC, join(proj, '.factory', 'hooks', 'uap-policy-gate.sh'));
  copyFileSync(FASTPATH_SRC, join(proj, '.factory', 'hooks', 'fastpath_gate.py'));
  chmodSync(join(proj, '.factory', 'hooks', 'fastpath_gate.py'), 0o755);
  return proj;
}

/** Run the gate for a small (trivial) edit to `file`, with a cumulative budget. */
function runTrivialEdit(proj: string, file: string, cumEdits = 3): number {
  const hook = join(proj, '.factory', 'hooks', 'uap-policy-gate.sh');
  const payload = {
    tool_name: 'Write',
    tool_input: { file_path: join(proj, file), old_string: 'x'.repeat(8), new_string: 'y'.repeat(8) },
  };
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: '', OPENAI_BASE_URL: '', UAP_INFERENCE_ENDPOINT: '',
    UAP_DELIVER_ACTIVE: '', UAP_DELIVER_BYPASS: '', UAP_DELIVER_LOCAL_MODE: '',
    UAP_DELIVER_FASTPATH: 'on',
    UAP_DELIVER_CUMULATIVE_EDITS: String(cumEdits),
    UAP_DELIVER_CUMULATIVE_CHARS: '100000', // exercise the edit-count budget in isolation
  } as Record<string, string>;
  return spawnSync('bash', [hook], { input: JSON.stringify(payload), cwd: proj, env, encoding: 'utf8' }).status ?? -1;
}

describe('gate: cumulative trivial-edit fast-path', () => {
  let proj: string;
  afterEach(() => proj && rmSync(proj, { recursive: true, force: true }));

  it('allows trivial source edits up to the cumulative budget, then ROUTES', () => {
    proj = makeProject();
    // First 3 trivial edits to the same source file are fast-pathed (exit 0)...
    expect(runTrivialEdit(proj, 'src/app.ts', 3)).toBe(0);
    expect(runTrivialEdit(proj, 'src/app.ts', 3)).toBe(0);
    expect(runTrivialEdit(proj, 'src/app.ts', 3)).toBe(0);
    // ...the 4th crosses the budget → routes through deliver (blocked, exit 2).
    expect(runTrivialEdit(proj, 'src/app.ts', 3)).toBe(2);
  });

  it('resets after routing so a fresh batch of trivial edits is allowed again', () => {
    proj = makeProject();
    for (let i = 0; i < 3; i++) runTrivialEdit(proj, 'src/app.ts', 3);
    expect(runTrivialEdit(proj, 'src/app.ts', 3)).toBe(2); // routes + resets tally
    expect(runTrivialEdit(proj, 'src/app.ts', 3)).toBe(0); // next batch allowed
  });

  it('tracks budget PER FILE (one busy file does not gate another)', () => {
    proj = makeProject();
    for (let i = 0; i < 3; i++) runTrivialEdit(proj, 'src/app.ts', 3);
    expect(runTrivialEdit(proj, 'src/app.ts', 3)).toBe(2); // app.ts over budget
    expect(runTrivialEdit(proj, 'src/other.ts', 3)).toBe(0); // other.ts untouched
  });

  it('test files are always fast-pathed regardless of count', () => {
    proj = makeProject();
    for (let i = 0; i < 6; i++) {
      expect(runTrivialEdit(proj, 'src/app.test.ts', 3)).toBe(0);
    }
  });
});
