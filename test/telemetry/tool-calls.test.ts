import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordToolCall,
  summarizeToolCalls,
  renderEvidence,
  closeToolCallStores,
} from '../../src/telemetry/tool-calls.js';
import {
  classifyToolResult,
  componentForTool,
  isFailureClass,
} from '../../src/telemetry/tool-failure.js';

const dirs: string[] = [];
/** An isolated corpus root — the store is per-user, not per-project. */
function tempProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-toolcalls-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  closeToolCallStores();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('classifyToolResult (harness plan D2)', () => {
  it('files an edit miss under edit-miss, not path-not-found', () => {
    // Both strings contain "not found"; conflating them would point the evolve
    // stage at path handling instead of at the edit tool.
    expect(classifyToolResult('edit_file', 'ERROR: file.ts: old_string not found.\nNearest region…')).toBe(
      'edit-miss',
    );
    expect(classifyToolResult('read_file', 'ERROR: file not found: src/x.ts')).toBe('path-not-found');
  });

  it('separates ambiguity from a miss', () => {
    expect(classifyToolResult('edit_file', 'ERROR: x.ts: old_string matches 3 times — …')).toBe(
      'edit-ambiguous',
    );
  });

  it('treats a tolerant match as a success that still carries a signal', () => {
    const result = 'OK: edited x.ts (1 replacement) — NOTE: old_string did not match byte-for-byte;';
    expect(classifyToolResult('edit_file', result)).toBe('ok-tolerant');
    expect(isFailureClass('ok-tolerant')).toBe(false);
  });

  it('recognises the protection refusals', () => {
    expect(classifyToolResult('write_file', 'ERROR: t.spec.ts is a protected test/oracle file')).toBe(
      'protected-path',
    );
    expect(classifyToolResult('write_file', 'ERROR: types.ts is a LOCKED CONTRACT file')).toBe(
      'protected-path',
    );
  });

  it('classifies run_bash by EXIT CODE, not by an error prefix', () => {
    // run_bash returns `exit=<code> ...`, which never starts with "ERROR:" — so
    // prefix classification filed every failed command as a success and left the
    // execution component looking permanently healthy.
    expect(classifyToolResult('run_bash', 'exit=0\nall good')).toBe('ok');
    expect(classifyToolResult('run_bash', 'exit=1\nboom')).toBe('command-failed');
    expect(classifyToolResult('run_bash', 'exit=127\nnot found')).toBe('command-failed');
  });

  it('separates a refused shell from a failed one', () => {
    expect(classifyToolResult('run_bash', 'run_bash is disabled (no sandbox).')).toBe('refused');
  });

  it('flags a rolled-back tamper attempt as its own class', () => {
    expect(
      classifyToolResult('run_bash', 'exit=0 [blocked: restored 2 protected file(s) your command modified]'),
    ).toBe('tamper-restored');
  });

  it('attributes tools to the AHE ablation axes', () => {
    expect(componentForTool('edit_file')).toBe('tools');
    expect(componentForTool('edit_range')).toBe('tools');
    expect(componentForTool('run_bash')).toBe('execution');
  });
});

describe('tool-call evidence corpus (harness plan D1/D3)', () => {
  it('records calls and computes edit-tool health', () => {
    const cwd = tempProject();
    recordToolCall({ runId: 'r1', tool: 'edit_file', result: 'OK: edited a.ts (1 replacement)' }, cwd);
    recordToolCall(
      {
        runId: 'r1',
        tool: 'edit_file',
        result: 'OK: edited a.ts (1 replacement) — NOTE: old_string did not match byte-for-byte;',
      },
      cwd,
    );
    recordToolCall({ runId: 'r1', tool: 'edit_file', result: 'ERROR: a.ts: old_string not found.' }, cwd);
    recordToolCall({ runId: 'r1', tool: 'read_file', result: 'contents' }, cwd);

    const s = summarizeToolCalls('r1', cwd);
    expect(s.totalCalls).toBe(4);
    expect(s.failedCalls).toBe(1);
    expect(s.editHealth.attempts).toBe(3);
    expect(s.editHealth.exact).toBe(1);
    expect(s.editHealth.tolerant).toBe(1);
    expect(s.editHealth.misses).toBe(1);
    expect(s.editHealth.successRate).toBeCloseTo(2 / 3, 5);
  });

  it('ranks failure classes and attributes them to components', () => {
    const cwd = tempProject();
    for (let i = 0; i < 3; i++) {
      recordToolCall({ runId: 'r2', tool: 'edit_file', result: 'ERROR: x: old_string not found.' }, cwd);
    }
    recordToolCall({ runId: 'r2', tool: 'run_bash', result: 'exit=1 boom' }, cwd);

    const s = summarizeToolCalls('r2', cwd);
    expect(s.topFailures[0].outcome).toBe('edit-miss');
    expect(s.topFailures[0].count).toBe(3);
    const tools = s.byComponent.find((c) => c.component === 'tools');
    expect(tools?.failures).toBe(3);
  });

  it('scopes a summary to one run', () => {
    const cwd = tempProject();
    recordToolCall({ runId: 'a', tool: 'read_file', result: 'ok' }, cwd);
    recordToolCall({ runId: 'b', tool: 'read_file', result: 'ok' }, cwd);
    expect(summarizeToolCalls('a', cwd).totalCalls).toBe(1);
    expect(summarizeToolCalls(undefined, cwd).totalCalls).toBe(2);
  });

  it('reports honest emptiness rather than inventing a health number', () => {
    const cwd = tempProject();
    const s = summarizeToolCalls(undefined, cwd);
    expect(s.totalCalls).toBe(0);
    expect(s.failureRate).toBe(0);
    expect(renderEvidence(s)).toMatch(/No tool-call evidence/);
  });

  it('renders evidence prose the propose stage can read', () => {
    const cwd = tempProject();
    recordToolCall({ runId: 'r', tool: 'edit_file', result: 'ERROR: x: old_string not found.' }, cwd);
    const text = renderEvidence(summarizeToolCalls('r', cwd));
    expect(text).toMatch(/edit_file\/edit-miss/);
    expect(text).toMatch(/By harness component/);
  });
});
