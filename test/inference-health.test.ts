import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  analyzeCheckpoints,
  analyzeTrend,
  assessInference,
  sizeBucket,
  type PrefillSample,
} from '../src/inference/analysis.js';
import {
  collect,
  parseExecStartFlags,
  parseMetrics,
  parseServerJournal,
  parseSystemdTimestamp,
} from '../src/inference/probe.js';

/**
 * These tests are anchored to a real incident (2026-09-21): an inference
 * server that reported `active (running)` and GREEN from `uap doctor` for 18
 * hours while its prefill throughput fell ~8x and five client requests blew a
 * 1800s deadline. Nothing was down, so liveness checks saw nothing.
 */

const sample = (at: number, tokens: number, tps: number): PrefillSample => ({
  at,
  tokens,
  tokensPerSecond: tps,
});

describe('sizeBucket', () => {
  it('separates the ranges prefill throughput actually differs across', () => {
    expect(sizeBucket(900)).toBe('<5k');
    expect(sizeBucket(9_000)).toBe('5-15k');
    expect(sizeBucket(20_000)).toBe('15-30k');
    expect(sizeBucket(40_000)).toBe('>30k');
  });
});

describe('analyzeTrend — must compare like with like', () => {
  it('detects decay within a single size bucket', () => {
    const early = Array.from({ length: 6 }, (_, i) => sample(1_000 + i, 20_000, 600));
    const late = Array.from({ length: 6 }, (_, i) => sample(9_000 + i, 20_000, 80));
    const t = analyzeTrend([...early, ...late]);
    expect(t.bucket).toBe('15-30k');
    expect(t.ratio).toBeCloseTo(80 / 600, 3);
  });

  it('is NOT fooled by prompt sizes drifting over time', () => {
    // The trap this function exists for: conversations grow, so later prompts
    // are bigger, and a naive mean moves even when the server is unchanged.
    // Same 600 tok/s throughout; only the sizes differ.
    const early = Array.from({ length: 6 }, (_, i) => sample(1_000 + i, 6_000, 600));
    const late = Array.from({ length: 6 }, (_, i) => sample(9_000 + i, 40_000, 600));
    const t = analyzeTrend([...early, ...late]);
    // No bucket has samples on both sides, so it must refuse to judge rather
    // than report a phantom change.
    expect(t.ratio).toBeUndefined();
    expect(t.note).toMatch(/bucket/i);
  });

  it('refuses a verdict on too few samples', () => {
    const t = analyzeTrend([sample(1, 20_000, 600), sample(2, 20_000, 80)]);
    expect(t.ratio).toBeUndefined();
    expect(t.note).toMatch(/not enough/i);
  });

  it('reports the WORST bucket, not the one with the most samples', () => {
    // An earlier version ranked by sample count, so this exact input reported
    // the mild 15-30k drop and emitted NO finding at all while a thin bucket
    // had collapsed 10x. On a real 30h journal it reported >30k at 0.522
    // (WARN) while 5-15k sat at 0.289 (RED) — understating severity and
    // flipping the remedy from "restart" to "watch it".
    const rows = [
      // thin bucket, 10x collapse
      ...Array.from({ length: 4 }, (_, i) => sample(1_000 + i, 6_000, 900)),
      ...Array.from({ length: 4 }, (_, i) => sample(9_000 + i, 6_000, 90)),
      // fat bucket, mild drop
      ...Array.from({ length: 20 }, (_, i) => sample(1_100 + i, 20_000, 600)),
      ...Array.from({ length: 20 }, (_, i) => sample(9_100 + i, 20_000, 500)),
    ];
    const t = analyzeTrend(rows);
    expect(t.bucket).toBe('5-15k');
    expect(t.ratio).toBeCloseTo(0.1, 2);
    const r = assessInference({ prefill: rows, checkpoints: [] });
    expect(r.findings.find((f) => f.code === 'prefill-decay')?.health).toBe('RED');
  });

  it('keeps every qualifying bucket so nothing is silently dropped', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => sample(1_000 + i, 6_000, 900)),
      ...Array.from({ length: 5 }, (_, i) => sample(9_000 + i, 6_000, 300)),
      ...Array.from({ length: 5 }, (_, i) => sample(1_100 + i, 20_000, 600)),
      ...Array.from({ length: 5 }, (_, i) => sample(9_100 + i, 20_000, 500)),
    ];
    const t = analyzeTrend(rows);
    expect(t.buckets?.map((b) => b.bucket)).toEqual(['5-15k', '15-30k']); // worst first
    // And the headline finding names the others rather than hiding them.
    const msg = assessInference({ prefill: rows, checkpoints: [] }).findings
      .find((f) => f.code === 'prefill-decay')!.message;
    expect(msg).toMatch(/also down in 15-30k/);
  });

  it('ignores NaN throughput rather than producing a NaN ratio', () => {
    // A NaN sample made recentMean NaN; NaN !== undefined so the decay branch
    // ran, both threshold comparisons were false, and the CLI printed
    // "NaN -> NaN tok/s" while --json emitted a null indistinguishable from
    // "no data".
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => sample(1_000 + i, 20_000, 600)),
      ...Array.from({ length: 6 }, (_, i) => sample(9_000 + i, 20_000, 100)),
      sample(9_500, 20_000, Number.NaN),
    ];
    const t = analyzeTrend(rows);
    // Assert the PROPERTY (a NaN sample cannot poison the result), not an
    // exact figure — an exact one encodes the split's arithmetic and breaks
    // whenever the split changes, which says nothing about NaN handling.
    expect(Number.isFinite(t.ratio!)).toBe(true);
    expect(t.ratio!).toBeCloseTo(100 / 600, 2);
    // the NaN row is dropped, not counted into either era
    expect(t.earlyCount + t.recentCount).toBe(12);
  });

  it('gives a note, never a silent blank, when the early era is all zeros', () => {
    // Previously `best` was set but `ratio` was undefined AND `note` absent,
    // so the CLI printed nothing at all on the prefill line.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => sample(1_000 + i, 20_000, 0)),
      ...Array.from({ length: 5 }, (_, i) => sample(9_000 + i, 20_000, 500)),
    ];
    const t = analyzeTrend(rows);
    expect(t.ratio).toBeUndefined();
    expect(t.note).toBeTruthy();
  });

  it('analyses a bucket whose samples are SKEWED IN TIME', () => {
    // The defect this fixes, taken from a live 6h journal. Agent conversations
    // grow, so large prompts arrive late; splitting every sample at the GLOBAL
    // median then left that bucket with 2 early / 21 recent and the
    // minSamplesPerEra guard dropped it entirely.
    //
    //   <5k     41 early / 17 recent  -> reported 0.78 (mild)
    //   15-30k   2 early / 21 recent  -> EXCLUDED
    //
    // The excluded bucket had gone 616 -> 73 tok/s. An 8x collapse, invisible,
    // while the report showed a benign 0.78 and emitted no finding at all.
    // Modelled on the bucket's OWN chronology, which is what the fix reads:
    // large prompts appear only in the back half of wall-clock time, and
    // within that span they decay 610 -> 73. Under the global split every one
    // of them lands in the "recent" half, the early era is empty, and the
    // whole bucket is dropped.
    const rows: PrefillSample[] = [
      ...Array.from({ length: 41 }, (_, i) => sample(1_000 + i, 3_000, 310)),
      ...Array.from({ length: 17 }, (_, i) => sample(5_000 + i, 3_000, 242)),
      ...Array.from({ length: 11 }, (_, i) => sample(9_000 + i, 20_000, 610)),
      ...Array.from({ length: 12 }, (_, i) => sample(9_500 + i, 20_000, 73)),
    ];
    const t = analyzeTrend(rows);
    expect(t.bucket).toBe('15-30k');
    expect(t.ratio!).toBeLessThan(0.35);
    // and it must actually FIRE, not just be measured
    const f = assessInference({ prefill: rows, checkpoints: [] }).findings.find(
      (x) => x.code === 'prefill-decay',
    );
    expect(f?.health).toBe('RED');
  });

  it('splits each bucket on its own clock, not the global one', () => {
    // A bucket entirely inside the second half of wall-clock time still has a
    // first and second half OF ITS OWN, which is what "did this get slower"
    // means for that prompt size.
    const rows: PrefillSample[] = [
      ...Array.from({ length: 10 }, (_, i) => sample(1_000 + i, 3_000, 500)),
      ...Array.from({ length: 5 }, (_, i) => sample(8_000 + i, 20_000, 600)),
      ...Array.from({ length: 5 }, (_, i) => sample(9_000 + i, 20_000, 150)),
    ];
    const t = analyzeTrend(rows);
    const big = t.buckets?.find((b) => b.bucket === '15-30k');
    expect(big).toBeDefined();
    expect(big!.earlyCount).toBe(5);
    expect(big!.recentCount).toBe(5);
    expect(big!.ratio).toBeCloseTo(150 / 600, 2);
  });

  it('still refuses a bucket with too few samples to split at all', () => {
    // Per-bucket splitting must not become "judge anything": a bucket needs
    // minSamplesPerEra on BOTH sides of its own median.
    const rows: PrefillSample[] = [
      ...Array.from({ length: 10 }, (_, i) => sample(1_000 + i, 3_000, 500)),
      ...Array.from({ length: 10 }, (_, i) => sample(9_000 + i, 3_000, 400)),
      // only 3 samples — cannot make two eras of 4
      ...Array.from({ length: 3 }, (_, i) => sample(5_000 + i, 20_000, 40)),
    ];
    const t = analyzeTrend(rows);
    expect(t.buckets?.map((b) => b.bucket)).not.toContain('15-30k');
    expect(t.bucket).toBe('<5k');
  });

  it('reports improvement as a ratio above 1, not as a fault', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => sample(1_000 + i, 20_000, 100)),
      ...Array.from({ length: 5 }, (_, i) => sample(9_000 + i, 20_000, 700)),
    ];
    expect(analyzeTrend(rows).ratio!).toBeGreaterThan(1);
  });
});

