import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorkflow, orderedSteps, workflowSearchRoots } from '../../src/workflow/loader.js';
import { parseWorkflowDef, type LoadedWorkflow, type WorkflowDef } from '../../src/workflow/types.js';

/**
 * The loader is the fail-closed front door: every structural defect is an
 * error HERE, before any model is paid. These tests pin each rejection plus
 * the bundled team-solve (the flagship workflow must always load).
 */

const PROJECT_ROOT = process.cwd();

function makeDef(raw: Record<string, unknown>): WorkflowDef {
  return parseWorkflowDef(raw);
}

/** Two parallel steps sharing a write target — FALSE INDEPENDENCE (S7). */
const COLLISION_RAW = {
  name: 'collide',
  steps: [
    { id: 'a', kind: 'agent', goal: 'write it', writes: ['out.md'], requires: [] },
    { id: 'b', kind: 'agent', goal: 'write it too', writes: ['out.md'], requires: [] },
  ],
};

/** Write raw YAML under a temp project and load it (the validateGraph path). */
function loadRaw(raw: string, name: string): LoadedWorkflow {
  const dir = mkdtempSync(join(tmpdir(), 'uap-wf-raw-'));
  mkdirSync(join(dir, '.uap', 'workflows', name), { recursive: true });
  writeFileSync(join(dir, '.uap', 'workflows', name, 'workflow.yaml'), raw);
  return loadWorkflow(name, dir);
}

describe('workflow loader', () => {
  it('loads the bundled team-solve: 8 steps, topological order, role prompts resolved', () => {
    const loaded = loadWorkflow('team-solve', PROJECT_ROOT);
    expect(loaded.def.steps).toHaveLength(8);
    const order = orderedSteps(loaded.def).map((s) => s.id);
    expect(order[0]).toBe('plan');
    expect(order.indexOf('ideate-a')).toBeLessThan(order.indexOf('solve'));
    expect(order.indexOf('ideate-b')).toBeLessThan(order.indexOf('solve'));
    expect(order.indexOf('test')).toBeLessThan(order.indexOf('review'));
    expect(order.indexOf('repair')).toBeLessThan(order.indexOf('verify'));
    // Fail-closed role prompts: resolved from files, not empty strings.
    const planPrompt = loaded.rolePrompts.get('plan');
    expect(planPrompt).toBeTruthy();
    expect(planPrompt).toContain('PLANNER');
    // The deterministic steps stay deterministic.
    expect(loaded.def.steps.find((s) => s.id === 'test')?.neverFails).toBe(true);
    expect(loaded.def.steps.find((s) => s.id === 'verify')?.neverFails).toBeUndefined();
  });

  it('rejects a cycle in requires: edges', () => {
    // A cycle is a graph-level check (post-schema), so it loads only via the
    // full loader path.
    expect(() =>
      loadRaw(
        `name: cyclic\nsteps:\n  - id: a\n    kind: agent\n    goal: a\n    requires: [b]\n  - id: b\n    kind: agent\n    goal: b\n    requires: [a]\n`,
        'cyclic'
      )
    ).toThrow(/cycle/i);
  });

  it('rejects a step that requires an unknown id', () => {
    expect(() =>
      loadRaw(`name: ghost\nsteps:\n  - id: a\n    kind: agent\n    goal: a\n    requires: [nonexistent]\n`, 'ghost')
    ).toThrow(/unknown step "nonexistent"/);
  });

  it('rejects two parallel steps writing the same file with no edge between them', () => {
    expect(() => makeDef(COLLISION_RAW)).not.toThrow(); // schema alone passes —
    // the FALSE INDEPENDENCE check is a graph-level invariant
    expect(() =>
      loadRaw(
        `name: collide\nsteps:\n  - id: a\n    kind: agent\n    goal: write it\n    writes: [out.md]\n    requires: []\n  - id: b\n    kind: agent\n    goal: write it too\n    writes: [out.md]\n    requires: []\n`,
        'collide'
      )
    ).toThrow(/both write "out\.md"/);
  });

  it('rejects an agent step with both prompt: and goal:, and one with neither', () => {
    expect(() =>
      loadRaw(`name: both\nsteps:\n  - id: a\n    kind: agent\n    goal: x\n    prompt: p.md\n    requires: []\n`, 'both')
    ).toThrow(/exactly one of prompt: or goal:/);
    expect(() => loadRaw(`name: neither\nsteps:\n  - id: a\n    kind: agent\n    requires: []\n`, 'neither')).toThrow(
      /exactly one of prompt: or goal:/
    );
  });

  it('rejects command-only fields on a non-command step (kind confusion)', () => {
    expect(() =>
      loadRaw(
        `name: confused\nsteps:\n  - id: a\n    kind: agent\n    goal: x\n    command: echo hi\n    requires: []\n`,
        'confused'
      )
    ).toThrow(/command-only fields/);
  });

  it('rejects non-slug step ids (repair chains namespace as <id>.r0-…)', () => {
    expect(() =>
      makeDef({ name: 'badid', steps: [{ id: 'A.1', kind: 'agent', goal: 'x', requires: [] }] })
    ).toThrow(/step id/);
  });

  it('duplicate requires: entries load fine (deduped, not misreported as a cycle)', () => {
    expect(() =>
      loadRaw(
        `name: dupedge\nsteps:\n  - id: a\n    kind: agent\n    goal: a\n    requires: []\n  - id: b\n    kind: agent\n    goal: b\n    requires: [a, a]\n`,
        'dupedge'
      )
    ).not.toThrow();
  });

  it('rejects unknown model pins at LOAD time (before any GPU is paid)', () => {
    expect(() =>
      loadRaw(
        `name: badpin\nsteps:\n  - id: a\n    kind: agent\n    goal: x\n    model: qwen38-27B-typo\n    requires: []\n`,
        'badpin'
      )
    ).toThrow(/unknown model "qwen38-27B-typo"/);
    expect(() =>
      loadRaw(`name: baddefault\ndefaultModel: not-a-preset\nsteps:\n  - id: a\n    kind: agent\n    goal: x\n    requires: []\n`, 'baddefault')
    ).toThrow(/defaultModel "not-a-preset" is not a known preset/);
  });

  it('searches project, home, then bundled roots in order', () => {
    const roots = workflowSearchRoots(PROJECT_ROOT);
    expect(roots).toHaveLength(3);
    expect(roots[0]).toBe(join(PROJECT_ROOT, '.uap', 'workflows'));
    expect(roots[2]).toContain(join('examples', 'workflows'));
  });
});
