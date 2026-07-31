import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyPending,
  clearPending,
  unclearableReason,
  outstandingPlans,
  isInsideProject,
} from '../../src/cli/plan.js';

function writeState(cwd: string, pending: Record<string, number>): void {
  mkdirSync(join(cwd, '.uap'), { recursive: true });
  writeFileSync(join(cwd, '.uap', 'plan_state.json'), JSON.stringify({ pending }, null, 2));
}

function readPending(cwd: string): string[] {
  const raw = JSON.parse(readFileSync(join(cwd, '.uap', 'plan_state.json'), 'utf-8'));
  return Object.keys(raw.pending ?? {});
}

describe('plan gate: unreachable pending entries', () => {
  let cwd: string;
  let outside: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-plan-clear-'));
    outside = mkdtempSync(join(tmpdir(), 'uap-plan-outside-'));
    mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('names an outside-the-project entry as unreachable', () => {
    // The live wedge: a memory note at ~/.claude/.../memory/plan_gate_before_build.md
    // matched only because its filename contains "plan". `uap plan validate`
    // refuses it ("must live under the project directory"), so the entry could
    // never clear and every build in the repo blocked.
    const foreign = join(outside, 'some-plan.md');
    writeFileSync(foreign, '# not really a plan');
    expect(unclearableReason(cwd, foreign)).toMatch(/outside the project/);
  });

  it('names a deleted plan as unreachable', () => {
    expect(unclearableReason(cwd, 'docs/plans/gone.md')).toMatch(/no longer exists/);
  });

  it('treats a real, present plan as clearable by validation', () => {
    const p = join(cwd, 'docs', 'plans', 'real-plan.md');
    writeFileSync(p, '# a real plan');
    expect(unclearableReason(cwd, 'docs/plans/real-plan.md')).toBeNull();
  });

  it('splits pending into clearable and unreachable', () => {
    const real = join(cwd, 'docs', 'plans', 'real-plan.md');
    writeFileSync(real, '# a real plan');
    const foreign = join(outside, 'stray-plan.md');
    writeFileSync(foreign, '# stray');
    writeState(cwd, {
      'docs/plans/real-plan.md': 1,
      'docs/plans/deleted-plan.md': 2,
      [foreign]: 3,
    });

    const { clearable, unclearable } = classifyPending(cwd);
    expect(clearable).toEqual(['docs/plans/real-plan.md']);
    expect(unclearable.map((u) => u.key).sort()).toEqual(
      ['docs/plans/deleted-plan.md', foreign].sort()
    );
  });

  it('clear drops only the unreachable entries', () => {
    const real = join(cwd, 'docs', 'plans', 'real-plan.md');
    writeFileSync(real, '# a real plan');
    const foreign = join(outside, 'stray-plan.md');
    writeFileSync(foreign, '# stray');
    writeState(cwd, {
      'docs/plans/real-plan.md': 1,
      'docs/plans/deleted-plan.md': 2,
      [foreign]: 3,
    });

    const { dropped } = clearPending(cwd);
    expect(dropped.sort()).toEqual(['docs/plans/deleted-plan.md', foreign].sort());
    // The real plan still gates the build — that is the whole point of the gate.
    expect(readPending(cwd)).toEqual(['docs/plans/real-plan.md']);
    expect(outstandingPlans(cwd).pending).toEqual(['docs/plans/real-plan.md']);
  });

  it('REFUSES to clear a reviewable plan — clear is recovery, not a skip', () => {
    const real = join(cwd, 'docs', 'plans', 'real-plan.md');
    writeFileSync(real, '# a real plan');
    writeState(cwd, { 'docs/plans/real-plan.md': 1 });

    const { dropped, refused } = clearPending(cwd, 'docs/plans/real-plan.md');
    expect(dropped).toEqual([]);
    expect(refused[0].reason).toMatch(/validate/);
    expect(readPending(cwd)).toEqual(['docs/plans/real-plan.md']);
  });

  it('clears a single named unreachable entry', () => {
    writeState(cwd, { 'docs/plans/a-plan.md': 1, 'docs/plans/b-plan.md': 2 });
    const { dropped } = clearPending(cwd, 'docs/plans/a-plan.md');
    expect(dropped).toEqual(['docs/plans/a-plan.md']);
    expect(readPending(cwd)).toEqual(['docs/plans/b-plan.md']);
  });

  it('is a no-op when nothing is unreachable', () => {
    const real = join(cwd, 'docs', 'plans', 'real-plan.md');
    writeFileSync(real, '# a real plan');
    writeState(cwd, { 'docs/plans/real-plan.md': 1 });
    expect(clearPending(cwd).dropped).toEqual([]);
    expect(readPending(cwd)).toEqual(['docs/plans/real-plan.md']);
  });

  it('does not write state when there is nothing to drop', () => {
    writeState(cwd, {});
    const before = readFileSync(join(cwd, '.uap', 'plan_state.json'), 'utf-8');
    clearPending(cwd);
    expect(readFileSync(join(cwd, '.uap', 'plan_state.json'), 'utf-8')).toBe(before);
  });
});

