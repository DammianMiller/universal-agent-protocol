/**
 * `deliveryOutcomeVerdict` / `deliveryRootCauseLine` / `deliveryOutcomeContent`
 * — the [deliver] outcome-memory line. The verdict is what the resume path
 * and the NEXT session read back from memory: a failure lesson without a
 * root cause steers nothing, and the root cause must be sanitized (it is
 * untrusted gate/executor output the bridge mirrors into committed files)
 * and ordered after the task text so the bridge's 140-char mirror keeps
 * verdict + model + task visible.
 */
import { describe, it, expect } from 'vitest';
import {
  deliveryOutcomeContent,
  deliveryOutcomeVerdict,
  deliveryRootCauseLine,
} from '../../src/delivery/task-sync.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';

function result(overrides: Partial<DeliveryResult>): DeliveryResult {
  return {
    success: false,
    alreadyDelivered: false,
    turns: 3,
    bestScore: 0.83,
    bestTurn: 2,
    history: [],
    finalFeedback: '',
    finalOutput: '',
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('deliveryOutcomeVerdict', () => {
  it('keeps the delivered verdict unchanged', () => {
    expect(deliveryOutcomeVerdict(result({ success: true, turns: 4 }))).toBe(
      'delivered in 4 turn(s)',
    );
  });

  it('keeps the already-delivered verdict unchanged', () => {
    expect(
      deliveryOutcomeVerdict(result({ success: true, alreadyDelivered: true, turns: 0 })),
    ).toBe('already delivered (baseline green)');
  });

  it('keeps the stopped verdict resumable and bare', () => {
    expect(
      deliveryOutcomeVerdict(
        result({ stopped: true, turns: 1, bestScore: 0.67, finalFeedback: 'gate x red' }),
      ),
    ).toBe(
      'STOPPED (interrupted, resumable — not a gate failure) after 1 turn(s), best 67% of gates',
    );
  });

  it('keeps the NOT-delivered verdict bare (the cause is a separate segment)', () => {
    expect(
      deliveryOutcomeVerdict(
        result({ turns: 5, bestScore: 0, stallReason: 'stalled: 3 no-op turns' }),
      ),
    ).toBe('NOT delivered after 5 turn(s), best 0% of gates');
  });
});

describe('deliveryRootCauseLine', () => {
  it('is empty for success and stopped runs', () => {
    expect(deliveryRootCauseLine(result({ success: true }))).toBe('');
    expect(deliveryRootCauseLine(result({ stopped: true, finalFeedback: 'x' }))).toBe('');
  });

  it('prefers the stall reason; with both set it never duplicates the feedback copy', () => {
    // convergence-loop prefixes stallReason into finalFeedback, so a both-set
    // result carries the stall text twice; preferring stallReason must keep
    // the lesson free of the duplication.
    const stall = 'no-progress circuit breaker: 3 turns changed nothing';
    const line = deliveryRootCauseLine(
      result({ stallReason: stall, finalFeedback: `${stall} gate build FAILED` }),
    );
    expect(line).toBe(` — root cause: ${stall}`);
    expect(line.match(/circuit breaker/g)).toHaveLength(1);
  });

  it('falls back to the final gate feedback, control-stripped and capped at 240', () => {
    const line = deliveryRootCauseLine(
      result({
        finalFeedback:
          'gate build FAILED\n\u001b[31mred\u001b[0m  tsc: error TS2345 at src/x.ts:12:9\n' +
          'x'.repeat(400),
      }),
    );
    expect(line).toContain('root cause: gate build FAILED red tsc: error TS2345');
    expect(line).not.toContain('\u001b');
    expect(line.length).toBeLessThanOrEqual(' — root cause: '.length + 240);
  });

  it('masks token-shaped secrets before they reach memory', () => {
    const line = deliveryRootCauseLine(
      result({ finalFeedback: 'upstream rejected sk-abcdefghijklmnopqrst1234 at gate models' }),
    );
    expect(line).toContain('root cause: upstream rejected *** at gate models');
  });

  it('is empty when neither stall reason nor feedback exists', () => {
    expect(deliveryRootCauseLine(result({ turns: 5, bestScore: 0 }))).toBe('');
  });
});

describe('deliveryOutcomeContent', () => {
  it('orders the cause after the task so the 140-char bridge mirror keeps model + task', () => {
    const content = deliveryOutcomeContent(
      'Fix security gap in src/delivery/user-validation.ts',
      result({ turns: 17, stallReason: 'no-progress circuit breaker: 3 turns changed nothing' }),
      'qwen35-a3b',
    );
    expect(content).toBe(
      '[deliver] NOT delivered after 17 turn(s), best 83% of gates — model qwen35-a3b — ' +
        'task: Fix security gap in src/delivery/user-validation.ts — root cause: ' +
        'no-progress circuit breaker: 3 turns changed nothing',
    );
    // the memory-bridge mirror truncates at 140 chars; the head must still
    // identify model and task
    expect(content.slice(0, 140)).toContain('model qwen35-a3b');
    expect(content.slice(0, 140)).toContain('task: Fix security gap');
  });
});
