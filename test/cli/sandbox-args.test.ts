/**
 * `uap sandbox` planSandbox (bridge P4) — the pure bwrap planner, so the
 * kernel boundary and the two new authorities (per-session grant holes,
 * --net off egress cut) are asserted WITHOUT bubblewrap: what the argv
 * contains is what the kernel enforces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
    expect(r.plan!.notes.some((n) => n.includes('were not opened'))).toBe(true);
  });

  it('re-resolves granted paths at PLAN time and refuses a symlink swapped in after load (TOCTOU)', () => {
    // The row's path was realpath-validated at load; the planner must not
    // trust the row's word for it — a symlink to $HOME swapped in during
    // the load→exec window would bind the operator's home writable. In the
    // CLI the sandbox home IS the real $HOME, so the production semantics
    // are exercised by passing the real home here.
    const real = join(dir, 'real-hole');
    mkdirSync(real);
    const homeLink = join(dir, 'innocuous');
    const home = process.env.HOME || '';
    symlinkSync(home, homeLink);
    const evilLink = join(dir, 'evil');
    symlinkSync(home, evilLink);
    const grants: ResolvedGrants = { grants: [], paths: [homeLink, evilLink, real] };
    const r = plan({ grants, home });
    const argv = r.plan!.argv.join(' ');
    expect(argv).toContain(`--bind ${real} ${real}`);
    // The symlink rows are re-resolved and the resolved value re-checked:
    // $HOME is over-broad, so those rows open NOTHING.
    expect(r.plan!.grantedPaths).toEqual([real]);
    expect(argv).not.toContain(`--bind ${home} ${home}`);
    // A symlink to a legitimately grantable dir binds the RESOLVED path,
    // not the link name (the resolution, not the row, chooses the target).
    const dirLink = join(dir, 'dir-link');
    symlinkSync(real, dirLink);
    const r2 = plan({ grants: { grants: [], paths: [dirLink] }, home });
    expect(r2.plan!.grantedPaths).toEqual([real]);
  });

  it('ro-binds the consent ledger and audit file so the sandboxed side can neither plant rows nor forge audit lines', () => {
    // P4 security review finding 1: the ledger/audit live inside the
    // writable hole, so without a ro-bind a sandboxed agent plants a
    // well-formed `paths:["/etc"]` row and the NEXT run opens it.
    const ledger = join(dir, '.uap', 'sandbox-grants.json');
    const audit = join(dir, '.uap', 'sandbox-audit.jsonl');
    mkdirSync(join(dir, '.uap'));
    writeFileSync(ledger, '[]');
    writeFileSync(audit, '');
    const r = plan({ grantsLedgerPath: ledger, auditLogPath: audit });
    const argv = r.plan!.argv.join(' ');
    expect(argv).toContain(`--ro-bind ${ledger} ${ledger}`);
    expect(argv).toContain(`--ro-bind ${audit} ${audit}`);
    // A MISSING file gets /dev/null bound at its path: planting one must
    // be equally impossible (it reads empty and refuses writes).
    const r2 = plan({ grantsLedgerPath: join(dir, '.uap', 'absent.json'), auditLogPath: join(dir, '.uap', 'gone.jsonl') });
    const argv2 = r2.plan!.argv.join(' ');
    expect(argv2).toContain(`--ro-bind /dev/null ${join(dir, '.uap', 'absent.json')}`);
    expect(argv2).toContain(`--ro-bind /dev/null ${join(dir, '.uap', 'gone.jsonl')}`);
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
