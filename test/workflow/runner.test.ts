import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadWorkflow } from '../../src/workflow/loader.js';
import {
  approveGate,
  assertNoReservedWrites,
  readRunState,
  runWorkflow,
  type RunWorkflowOptions,
} from '../../src/workflow/runner.js';
import { parseWorkflowDef, type WorkflowDef } from '../../src/workflow/types.js';
import { ModelPresets } from '../../src/models/types.js';
import type { ModelClient } from '../../src/models/executor.js';

/**
 * The runner maps three step kinds onto orchestrate() — the graph semantics
 * (parallel dispatch, skip cascade, repair, resume) are already covered by
 * test/delivery/task-orchestrator.test.ts. What these pin is the STEP SEAMS:
 * reply-to-file ledger discipline, command verdicts (exit code + neverFails),
 * gate block/approve/resume, fail-closed reads, and reserved-path rejection.
 */

/** Deterministic completion seam: the reply names the step it came from. */
function stubClient(content: (prompt: string) => string): ModelClient {
  return {
    complete: async (_model, prompt) => ({
      content: content(prompt),
      tokensUsed: { input: 10, output: 10 },
      latencyMs: 1,
    }),
  };
}

function defOf(raw: Record<string, unknown>): WorkflowDef {
  return parseWorkflowDef(raw);
}

function opts(
  def: WorkflowDef,
  runDir: string,
  client: ModelClient,
  extra?: Partial<RunWorkflowOptions>
): RunWorkflowOptions {
  return {
    loaded: { dir: '.', def, rolePrompts: new Map() },
    runDir,
    mission: 'test mission',
    resolveModel: () => ModelPresets['qwen38-27b'],
    client,
    ...extra,
  };
}