describe('analyzeCheckpoints', () => {
  it('measures how much of the reusable prefix is actually restored', () => {
    // The real shape: 43,528 reusable, restored only 11,903.
    const r = analyzeCheckpoints([{ incoming: 44_039, reusable: 43_528, restored: 11_903 }]);
    expect(r.recovery).toBeCloseTo(11_903 / 43_528, 3);
    expect(r.wastedTokens).toBeCloseTo(43_528 - 11_903, 0);
  });

  it('ignores turns with nothing reusable (a genuinely fresh prompt)', () => {
    expect(analyzeCheckpoints([{ incoming: 20_000, reusable: 0, restored: 0 }]).samples).toBe(0);
  });

  it('never reports recovery above 100%', () => {
    const r = analyzeCheckpoints([{ incoming: 100, reusable: 50, restored: 80 }]);
    expect(r.recovery).toBe(1);
    expect(r.wastedTokens).toBe(0);
  });
});

describe('assessInference — the incident it was written for', () => {
  const degraded = {
    rails: 2,
    poolCells: 229_376,
    ctxCheckpoints: 1,
    kvBitsPerValue: 4.21875,
    kvFloorBitsPerValue: 4.125,
    generationTimeouts: 5,
    prefill: [
      ...Array.from({ length: 6 }, (_, i) => sample(1_000 + i, 20_000, 620)),
      ...Array.from({ length: 6 }, (_, i) => sample(9_000 + i, 20_000, 80)),
    ],
    checkpoints: [{ incoming: 44_039, reusable: 43_528, restored: 11_903 }],
  };

  it('is RED overall', () => {
    expect(assessInference(degraded).health).toBe('RED');
  });

  it('names all three underlying problems, not just the visible symptom', () => {
    const codes = assessInference(degraded).findings.map((f) => f.code);
    expect(codes).toContain('prefill-decay');
    expect(codes).toContain('checkpoint-starved');
    expect(codes).toContain('kv-at-floor');
    expect(codes).toContain('generation-timeouts');
  });

  it('points at --ctx-checkpoints when it is the low value causing starvation', () => {
    const f = assessInference(degraded).findings.find((x) => x.code === 'checkpoint-starved');
    expect(f!.remedy).toMatch(/--ctx-checkpoints/);
    expect(f!.remedy).toMatch(/per SLOT/);
  });

  it('refuses to raise the deadline as the remedy for timeouts', () => {
    const f = assessInference(degraded).findings.find((x) => x.code === 'generation-timeouts');
    expect(f!.remedy).toMatch(/fix the cause/i);
  });

  it('goes GREEN once the same stack is healthy', () => {
    const healthy = {
      ...degraded,
      ctxCheckpoints: 4,
      kvBitsPerValue: 8.125,
      generationTimeouts: 0,
      prefill: [
        ...Array.from({ length: 6 }, (_, i) => sample(1_000 + i, 20_000, 700)),
        ...Array.from({ length: 6 }, (_, i) => sample(9_000 + i, 20_000, 760)),
      ],
      checkpoints: [{ incoming: 44_039, reusable: 43_528, restored: 43_000 }],
    };
    expect(assessInference(healthy).health).toBe('GREEN');
  });

  it('says UNKNOWN rather than GREEN when it has no evidence at all', () => {
    // A fabricated GREEN is the failure mode that let the real incident run
    // for 18 hours.
    expect(assessInference({ prefill: [], checkpoints: [] }).health).toBe('UNKNOWN');
  });

  it('never masks an actionable finding behind an UNKNOWN rollup', () => {
    // Timeouts are counted from the PROXY journal, so they can fire with none
    // of the sampled signals (trend/checkpoints/KV) present. An earlier
    // version returned UNKNOWN there, and since --strict keys on the rollup,
    // a RED finding exited 0 — silently passing the gate it exists to fail.
    const r = assessInference({ prefill: [], checkpoints: [], generationTimeouts: 5 });
    expect(r.findings.some((f) => f.health === 'RED')).toBe(true);
    expect(r.health).toBe('RED');
  });

  it('does not flag KV that is comfortably above the floor', () => {
    const codes = assessInference({
      ...degraded,
      kvBitsPerValue: 8.125,
      kvFloorBitsPerValue: 4.125,
    }).findings.map((f) => f.code);
    expect(codes).not.toContain('kv-at-floor');
  });

  it('escalates decay from WARN to RED as it worsens', () => {
    const mk = (recent: number) => ({
      prefill: [
        ...Array.from({ length: 6 }, (_, i) => sample(1_000 + i, 20_000, 600)),
        ...Array.from({ length: 6 }, (_, i) => sample(9_000 + i, 20_000, recent)),
      ],
      checkpoints: [],
    });
    const warn = assessInference(mk(330)).findings.find((f) => f.code === 'prefill-decay');
    const red = assessInference(mk(80)).findings.find((f) => f.code === 'prefill-decay');
    expect(warn!.health).toBe('WARN');
    expect(red!.health).toBe('RED');
  });
});