describe('plan clear: it is a recovery hatch, not a bypass', () => {
  let cwd: string;
  let outside: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-plan-sec-'));
    outside = mkdtempSync(join(tmpdir(), 'uap-plan-out-'));
    mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('resolves symlinks so an in-repo link out of the tree is not "inside"', () => {
    // A lexical check would call this inside the project, and `validate` would
    // then ship the LINK TARGET's contents to a model endpoint.
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'private');
    const link = join(cwd, 'docs', 'plans', 'sneaky-plan.md');
    symlinkSync(secret, link);
    expect(isInsideProject(cwd, 'docs/plans/sneaky-plan.md')).toBe(false);
    expect(unclearableReason(cwd, 'docs/plans/sneaky-plan.md')).toMatch(/outside the project/);
  });

  it('does not treat a sibling directory sharing the prefix as inside', () => {
    expect(isInsideProject(cwd, `${cwd}-backup/plan.md`)).toBe(false);
  });

  it('classifies a present-but-unreadable entry as unreachable, not "awaiting review"', () => {
    // `validate` reads the file and leaves the entry pending when that throws,
    // so this is the same permanent wedge with a different cause.
    const dir = join(cwd, 'docs', 'plans', 'weird-plan.md');
    mkdirSync(dir);
    expect(unclearableReason(cwd, 'docs/plans/weird-plan.md')).toMatch(/not a regular file/);
  });

  it('ignores inherited Object properties as pending keys', () => {
    // `key in pending` matched `toString`, reported a phantom drop, and rewrote
    // state that should never have been touched.
    writeState(cwd, { 'docs/plans/real-plan.md': 1 });
    writeFileSync(join(cwd, 'docs', 'plans', 'real-plan.md'), '# real');
    const before = readFileSync(join(cwd, '.uap', 'plan_state.json'), 'utf-8');
    const { dropped, refused } = clearPending(cwd, 'toString');
    expect(dropped).toEqual([]);
    expect(refused).toEqual([]);
    expect(readFileSync(join(cwd, '.uap', 'plan_state.json'), 'utf-8')).toBe(before);
  });

  it('matches an absolute key the way `status` prints it', () => {
    // The enforcer stores an out-of-project entry as the absolute path it saw,
    // while planKey would render it `../../…`. Copy-pasting the printed key
    // used to find nothing and report "nothing to clear".
    const foreign = join(outside, 'stray-plan.md');
    writeState(cwd, { [foreign]: 1 });
    const { dropped } = clearPending(cwd, foreign);
    expect(dropped).toEqual([foreign]);
    expect(readPending(cwd)).toEqual([]);
  });

  it('records what it dropped and why', () => {
    const foreign = join(outside, 'stray-plan.md');
    writeState(cwd, { [foreign]: 1 });
    clearPending(cwd);
    const st = JSON.parse(readFileSync(join(cwd, '.uap', 'plan_state.json'), 'utf-8'));
    expect(st.cleared).toHaveLength(1);
    expect(st.cleared[0].key).toBe(foreign);
    expect(st.cleared[0].reason).toMatch(/outside the project/);
  });

  it('preserves every other field of the state file', () => {
    const foreign = join(outside, 'stray-plan.md');
    mkdirSync(join(cwd, '.uap'), { recursive: true });
    writeFileSync(
      join(cwd, '.uap', 'plan_state.json'),
      JSON.stringify({
        pending: { [foreign]: 1 },
        validated: { 'docs/plans/done-plan.md': 'abc123' },
        validated_at: 42,
      })
    );
    clearPending(cwd);
    const st = JSON.parse(readFileSync(join(cwd, '.uap', 'plan_state.json'), 'utf-8'));
    expect(st.validated).toEqual({ 'docs/plans/done-plan.md': 'abc123' });
    expect(st.validated_at).toBe(42);
  });
});
