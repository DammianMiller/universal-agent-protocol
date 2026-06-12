import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHaloDeliveryTracer } from '../../src/delivery/halo-trace.js';
import { _resetHaloSession } from '../../src/observability/halo-exporter.js';
import type { DeliveryResult, IterationRecord } from '../../src/delivery/convergence-loop.js';

const RECORD: IterationRecord = {
  turn: 2,
  passed: false,
  score: 0.5,
  gateResults: [
    { id: 'build', name: 'Build', passed: true, skipped: false, exitCode: 0, durationMs: 10, outputTail: '' },
    { id: 'test', name: 'Tests', passed: false, skipped: false, exitCode: 1, durationMs: 20, outputTail: 'fail' },
  ],
  filesApplied: ['src/a.ts'],
  strategy: 'test-first',
  durationMs: 1234,
};

const RESULT: DeliveryResult = {
  success: true,
  alreadyDelivered: false,
  turns: 2,
  bestScore: 1,
  bestTurn: 2,
  history: [RECORD],
  finalFeedback: '',
  finalOutput: '',
  totalDurationMs: 5000,
};

describe('createHaloDeliveryTracer', () => {
  let dir: string;
  let tracePath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-trace-'));
    tracePath = join(dir, 'traces.jsonl');
    process.env.UAP_HALO_TRACE = '1';
    process.env.UAP_HALO_TRACE_PATH = tracePath;
    _resetHaloSession();
  });

  afterEach(() => {
    process.env.UAP_HALO_TRACE = savedEnv.UAP_HALO_TRACE;
    process.env.UAP_HALO_TRACE_PATH = savedEnv.UAP_HALO_TRACE_PATH;
    if (savedEnv.UAP_HALO_TRACE === undefined) delete process.env.UAP_HALO_TRACE;
    if (savedEnv.UAP_HALO_TRACE_PATH === undefined) delete process.env.UAP_HALO_TRACE_PATH;
    rmSync(dir, { recursive: true, force: true });
    _resetHaloSession();
  });

  function readSpans(): Array<Record<string, any>> {
    return readFileSync(tracePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it('emits a CHAIN span per turn parented to the run span', () => {
    const tracer = createHaloDeliveryTracer({
      instruction: 'do the thing',
      modelId: 'test-model',
      projectRoot: '/tmp/project',
    });
    tracer.onIteration(RECORD);
    tracer.finish(RESULT);

    const spans = readSpans();
    expect(spans).toHaveLength(2);

    const [turnSpan, runSpan] = spans;
    expect(turnSpan.name).toBe('delivery.turn.2');
    expect(turnSpan.attributes['inference.observation_kind']).toBe('CHAIN');
    expect(turnSpan.attributes['delivery.score']).toBe(0.5);
    expect(turnSpan.attributes['delivery.strategy']).toBe('test-first');
    expect(turnSpan.attributes['delivery.gates_failed']).toBe('test');
    expect(turnSpan.status.code).toBe('STATUS_CODE_ERROR');
    expect(turnSpan.parent_span_id).toBe(runSpan.span_id);
  });

  it('emits a run-level AGENT span with outcome attributes', () => {
    const tracer = createHaloDeliveryTracer({
      instruction: 'do the thing',
      modelId: 'test-model',
      projectRoot: '/tmp/project',
    });
    tracer.finish(RESULT);

    const [runSpan] = readSpans();
    expect(runSpan.name).toBe('agent.deliver');
    expect(runSpan.attributes['inference.observation_kind']).toBe('AGENT');
    expect(runSpan.attributes['delivery.model']).toBe('test-model');
    expect(runSpan.attributes['delivery.turns']).toBe(2);
    expect(runSpan.attributes['delivery.best_score']).toBe(1);
    expect(runSpan.status.code).toBe('STATUS_CODE_OK');
  });

  it('is a no-op when HALO tracing is disabled', () => {
    delete process.env.UAP_HALO_TRACE;
    const tracer = createHaloDeliveryTracer({
      instruction: 'x',
      modelId: 'm',
      projectRoot: '/tmp',
    });
    tracer.onIteration(RECORD);
    tracer.finish(RESULT);
    expect(existsSync(tracePath)).toBe(false);
  });
});
