import { describe, expect, it } from 'vitest';
import { writeSync, openSync, closeSync, unlinkSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeReuse,
  analyzeTrend,
  assessInference,
  DEFAULT_THRESHOLDS,
  type InferenceSnapshot,
} from '../src/inference/analysis.js';
import { collect, parseWindowExpr } from '../src/inference/probe.js';
import {
  draftAcceptanceRate,
  looksLikeStrataMetrics,
  parseStrataEngine,
  parseStrataLog,
  parseStrataRequests,
  strataKvBitsPerValue,
} from '../src/inference/strata.js';

/**
 * The strata backend of `uap inference health` (added 2026-10-04, when the
 * local Qwen3.8 backend moved from buun-llama-cpp to the strata serve layer).
 *
 * Everything here is pinned to the REAL output shapes observed on this box:
 * the serve-log request lines and the /metrics JSON document are verbatim
 * samples, not idealized ones.
 */

const LOG_LINE =
  'strata serve: prompt 19307 tokens = 15536 reused + 3771 read in 4189 ms (900.2 tok/s), ' +
  '117 generated in 2471 ms (47.4 tok/s), drafts accepted 80 of 93, 2 checkpoints';
const LOG_LINE_NO_DRAFTS =
  'strata serve: prompt 11612 tokens = 0 reused + 11612 read in 11894 ms (976.3 tok/s), ' +
  '133 generated in 3077 ms (43.2 tok/s), 1 checkpoints';

const METRICS_DOC = {
  engine: {
    model: 'qwen3.8-flash-next-iq3_xxs',
    max_context: 131072,
    context: 131072,
    kv: 'int8',
    kv_resident: 32768,
    vram_free_mib: 954,
    version: '0.1.37',
    spec: 6,
    mtp_max: 4,
    expert_cache_mib: 14853,
  },
  live: { state: 'reading', phase: 'reading the prompt', prompt_tokens: 39574 },
  requests: [
    {
      time: 1791088788.17,
      duration_s: 24.3,
      finish: 'stop',
      prompt_tokens: 38659,
      reused: 38270,
      prompt_read: 389,
      output_tokens: 814,
      prompt_ms: 2086.6,
      decode_ms: 22222.8,
      decode_tok_s: 36.6,
      drafts_accepted: 4535,
      drafts_offered: 5427,
      hit_rate: 0.951,
    },
    {
      time: 1791088231.04,
      duration_s: 1.1,
      finish: 'stop',
      prompt_tokens: 800,
      reused: 0,
      prompt_read: 800,
      output_tokens: 5,
      prompt_ms: 100.0,
      decode_ms: 200.0,
      decode_tok_s: 25.0,
    },
  ],
};

const LLAMACPP_METRICS =
  '# HELP llamacpp:prompt_tokens_total Prompt tokens\nllamacpp:prompt_tokens_total 123\n';

describe('parseStrataLog — pinned to the real serve-log format', () => {
  it('extracts prefill, decode, reuse and drafts from a request line', () => {
    const s = parseStrataLog(['noise', LOG_LINE, ''].join('\n'));
    expect(s.prefill).toEqual([{ at: 2, tokens: 3771, tokensPerSecond: 900.2 }]);
    // Decode samples bucket by prompt DEPTH: tokens carries the depth, the
    // rate is the reported decode tok/s.
    expect(s.decode).toEqual([{ at: 2, tokens: 19307, tokensPerSecond: 47.4 }]);
    expect(s.reuse).toEqual([{ at: 2, incoming: 19307, reused: 15536 }]);
    expect(s.drafts).toEqual([{ accepted: 80, offered: 93 }]);
  });

  it('survives a line without the drafts segment', () => {
    const s = parseStrataLog(LOG_LINE_NO_DRAFTS);
    expect(s.drafts).toEqual([]);
    expect(s.prefill[0]?.tokens).toBe(11612);
  });

  it('uses a monotonic line-index clock, not wall time', () => {
    // The log carries no timestamps; the trend split only needs monotonicity.
    const s = parseStrataLog([LOG_LINE, LOG_LINE].join('\n'));
    expect(s.prefill[0]!.at).toBeLessThan(s.prefill[1]!.at);
  });

  it('skips malformed request lines rather than sampling garbage', () => {
    const s = parseStrataLog([
      'strata serve: prompt NaN tokens = 1 reused + 2 read in 3 ms (0 tok/s), 4 generated in 5 ms (6 tok/s)',
      LOG_LINE,
    ].join('\n'));
    expect(s.prefill).toHaveLength(1);
  });
});

