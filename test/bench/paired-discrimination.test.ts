import { describe, it, expect } from 'vitest';
import { analyze, assessDiscrimination } from '../../src/benchmarks/paired/report.js';
import type { RunRecord } from '../../src/benchmarks/paired/types.js';

/**
 * Build a grid where each condition hits a target success rate, so a report can
 * be shaped like a real run without a model.
 */
function records(
  rates: Record<string, number>,
  tasks = 5,
  epochs = 3,
  tokensBy: Record<string, number> = {}
): RunRecord[] {
  const out: RunRecord[] = [];
  for (const [label, rate] of Object.entries(rates)) {
    const cells = tasks * epochs;
    let i = 0;
    for (let t = 0; t < tasks; t++) {
      for (let s = 0; s < epochs; s++) {
        out.push({
          taskId: `t${t}`,
          seed: s,
          condition: label,
          adapter: 'raw',
          model: 'm',
          metrics: {
            correct: i < Math.round(rate * cells),
            error: null,
            turns: 1,
            tokens: tokensBy[label] ?? 100,
            costUsd: null,
            toolCalls: null,
            latencyMs: 1,
            wellFormed: true,
          },
        } as RunRecord);
        i++;
      }
    }
  }
  return out;
}

function report(
  rates: Record<string, number>,
  tasks = 5,
  epochs = 3,
  tokensBy: Record<string, number> = {}
) {
  return analyze(
    {
      records: records(rates, tasks, epochs, tokensBy),
      model: 'm',
      adapter: 'raw',
      epochs,
      startedAt: '',
      finishedAt: '',
    },
    { seed: 1, iterations: 500 }
  );
}

describe('discrimination verdict — "no measurement" is not "no effect"', () => {
  it('flags a CEILING suite where every arm solves everything', () => {
    // The real case: `real-gate` scored 100%/100%, and the report said
    // `delta=+0.000, significant=false` — which reads as a null result.
    const d = report({ baseline: 1.0, 'uap-full': 1.0 }).discrimination;
    expect(d.status).toBe('ceiling');
    expect(d.usable).toBe(false);
    expect(d.reason).toMatch(/too easy/);
  });

  it('flags a FLOOR run where nothing was solved', () => {
    // The real case: the mock-only `smoke` suite run against a real model —
    // every cell aborted, both arms 0%, delta +0.000.
    const d = report({ baseline: 0, 'uap-full': 0 }).discrimination;
    expect(d.status).toBe('floor');
    expect(d.usable).toBe(false);
    expect(d.reason).toMatch(/misconfigured|too hard/);
  });

  it('accepts a suite with real headroom', () => {
    const d = report({ baseline: 0.3, 'uap-full': 0.65 }, 10, 6).discrimination;
    expect(d.status).toBe('ok');
    expect(d.usable).toBe(true);
    expect(d.discordantPairs).toBeGreaterThan(0);
  });

  it('never calls a SIGNIFICANT result underpowered, however wide its tail', () => {
    // A half-width rule refused this: 35pp at n=15 carries CI [0.07, 0.60],
    // half-width 0.27 — a proven win thrown away for having a long right tail.
    // Inconclusiveness is "the interval admits both zero and the effect", and a
    // significant interval excludes zero by definition.
    const r = report({ baseline: 0.3, 'uap-full': 0.65 }, 5, 3);
    expect(r.comparisons[0].correctness.delta.significant).toBe(true);
    expect(r.discrimination.status).toBe('ok');
  });

  it('flags ZERO DISCORDANT PAIRS even when the arms are mid-range', () => {
    // The case that motivated rebuilding this check: two real runs scored
    // 11%/11% and 33%/33% with every paired cell identical. A bootstrap over an
    // all-zero delta vector returns CI [0.000, 0.000] — which reads as
    // "conclusively no effect" and is actually zero information.
    const d = report({ baseline: 0.4, 'uap-full': 0.4 }).discrimination;
    expect(d.status).toBe('no-discordant-pairs');
    expect(d.usable).toBe(false);
    expect(d.discordantPairs).toBe(0);
    expect(d.reason).toMatch(/LOOKS conclusive/);
  });

  it('flags an interval that admits both zero and the effect worth having', () => {
    const r = report({ baseline: 0.93, 'uap-full': 1.0 });
    expect(r.discrimination.status).toBe('underpowered');
    expect(r.discrimination.reason).toMatch(/contains both zero/);
  });

  it('refuses a near-ceiling suite resting on a single discordant pair', () => {
    // 93%/100% over 15 cells is one flipped cell. The interval spans both zero
    // and the effect worth having, so it cannot support either conclusion.
    const d = report({ baseline: 0.93, 'uap-full': 1.0 }).discrimination;
    expect(d.status).toBe('underpowered');
    expect(d.discordantPairs).toBe(1);
  });

  it('flags an UNDERPOWERED run before its delta is read', () => {
    // 2 tasks x 2 epochs = 4 paired cells: not enough to tell an effect from noise.
    const d = report({ baseline: 0.5, 'uap-full': 1.0 }, 2, 2).discrimination;
    expect(d.status).toBe('underpowered');
    expect(d.usable).toBe(false);
  });

  it('prefers the DIAGNOSTIC name over the generic symptom', () => {
    // A ceiling run also has zero discordant pairs; "ceiling" tells the operator
    // what to change, "no-discordant-pairs" does not.
    expect(report({ baseline: 1.0, 'uap-full': 1.0 }).discrimination.status).toBe('ceiling');
    expect(report({ baseline: 0, 'uap-full': 0 }).discrimination.status).toBe('floor');
  });

  it('reports the observed span, cells and discordant count either way', () => {
    const d = report({ baseline: 0.2, 'uap-full': 0.8 }).discrimination;
    expect(d.minSuccess).toBeCloseTo(0.2, 5);
    expect(d.maxSuccess).toBeCloseTo(0.8, 5);
    expect(d.pairedCells).toBe(15);
    expect(d.discordantPairs).toBeGreaterThan(0);
  });

  it('honours caller thresholds', () => {
    const strict = report({ baseline: 0.93, 'uap-full': 0.95 });
    expect(
      assessDiscrimination(strict.perCondition, strict.comparisons, { ceilingAt: 0.9 }).status
    ).toBe('ceiling');
  });

  it('refuses a report with no treatment arm rather than passing it', () => {
    // "usable" on a report with nothing to compare is the false-confidence shape
    // this whole check exists to prevent.
    const d = assessDiscrimination([], []);
    expect(d.status).toBe('no-comparisons');
    expect(d.usable).toBe(false);
    expect(d.pairedCells).toBe(0);
  });

  it('judges the PRIMARY comparison, not an aggregate over ablation arms', () => {
    // An --ablation run has 6 comparisons. Summing discordance let one noisy
    // leave-one-out arm mask a null primary; taking the widest CI let it refuse
    // a tight one. Here the primary is null and a secondary arm is not.
    const r = report({ baseline: 0.4, 'uap-full': 0.4, 'no-memory': 0.9 }, 10, 6);
    expect(r.comparisons[0].label).toBe('uap-full');
    expect(r.discrimination.status).toBe('no-discordant-pairs');
    expect(r.discrimination.usable).toBe(false);
  });
});