describe('journal parsing — pinned to the real log format', () => {
  // Verbatim line shapes taken from the incident.
  const LOG = [
    'Sep 21 09:01:28 host llama-server[355739]: 1054.35 I slot print_timing: id  0 | task 471647 | prompt eval time =  352858.83 ms / 27972 tokens (   12.61 ms per token,    79.27 tokens per second)',
    'Sep 21 09:01:42 host llama-server[355739]: 1054.49 I slot   operator(): id  0 | task 473365 | edit/divergence sample (cached/incoming/lcp/reusable/rewind/append/cache_prompt) = (47654/44039/43528/43528/412/511/1)',
    'Sep 21 09:01:42 host llama-server[355739]: 1054.49 W slot   operator(): id  0 | task 473365 | restored context checkpoint (pos_min = 11902, pos_max = 11902, n_tokens = 11903, n_past = 11903, size = 149.626 MiB)',
    'Sep 21 09:10:38 host llama-server[355739]: 1063.45 I slot print_timing: id  0 | task 473365 | prompt eval time =  380222.86 ms / 30429 tokens (   12.50 ms per token,    80.03 tokens per second)',
  ].join('\n');

  it('extracts prefill tokens and throughput', () => {
    const { prefill } = parseServerJournal(LOG, 2026);
    expect(prefill).toHaveLength(2);
    expect(prefill[0]).toMatchObject({ tokens: 27_972, tokensPerSecond: 79.27 });
    expect(prefill[1]).toMatchObject({ tokens: 30_429, tokensPerSecond: 80.03 });
  });

  it('pairs a divergence sample with the restore that followed it', () => {
    const { checkpoints } = parseServerJournal(LOG, 2026);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toEqual({ incoming: 44_039, reusable: 43_528, restored: 11_903 });
  });

  it('records restored=0 when a turn restored nothing at all', () => {
    // Starvation looks like a divergence line with no restore before the next
    // one. Dropping those would hide the worst case.
    const noRestore = [
      'Sep 21 09:01:42 host llama-server[1]: 1 I x: edit/divergence sample (cached/incoming/lcp/reusable/rewind/append/cache_prompt) = (100/90/80/80/0/0/1)',
      'Sep 21 09:02:42 host llama-server[1]: 1 I x: edit/divergence sample (cached/incoming/lcp/reusable/rewind/append/cache_prompt) = (200/190/180/180/0/0/1)',
    ].join('\n');
    const { checkpoints } = parseServerJournal(noRestore, 2026);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].restored).toBe(0);
    expect(checkpoints[1].restored).toBe(0);
  });

  it('does not mis-pair across interleaved slots', () => {
    // With -np > 1 both slots write to the SAME journal and their lines DO
    // interleave (confirmed: 9,270 `id 0` and 9,241 `id 1` lines in one real
    // window). This specific ordering — D(task A), D(task B), R(task A) — was
    // not observed there, where restores followed their own divergence within
    // two lines, so the fixture is constructed rather than captured. It is
    // still reachable whenever a restore is delayed, and a slot-blind parser
    // would pair slot 0's restore with slot 1's divergence, getting BOTH
    // turns wrong.
    const interleaved = [
      'Sep 20 15:33:24 h llama-server[1]: 6.31 I slot operator(): id  0 | task 766 | edit/divergence sample (cached/incoming/lcp/reusable/rewind/append/cache_prompt) = (21596/21810/20877/20877/719/933/1)',
      'Sep 20 15:35:14 h llama-server[1]: 8.22 I slot operator(): id  1 | task 2458 | edit/divergence sample (cached/incoming/lcp/reusable/rewind/append/cache_prompt) = (2944/30860/41/41/2903/30819/1)',
      'Sep 20 15:35:20 h llama-server[1]: 8.28 W slot operator(): id  0 | task 766 | restored context checkpoint (pos_min = 19849, pos_max = 19849, n_tokens = 19850, n_past = 19850, size = 149.626 MiB)',
    ].join('\n');
    const { checkpoints } = parseServerJournal(interleaved, 2026);

    const slot0 = checkpoints.find((c) => c.incoming === 21_810);
    const slot1 = checkpoints.find((c) => c.incoming === 30_860);
    expect(slot0).toEqual({ incoming: 21_810, reusable: 20_877, restored: 19_850 });
    // Slot 1's turn never restored anything; it must not inherit slot 0's.
    expect(slot1).toEqual({ incoming: 30_860, reusable: 41, restored: 0 });
  });

  it('gives prefill samples increasing timestamps so the trend can order them', () => {
    const { prefill } = parseServerJournal(LOG, 2026);
    expect(prefill[1].at).toBeGreaterThan(prefill[0].at);
  });

  it('returns empty rather than throwing on unrelated text', () => {
    const r = parseServerJournal('no interesting lines here\n', 2026);
    expect(r.prefill).toEqual([]);
    expect(r.checkpoints).toEqual([]);
  });
});

