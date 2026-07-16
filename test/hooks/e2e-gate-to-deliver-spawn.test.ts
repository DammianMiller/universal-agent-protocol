/**
 * END-TO-END: a real agent-shaped tool call → policy gate → delivery enforcer →
 * deliver_autoroute → an ACTUAL `uap deliver` process being spawned.
 *
 * WHY THIS EXISTS
 * Four separate bugs in a row all had the same shape: the BLOCKING half of the
 * pipeline was tested and worked, while the HAND-OFF half was inert and nothing
 * caught it. The gate would dutifully block an edit, log the intent, tell the
 * model "call deliver" — and deliver would never run:
 *   1. a stale ambient UAP_ENFORCE_DELIVERY=advisory silently disabled routing
 *   2. deliver_autoroute.py was never deployed by the installer at all
 *   3. `.html` wasn't in SOURCE_EXTS, so a whole web app was "not source code"
 *   4. autoroute read only snake_case keys, so for opencode (`filePath`)
 *      file_path was always "" and `spawn` was always False
 *
 * Every one of these was invisible to the unit tests because each layer was
 * tested in isolation, with only Claude's key spelling. This test drives the
 * WHOLE chain with each agent's real payload shape and asserts the thing that
 * actually matters: **a deliver process gets spawned, with the right args.**
 *
 * `uap` is stubbed on PATH so we assert the spawn without running a model.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync,
  existsSync, rmSync, chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const GATE_SRC = join(REPO, 'templates', 'hooks', 'uap-policy-gate.sh');
const AUTOROUTE_SRC = join(REPO, 'templates', 'hooks', 'deliver_autoroute.py');
const FASTPATH_SRC = join(REPO, 'templates', 'hooks', 'fastpath_gate.py');
const ENFORCER_SRC = join(REPO, 'src', 'policies', 'enforcers', 'delivery_enforcement.py');
const COMMON_SRC = join(REPO, '.policy-tools', '_common.py');

interface Env { proj: string; spawnLog: string; binDir: string }

/** A project wired exactly like a real UAP-managed one, plus a fake `uap` on PATH. */
function makeProject(): Env {
  const proj = mkdtempSync(join(tmpdir(), 'uap-e2e-'));
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(join(proj, 'agents', 'data', 'memory'), { recursive: true });
  mkdirSync(join(proj, '.policy-tools'), { recursive: true });
  mkdirSync(join(proj, '.factory', 'hooks'), { recursive: true });
  mkdirSync(join(proj, '.uap'), { recursive: true });
  mkdirSync(join(proj, 'src'), { recursive: true });

  // Project declares the posture the operator wants: route source edits through deliver.
  writeFileSync(join(proj, '.uap.json'), JSON.stringify({ delivery: { enforcement: 'block', localMode: 'deliver' } }));

  // The policy DB the gate iterates (NOTE: `priority` column — the gate ORDER BYs it).
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
  copyFileSync(AUTOROUTE_SRC, join(proj, '.factory', 'hooks', 'deliver_autoroute.py'));
  copyFileSync(FASTPATH_SRC, join(proj, '.factory', 'hooks', 'fastpath_gate.py'));

  // Fake `uap` on PATH: records the argv autoroute spawns it with, instead of
  // running a real deliver (which would call a model).
  const binDir = join(proj, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  const spawnLog = join(proj, 'spawned.txt');
  const stub = join(binDir, 'uap');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spawnLog}"\n`);
  chmodSync(stub, 0o755);

  return { proj, spawnLog, binDir };
}

/** Run the gate exactly as a harness does: JSON payload on stdin, from the project cwd. */
function runGate(env: Env, payload: object): number {
  const hook = join(env.proj, '.factory', 'hooks', 'uap-policy-gate.sh');
  const e = {
    ...process.env,
    PATH: `${env.binDir}:${process.env.PATH}`,
    UAP_DELIVER_AUTOROUTE: 'on',
    // Neutralize ambient state that would steer the enforcer (this is exactly the
    // class of leak that silently disabled routing once already).
    ANTHROPIC_BASE_URL: '', OPENAI_BASE_URL: '', UAP_INFERENCE_ENDPOINT: '',
    UAP_DELIVER_ACTIVE: '', UAP_DELIVER_BYPASS: '', UAP_ENFORCE_DELIVERY: '',
    UAP_DELIVER_LOCAL_MODE: '', UAP_DELIVER_FASTPATH: 'on',
  } as Record<string, string>;
  return spawnSync('bash', [hook], {
    input: JSON.stringify(payload), cwd: env.proj, env: e, encoding: 'utf8',
  }).status ?? -1;
}

/** autoroute spawns detached — poll briefly for the fake `uap` to record itself. */
function waitForSpawn(spawnLog: string, ms = 5000): string {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(spawnLog)) {
      const s = readFileSync(spawnLog, 'utf-8').trim();
      if (s) return s;
    }
    spawnSync('sleep', ['0.05']);
  }
  return '';
}