describe('parseStrataMetrics — pinned to the real /metrics document', () => {
  it('recognizes the strata document by its engine block', () => {
    expect(looksLikeStrataMetrics(METRICS_DOC)).toBe(true);
    expect(looksLikeStrataMetrics(LLAMACPP_METRICS)).toBe(false);
    expect(looksLikeStrataMetrics(JSON.parse('{"slots": [{"n_ctx": 1}]}'))).toBe(false);
  });

  it('parses the engine and live blocks', () => {
    const { engine, live } = parseStrataEngine(METRICS_DOC);
    expect(engine.model).toBe('qwen3.8-flash-next-iq3_xxs');
    expect(engine.maxContext).toBe(131072);
    expect(engine.kv).toBe('int8');
    expect(engine.vramFreeMiB).toBe(954);
    expect(live.state).toBe('reading');
    expect(live.promptTokens).toBe(39574);
  });

  it('maps the requests ring to samples with real epoch clocks', () => {
    const s = parseStrataRequests(METRICS_DOC.requests);
    expect(s.prefill[0]).toEqual({ at: 1791088788.17 * 1000, tokens: 389, tokensPerSecond: 389 / (2086.6 / 1000) });
    expect(s.decode[0]).toEqual({ at: 1791088788.17 * 1000, tokens: 38659, tokensPerSecond: 36.6 });
    expect(s.reuse[1]).toEqual({ at: 1791088231.04 * 1000, incoming: 800, reused: 0 });
    expect(s.drafts[0]).toEqual({ accepted: 4535, offered: 5427 });
    // A request missing drafts fields contributes no draft sample, not a 0.
    expect(s.drafts).toHaveLength(1);
  });

  it('tolerates a missing ring entirely', () => {
    const s = parseStrataRequests(undefined);
    expect(s.prefill).toEqual([]);
  });
});

describe('strata derived metrics', () => {
  it('maps kv kind strings to bits per value, unknown to undefined', () => {
    expect(strataKvBitsPerValue('int8')).toBe(8);
    expect(strataKvBitsPerValue('int4')).toBe(4);
    expect(strataKvBitsPerValue('fp16')).toBe(16);
    expect(strataKvBitsPerValue('vbr-turbo')).toBeUndefined();
    expect(strataKvBitsPerValue(undefined)).toBeUndefined();
  });

  it('computes token-weighted draft acceptance', () => {
    expect(draftAcceptanceRate([{ accepted: 80, offered: 93 }, { accepted: 66, offered: 77 }])).toBeCloseTo(
      (80 + 66) / (93 + 77),
      5,
    );
    expect(draftAcceptanceRate([])).toBeUndefined();
  });

  it('computes mean reuse fraction only over real prompts', () => {
    // reuseFraction was deleted when the ring fix landed — analyzeReuse is
    // the single home of this math, and the incoming=0 guard lives there.
    expect(analyzeReuse([{ at: 1, incoming: 38659, reused: 38270 }]).fraction).toBeCloseTo(38270 / 38659, 5);
    // incoming=0 is not a 100%-reuse reading; it is no reading.
    expect(analyzeReuse([{ at: 1, incoming: 0, reused: 0 }, { at: 2, incoming: 100, reused: 50 }]).fraction).toBe(0.5);
    expect(analyzeReuse([]).fraction).toBeUndefined();
  });
});