describe('flag and timestamp parsing', () => {
  const EXEC =
    '{ path=/x/llama-server ; argv[]=/x/llama-server -m m.gguf -ngl 99 -fa on ' +
    '-c 229376 -np 2 -ub 1024 --ctx-checkpoints 4 --cache-ram 32768 }';

  it('reads rails, pool and checkpoints out of a systemd ExecStart', () => {
    expect(parseExecStartFlags(EXEC)).toEqual({
      rails: 2,
      poolCells: 229_376,
      ctxCheckpoints: 4,
    });
  });

  it('accepts the short -ctxcp spelling', () => {
    expect(parseExecStartFlags('-ctxcp 6').ctxCheckpoints).toBe(6);
  });

  it('leaves flags undefined when absent rather than defaulting them', () => {
    expect(parseExecStartFlags('-m model.gguf')).toEqual({
      rails: undefined,
      poolCells: undefined,
      ctxCheckpoints: undefined,
    });
  });

  it("parses systemd's weekday+zone timestamp, which Date.parse rejects", () => {
    expect(Number.isNaN(Date.parse('Mon 2026-09-21 09:54:00 AEST'))).toBe(true);
    expect(parseSystemdTimestamp('Mon 2026-09-21 09:54:00 AEST')).toBe(
      Date.parse('2026-09-21T09:54:00'),
    );
  });

  it('returns NaN for an unparseable timestamp so uptime reads "unknown"', () => {
    expect(Number.isNaN(parseSystemdTimestamp('n/a'))).toBe(true);
    expect(Number.isNaN(parseSystemdTimestamp(undefined))).toBe(true);
  });

  it('parses the llama.cpp metrics we act on', () => {
    const m = parseMetrics(
      ['llamacpp:prompt_tokens_total 8.98924e+06', 'llamacpp:n_busy_slots_per_decode 1.05841'].join('\n'),
    );
    expect(m.promptTokens).toBeCloseTo(8_989_240, 0);
    expect(m.busySlotsPerDecode).toBeCloseTo(1.05841, 5);
  });
});

