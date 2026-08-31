/**
 * F1 (deliver-hardening 2026-07-13): policy liveness — a policy whose
 * compliant path is dead must be VISIBLE, and must NOT silently degrade.
 *
 * Defect 10 was the catch-22 class: the gate blocks, the sanctioned route
 * (a command, a writable dir, a skill) is broken, and nothing notices. The
 * liveness check makes it machine-checkable. The sabotage guard is the
 * security half: an agent could break its own compliant path to force a
 * blocking policy down to advisory, so `degradable` requires BOTH the
 * policy's degradeOnDeadPath opt-in AND every failure on a surface the agent
 * cannot write (a PATH command, a system dir) — a failure inside the repo or
 * a missing skill keeps the policy blocking while the operator decides.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  POLICY_LIVENESS,
  checkPolicyLiveness,
  runLiveness,
  writeLivenessCache,
  readLivenessCache,
  classifySurface,
  type PolicyLivenessSpec,
} from '../../src/policies/liveness.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-liveness-'));
  roots.push(root);
  return root;
}

/** Run a check against a throwaway spec without mutating the registry. */
function checkWith(root: string, name: string, spec: PolicyLivenessSpec) {
  POLICY_LIVENESS[name] = spec;
  try {
    return checkPolicyLiveness(root, name);
  } finally {
    delete POLICY_LIVENESS[name];
  }
}

describe('policy liveness (F1)', () => {
  it('a policy with no declared requirements has nothing to check', () => {
    expect(checkPolicyLiveness(project(), 'no-such-policy')).toBeNull();
  });

  it('healthy when all commands resolve', () => {
    const root = project();
    const r = checkWith(root, 't-healthy', { commands: ['sh'] });
    expect(r?.healthy).toBe(true);
    expect(r?.failures).toEqual([]);
  });

  it('a missing command is an EXTERNAL failure (environment, not agent)', () => {
    const root = project();
    const r = checkWith(root, 't-cmd', { commands: ['uap-no-such-command-xyz'] });
    expect(r?.healthy).toBe(false);
    expect(r?.failures[0]).toMatchObject({ kind: 'command', surface: 'external' });
  });

  it('sabotage guard: external-only failures degrade ONLY with the opt-in', () => {
    const root = project();
    const spec = { commands: ['uap-no-such-command-xyz'] };
    const noOptIn = checkWith(root, 't-nooptin', spec);
    expect(noOptIn?.healthy).toBe(false);
    expect(noOptIn?.degradable, 'no degradeOnDeadPath → stays blocking').toBe(false);

    const optIn = checkWith(root, 't-optin', { ...spec, degradeOnDeadPath: true });
    expect(optIn?.degradable, 'external breakage + opt-in → advisory downgrade allowed').toBe(true);
  });

  it('sabotage guard: a missing REPO dir is agent-writable → never degradable', () => {
    const root = project();
    const r = checkWith(root, 't-dir', {
      commands: ['uap-no-such-command-xyz'], // external failure present…
      writableDirs: ['.uap/reviews'], // …but this one is inside the repo
      degradeOnDeadPath: true,
    });
    expect(r?.healthy).toBe(false);
    expect(r?.failures.find((f) => f.kind === 'dir')?.surface).toBe('agent-writable');
    expect(r?.degradable, 'ONE agent-writable failure must veto the degrade').toBe(false);
  });

  it('an existing writable repo dir satisfies the requirement', () => {
    const root = project();
    mkdirSync(join(root, '.uap', 'reviews'), { recursive: true });
    const r = checkWith(root, 't-dir-ok', { writableDirs: ['.uap/reviews'] });
    expect(r?.healthy).toBe(true);
  });

  it('a missing skill is agent-writable surface (the delete-a-skill sabotage vector)', () => {
    const root = project();
    const r = checkWith(root, 't-skill', {
      skills: ['definitely-not-a-real-skill-xyz'],
      degradeOnDeadPath: true,
    });
    expect(r?.healthy).toBe(false);
    expect(r?.failures[0]).toMatchObject({ kind: 'skill', surface: 'agent-writable' });
    expect(r?.degradable).toBe(false);
  });

  it('a skill present in the repo resolves', () => {
    const root = project();
    mkdirSync(join(root, '.claude', 'skills', 'myskill'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'myskill', 'SKILL.md'), '# myskill\n');
    const r = checkWith(root, 't-skill-ok', { skills: ['myskill'] });
    expect(r?.healthy).toBe(true);
  });

  it('classifySurface: absolute paths outside the repo are external', () => {
    const root = project();
    expect(classifySurface('/usr/share/whatever', root)).toBe('external');
    expect(classifySurface(join(root, 'sub', 'dir'), root)).toBe('agent-writable');
  });

  it('cache round-trips and the gate-visible degradable flag survives', () => {
    const root = project();
    const results = runLiveness(root, ['t-cache'].filter((n) => {
      POLICY_LIVENESS[n] = { commands: ['uap-no-such-command-xyz'], degradeOnDeadPath: true };
      return true;
    }));
    try {
      writeLivenessCache(root, results);
      const cache = readLivenessCache(root);
      expect(cache?.policies['t-cache']?.healthy).toBe(false);
      expect(cache?.policies['t-cache']?.degradable).toBe(true);
      expect(typeof cache?.checkedAt).toBe('string');
      // And the file is exactly where the hook looks for it.
      expect(JSON.parse(readFileSync(join(root, '.uap', 'policy-liveness.json'), 'utf8')).policies['t-cache']).toBeTruthy();
    } finally {
      delete POLICY_LIVENESS['t-cache'];
    }
  });

  it('readLivenessCache fails open on garbage', () => {
    const root = project();
    mkdirSync(join(root, '.uap'), { recursive: true });
    writeFileSync(join(root, '.uap', 'policy-liveness.json'), '{nope');
    expect(readLivenessCache(root)).toBeNull();
  });

  it('the seeded registry entries only declare real external dependencies', () => {
    // Guard against registry rot: every seeded spec must have at least one
    // requirement, and every command name must be a bare name (no paths).
    for (const [name, spec] of Object.entries(POLICY_LIVENESS)) {
      const total =
        (spec.commands?.length ?? 0) + (spec.writableDirs?.length ?? 0) + (spec.skills?.length ?? 0);
      expect(total, `${name} declares nothing — dead registry entry`).toBeGreaterThan(0);
      for (const c of spec.commands ?? []) {
        expect(c, `${name}: command '${c}' must be a bare name`).not.toMatch(/[/\\]/);
      }
    }
  });
});