function intents(proj: string): Array<Record<string, unknown>> {
  const f = join(proj, '.uap', 'pending-deliver.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const BIG = 'x'.repeat(2000); // well over the trivial fast-path threshold

describe('E2E: agent tool call → gate → enforcer → autoroute → `uap deliver` spawned', () => {
  let env: Env;
  afterEach(() => env && rmSync(env.proj, { recursive: true, force: true }));

  it('OPENCODE payload (camelCase filePath) actually spawns deliver', () => {
    // THE BUG THIS CATCHES: autoroute read only snake_case, so for opencode the
    // file_path was always "" and `spawn` was always False — the gate blocked the
    // edit and deliver NEVER ran. Blocking alone is not enough; assert the hand-off.
    env = makeProject();
    const exit = runGate(env, {
      tool_name: 'Write',
      cwd: env.proj,
      tool_input: { filePath: join(env.proj, 'src', 'app.ts'), content: BIG },
    });
    expect(exit).toBe(2); // blocked...

    const intent = intents(env.proj).at(-1)!;
    expect(intent.file_path).toBe(join(env.proj, 'src', 'app.ts')); // ...with a REAL path (was "")

    const spawned = waitForSpawn(env.spawnLog);
    expect(spawned).toContain('deliver');      // ...and deliver ACTUALLY ran
    // A Write carries the file content, so the intent is REPLAYABLE: it is
    // applied DETERMINISTICALLY via `uap deliver --pending <file>` (no model),
    // not the model-spawn autoroute. This is what actually lands the file.
    expect(spawned).toContain('--pending');
  });

  it('CLAUDE payload (snake_case file_path) also spawns deliver', () => {
    env = makeProject();
    const exit = runGate(env, {
      tool_name: 'Write',
      cwd: env.proj,
      tool_input: { file_path: join(env.proj, 'src', 'app.ts'), content: BIG },
    });
    expect(exit).toBe(2);
    expect(waitForSpawn(env.spawnLog)).toContain('deliver');
  });

  it('a WEB deliverable (.html) is source and spawns deliver', () => {
    // THE BUG THIS CATCHES: `.html` was not in SOURCE_EXTS, so a 34KB single-file
    // web app was "not source code" — allowed, unrouted, never validated.
    env = makeProject();
    const exit = runGate(env, {
      tool_name: 'Write',
      cwd: env.proj,
      tool_input: { filePath: join(env.proj, 'index.html'), content: BIG },
    });
    expect(exit).toBe(2);
    expect(waitForSpawn(env.spawnLog)).toContain('deliver');
  });

  it('a BASH source-write spawns deliver (it carries a command, not a path)', () => {
    // THE BUG THIS CATCHES: bash was ungated entirely (`cat > app.js` bypassed
    // everything), and once gated, autoroute still could not spawn it because it
    // demanded a file_path that a bash intent never has.
    env = makeProject();
    const exit = runGate(env, {
      tool_name: 'Bash',
      cwd: env.proj,
      tool_input: { command: 'cat > src/app.js <<EOF\nconsole.log(1)\nEOF' },
    });
    expect(exit).toBe(2);
    // A bash heredoc source-write (`cat > FILE << EOF ... EOF`) carries its path
    // AND body in the command — autoroute recovers both, so the intent is
    // REPLAYABLE and applied deterministically via `--pending` (a model reaching
    // for `cat >` when its Write tool is gated must still land the file).
    const spawned = waitForSpawn(env.spawnLog);
    expect(spawned).toContain('deliver');
    expect(spawned).toContain('--pending');
    expect(intents(env.proj).at(-1)!.file_path).toContain('app.js'); // path recovered
  });

  it('a stale ambient UAP_ENFORCE_DELIVERY=advisory cannot disable routing', () => {
    // THE BUG THIS CATCHES: a leaked `advisory` in the client's env silently
    // overrode the project's declared `block` — routing was off and nobody knew.
    env = makeProject();
    const hook = join(env.proj, '.factory', 'hooks', 'uap-policy-gate.sh');
    const exit = spawnSync('bash', [hook], {
      input: JSON.stringify({
        tool_name: 'Write', cwd: env.proj,
        tool_input: { filePath: join(env.proj, 'src', 'app.ts'), content: BIG },
      }),
      cwd: env.proj,
      env: {
        ...process.env,
        PATH: `${env.binDir}:${process.env.PATH}`,
        UAP_DELIVER_AUTOROUTE: 'on',
        UAP_ENFORCE_DELIVERY: 'advisory', // ← the leak
        ANTHROPIC_BASE_URL: '', OPENAI_BASE_URL: '', UAP_INFERENCE_ENDPOINT: '',
        UAP_DELIVER_ACTIVE: '', UAP_DELIVER_BYPASS: '', UAP_DELIVER_LOCAL_MODE: '',
      } as Record<string, string>,
      encoding: 'utf8',
    }).status;
    expect(exit).toBe(2); // .uap.json is authoritative — still blocks + routes
    expect(waitForSpawn(env.spawnLog)).toContain('deliver');
  });

  it('a TRIVIAL edit is fast-pathed: allowed, and does NOT spawn deliver', () => {
    // The other side of the contract: the fast path must stay fast. If this ever
    // starts spawning, every keystroke pays a deliver cycle.
    env = makeProject();
    const exit = runGate(env, {
      tool_name: 'Edit',
      cwd: env.proj,
      tool_input: { filePath: join(env.proj, 'src', 'app.ts'), old_string: 'a', new_string: 'b' },
    });
    expect(exit).toBe(0);                       // allowed directly
    expect(waitForSpawn(env.spawnLog, 700)).toBe(''); // and nothing was spawned
  });

  it('does not spawn twice for the same change (dedup)', () => {
    env = makeProject();
    const payload = {
      tool_name: 'Write', cwd: env.proj,
      tool_input: { filePath: join(env.proj, 'src', 'app.ts'), content: BIG },
    };
    expect(runGate(env, payload)).toBe(2);
    expect(waitForSpawn(env.spawnLog)).toContain('deliver');
    const first = readFileSync(env.spawnLog, 'utf-8').trim().split('\n').length;

    runGate(env, payload); // same change again
    spawnSync('sleep', ['0.5']);
    const after = readFileSync(env.spawnLog, 'utf-8').trim().split('\n').length;
    expect(after).toBe(first); // no second deliver for an identical intent
  });
});