describe('collect — historical replay must not borrow live readings', () => {
  const deps = {
    exec: (cmd: string, args: string[]) => {
      if (cmd === 'systemctl') {
        return [
          'ActiveState=active',
          'MainPID=123',
          'ActiveEnterTimestamp=Mon 2026-09-21 09:54:00 AEST',
          'ExecStart={ argv[]=/x -c 229376 -np 2 --ctx-checkpoints 4 }',
        ].join('\n');
      }
      if (cmd === 'journalctl' && args.includes('uap-anthropic-proxy.service')) {
        return 'GENERATION TIMEOUT: request exceeded 1800s hard deadline\n';
      }
      return '';
    },
    fetchText: async (url: string) => {
      if (url.endsWith('/slots')) return JSON.stringify([{ n_ctx: 229_376, kv_bpv: 8.125 }]);
      if (url.endsWith('/props')) return JSON.stringify({ vbr: { floor_bpv: 4.125 } });
      return '';
    },
    now: () => Date.parse('2026-09-21T10:00:00'),
  };
  const base = {
    serverUnit: 'uap-gsq-rco-server.service',
    proxyUnit: 'uap-anthropic-proxy.service',
    baseUrl: 'http://127.0.0.1:8080',
  };

  it('uses live readings in live mode', async () => {
    const { snapshot } = await collect(base, deps);
    expect(snapshot.kvBitsPerValue).toBe(8.125);
    expect(snapshot.ctxCheckpoints).toBe(4);
    expect(snapshot.uptimeSeconds).toBe(360);
  });

  it('drops live readings when replaying a past window', async () => {
    // An early version attributed the CURRENT --ctx-checkpoints 4 to a window
    // in which it had been 1, and so recommended the wrong remedy.
    const { snapshot } = await collect({ ...base, until: '2026-09-21 09:50:00' }, deps);
    expect(snapshot.kvBitsPerValue).toBeUndefined();
    expect(snapshot.ctxCheckpoints).toBeUndefined();
    expect(snapshot.uptimeSeconds).toBeUndefined();
  });

  it('drops the unit FLAGS in a replay too, not just the runtime readings', async () => {
    // rails/pool are parsed from the CURRENT ExecStart. Keeping them made the
    // report print "2 rails share one 229,376-cell pool" underneath the REPLAY
    // banner, describing the wrong process — the same class of error as the
    // checkpoint case above, but it survived the first fix.
    const { snapshot } = await collect({ ...base, until: '2026-09-21 09:50:00' }, deps);
    expect(snapshot.rails).toBeUndefined();
    expect(snapshot.poolCells).toBeUndefined();
    const codes = assessInference(snapshot).findings.map((f) => f.code);
    expect(codes).not.toContain('shared-pool');
  });

  it('still counts timeouts in the replayed window', async () => {
    const { snapshot } = await collect({ ...base, until: '2026-09-21 09:50:00' }, deps);
    expect(snapshot.generationTimeouts).toBe(1);
  });

  it('reports which probes were unavailable instead of guessing', async () => {
    const blind = {
      exec: () => {
        throw new Error('no systemctl');
      },
      fetchText: async () => {
        throw new Error('connection refused');
      },
    };
    const { unavailable, snapshot } = await collect(base, blind);
    expect(unavailable).toContain('systemctl');
    expect(unavailable).toContain('journalctl');
    expect(assessInference(snapshot, DEFAULT_THRESHOLDS).health).toBe('UNKNOWN');
  });

  it('refuses a unit name that systemctl would parse as a flag', async () => {
    // "--host=x.service" ends in .service but systemctl parses it as a FLAG.
    const { unavailable } = await collect({ ...base, serverUnit: '--host=evil.service' }, deps);
    expect(unavailable.join(' ')).toMatch(/invalid unit name/);
    // ...and it must not be blamed on a missing binary.
    expect(unavailable).not.toContain('systemctl');
  });
});

