import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  clearToolCallRun,
  closeToolCallStores,
  recordToolCall,
  benchTelemetryDir,
  toolCorpusRoot,
} from '../../src/telemetry/tool-calls.js';
import { ingestDroidSession, parseDroidSession } from '../../src/telemetry/droid-sessions.js';
import { recordLadderRun, summarizeBenchMirror } from '../../src/quality/tier-ladder.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  closeToolCallStores();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal Droid transcript: one session_start, one paired call, one unpaired. */
function sampleTranscript(): string {
  return [
    JSON.stringify({ type: 'session_start', cwd: '/proj/round-6', title: 'Round 6', id: 's1' }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      timestamp: '2026-11-26T01:00:00.000Z',
      seq: 3,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'Execute', input: { command: 'ls', summary: 'List' } },
          { type: 'tool_use', id: 'call_b', name: 'Read', input: { file_path: '/proj/src/x.ts' } },
          { type: 'tool_use', id: 'call_c', name: 'Edit', input: { file_path: '/proj/src/y.ts' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'm2',
      timestamp: '2026-11-26T01:00:02.500Z',
      seq: 4,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'file1\nfile2' },
          {
            type: 'tool_result',
            tool_use_id: 'call_b',
            is_error: true,
            content: [{ type: 'text', text: 'Error: read failed: permission denied' }],
          },
        ],
      },
    }),
    // call_c never gets a result — the session was cut off mid-call.
  ].join('\n');
}

describe('parseDroidSession (wave 6, item 2)', () => {
  it('pairs tool_use with tool_result, maps names, and counts the unpaired tail', () => {
    const s = parseDroidSession(sampleTranscript(), '/x/droid-round.jsonl');
    expect(s.sessionId).toBe('droid-round');
    expect(s.cwd).toBe('/proj/round-6');
    expect(s.title).toBe('Round 6');
    expect(s.toolCalls).toHaveLength(2);
    expect(s.unpaired).toBe(1);

    const [exec, read] = s.toolCalls;
    // Droid tool names land in the corpus name space the failure classes
    // resolve against.
    expect(exec.tool).toBe('run_bash');
    expect(exec.isError).toBe(false);
    expect(exec.latencyMs).toBe(2500);
    expect(exec.turn).toBe(3);
    // An unknown tool name snake-cases instead of vanishing.
    expect(read.tool).toBe('read_file');
    expect(read.inputPath).toBe('/proj/src/x.ts');
    expect(read.isError).toBe(true);
  });

  it('ingests a session into the corpus and is idempotent on re-ingest', () => {
    const root = tempDir('uap-droid-corpus-');
    // Write the transcript where the ingest can read it (outside a corpus dir
    // it would pollute): use a scratch file.
    const scratch = tempDir('uap-droid-src-');
    const src = join(scratch, 'session-abc.jsonl');
    writeFileSync(src, sampleTranscript());

    const first = ingestDroidSession(src, root);
    expect(first.toolCalls).toHaveLength(2);
    // The errored Read call is classified as a failure through the same
    // classifier live traffic uses — 'Error: Command not found' is not an ok.
    expect(first.outcomes['other-error']).toBe(1);
    expect(first.outcomes['ok']).toBe(1);

    const db = new Database(join(root, 'tool-calls.db'), { readonly: true });
    const rows = db
      .prepare('SELECT run_id, task_id, tool, outcome, run_kind FROM tool_calls')
      .all() as Array<{ run_id: string; task_id: string; tool: string; outcome: string; run_kind: string }>;
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.run_id === 'session-abc')).toBe(true);
    // The session's cwd is the attribution a fleet query filters on.
    expect(rows.every((r) => r.task_id === '/proj/round-6')).toBe(true);
    expect(rows.every((r) => r.run_kind === 'live')).toBe(true);

    // Re-ingest REPLACES, never duplicates.
    const second = ingestDroidSession(src, root);
    expect(second.replacedRows).toBe(2);
    const db2 = new Database(join(root, 'tool-calls.db'), { readonly: true });
    const count = db2.prepare('SELECT COUNT(*) c FROM tool_calls').get() as { c: number };
    db2.close();
    expect(count.c).toBe(2);
  });
});

