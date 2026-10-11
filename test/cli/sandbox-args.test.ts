/**
 * `uap sandbox` planSandbox (bridge P4) — the pure bwrap planner, so the
 * kernel boundary and the two new authorities (per-session grant holes,
 * --net off egress cut) are asserted WITHOUT bubblewrap: what the argv
 * contains is what the kernel enforces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planSandbox, sandboxCustomHeaders, type SandboxPlanInput } from '../../src/cli/sandbox.js';
import type { ResolvedGrants } from '../../src/policies/sandbox-grants.js';

let dir: string;
let workdir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-sandbox-plan-'));
  workdir = join(dir, 'tree');
  home = join(dir, 'home');
  mkdirSync(workdir);
  mkdirSync(home);
  delete process.env.UAP_SANDBOX_ALLOW;
  delete process.env.UAP_SANDBOX_NET;
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NO_GRANTS: ResolvedGrants = { grants: [], paths: [] };

function plan(over: Partial<SandboxPlanInput> = {}) {
  return planSandbox({
    command: ['claude'],
    workdir,
    home,
    legacyAllow: [],
    grants: NO_GRANTS,
    ...over,
  });
}

describe('the floor (unchanged P0 behavior)', () => {
  it('keeps the kernel boundary: ro root, writable holes, unshare-pid, sandbox marker', () => {
    const r = plan();
    expect(r.error).toBeUndefined();
    const argv = r.plan!.argv.join(' ');
    expect(argv).toContain('--ro-bind / /');
    expect(argv).toContain(`--bind ${workdir} ${workdir}`);
    expect(argv).toContain('--unshare-pid');
    expect(argv).not.toContain('--unshare-net');
    expect(argv).toContain('--setenv UAP_SANDBOX_ACTIVE 1');
    expect(argv).toContain('X-Uap-Sandbox: 1');
  });

  it('appends the sandbox marker to pre-existing custom headers without clobbering', () => {
    expect(sandboxCustomHeaders('X-Other: v')).toBe('X-Other: v\nX-Uap-Sandbox: 1');
    expect(sandboxCustomHeaders('X-Uap-Sandbox: 1')).toBe('X-Uap-Sandbox: 1');
    expect(sandboxCustomHeaders(undefined)).toBe('X-Uap-Sandbox: 1');
    // The planner takes the pre-existing headers as an INPUT (pure planner):
    const r = plan({ existingCustomHeaders: 'X-Other: v' });
    expect(r.plan!.argv.join(' ')).toContain('X-Other: v\nX-Uap-Sandbox: 1');
  });

  it('refuses an over-broad workdir', () => {
    expect(plan({ workdir: '/' }).error).toMatch(/too broad/);
    expect(plan({ workdir: home }).error).toMatch(/too broad/);
  });

  it('plumbs the session id and legacy allow holes', () => {
    const legacy = join(dir, 'legacy');
    mkdirSync(legacy);
    const r = plan({ session: 'sess-1', legacyAllow: [legacy, join(dir, 'missing')] });
    const argv = r.plan!.argv.join(' ');
    expect(argv).toContain('--setenv UAP_SESSION_ID sess-1');
    expect(argv).toContain(`--bind ${legacy} ${legacy}`);
    expect(argv).not.toContain(join(dir, 'missing'));
    expect(r.plan!.notes.some((n) => n.includes('UNRECORDED allow'))).toBe(true);
  });
});

describe('D2 — per-session grants open holes the ledger consented to', () => {
  it('binds granted paths and skips ones that no longer exist', () => {
    const granted = join(dir, 'granted');
    const vanished = join(dir, 'vanished');
    mkdirSync(granted);
    const grants: ResolvedGrants = {
      grants: [],
      paths: [granted, vanished],
    };
    const r = plan({ grants });
    const argv = r.plan!.argv.join(' ');
    expect(argv).toContain(`--bind ${granted} ${granted}`);
    expect(argv).not.toContain(vanished);
    expect(r.plan!.grantedPaths).toEqual([granted]);
    expect(r.plan!.notes.some((n) => n.includes('do not exist'))).toBe(true);
  });
});

describe('D1 — --net off egress boundary', () => {
  it('cuts the netns with NOTHING brought up: --unshare-net, no relay, command verbatim', () => {
    const r = plan({ net: 'off', command: ['claude', '--flag'] });
    expect(r.error).toBeUndefined();
    const p = r.plan!;
    const argv = p.argv.join(' ');
    expect(argv).toContain('--unshare-net');
    // The session command runs VERBATIM — no wrapper, no base-URL rewrite:
    // a harness that needs the model fails loudly (connection refused),
    // which is the boundary working, not a bug.
    expect(p.inner).toEqual(['claude', '--flag']);
    expect(p.setenv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(p.netMode).toBe('off');
    expect(p.notes.some((n) => n.includes('net: OFF'))).toBe(true);
  });

  it('defaults the net mode from the caller-resolved env (pure planner: env comes in as an input)', () => {
    // The CLI resolves $UAP_SANDBOX_NET and hands it to the planner as
    // `envNet`; the planner itself never touches process.env, so tests pin
    // the contract without env plumbing and the plan stays reproducible.
    expect(plan({ envNet: 'off' }).plan!.netMode).toBe('off');
    expect(plan({ envNet: 'off' }).plan!.argv).toContain('--unshare-net');
    expect(plan({ envNet: 'shared' }).plan!.netMode).toBe('shared');
    // An explicit flag beats the env; a garbage env value is IGNORED by the
    // planner (the CLI layer fails loud on unknown --net before we get here).
    expect(plan({ net: 'shared', envNet: 'off' }).plan!.netMode).toBe('shared');
    expect(plan({ net: 'off', envNet: 'garbage' }).plan!.netMode).toBe('off');
    expect(plan({ envNet: 'garbage' }).plan!.netMode).toBe('shared');
  });
});