describe('probe failures must never read as a confident GREEN', () => {
  const PROXY_LOG = Array(5)
    .fill('Sep 21 01:40:44 h proxy[1]: [ERROR] GENERATION TIMEOUT: request exceeded 1800s hard deadline')
    .join('\n');

  const deps = {
    exec: (cmd: string, args: string[]) => {
      if (cmd === 'systemctl') {
        return [
          'ActiveState=active',
          'MainPID=1',
          'ActiveEnterTimestamp=Mon 2026-09-21 09:54:00 AEST',
          'ExecStart={ argv[]=/x -c 229376 -np 2 --ctx-checkpoints 4 }',
        ].join('\n');
      }
      if (cmd === 'journalctl') {
        const unit = args[args.indexOf('-u') + 1];
        if (unit?.includes('proxy')) {
          // Real journalctl exits non-zero on an unparseable --since.
          const si = args.indexOf('--since');
          if (si >= 0 && !String(args[si + 1] ?? '').trim()) throw new Error('Failed to parse timestamp:');
          return PROXY_LOG;
        }
        return '';
      }
      return '';
    },
    fetchText: async () => {
      throw new Error('no server');
    },
    now: () => Date.parse('2026-09-21T10:00:00'),
  };
  const base = {
    serverUnit: 'uap-gsq-rco-server.service',
    proxyUnit: 'uap-anthropic-proxy.service',
    baseUrl: 'http://127.0.0.1:8080',
  };

  it('counts timeouts normally', async () => {
    const { snapshot } = await collect(base, deps);
    expect(snapshot.generationTimeouts).toBe(5);
    expect(assessInference(snapshot).health).toBe('RED');
  });

  it('an empty --since must not silently drop the timeout evidence', async () => {
    // `''` is not nullish, so `opts.since ?? …` passed it straight through.
    // probeJournal guarded against it; countProxyTimeouts did not — so the
    // prefill analysis ran while the RED evidence vanished and --strict
    // exited 0 on an incident window.
    const { snapshot } = await collect({ ...base, since: '' }, deps);
    expect(snapshot.generationTimeouts).toBe(5);
    expect(assessInference(snapshot).health).toBe('RED');
  });

  it('reports the proxy probe as unavailable rather than assuming zero', async () => {
    const { snapshot, unavailable } = await collect({ ...base, proxyUnit: 'not-a-unit' }, deps);
    expect(snapshot.generationTimeouts).toBeUndefined();
    expect(unavailable.join(' ')).toMatch(/invalid proxy unit name/);
    // Unverified is UNKNOWN, never GREEN.
    expect(assessInference(snapshot).health).not.toBe('GREEN');
  });

  it('strips credentials from a URL before it reaches the report', async () => {
    // --json is piped into monitors and stored; node's fetch turns userinfo
    // into an Authorization header, so this is a live credential.
    const { unavailable } = await collect(
      { ...base, baseUrl: 'http://admin:hunter2@10.0.0.5:8080' },
      deps,
    );
    expect(unavailable.join(' ')).not.toMatch(/hunter2/);
    expect(unavailable.join(' ')).toMatch(/10\.0\.0\.5:8080/);
  });
});

