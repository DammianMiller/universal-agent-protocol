/**
 * Config-authoritative delivery enforcement.
 *
 * Bug: the gate set `export UAP_ENFORCE_DELIVERY="${UAP_ENFORCE_DELIVERY:-block}"`,
 * so a stale ambient UAP_ENFORCE_DELIVERY=advisory (leaked from a launching
 * shell/session) silently OVERRODE a project's declared `.uap.json`
 * `delivery.enforcement: "block"` — substantive source edits were never routed
 * through `uap deliver`.
 *
 * Fix: the gate now reads `.uap.json` `delivery.enforcement` (and
 * `delivery.localMode`) and makes the DECLARED posture authoritative over the
 * ambient env. These tests run the real delivery_enforcement enforcer end-to-end
 * through the template gate and assert config beats a conflicting ambient env in
 * BOTH directions, plus that config-declared localMode reaches the enforcer.
 *
 * Also asserts the installer deploys the autoroute helper the gate depends on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const GATE_SRC = join(REPO, 'templates', 'hooks', 'uap-policy-gate.sh');
const ENFORCER_SRC = join(REPO, 'src', 'policies', 'enforcers', 'delivery_enforcement.py');
const COMMON_SRC = join(REPO, '.policy-tools', '_common.py');
const HOOKS_TS = join(REPO, 'src', 'cli', 'hooks.ts');

/** Build a temp project whose delivery posture is declared in .uap.json. */
function makeProject(delivery: Record<string, unknown>): string {
  const proj = mkdtempSync(join(tmpdir(), 'uap-cfgauth-'));
  // A bare `.git` dir makes the gate resolve MAIN_ROOT to proj (matches the
  // policy-gate-mainroot fixture) without needing a real repo.
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(join(proj, 'agents', 'data', 'memory'), { recursive: true });
  mkdirSync(join(proj, '.policy-tools'), { recursive: true });
  mkdirSync(join(proj, '.factory', 'hooks'), { recursive: true });
  mkdirSync(join(proj, 'src'), { recursive: true });

  writeFileSync(join(proj, '.uap.json'), JSON.stringify({ delivery }));

  // Register the delivery-enforcement policy. NOTE: the schema carries a
  // `priority` column — the gate's policy query ORDER BYs it.
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
  return proj;
}

/** Run the gate for a source Write, with an explicit ambient env. */
function runGate(proj: string, env: Record<string, string>): number {
  const hook = join(proj, '.factory', 'hooks', 'uap-policy-gate.sh');
  const payload = { tool_name: 'Write', tool_input: { file_path: join(proj, 'src', 'app.ts'), content: 'export const x = 1;\n' } };
  // Neutralize anything in the test runner's real environment that would steer
  // the enforcer: base URLs decide local-session handling; the escape hatches
  // must be off; fast-path on (a whole-file Write is never "trivial" anyway).
  const base = {
    ...process.env,
    ANTHROPIC_BASE_URL: '', OPENAI_BASE_URL: '', UAP_INFERENCE_ENDPOINT: '',
    UAP_DELIVER_ACTIVE: '', UAP_DELIVER_BYPASS: '', UAP_DELIVER_LOCAL_MODE: '',
    UAP_DELIVER_FASTPATH: 'on',
  } as Record<string, string>;
  return spawnSync('bash', [hook], { input: JSON.stringify(payload), cwd: proj, env: { ...base, ...env }, encoding: 'utf8' }).status ?? -1;
}

describe('gate: .uap.json delivery posture is authoritative over ambient env', () => {
  let proj: string;
  afterEach(() => proj && rmSync(proj, { recursive: true, force: true }));

  it('config block BLOCKS even when ambient UAP_ENFORCE_DELIVERY=advisory (the bug)', () => {
    proj = makeProject({ enforcement: 'block' });
    expect(runGate(proj, { UAP_ENFORCE_DELIVERY: 'advisory' })).toBe(2);
  });

  it('config advisory ALLOWS even when ambient UAP_ENFORCE_DELIVERY=block (precedence both ways)', () => {
    proj = makeProject({ enforcement: 'advisory' });
    expect(runGate(proj, { UAP_ENFORCE_DELIVERY: 'block' })).toBe(0);
  });

  it('config-declared localMode=advisory relaxes a block for a LOCAL session', () => {
    // block + local session + localMode=advisory -> enforcer unblocks direct writes.
    proj = makeProject({ enforcement: 'block', localMode: 'advisory' });
    expect(runGate(proj, { UAP_ENFORCE_DELIVERY: 'advisory', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' })).toBe(0);
  });

  it('config-declared localMode=block keeps a strict block for a LOCAL session', () => {
    // Proves UAP_DELIVER_LOCAL_MODE is read from config, not defaulted to advisory.
    proj = makeProject({ enforcement: 'block', localMode: 'block' });
    expect(runGate(proj, { UAP_ENFORCE_DELIVERY: 'advisory', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' })).toBe(2);
  });
});

describe('gate template + installer wiring', () => {
  it('template reads delivery.localMode and exports UAP_DELIVER_LOCAL_MODE', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    expect(src).toContain('localMode');
    expect(src).toMatch(/export\s+UAP_DELIVER_LOCAL_MODE=/);
    // The config value still overrides a stale ambient env.
    expect(src).toContain('config-authoritative');
  });

  it('installer hookFiles deploys deliver_autoroute.py alongside the gate', () => {
    const src = readFileSync(HOOKS_TS, 'utf-8');
    expect(src).toContain("'deliver_autoroute.py'");
  });
});
