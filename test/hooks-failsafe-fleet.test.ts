import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

/**
 * The fleet-wide fail-safe contracts for the UAP hook templates.
 *
 * PR #972 enforced session-start.sh's "never blocks the agent" promise; the
 * same day the live fleet produced the second specimen: "SessionEnd hook
 * error: Hook exited with code 1" (voxel-pagoda client, 2026-11-26 16:47).
 * Every hook template ran `set -euo pipefail` at top level, so any unguarded
 * sub-failure surfaced as a hook error in the client session.
 *
 * Two contracts, enforced per hook class:
 * - ADVISORY hooks (session-end, pre-compact, post-compact,
 *   post-tool-use-edit-write, uap-schema-post): aborts collapse to `|| :`
 *   and a hard exit 0 — never any other status.
 * - BLOCKING hooks (stop, pre-tool-use-bash, pre-tool-use-edit-write):
 *   aborts fail OPEN (ERR trap converts them to exit 0 before set -e can
 *   make them the hook status), while the explicit exit-2 gate blocks
 *   propagate untouched — enforcement is preserved, not weakened.
 *
 * uap-policy-gate.sh is deliberately fail-closed and is out of scope here.
 */
describe('hook fail-safe contracts (fleet)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  const install = async () => {
    const testDir = mkdtempSync(join(tmpdir(), `uap-fleet-failsafe-${Date.now()}`));
    dirs.push(testDir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: testDir, target: 'factory' });
    return testDir;
  };

  const hook = (dir: string, name: string) => join(dir, '.factory', 'hooks', `${name}.sh`);

  const runHook = (
    script: string,
    payload: string,
    env: NodeJS.ProcessEnv = {},
    shims: Record<string, string> = {},
  ) => {
    const shimDir = mkdtempSync(join(tmpdir(), `uap-fleet-shim-${Date.now()}`));
    dirs.push(shimDir);
    for (const [name, body] of Object.entries(shims)) {
      const p = join(shimDir, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    }
    const r = spawnSync('bash', [script], {
      cwd: shimDir === '' ? undefined : process.cwd(),
      input: payload,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        FACTORY_PROJECT_DIR: env.FACTORY_PROJECT_DIR,
        ...env,
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return r.status;
  };

  it('advisory hooks abort to exit 0 on an unguarded dependency failure (the observed SessionEnd class)', async () => {
    const dir = await install();
    // Memory DB present so session-end passes its early gate; poison `date`
    // (unguarded TIMESTAMP assignment) — the class that surfaced
    // "SessionEnd hook error: Hook exited with code 1" on 2026-11-26.
    mkdirSync(join(dir, 'agents', 'data', 'memory'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'data', 'memory', 'short_term.db'), '');
    const status = runHook(
      hook(dir, 'session-end'),
      '',
      { FACTORY_PROJECT_DIR: dir },
      { date: '#!/bin/sh\nexit 1\n' },
    );
    expect(status).toBe(0);
  });

  it('blocking hooks fail OPEN when an unguarded dependency aborts (sleep in the jq retry loop)', async () => {
    const dir = await install();
    // jq succeeds but yields empty (5 retries exhaust), then the bare
    // `sleep 0.05` in the retry loop fails — an unguarded abort that must
    // become allow (exit 0), never a phantom block.
    const status = runHook(
      hook(dir, 'pre-tool-use-bash'),
      '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}',
      { FACTORY_PROJECT_DIR: dir },
      { jq: '#!/bin/sh\nexit 0\n', sleep: '#!/bin/sh\nexit 1\n' },
    );
    expect(status).toBe(0);
  });

  it('blocking hooks keep their explicit exit-2 blocks through the fail-open wrapper', async () => {
    const dir = await install();
    // terraform apply is an unconditional IaC-pipeline block (no config,
    // no env dependencies) — the deterministic block-preservation probe.
    const r = spawnSync('bash', [hook(dir, 'pre-tool-use-bash')], {
      input: '{"tool_name":"Bash","tool_input":{"command":"terraform apply -auto-approve"}}',
      env: { ...process.env, FACTORY_PROJECT_DIR: dir },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
  });

  it('benign commands stay allowed', async () => {
    const dir = await install();
    const r = spawnSync('bash', [hook(dir, 'pre-tool-use-bash')], {
      input: '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}',
      env: { ...process.env, FACTORY_PROJECT_DIR: dir },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
  });

  it('carries the contracts structurally across the whole hook fleet', async () => {
    const dir = await install();
    const advisory = ['session-end', 'pre-compact', 'post-compact', 'post-tool-use-edit-write', 'uap-schema-post'];
    const blocking = ['stop', 'pre-tool-use-bash', 'pre-tool-use-edit-write'];
    for (const name of advisory) {
      const s = readFileSync(hook(dir, name), 'utf-8');
      expect(s).toMatch(/\(\s*\n\s*set -euo pipefail/, `${name} body in subshell`);
      expect(s).toContain(') || :', `${name} swallows aborts`);
      expect(s.trimEnd().endsWith('exit 0'), `${name} ends exit 0`).toBe(true);
    }
    for (const name of blocking) {
      const s = readFileSync(hook(dir, name), 'utf-8');
      expect(s).toContain('set -E', `${name} errtrace`);
      // Fail-open ONLY while errexit is armed: the deliberate `set +e`
      // windows (the stop.sh verify gate) keep their hand-inspected RC
      // semantics, so a genuine runtime failure still blocks.
      expect(s).toContain("trap '[[ $- == *e* ]] && exit 0' ERR", `${name} fail-open aborts`);
      expect(s).toContain('exit $?', `${name} propagates 0/2 decisions`);
    }
  });
});

/**
 * The hands-free completion gate wiring (stop.sh ↔ `uap handsfree stop-check`).
 *
 * `decideStopCheck` (src/cli/handsfree.ts) is the ledger-backed Stop
 * enforcement lever: block while the completion ledger has remaining items
 * so a hands-free build cannot end its session mid-build. It was fully
 * implemented and unit-tested (test/delivery/handsfree.test.ts) but never
 * invoked from ANY shipped hook — nothing ever pulled the lever (measured
 * 2026-11-28 on the voxel-pagoda-basalt-inkling-1 fleet arm: rounds stopped
 * after one build pass — or mid-pass — with the artifact's quality gates
 * unconverged, because the only stop-side hard gate was runtime execution;
 * zero ledgers ever seeded across the 14 UAP fleet arms). These tests pin
 * the wiring contract of the gate block now in stop.sh:
 * - stop-check RC 2 → hard block (exit 2, model-facing message);
 * - every other RC — including 1 from an older CLI without the subcommand —
 *   fails OPEN (allow-path messages print, never wedge);
 * - the installed/scaffolded copy stays byte-identical to the template.
 */
describe('hands-free completion gate wiring (stop.sh)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  const install = async () => {
    const testDir = mkdtempSync(join(tmpdir(), `uap-stop-gate-${Date.now()}`));
    dirs.push(testDir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: testDir, target: 'factory' });
    return testDir;
  };

  const shimmedRun = (script: string, payload: string, dir: string, uapShim: string) => {
    const shimDir = mkdtempSync(join(tmpdir(), `uap-stop-gate-shim-${Date.now()}`));
    dirs.push(shimDir);
    const p = join(shimDir, 'uap');
    writeFileSync(p, uapShim);
    chmodSync(p, 0o755);
    return spawnSync('bash', [script], {
      input: payload,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, FACTORY_PROJECT_DIR: dir },
      encoding: 'utf-8',
      timeout: 60_000,
    });
  };

  const BLOCK_SHIM = [
    '#!/bin/sh',
    'if [ "$1" = "handsfree" ] && [ "$2" = "stop-check" ]; then',
    '  cat >/dev/null',
    '  echo "NOT DONE - 3 item(s) remain in the completion ledger" >&2',
    '  exit 2',
    'fi',
    'exit 0',
    '',
  ].join('\n');

  it('blocks the stop when the completion ledger is unfinished (stop-check RC 2)', async () => {
    const dir = await install();
    const r = shimmedRun(
      join(dir, '.factory', 'hooks', 'stop.sh'),
      '{"tool_name":"Stop","stop_hook_active":false}',
      dir,
      BLOCK_SHIM,
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('BUILD-COMPLETION GATE');
    expect(r.stdout).toContain('3 item(s) remain');
  });

  it('fails OPEN when the CLI predates the subcommand (stop-check RC 1)', async () => {
    const dir = await install();
    const r = shimmedRun(
      join(dir, '.factory', 'hooks', 'stop.sh'),
      '{"tool_name":"Stop","stop_hook_active":false}',
      dir,
      ['#!/bin/sh', 'if [ "$1" = "handsfree" ]; then exit 1; fi', 'exit 0', ''].join('\n'),
    );
    // Clean temp project (no code changes): the rest of stop.sh must allow.
    expect(r.status).toBe(0);
  });

  it('keeps the scaffolded stop.sh byte-identical to the shipped template', async () => {
    const dir = await install();
    const scaffolded = readFileSync(join(dir, '.factory', 'hooks', 'stop.sh'), 'utf-8');
    const template = readFileSync(join(process.cwd(), 'templates', 'hooks', 'stop.sh'), 'utf-8');
    expect(scaffolded).toBe(template);
  });

  it('keeps the repo live stop.sh in lockstep with the template', () => {
    const live = readFileSync(join(process.cwd(), '.factory', 'hooks', 'stop.sh'), 'utf-8');
    const template = readFileSync(join(process.cwd(), 'templates', 'hooks', 'stop.sh'), 'utf-8');
    expect(live).toBe(template);
  });
});