describe('journal parsing is bounded and calendar-correct', () => {
  it('does not backtrack quadratically on a long digit run', () => {
    // journald's LineMax is 48K. With an unbounded lazy tail this took ~1.5s
    // for ONE line; 20 of them was 30s of unbounded CPU, and the exec timeout
    // bounds journalctl, not parsing.
    const line =
      'Sep 21 09:01:28 h llama-server[1]: x prompt eval time =  1.0 ms / 100 tokens ' + '1'.repeat(48_000);
    const t0 = Date.now();
    parseServerJournal(line, 2026);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('advances the year when the log crosses a New Year boundary', () => {
    // Journal lines carry no year; a backwards jump means the year rolled.
    // Otherwise a window spanning 31 Dec scrambles the early/recent split.
    const log = [
      'Dec 31 23:59:00 h llama-server[1]: x prompt eval time =  1.0 ms / 100 tokens (1.0 ms per token,    500.00 tokens per second)',
      'Jan 01 00:01:00 h llama-server[1]: x prompt eval time =  1.0 ms / 100 tokens (1.0 ms per token,    400.00 tokens per second)',
    ].join('\n');
    const { prefill } = parseServerJournal(log, 2026);
    expect(prefill).toHaveLength(2);
    expect(prefill[1].at).toBeGreaterThan(prefill[0].at);
    expect(new Date(prefill[1].at).getFullYear()).toBe(2027);
  });
});

describe('replay windows must not be silently inverted or span restarts', () => {
  const calls: string[][] = [];
  const deps = {
    exec: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'systemctl') {
        return [
          'ActiveState=active',
          'MainPID=1',
          // The CURRENT process started well AFTER any past incident window.
          'ActiveEnterTimestamp=Mon 2026-09-21 09:54:00 AEST',
          'ExecStart={ argv[]=/x -c 229376 -np 2 }',
        ].join('\n');
      }
      return '';
    },
    fetchText: async () => {
      throw new Error('no server');
    },
    now: () => Date.parse('2026-09-21T10:00:00'),
  };
  const base = {
    serverUnit: 'uap-gsq-rco-server.service',
    proxyUnit: 'uap-anthropic-proxy.service',
    baseUrl: 'http://127.0.0.1:8080',
  };

  it('does not pass journalctl a --since later than --until', async () => {
    // The default --since is the CURRENTLY running process's start. For any
    // past incident that is after the window's end, so journalctl returned
    // nothing and the report was a clean UNKNOWN with no hint that the window
    // was backwards. The server restarted 7 times in 30h here, so the current
    // start is almost always later than the window of interest.
    calls.length = 0;
    await collect({ ...base, until: '2026-09-20 06:00:00' }, deps);
    const journal = calls.find((c) => c[0] === 'journalctl')!;
    const since = journal[journal.indexOf('--since') + 1];
    const until = journal[journal.indexOf('--until') + 1];
    expect(until).toBe('2026-09-20 06:00:00');
    expect(since).not.toBe('2026-09-21 09:54:00');
    // A relative window is fine; an inverted absolute one is not.
    if (!since.startsWith('-')) {
      expect(Date.parse(since.replace(' ', 'T'))).toBeLessThan(Date.parse(until.replace(' ', 'T')));
    }
  });

  it('still uses the process start when no --until is given', async () => {
    calls.length = 0;
    await collect(base, deps);
    const journal = calls.find((c) => c[0] === 'journalctl')!;
    expect(journal[journal.indexOf('--since') + 1]).toBe('2026-09-21 09:54:00');
  });

  it('counts distinct server processes in the window', () => {
    const log = [
      'Sep 21 09:01:28 h llama-server[111]: x prompt eval time =  1.0 ms / 20000 tokens (1.0 ms per token,    600.00 tokens per second)',
      'Sep 21 09:02:28 h llama-server[222]: x prompt eval time =  1.0 ms / 20000 tokens (1.0 ms per token,     80.00 tokens per second)',
    ].join('\n');
    expect(parseServerJournal(log, 2026).processCount).toBe(2);
  });

  it('warns that a trend across a restart is not decay within one process', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => sample(1_000 + i, 20_000, 600)),
      ...Array.from({ length: 5 }, (_, i) => sample(9_000 + i, 20_000, 80)),
    ];
    const codes = assessInference({ prefill: rows, checkpoints: [], processCount: 3 }).findings.map(
      (f) => f.code,
    );
    expect(codes).toContain('spans-restart');
    // ...and not when the window is a single process.
    const single = assessInference({ prefill: rows, checkpoints: [], processCount: 1 }).findings.map(
      (f) => f.code,
    );
    expect(single).not.toContain('spans-restart');
  });
});

