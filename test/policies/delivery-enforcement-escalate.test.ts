/**
 * `escalate` delivery mode: deliver is an ESCALATION POINT, not the path every
 * source edit is forced through.
 *
 * Motivating incident (cognition-engine / opencode + llama.cpp, 2026-08-20):
 * under `localMode: deliver` every Rust edit over 240 characters was refused
 * and routed into `uap deliver`; 93 blocked intents queued, five consecutive
 * 5-turn deliver runs failed, and the model sat in a 60-turn read-only loop.
 * Small and medium edits must land directly and be judged by the project's
 * own gates; deliver is for when that is demonstrably not working (two red
 * gates in a row, a file thrashed edit after edit) or for whole-module work.
 *
 * The enforcer is run for real (python3) against a throwaway project root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'delivery_enforcement.py');
const TRACKER = join(process.cwd(), 'templates', 'hooks', 'escalation_tracker.py');

const STRIP = ['UAP_ENFORCE_DELIVERY', 'UAP_DELIVER_ACTIVE', 'UAP_DELIVER_BYPASS', 'UAP_DELIVER_LOCAL_MODE', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'UAP_INFERENCE_ENDPOINT', 'UAP_FASTPATH_ROUTED'];

let root: string;

function hermetic(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIP) delete e[k];
  return { ...e, UAP_REPO_ROOT: root, UAP_MAIN_ROOT: root, ...extra };
}

interface Verdict { exit: number; allowed: boolean; reason: string; route?: string; escalation?: string; editIntent?: Record<string, string> | null }

function run(op: string, args: Record<string, unknown>, env: Record<string, string> = { UAP_ENFORCE_DELIVERY: 'escalate' }): Verdict {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify(args)], { env: hermetic(env), encoding: 'utf8' });
  let parsed: Partial<Verdict> = {};
  try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* empty */ }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '', route: parsed.route, escalation: parsed.escalation, editIntent: parsed.editIntent };
}

function track(...argv: string[]): string {
  const r = spawnSync('python3', [TRACKER, ...argv], { env: hermetic({}), encoding: 'utf8' });
  return r.stdout + r.stderr;
}

const medium = 'x'.repeat(400); // well over the 240-char trivial fast-path
const editArgs = (file = 'src/a.rs') => ({ filePath: join(root, file), oldString: 'a', newString: medium });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uap-escalate-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'src'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('delivery-enforcement: escalate mode', () => {
  it('lands a medium direct edit with no evidence against it (exit 0)', () => {
    const r = run('Edit', editArgs());
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/escalation point/);
  });

  it('escalates to deliver after two consecutive verification failures, carrying the failure', () => {
    track('fail', '--source', 'verify', '--detail', 'error[E0425]: cannot find value `x`');
    expect(run('Edit', editArgs()).allowed).toBe(true); // one failure is normal iteration
    track('fail', '--source', 'bash', '--detail', '$ cargo test\nerror[E0425]: cannot find value `x`');
    const r = run('Edit', editArgs());
    expect(r.exit).toBe(2);
    expect(r.route).toBe('deliver');
    expect(r.escalation).toBe('failures');
    expect(r.reason).toMatch(/E0425/);
    expect(r.reason).toMatch(/`deliver` tool/);
  });

  it('a green gate clears the evidence and direct edits resume', () => {
    track('fail', '--detail', 'boom');
    track('edit', '--file', 'src/a.rs'); // an attempt between the two reds
    track('fail', '--detail', 'boom');
    expect(run('Edit', editArgs()).allowed).toBe(false);
    track('pass', '--source', 'verify');
    expect(run('Edit', editArgs()).allowed).toBe(true);
  });

  it('escalates a file that is being thrashed (escalateAfterEdits) with no green in between', () => {
    for (let i = 0; i < 10; i++) expect(run('Edit', editArgs()).allowed).toBe(true);
    const r = run('Edit', editArgs());
    expect(r.allowed).toBe(false);
    expect(r.escalation).toBe('churn');
    // another file is unaffected
    expect(run('Edit', editArgs('src/other.rs')).allowed).toBe(true);
  });

  it('routes a whole-module write (complexEditChars) through deliver with a replayable intent', () => {
    const r = run('Write', { filePath: join(root, 'src/big.rs'), content: 'y'.repeat(7000) });
    expect(r.allowed).toBe(false);
    expect(r.escalation).toBe('complex');
    expect(r.route).toBe('deliver');
    expect(r.editIntent?.content?.length).toBe(7000);
    // the budget is a project decision
    writeFileSync(join(root, '.uap.json'), JSON.stringify({ delivery: { complexEditChars: 9000 } }));
    expect(run('Write', { filePath: join(root, 'src/big.rs'), content: 'y'.repeat(7000) }).allowed).toBe(true);
  });

  it('still fast-paths trivial edits and still WAITs on a live deliver run', () => {
    track('fail', '--detail', 'boom');
    track('edit', '--file', 'src/a.rs'); // an attempt between the two reds
    track('fail', '--detail', 'boom');
    const tiny = run('Edit', { filePath: join(root, 'src/a.rs'), oldString: 'a', newString: 'bb' });
    expect(tiny.allowed).toBe(true);
    mkdirSync(join(root, '.uap'), { recursive: true });
    writeFileSync(join(root, '.uap', 'deliver.lock'), `${process.pid}|x`);
    const r = run('Edit', editArgs());
    expect(r.allowed).toBe(false);
    expect(r.route).toBe('wait');
  });

  it('a local-model session under block + localMode=escalate resolves to escalate', () => {
    const r = run('Edit', editArgs(), { UAP_ENFORCE_DELIVERY: 'block', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', UAP_DELIVER_LOCAL_MODE: 'escalate' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/escalate mode/);
  });

  it('lets a heredoc source write through the shell land, unless the gates are red', () => {
    const cmd = 'cat > src/c.rs <<EOF\nfn main(){}\nEOF';
    expect(run('Bash', { command: cmd }).allowed).toBe(true);
    track('fail', '--detail', 'boom');
    track('edit', '--file', 'src/a.rs'); // an attempt between the two reds
    track('fail', '--detail', 'boom');
    const r = run('Bash', { command: cmd });
    expect(r.allowed).toBe(false);
    expect(r.route).toBe('deliver');
  });

  it('ignores stale evidence (TTL) so yesterday\'s red build does not gate today', () => {
    track('fail', '--detail', 'boom');
    track('edit', '--file', 'src/a.rs'); // an attempt between the two reds
    track('fail', '--detail', 'boom');
    const p = join(root, '.uap', 'escalation-state.json');
    const st = JSON.parse(readFileSync(p, 'utf8'));
    // the failure's own timestamp ages it — `updated` moves on every edit
    st.last_failure.ts = Math.floor(Date.now() / 1000) - 8 * 3600;
    writeFileSync(p, JSON.stringify(st));
    expect(run('Edit', editArgs()).allowed).toBe(true);
  });

  it('block mode is unchanged — and now records opencode\'s oldString/newString as a replayable intent', () => {
    const r = run('Edit', editArgs(), { UAP_ENFORCE_DELIVERY: 'block' });
    expect(r.exit).toBe(2);
    expect(r.route).toBe('deliver');
    expect(r.editIntent).toEqual({ old_string: 'a', new_string: medium });
    expect(existsSync(join(root, '.uap', 'escalation-state.json'))).toBe(false);
  });
});