describe('assessInference — strata findings', () => {
  const decodeSample = (at: number, depth: number, tps: number) => ({ at, tokens: depth, tokensPerSecond: tps });

  it('flags decode decay RED with a depth-bucketed comparison', () => {
    // 8 fast early samples, 8 slow recent ones, same depth bucket.
    const decode = [
      ...Array.from({ length: 8 }, (_, i) => decodeSample(i, 20_000, 50)),
      ...Array.from({ length: 8 }, (_, i) => decodeSample(i + 8, 20_000, 12)),
    ];
    const snap: InferenceSnapshot = {
      backend: 'strata',
      prefill: [],
      checkpoints: [],
      decode,
    };
    const r = assessInference(snap);
    expect(r.health).toBe('RED');
    expect(r.findings.some((f) => f.code === 'decode-decay' && f.health === 'RED')).toBe(true);
    expect(r.decodeTrend?.bucket).toBe('15-30k');
  });

  it('does not fire cache-miss on one honest compaction turn', () => {
    // 9 turns at ~95% reuse and one 0% turn right after a client compaction:
    // the mean stays high, no finding — the compaction case is legitimate.
    const reuse = [
      ...Array.from({ length: 9 }, (_, i) => ({ at: i, incoming: 39_000, reused: 37_000 })),
      { at: 9, incoming: 10_851, reused: 0 },
    ];
    const r = assessInference({ backend: 'strata', prefill: [], checkpoints: [], reuse });
    expect(r.findings.some((f) => f.code === 'cache-miss')).toBe(false);
  });

  it('judges the cache on the RECENT tail, not the whole process window', () => {
    // The live 2026-10-04 case: a whole-process mean of 39% (hundreds of
    // legitimate cold starts from other sessions) fired a WARN while the
    // CURRENT conversation's turns reused 99%. Only the tail may count.
    const coldStarts = Array.from({ length: 200 }, (_, i) => ({ at: i, incoming: 20_000, reused: 0 }));
    const current = Array.from({ length: 50 }, (_, i) => ({
      at: 200 + i,
      incoming: 39_000,
      reused: 38_500,
    }));
    const r = assessInference({ backend: 'strata', prefill: [], checkpoints: [], reuse: [...coldStarts, ...current] });
    expect(r.findings.some((f) => f.code === 'cache-miss')).toBe(false);
    expect(r.reuse?.fraction).toBeGreaterThan(0.95);
  });

  it('fires cache-miss RED when heavy re-reads bleed the pool every turn', () => {
    // 25k tokens re-read per turn clears the 20k RED bar — sustained misses
    // this large are re-prefilling most of every prompt.
    const reuse = Array.from({ length: 8 }, (_, i) => ({ at: i, incoming: 30_000, reused: 5_000 }));
    const r = assessInference({ backend: 'strata', prefill: [], checkpoints: [], reuse });
    expect(r.findings.some((f) => f.code === 'cache-miss' && f.health === 'RED')).toBe(true);
  });

  it('fires cache-miss WARN for sustained moderate misses', () => {
    // 18k re-read per turn: below half reused (a failing cache), but not the
    // catastrophic re-prefill-everything case.
    const reuse = Array.from({ length: 8 }, (_, i) => ({ at: i, incoming: 30_000, reused: 12_000 }));
    const r = assessInference({ backend: 'strata', prefill: [], checkpoints: [], reuse });
    const f = r.findings.find((x) => x.code === 'cache-miss');
    expect(f?.health).toBe('WARN');
  });

  it('fires vram-headroom when the backend reports low free VRAM', () => {
    const r = assessInference({
      backend: 'strata',
      prefill: [],
      checkpoints: [],
      vramFreeMiB: 400,
    });
    expect(r.findings.some((f) => f.code === 'vram-headroom' && f.health === 'WARN')).toBe(true);
  });

  it('reports UNKNOWN for a strata snapshot with no evidence — never a GREEN', () => {
    const r = assessInference({ backend: 'strata', prefill: [], checkpoints: [] });
    expect(r.health).toBe('UNKNOWN');
  });

  it('analyzeReuse mirrors the reuse math', () => {
    const r = analyzeReuse([
      { at: 1, incoming: 100, reused: 60 },
      { at: 2, incoming: 0, reused: 0 },
    ]);
    expect(r.fraction).toBeCloseTo(0.6, 5);
    expect(r.samples).toBe(1);
  });

  it('takes the reuse tail by AGE, not array position (newest-first rings)', () => {
    // The /metrics ring is NEWEST-first. Before the sort fix, the tail slice
    // took the FIRST 50 by position — the oldest half — inverting exactly
    // the current-vs-cold-start signal the tail exists for. 60 cold starts
    // followed by 60 healthy turns, delivered newest-first.
    const healthy = Array.from({ length: 60 }, (_, i) => ({ at: 60 + i, incoming: 39_000, reused: 38_500 }));
    const cold = Array.from({ length: 60 }, (_, i) => ({ at: i, incoming: 20_000, reused: 0 }));
    const r = assessInference({ backend: 'strata', prefill: [], checkpoints: [], reuse: [...healthy, ...cold] });
    expect(r.findings.some((f) => f.code === 'cache-miss')).toBe(false);
    expect(r.reuse?.fraction).toBeGreaterThan(0.95);
  });
});