describe('the CLI contract monitors depend on', () => {
  const deps = {
    exec: (cmd: string) => {
      if (cmd === 'systemctl') {
        return [
          'ActiveState=active',
          'MainPID=1',
          'ActiveEnterTimestamp=Mon 2026-09-21 09:54:00 AEST',
          'ExecStart={ argv[]=/x -c 229376 -np 2 --ctx-checkpoints 1 }',
        ].join('\n');
      }
      // A degraded window: 600 -> 80 tok/s in one bucket.
      return [
        ...Array.from(
          { length: 6 },
          (_, i) =>
            `Sep 21 09:0${i} h llama-server[1]: x prompt eval time =  1.0 ms / 20000 tokens (1.0 ms per token,    600.00 tokens per second)`,
        ),
        ...Array.from(
          { length: 6 },
          (_, i) =>
            `Sep 21 09:5${i} h llama-server[1]: x prompt eval time =  1.0 ms / 20000 tokens (1.0 ms per token,     80.00 tokens per second)`,
        ),
      ].join('\n');
    },
    fetchText: async () => {
      throw new Error('no server');
    },
    now: () => Date.parse('2026-09-21T10:00:00'),
  };

  const capture = async (opts: Record<string, unknown>) => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    const prev = process.exitCode;
    process.exitCode = undefined;
    try {
      const { inferenceHealthCommand } = await import('../src/cli/inference.js');
      await inferenceHealthCommand(opts, deps);
      return { out: lines.join('\n'), exitCode: process.exitCode };
    } finally {
      console.log = log;
      process.exitCode = prev;
    }
  };

  it('--strict exits 1 on a degraded window', async () => {
    const { exitCode } = await capture({ strict: true });
    expect(exitCode).toBe(1);
  });

  it('exits 0 without --strict, so it stays advisory by default', async () => {
    const { exitCode } = await capture({});
    expect(exitCode).toBeUndefined();
  });

  it('--json emits a pinned reportVersion and the findings', async () => {
    const { out } = await capture({ json: true });
    const parsed = JSON.parse(out);
    expect(parsed.reportVersion).toBe(1);
    expect(parsed.health).toBe('RED');
    expect(parsed.findings.map((f: { code: string }) => f.code)).toContain('prefill-decay');
  });

  it('a replay suppresses the live readings in the printed report', async () => {
    const { out } = await capture({ until: '2026-09-21 09:50:00' });
    expect(out).toMatch(/REPLAY/);
    // These describe the CURRENT process, not the window.
    expect(out).not.toMatch(/checkpoints \d+ per slot/);
    expect(out).not.toMatch(/up \d+[hm]/);
  });
});