describe('the warning reaches the rendered report', () => {
  it('puts NO USABLE SIGNAL above the numbers, not in a footnote', async () => {
    const { renderMarkdown } = await import('../../src/benchmarks/paired/report.js');
    const md = renderMarkdown(report({ baseline: 1.0, 'uap-full': 1.0 }));
    expect(md).toMatch(/NO USABLE SIGNAL/);
    expect(md).toMatch(/Do not cite them/);
    // Ahead of the per-condition table a reader would otherwise quote from.
    expect(md.indexOf('NO USABLE SIGNAL')).toBeLessThan(md.indexOf('Per-condition summary'));
  });

  it('states the signal check on a usable run too', async () => {
    const { renderMarkdown } = await import('../../src/benchmarks/paired/report.js');
    const md = renderMarkdown(report({ baseline: 0.3, 'uap-full': 0.65 }, 10, 6));
    expect(md).toMatch(/Signal check:/);
    expect(md).not.toMatch(/NO USABLE SIGNAL/);
  });
});


describe('efficiency results survive a correctness ceiling', () => {
  it('does not call a token win "not evidence of anything"', () => {
    // The canonical UAP result: identical correctness, materially fewer tokens.
    // Judging the whole run on correctness discordance refused it — and printed
    // "not evidence of anything" directly above a token table reading WIN.
    const r = report({ baseline: 1.0, 'uap-full': 1.0 }, 10, 6, {
      baseline: 3000,
      'uap-full': 1800,
    });
    expect(r.discrimination.usable).toBe(false); // correctness: genuinely nothing
    expect(r.discrimination.efficiencyUsable).toBe(true); // tokens: a real result
  });

  it('says so in the report instead of blanket-refusing it', async () => {
    const { renderMarkdown } = await import('../../src/benchmarks/paired/report.js');
    const md = renderMarkdown(
      report({ baseline: 1.0, 'uap-full': 1.0 }, 10, 6, { baseline: 3000, 'uap-full': 1800 })
    );
    expect(md).toMatch(/NO CORRECTNESS SIGNAL/);
    expect(md).toMatch(/The efficiency deltas are/);
    expect(md).not.toMatch(/Do not cite them/);
  });

  it('still refuses everything when nothing at all was measured', () => {
    const r = report({ baseline: 1.0, 'uap-full': 1.0 }, 10, 6); // identical tokens
    expect(r.discrimination.efficiencyUsable).toBe(false);
  });
});