describe('collect — backend detection and the strata path', () => {
  const strataDeps = {
    exec: (_cmd: string, _args: string[]) => {
      if (_cmd === 'systemctl') {
        // The declared llama unit is DEAD — exactly the live 2026-10-04 state.
        return ['ActiveState=inactive', 'ExecStart={ argv[]=/x -c 229376 -np 2 }'].join('\n');
      }
      return '';
    },
    fetchText: async (url: string) => {
      if (url.endsWith('/metrics')) return JSON.stringify(METRICS_DOC);
      if (url.endsWith('/slots')) return JSON.stringify([{ id: 0, n_ctx: 131072, is_processing: true }]);
      throw new Error(`unexpected ${url}`);
    },
  };
  const base = {
    serverUnit: 'uap-gsq-rco-server.service',
    proxyUnit: 'uap-anthropic-proxy.service',
    baseUrl: 'http://127.0.0.1:8080',
  };

  it('auto-detects strata from /metrics and does not trust the dead unit flags', async () => {
    const { snapshot, backend, strata } = await collect(base, strataDeps);
    expect(backend).toBe('strata');
    expect(snapshot.backend).toBe('strata');
    // THE 2026-10-04 BUG: the inactive unit's ExecStart still says -c 229376.
    // The snapshot must carry the LIVE pool (131072), not the dead unit's.
    expect(snapshot.poolCells).toBe(131072);
    expect(snapshot.rails).toBe(1);
    expect(snapshot.kvBitsPerValue).toBe(8);
    expect(snapshot.engineModel).toBe('qwen3.8-flash-next-iq3_xxs');
    expect(snapshot.vramFreeMiB).toBe(954);
    expect(strata?.engine.model).toBe('qwen3.8-flash-next-iq3_xxs');
  });

  it('notes that only the bounded ring was used when no serve log is given', async () => {
    const { unavailable, snapshot } = await collect(base, strataDeps);
    expect(unavailable.some((u) => u.includes('strata serve log'))).toBe(true);
    // Ring samples ARE used — the note explains the thinness, it does not
    // discard them.
    expect(snapshot.prefill.length).toBe(2);
  });

  it('prefers the serve log for live trends when a path is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-log-'));
    const path = join(dir, 'strata.log');
    const fd = openSync(path, 'w');
    writeSync(fd, [LOG_LINE, LOG_LINE, LOG_LINE, LOG_LINE, LOG_LINE, LOG_LINE].join('\n'));
    closeSync(fd);
    try {
      const { snapshot, unavailable } = await collect({ ...base, strataLogPath: path }, strataDeps);
      expect(snapshot.prefill).toHaveLength(6);
      expect(unavailable.some((u) => u.includes('strata serve log'))).toBe(false);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('falls back to the ring (never the log) in a windowed replay', async () => {
    const { snapshot } = await collect(
      { ...base, until: '2100-01-01 00:00:00', strataLogPath: '/nonexistent/strata.log' },
      strataDeps,
    );
    // Log position is not wall time: the log CANNOT be windowed, so the
    // replay uses the timestamped ring only.
    expect(snapshot.prefill).toHaveLength(2);
  });

  it('filters the ring to the requested window in a replay — never the current process', async () => {
    // THE P1: before the filter, a "past incident" replay analysed the
    // CURRENT process's ring entries under the REPLAY banner. The ring times
    // (1791088231 / 1791088788) are both after this window's end, so a
    // correct replay has ZERO samples rather than verdicts about now.
    const { snapshot, strata } = await collect(
      { ...base, until: '2020-01-01 00:00:00', strataLogPath: '/nonexistent/strata.log' },
      strataDeps,
    );
    expect(snapshot.prefill).toHaveLength(0);
    expect(snapshot.decode).toHaveLength(0);
    // Drafts carry no clock at all — they must not leak the current
    // process's acceptance rate into a replay.
    expect(strata?.samples.drafts).toHaveLength(0);
  });

  it('applies --since as the ring lower bound in a replay', async () => {
    // The bound sits BETWEEN the two ring entries (epoch ms), expressed in
    // LOCAL time exactly as a human would type it — computed rather than
    // hardcoded so the test is timezone-proof.
    const midMs = ((1791088231.04 + 1791088788.17) / 2) * 1000;
    const mid = new Date(midMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const midStr = `${mid.getFullYear()}-${pad(mid.getMonth() + 1)}-${pad(mid.getDate())} ` +
      `${pad(mid.getHours())}:${pad(mid.getMinutes())}:${pad(mid.getSeconds())}`;
    const { snapshot } = await collect(
      {
        ...base,
        since: midStr,
        until: '2100-01-01 00:00:00',
        strataLogPath: '/nonexistent/strata.log',
      },
      strataDeps,
    );
    expect(snapshot.prefill).toHaveLength(1);
  });

  it('discloses an unparseable window instead of guessing a bound', async () => {
    const { snapshot, unavailable } = await collect(
      { ...base, until: 'yesterday-ish', strataLogPath: '/nonexistent/strata.log' },
      strataDeps,
    );
    // Unfiltered ring (2 samples), but the report says WHY.
    expect(snapshot.prefill).toHaveLength(2);
    expect(unavailable.some((u) => u.includes("could not be parsed"))).toBe(true);
  });

  it('discloses that --since cannot be applied to the timestamp-less log (live path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-log-'));
    const path = join(dir, 'strata.log');
    const fd = openSync(path, 'w');
    writeSync(fd, [LOG_LINE, LOG_LINE].join('\n'));
    closeSync(fd);
    try {
      const { snapshot, unavailable } = await collect({ ...base, since: '-1h', strataLogPath: path }, strataDeps);
      expect(snapshot.prefill).toHaveLength(2);
      expect(unavailable.some((u) => u.includes('--since -1h was not applied'))).toBe(true);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('reports a missing strata serve log without pretending it read one', async () => {
    const { unavailable } = await collect({ ...base, strataLogPath: '/nonexistent/strata.log' }, strataDeps);
    expect(unavailable).toContain('/nonexistent/strata.log');
  });

  it('stays on the llama.cpp path for Prometheus metrics, with the same stale-flags fix', async () => {
    const deps = {
      exec: (cmd: string) => {
        if (cmd === 'systemctl') {
          return ['ActiveState=inactive', 'ExecStart={ argv[]=/x -c 229376 -np 2 }'].join('\n');
        }
        return '';
      },
      fetchText: async (url: string) => {
        if (url.endsWith('/metrics')) return LLAMACPP_METRICS;
        if (url.endsWith('/slots')) return JSON.stringify([{ n_ctx: 131072 }]);
        throw new Error(`unexpected ${url}`);
      },
    };
    const { snapshot, backend } = await collect(base, deps);
    expect(backend).toBe('llamacpp');
    // Same doctrine as the strata path: an INACTIVE unit's ExecStart is not
    // live geometry. /slots is.
    expect(snapshot.poolCells).toBe(131072);
    expect(snapshot.rails).toBe(1);
  });

  it('an auto-detect miss is reported, not guessed', async () => {
    const deps = {
      exec: () => '',
      fetchText: async () => '<html>not a metrics document</html>',
    };
    const { backend, snapshot, unavailable } = await collect(base, deps);
    // 'auto-unresolved' — not a silent 'llamacpp' label: the JSON monitor
    // can distinguish "llama.cpp confirmed" from "could not classify".
    expect(backend).toBe('auto-unresolved');
    expect(snapshot.backend).toBe('llamacpp'); // the path actually taken
    expect(unavailable.some((u) => u.includes('neither a strata JSON document nor llama.cpp'))).toBe(true);
  });

  it('sanitizes server-provided strings at the probe boundary (CWE-117)', async () => {
    // engine.model and live.state cross a trust boundary and are printed by
    // the headline and the doctor — an escape-injected model string must not
    // reach the terminal raw.
    const hostile = { ...METRICS_DOC, engine: { ...METRICS_DOC.engine, model: 'evil\x1b[31m-model' } };
    const deps = {
      ...strataDeps,
      fetchText: async (url: string) => {
        if (url.endsWith('/metrics')) return JSON.stringify(hostile);
        if (url.endsWith('/slots')) return JSON.stringify([{ id: 0, n_ctx: 131072 }]);
        throw new Error(`unexpected ${url}`);
      },
    };
    const { snapshot, strata } = await collect(base, deps);
    expect(snapshot.engineModel).toBe('evil-model');
    expect(strata?.engine.model).toBe('evil-model');
  });
});

describe('parseWindowExpr — journalctl-style window bounds', () => {
  it('parses relative expressions', () => {
    const before = Date.now();
    const t = parseWindowExpr('-24h');
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before - 24 * 3600_000);
    expect(t).toBeLessThanOrEqual(after - 24 * 3600_000);
  });

  it('parses absolute local-time expressions', () => {
    const d = new Date(2026, 9, 4, 10, 30, 0); // local 2026-10-04 10:30:00
    expect(parseWindowExpr('2026-10-04 10:30:00')).toBe(d.getTime());
    expect(parseWindowExpr('2026-10-04 10:30')).toBe(d.getTime());
    expect(parseWindowExpr('2026-10-04')).toBe(new Date(2026, 9, 4).getTime());
  });

  it('returns undefined for anything it cannot parse — never a guess', () => {
    expect(parseWindowExpr('yesterday-ish')).toBeUndefined();
    expect(parseWindowExpr('http://127.0.0.1:8080')).toBeUndefined();
    expect(parseWindowExpr('')).toBeUndefined();
    expect(parseWindowExpr(undefined)).toBeUndefined();
    expect(parseWindowExpr('--24h')).toBeUndefined();
  });
});

describe('analyzeTrend over decode samples', () => {
  it('buckets decode by DEPTH so like is compared with like', () => {
    const shallow = Array.from({ length: 8 }, (_, i) => ({ at: i, tokens: 1_000, tokensPerSecond: 60 }));
    const deep = Array.from({ length: 8 }, (_, i) => ({ at: i + 8, tokens: 40_000, tokensPerSecond: 30 }));
    const t = analyzeTrend([...shallow, ...deep], DEFAULT_THRESHOLDS);
    // The buckets must be compared WITHIN depth, not across it: deep prompts
    // decode slower by nature, and a naive split would call that decay.
    expect(t.bucket).toBe('<5k');
    expect(t.ratio).toBeCloseTo(1, 3);
  });
});