describe('recordToolCall bench attribution (wave 6, item 1)', () => {
  it('attributes rows from bench envs when the record carries no ids', () => {
    vi.stubEnv('UAP_RUN_KIND', 'benchmark');
    vi.stubEnv('UAP_BENCH_RUN_ID', 't1/uap-full#2');
    vi.stubEnv('UAP_BENCH_TASK', 't1');
    try {
      const root = tempDir('uap-bench-attr-');
      recordToolCall({ tool: 'edit_file', result: 'OK: edited x.ts' }, root);
      const db = new Database(join(root, 'tool-calls.db'), { readonly: true });
      const row = db
        .prepare('SELECT run_id, task_id, run_kind FROM tool_calls')
        .get() as { run_id: string; task_id: string; run_kind: string };
      db.close();
      expect(row).toMatchObject({
        run_id: 't1/uap-full#2',
        task_id: 't1',
        run_kind: 'benchmark',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets an explicit record win over the bench env', () => {
    vi.stubEnv('UAP_BENCH_RUN_ID', 'bench-cell');
    vi.stubEnv('UAP_BENCH_TASK', 'bench-task');
    try {
      const root = tempDir('uap-bench-attr-');
      recordToolCall(
        { runId: 'live-run', taskId: 'live-task', tool: 'read_file', result: 'file body' },
        root,
      );
      const db = new Database(join(root, 'tool-calls.db'), { readonly: true });
      const row = db
        .prepare('SELECT run_id, task_id FROM tool_calls')
        .get() as { run_id: string; task_id: string };
      db.close();
      expect(row).toMatchObject({ run_id: 'live-run', task_id: 'live-task' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('clearToolCallRun removes exactly one run, for idempotent re-ingest', () => {
    const root = tempDir('uap-clear-run-');
    recordToolCall({ runId: 'keep', tool: 'read_file', result: 'a' }, root);
    recordToolCall({ runId: 'drop', tool: 'read_file', result: 'b' }, root);
    recordToolCall({ runId: 'drop', tool: 'read_file', result: 'c' }, root);
    expect(clearToolCallRun('drop', root)).toBe(2);
    expect(clearToolCallRun('drop', root)).toBe(0); // gone
    const db = new Database(join(root, 'tool-calls.db'), { readonly: true });
    const kept = db.prepare('SELECT COUNT(*) c FROM tool_calls').get() as { c: number };
    db.close();
    expect(kept.c).toBe(1);
  });
});

describe('ladder-run home mirror (wave 6, item 1)', () => {
  it('mirrors recorded runs to the env-designated dir, stamped with their origin', () => {
    const projectRoot = tempDir('uap-mirror-proj-');
    const mirrorDir = tempDir('uap-mirror-home-');
    vi.stubEnv('UAP_QUALITY_LOG_MIRROR', mirrorDir);
    try {
      recordLadderRun(projectRoot, {
        tier: 'visual/pagoda-v2',
        outcome: 'tier-reached',
        rounds: 3,
        candidatesMeasured: 9,
        winnerPassed: true,
        escalationFired: false,
        model: 'inkling-2-mini',
        meanDivergence: 0.4,
      });
      // The project-local log still exists — the mirror is ADDITIVE.
      expect(existsSync(join(projectRoot, '.uap', 'quality', 'convergence.jsonl'))).toBe(true);

      const mirrorFile = join(mirrorDir, 'convergence-mirror.jsonl');
      expect(existsSync(mirrorFile)).toBe(true);
      const line = JSON.parse(readFileSync(mirrorFile, 'utf-8').trim()) as Record<string, unknown>;
      expect(line.tier).toBe('visual/pagoda-v2');
      expect(line.projectRoot).toBe(projectRoot);

      const { totalRuns, summaries } = summarizeBenchMirror(mirrorDir);
      expect(totalRuns).toBe(1);
      expect(summaries[0]?.tierReached).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('summarizeBenchMirror reads zero runs from an absent mirror without error', () => {
    const empty = summarizeBenchMirror(tempDir('uap-mirror-empty-'));
    expect(empty.totalRuns).toBe(0);
    expect(empty.summaries).toHaveLength(0);
  });

  it('benchTelemetryDir sits under the corpus root and follows its env override', () => {
    // The vitest setup pins UAP_TOOL_CORPUS_DIR to a per-pid temp dir, so the
    // relation is the assertion — not a literal home path.
    expect(benchTelemetryDir()).toBe(join(toolCorpusRoot(), 'bench'));
    vi.stubEnv('UAP_TOOL_CORPUS_DIR', '/tmp/uap-corpus-override');
    try {
      expect(benchTelemetryDir()).toBe(join('/tmp/uap-corpus-override', 'bench'));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