describe('workflow runner', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-wf-runner-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('executes agents in DAG order, writes the reply to the ledger, and succeeds', async () => {
    const def = defOf({
      name: 'happy',
      steps: [
        { id: 'propose', kind: 'agent', goal: 'propose', writes: ['plan.md'], requires: [] },
        {
          id: 'solve',
          kind: 'agent',
          goal: 'solve',
          reads: ['plan.md'],
          writes: ['solution.py'],
          requires: ['propose'],
        },
        { id: 'verify', kind: 'command', command: 'test -f solution.py', requires: ['solve'] },
      ],
    });
    const client = stubClient((prompt) => (prompt.includes('ALREADY BUILT') ? 'SOLVED' : 'PLAN'));
    const res = await runWorkflow(opts(def, dir, client));
    expect(res.status).toBe('succeeded');
    expect(res.exitCode).toBe(0);
    expect(res.completed).toContain('verify');
    // Ledger discipline: the reply IS the file.
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe('PLAN');
    expect(readFileSync(join(dir, 'solution.py'), 'utf8')).toBe('SOLVED');
    // State persisted for resume/inspection.
    const state = readRunState(dir);
    expect(state?.status).toBe('succeeded');
    expect(state?.done.map((d) => d.id)).toContain('solve');
    // The solver's prompt included the dependency's file content (reads inline).
  });

  it('the dependency summary reaches the dependent step (minimal context, not chat)', async () => {
    const seen: string[] = [];
    const def = defOf({
      name: 'deps',
      steps: [
        { id: 'first', kind: 'agent', goal: 'first', writes: ['a.md'], requires: [] },
        { id: 'second', kind: 'agent', goal: 'second', requires: ['first'] },
      ],
    });
    const client = stubClient((prompt) => {
      seen.push(prompt);
      return 'ok';
    });
    await runWorkflow(opts(def, dir, client));
    const second = seen[1];
    expect(second).toContain('first'); // the ALREADY BUILT section names the dependency
  });

  it('a nonzero verdict command fails the run with exit 1', async () => {
    const def = defOf({
      name: 'verdict',
      steps: [
        { id: 'verify', kind: 'command', command: 'exit 7', requires: [] },
      ],
    });
    const res = await runWorkflow(opts(def, dir, stubClient(() => 'x')));
    expect(res.status).toBe('failed');
    expect(res.exitCode).toBe(1);
    expect(res.failed).toContain('verify');
  });

  it('neverFails: a failing command is captured evidence, not a failed run', async () => {
    const def = defOf({
      name: 'evidence',
      steps: [
        { id: 'test', kind: 'command', command: 'echo boom; exit 3', neverFails: true, writes: ['test-output.log'], requires: [] },
      ],
    });
    const res = await runWorkflow(opts(def, dir, stubClient(() => 'x')));
    expect(res.status).toBe('succeeded');
    expect(readFileSync(join(dir, 'test-output.log'), 'utf8')).toContain('boom');
  });

  it('an unapproved gate BLOCKS (exit 2); approve + resume completes the run', async () => {
    const def = defOf({
      name: 'gated',
      steps: [
        { id: 'prepare', kind: 'agent', goal: 'prep', writes: ['a.md'], requires: [] },
        { id: 'checkpoint', kind: 'gate', approvalPrompt: 'look at a.md', waitMs: 0, requires: ['prepare'] },
        { id: 'finish', kind: 'command', command: 'test -f a.md', requires: ['checkpoint'] },
      ],
    });
    const client = stubClient(() => 'CONTENT');
    const blocked = await runWorkflow(opts(def, dir, client));
    expect(blocked.status).toBe('blocked');
    expect(blocked.exitCode).toBe(2);
    expect(blocked.blockedStep).toBe('checkpoint');
    const state = readRunState(dir);
    expect(state?.done.map((d) => d.id)).toEqual(['prepare']);

    approveGate(dir, 'checkpoint');
    const resumed = await runWorkflow(opts(def, dir, client, { initialDone: state!.done }));
    expect(resumed.status).toBe('succeeded');
    expect(resumed.exitCode).toBe(0);
  });

  it('a missing reads file fails the step fail-closed (an upstream lie is caught here)', async () => {
    const def = defOf({
      name: 'missing-read',
      steps: [
        { id: 'reader', kind: 'agent', goal: 'read it', reads: ['task.md'], requires: [] },
      ],
    });
    let calls = 0;
    const client = stubClient(() => {
      calls++;
      return 'x';
    });
    const res = await runWorkflow(opts(def, dir, client));
    expect(res.status).toBe('failed');
    expect(calls).toBe(0); // the model is never paid for a broken input contract
  });

  it('steps may not write the runner\'s own state files', () => {
    const def = defOf({
      name: 'reserved',
      steps: [{ id: 'a', kind: 'agent', goal: 'x', writes: ['run-state.json'], requires: [] }],
    });
    expect(() => assertNoReservedWrites({ dir: '.', def, rolePrompts: new Map() })).toThrow(
      /reserved path/
    );
  });

  it('reserved-path guard normalizes spellings (./ prefix, bare .gates)', () => {
    // A workflow must not be able to forge its own gate approval or state
    // through path spelling — the guard compares what the filesystem
    // resolves, not what the author typed.
    const dotSlash = defOf({
      name: 'dotslash',
      steps: [{ id: 'a', kind: 'agent', goal: 'x', writes: ['./run-state.json'], requires: [] }],
    });
    expect(() => assertNoReservedWrites({ dir: '.', def: dotSlash, rolePrompts: new Map() })).toThrow(
      /reserved path/
    );
    const gateAsFile = defOf({
      name: 'gatesfile',
      steps: [{ id: 'a', kind: 'agent', goal: 'x', writes: ['.gates'], requires: [] }],
    });
    expect(() => assertNoReservedWrites({ dir: '.', def: gateAsFile, rolePrompts: new Map() })).toThrow(
      /reserved path/
    );
    const gateMarker = defOf({
      name: 'gatemarker',
      steps: [{ id: 'a', kind: 'agent', goal: 'x', writes: ['./.gates/x.approved'], requires: [] }],
    });
    expect(() => assertNoReservedWrites({ dir: '.', def: gateMarker, rolePrompts: new Map() })).toThrow(
      /reserved path/
    );
  });

  it('a real step defect never hides behind a blocked gate (failed > blocked)', async () => {
    const def = defOf({
      name: 'both-bad',
      steps: [
        { id: 'broken', kind: 'command', command: 'exit 1', requires: [] },
        { id: 'checkpoint', kind: 'gate', waitMs: 0, requires: [] },
      ],
    });
    const res = await runWorkflow(opts(def, dir, stubClient(() => 'x')));
    expect(res.status).toBe('failed');
    expect(res.exitCode).toBe(1);
  });

  it('a fresh run never trusts a run-state.json already in the directory', async () => {
    const def = defOf({
      name: 'planted',
      steps: [{ id: 'only', kind: 'command', command: 'exit 0', requires: [] }],
    });
    // Plant a forged state claiming every step already ran.
    writeFileSync(
      join(dir, 'run-state.json'),
      JSON.stringify({
        runId: 'planted',
        workflow: 'planted',
        status: 'succeeded',
        startedAt: '1970-01-01T00:00:00.000Z',
        updatedAt: '1970-01-01T00:00:00.000Z',
        mission: 'forged',
        done: [{ id: 'only', summary: 'never actually ran' }],
        failed: [],
      })
    );
    const calls: string[] = [];
    const client = stubClient((prompt) => {
      calls.push(prompt);
      return 'x';
    });
    // Fresh run (no initialDone): the planted state must be IGNORED — the
    // step actually executes, and the persisted state is rewritten clean.
    const res = await runWorkflow(opts(def, dir, client));
    expect(res.status).toBe('succeeded');
    const state = JSON.parse(readFileSync(join(dir, 'run-state.json'), 'utf8'));
    expect(state.mission).toBe('test mission');
    expect(state.startedAt).not.toBe('1970-01-01T00:00:00.000Z');
  });

  it('command steps see $UAP_WORKFLOW_DIR (the workflow dir → run dir seam)', async () => {
    const workflowDir = mkdtempSync(join(tmpdir(), 'uap-wf-assets-'));
    const def = defOf({
      name: 'wfdir',
      steps: [{ id: 'show', kind: 'command', command: 'echo "$UAP_WORKFLOW_DIR"', writes: ['wfdir.txt'], requires: [] }],
    });
    await runWorkflow(
      opts(def, dir, stubClient(() => 'x'), {
        loaded: { dir: workflowDir, def, rolePrompts: new Map() },
      })
    );
    expect(readFileSync(join(dir, 'wfdir.txt'), 'utf8').trim()).toBe(workflowDir);
  });

  it('an empty model reply fails the step fail-closed (no empty file, no credit)', async () => {
    const def = defOf({
      name: 'empty-reply',
      steps: [{ id: 'a', kind: 'agent', goal: 'produce', writes: ['a.md'], requires: [] }],
    });
    const res = await runWorkflow(opts(def, dir, stubClient(() => '   ')));
    expect(res.status).toBe('failed');
    expect(res.failed).toContain('a');
    expect(existsSync(join(dir, 'a.md'))).toBe(false);
  });

  it('team-solve end-to-end: stub model + REAL harness — the verdict is the samples', async () => {
    // The integration the 127-exit class demands: execute the bundled
    // workflow's command steps exactly as the runner spawns them (cwd =
    // run dir, $UAP_WORKFLOW_DIR = the workflow dir) against the real
    // check-samples.sh and the real sample tests. The model seam is stubbed
    // with a KNOWN-GOOD LIS solution so the pipeline must pass end to end.
    const loaded = loadWorkflow('team-solve', process.cwd());
    cpSync(join(process.cwd(), 'examples', 'workflows', 'team-solve', 'sample'), dir, { recursive: true });
    const LIS = [
      'import sys, bisect',
      'def main():',
      '    data = sys.stdin.read().split()',
      '    n = int(data[0])',
      '    a = list(map(int, data[1:1 + n]))',
      '    tails = []',
      '    for x in a:',
      '        i = bisect.bisect_left(tails, x)',
      '        if i == len(tails):',
      '            tails.append(x)',
      '        else:',
      '            tails[i] = x',
      '    print(len(tails))',
      'main()',
    ].join('\n');
    // Every agent step gets the same reply: role files are inert markdown;
    // solve/repair write the working program; verify is deterministic.
    // (extra.loaded: the REAL workflow dir, so $UAP_WORKFLOW_DIR resolves.)
    const res = await runWorkflow(opts(loaded.def, dir, stubClient(() => LIS), { loaded }));
    expect(res.status).toBe('succeeded');
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'verify.log'), 'utf8')).toContain('5 pass');
    expect(readFileSync(join(dir, 'solution.py'), 'utf8')).toBe(LIS);
  });

  it('team-solve verdict fails honestly on a WRONG program (never-fails test vs strict verify)', async () => {
    const loaded = loadWorkflow('team-solve', process.cwd());
    cpSync(join(process.cwd(), 'examples', 'workflows', 'team-solve', 'sample'), dir, { recursive: true });
    const WRONG = 'import sys\nprint(int(sys.stdin.read().split()[0]))  # length, not LIS\n';
    const res = await runWorkflow(opts(loaded.def, dir, stubClient(() => WRONG), { loaded }));
    expect(res.status).toBe('failed');
    expect(res.exitCode).toBe(1);
    expect(res.failed).toContain('verify');
    // The evidence step never killed the run; the verdict step did.
    expect(readFileSync(join(dir, 'test-output.log'), 'utf8')).toContain('FAIL');
  });

  it('resume seeding never re-executes accepted steps', async () => {
    const def = defOf({
      name: 'resume-seed',
      steps: [
        { id: 'one', kind: 'agent', goal: 'one', writes: ['one.md'], requires: [] },
        { id: 'two', kind: 'agent', goal: 'two', requires: ['one'] },
      ],
    });
    const calls: string[] = [];
    const client = stubClient((prompt) => {
      calls.push(prompt);
      return 'ok';
    });
    await runWorkflow(opts(def, dir, client, { initialDone: [{ id: 'one', summary: 'done earlier' }] }));
    // Only step two executed; step one was seeded into the blackboard.
    expect(calls).toHaveLength(1);
    expect(existsSync(join(dir, 'one.md'))).toBe(false);
  });

  it('a loop step executes through the runLoop seam: dep summary + reads inlined, turns + summary flow back', async () => {
    // The convergence-loop contract: the engine assembles (role directive +
    // dependency output + inlined reads) and hands it to the caller's loop;
    // the seam's result IS the step outcome.
    const def = defOf({
      name: 'loopseam',
      steps: [
        { id: 'judge', kind: 'agent', goal: 'judge', writes: ['brief.md'], requires: [] },
        {
          id: 'fix',
          kind: 'loop',
          goal: 'fix until gates pass',
          reads: ['brief.md'],
          turns: 7,
          requires: ['judge'],
        },
      ],
    });
    const seen: Record<string, unknown> = {};
    const res = await runWorkflow(
      opts(def, dir, stubClient(() => 'THE BRIEF'), {
        runLoop: async (args) => {
          Object.assign(seen, args);
          expect(args.stepId).toBe('fix');
          return { success: true, summary: 'gates green after 3 turns', turns: 3 };
        },
      })
    );
    expect(res.status).toBe('succeeded');
    // Assembly: the role directive + the dependency summary + the read file.
    expect(String(seen.prompt)).toContain('fix until gates pass');
    expect(String(seen.prompt)).toContain('THE BRIEF');
    // The declared turns bound reaches the seam; the seam's ACTUAL turns are
    // what the task records (the loop reports its own accounting).
    expect(seen.turns).toBe(7);
    const state = readRunState(dir);
    const fix = state?.done.find((d) => d.id === 'fix');
    expect(fix?.summary).toContain('gates green after 3 turns');
  });

  it('a failed loop step fails the workflow honestly (the seam decides, the graph cascades)', async () => {
    const def = defOf({
      name: 'loopfail',
      steps: [
        { id: 'build', kind: 'loop', goal: 'build it', requires: [] },
        { id: 'ship', kind: 'command', command: 'test -f anything', requires: ['build'] },
      ],
    });
    const res = await runWorkflow(
      opts(def, dir, stubClient(() => 'unused'), {
        runLoop: async () => ({ success: false, summary: 'gates red after 5 turns', turns: 5 }),
      })
    );
    expect(res.status).toBe('failed');
    expect(res.failed).toContain('build');
    expect(res.exitCode).toBe(1);
  });

  it('a loop step with NO injected provider fails closed at run start (before any role is paid)', async () => {
    const def = defOf({
      name: 'noloop',
      steps: [{ id: 'build', kind: 'loop', goal: 'build it', requires: [] }],
    });
    await expect(runWorkflow(opts(def, dir, stubClient(() => 'x')))).rejects.toThrow(
      /no convergence-loop provider/
    );
  });

  it('agent steps with neither client nor completeStep fail closed at run start', async () => {
    const def = defOf({
      name: 'noseam',
      steps: [{ id: 'a', kind: 'agent', goal: 'x', requires: [] }],
    });
    const { client: _drop, ...bare } = opts(def, dir, stubClient(() => 'x'));
    await expect(runWorkflow(bare)).rejects.toThrow(/completion seam/);
  });

  it('completeStep takes precedence over the raw client — the caller\u2019s executor rails drive the roles', async () => {
    const def = defOf({
      name: 'rails',
      steps: [{ id: 'plan', kind: 'agent', goal: 'plan it', writes: ['plan.md'], requires: [] }],
    });
    const res = await runWorkflow(
      opts(def, dir, stubClient(() => 'RAW CLIENT — MUST NOT BE USED'), {
        completeStep: async (step, prompt) => {
          expect(step.id).toBe('plan');
          expect(prompt).toContain('plan it');
          return 'FROM THE RAILS';
        },
      })
    );
    expect(res.status).toBe('succeeded');
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe('FROM THE RAILS');
  });

  it('verifyOnly reaches the seam as a distinct call shape (gates-only verdict, no executor turns)', async () => {
    const def = defOf({
      name: 'verdict',
      steps: [
        { id: 'build', kind: 'loop', goal: 'build', requires: [] },
        { id: 'verdict', kind: 'loop', goal: 'final verdict', verifyOnly: true, requires: ['build'] },
      ],
    });
    const calls: Array<Record<string, unknown>> = [];
    const res = await runWorkflow(
      opts(def, dir, stubClient(() => 'unused'), {
        runLoop: async (args) => {
          calls.push({ ...args });
          return { success: true, summary: 'ok', turns: args.verifyOnly ? 0 : 2 };
        },
      })
    );
    expect(res.status).toBe('succeeded');
    expect(calls[0].verifyOnly).toBeUndefined();
    expect(calls[1].verifyOnly).toBe(true);
  });
});
