/**
 * Per-turn attribution: what each turn DID, and why the loop stopped.
 *
 * THE GAP THIS CLOSES
 * The raw adapter already computed all of this inside its loop and folded it
 * into a human log line, then dropped the structure at the runner boundary. So
 * an aggregate like "a large share of cells burned the whole turn budget and
 * solved nothing" could be SEEN but not explained: answering "did they write
 * files and fail the gate, or never produce a parseable answer at all?" meant
 * re-reading prose logs by hand, one cell at a time.
 *
 * `finishReason` / `truncated` are carried for a specific measured reason —
 * empty completions were once diagnosed as a prompt-format problem and chased
 * in that direction, when the cause was `finish_reason=length`, the budget
 * running out mid-reasoning. Those two fields separate "answered badly" from
 * "never answered".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawCompletionAdapter } from '../../src/benchmarks/paired/adapter.js';
import { makeFullCondition } from '../../src/benchmarks/paired/types.js';
import type { TaskSpec } from '../../src/benchmarks/paired/types.js';

/** Serve a scripted sequence of completions; the last one repeats. */
function mockChat(bodies: { content: string; finish?: string }[]): void {
  let i = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    const b = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: b.content }, finish_reason: b.finish ?? 'stop' }],
        usage: { total_tokens: 100 },
      }),
    } as unknown as Response;
  });
}

const fileBlock = (p: string, body: string): string => `<<<FILE ${p}>>>\n${body}\n<<<END>>>`;

describe('raw adapter per-turn attribution', () => {
  let dir: string;
  let task: TaskSpec;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-attrib-'));
    mkdirSync(join(dir, 'repo'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'a.js'), 'broken');
    task = {
      id: 't',
      name: 't',
      instruction: 'fix it',
      gateCmd: 'exit 1', // fails unless a test overrides it
      verifyCmd: 'exit 1',
      verifyTimeoutSec: 5,
      agentTimeoutSec: 5,
    } as TaskSpec;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (a: RawCompletionAdapter, over: Partial<TaskSpec> = {}) =>
    a.run({
      task: { ...task, ...over },
      condition: makeFullCondition(),
      workdir: join(dir, 'repo'),
      seed: 0,
      model: 'm',
    });

  it('records one entry per turn, with the files that turn wrote', async () => {
    mockChat([{ content: fileBlock('a.js', 'fixed') }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 3 }));

    expect(r.turnTrace).toHaveLength(r.turns as number);
    expect(r.turnTrace?.[0]).toMatchObject({ turn: 1, files: 1, gateOk: false });
    // Turn numbers are 1-based and contiguous — a trace whose length disagrees
    // with `turns` is the failure mode this replaces.
    expect(r.turnTrace?.map((t) => t.turn)).toEqual([1, 2, 3]);
  });

  it('separates "answered badly" from "never answered"', async () => {
    // A truncated completion parses to zero file blocks, exactly like a
    // wrong-format answer. Only finishReason tells them apart.
    mockChat([{ content: '', finish: 'length' }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 1 }));

    expect(r.turnTrace?.[0]).toMatchObject({ files: 0, truncated: true, finishReason: 'length' });
  });

  it('a zero-file turn that was NOT truncated reads as a format failure', async () => {
    mockChat([{ content: 'I think the fix is to change a.js', finish: 'stop' }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 1 }));

    expect(r.turnTrace?.[0]).toMatchObject({ files: 0, finishReason: 'stop' });
    expect(r.turnTrace?.[0]?.truncated).toBeFalsy();
  });

  it('stops with `solved` when the gate passes, and records the passing turn', async () => {
    mockChat([{ content: fileBlock('a.js', 'fixed') }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 3 }), { gateCmd: 'exit 0' });

    expect(r.stopReason).toBe('solved');
    expect(r.turnTrace).toHaveLength(1);
    expect(r.turnTrace?.[0]?.gateOk).toBe(true);
  });

  it('stops with `budget` when the turns run out — the futility case', async () => {
    // This is the row that used to be indistinguishable from "solved on the
    // last turn" once the gate result was aggregated away.
    mockChat([{ content: fileBlock('a.js', 'still broken') }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 3 }));

    expect(r.stopReason).toBe('budget');
    expect(r.turnTrace).toHaveLength(3);
    expect(r.turnTrace?.every((t) => t.gateOk === false)).toBe(true);
  });

  it('records the errored turn before stopping, so counts stay consistent', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return { ok: false, status: 500 } as unknown as Response;
    });
    const r = await run(new RawCompletionAdapter({ maxGateIters: 3 }));

    expect(r.stopReason).toBe('error');
    // The turn happened; omitting it would make turns and trace length disagree.
    expect(r.turnTrace).toHaveLength(r.turns as number);
    expect(r.turnTrace?.[0]?.gateOk).toBeNull();
  });

  it('marks gateOk null when no gate ran', async () => {
    // The no-gate path is driven by the CONDITION/task, not the iteration cap:
    // `useGate = condition.has('gates') && Boolean(task.gateCmd)`. Without a
    // gate command one turn is the whole run, and `gateOk` must be null rather
    // than false — "not measured" is not "failed".
    mockChat([{ content: fileBlock('a.js', 'fixed') }]);
    const r = await run(new RawCompletionAdapter({ maxGateIters: 3 }), { gateCmd: '' });

    expect(r.stopReason).toBe('no-gate');
    expect(r.turnTrace).toHaveLength(1);
    expect(r.turnTrace?.[0]?.gateOk).toBeNull();
  });
});
