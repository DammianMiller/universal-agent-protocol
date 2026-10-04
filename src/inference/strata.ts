/**
 * Strata backend collectors for `uap inference health`.
 *
 * The local Qwen3.8 backend moved (2026-10-04) from the buun llama.cpp fork
 * behind uap-gsq-rco-server.service to the Strata serve layer
 * (`strata serve/server.py`, engine build 0.1.37, flash-next IQ3_XXS pack)
 * on :8080. Strata deliberately mimics the llama.cpp HTTP surface (/v1,
 * /slots, /props) but its /metrics is a JSON document, not Prometheus text —
 * the llamacpp: counter names the existing probe scrapes do not exist there.
 *
 * Two sources, both parsed purely here:
 *
 *   - `/metrics` (JSON): `engine` (pool size, KV kind, VRAM free), `live`
 *     (in-flight request), and `requests` — a bounded ring of COMPLETED
 *     requests with per-request prompt/decode timing and cache reuse. The
 *     ring is small (observed: 12), so it gives recent detail but cannot
 *     carry a life-of-process trend on its own.
 *   - the serve log (text): one `strata serve: prompt ...` summary line per
 *     completed request, appended for the process's whole life (observed:
 *     4400+ lines over ~23h). These lines carry NO timestamps, so the
 *     parser assigns each sample a monotonically increasing index as its
 *     `at` clock — `analyzeTrend` only requires a monotonic clock, and
 *     early-vs-recent split by log position is exactly the process-lifetime
 *     comparison it wants. The price: strata log trends cannot be windowed
 *     with --since/--until; windowed analysis uses the /metrics ring, which
 *     does carry epoch timestamps, and honestly reports "not enough samples"
 *     when the ring is short.
 */

import type { PrefillSample, ReuseSample, TrendSample } from './analysis.js';

export interface DraftSample {
  accepted: number;
  offered: number;
}

/** Everything the health analysis consumes, from either source. */
export interface StrataSamples {
  /** Prefill throughput per request (tokens read, not reused). */
  prefill: PrefillSample[];
  /** Decode throughput per request. `tokens` carries the prompt DEPTH —
   * decode speed depends on context depth, so depth is what the trend
   * buckets must compare like-for-like. */
  decode: TrendSample[];
  reuse: ReuseSample[];
  drafts: DraftSample[];
}

/** Parsed `engine` block of /metrics. */
export interface StrataEngine {
  model?: string;
  maxContext?: number;
  /** KV kind as strata spells it, e.g. 'int8'. */
  kv?: string;
  /** Strata's own reserve-aware view of free VRAM (MiB). */
  vramFreeMiB?: number;
  version?: string;
  spec?: number;
  kvResident?: number;
}

export interface StrataLive {
  state?: string;
  phase?: string;
  promptTokens?: number;
}

/**
 * One completed-request summary line from the strata serve log:
 *
 *   strata serve: prompt 19307 tokens = 15536 reused + 3771 read in 4189 ms
 *   (900.2 tok/s), 117 generated in 2471 ms (47.4 tok/s), drafts accepted
 *   80 of 93, 2 checkpoints
 *
 * The trailing segments (drafts, checkpoints) are optional so a strata
 * release that drops one keeps the rest of the sample intact; the core
 * segment order is fixed.
 */
const REQUEST_LINE_RE =
  /prompt (\d+) tokens = (\d+) reused \+ (\d+) read in (\d+(?:\.\d+)?) ms \((\d+(?:\.\d+)?) tok\/s\), (\d+) generated in (\d+(?:\.\d+)?) ms \((\d+(?:\.\d+)?) tok\/s\)/;
const DRAFTS_RE = /drafts accepted (\d+) of (\d+)/;

/** Parse a strata serve log (or any slice of one) into samples. `at` values
 * are line indices — monotonic, comparable, and deliberately NOT wall time
 * (the log has no timestamps). */
export function parseStrataLog(text: string): StrataSamples {
  const out: StrataSamples = { prefill: [], decode: [], reuse: [], drafts: [] };
  let at = 0;
  for (const line of text.split('\n')) {
    at += 1;
    const m = REQUEST_LINE_RE.exec(line);
    if (!m) continue;
    const promptTokens = Number(m[1]);
    const reused = Number(m[2]);
    const read = Number(m[3]);
    const prefillTps = Number(m[5]);
    const generated = Number(m[6]);
    const decodeTps = Number(m[8]);
    if (![promptTokens, reused, read, prefillTps, generated, decodeTps].every(Number.isFinite)) continue;
    if (prefillTps < 0 || decodeTps < 0) continue; // parse artefact, not a measurement
    out.prefill.push({ at, tokens: read, tokensPerSecond: prefillTps });
    out.decode.push({ at, tokens: promptTokens, tokensPerSecond: decodeTps });
    out.reuse.push({ at, incoming: promptTokens, reused });
    const d = DRAFTS_RE.exec(line);
    if (d) {
      const accepted = Number(d[1]);
      const offered = Number(d[2]);
      if (Number.isFinite(accepted) && Number.isFinite(offered)) out.drafts.push({ accepted, offered });
    }
  }
  return out;
}

/** Structural guard for the /metrics document: it must have an `engine`
 * object with a `model` string. Anything else (Prometheus text from a
 * llama.cpp server, an HTML error page) is "not strata", not a parse error. */
export function looksLikeStrataMetrics(parsed: unknown): parsed is { engine: Record<string, unknown> } & {
  live?: Record<string, unknown>;
  requests?: unknown[];
} {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { engine?: unknown }).engine === 'object' &&
    (parsed as { engine?: unknown }).engine !== null &&
    typeof ((parsed as { engine: Record<string, unknown> }).engine as { model?: unknown }).model === 'string'
  );
}

const finiteNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Parse the /metrics `engine` + `live` blocks into typed facts. */
export function parseStrataEngine(doc: {
  engine: Record<string, unknown>;
  live?: Record<string, unknown>;
}): { engine: StrataEngine; live: StrataLive } {
  const e = doc.engine;
  return {
    engine: {
      model: typeof e.model === 'string' ? e.model : undefined,
      maxContext: finiteNumber(e.max_context) ?? finiteNumber(e.context),
      kv: typeof e.kv === 'string' ? e.kv : undefined,
      vramFreeMiB: finiteNumber(e.vram_free_mib),
      version: typeof e.version === 'string' ? e.version : undefined,
      spec: finiteNumber(e.spec),
      kvResident: finiteNumber(e.kv_resident),
    },
    live: {
      state: typeof doc.live?.state === 'string' ? doc.live.state : undefined,
      phase: typeof doc.live?.phase === 'string' ? doc.live.phase : undefined,
      promptTokens: finiteNumber(doc.live?.prompt_tokens),
    },
  };
}

/** Parse the /metrics `requests` ring into samples. Ring entries carry real
 * epoch seconds in `time`, so these samples CAN be windowed — unlike
 * log-derived samples. An entry without a finite `time` is DROPPED, not
 * given a fallback index clock: mixing a small line-index with epoch-ms
 * inside one array would scramble analyzeTrend's era split, and the repo
 * doctrine is UNKNOWN over a guess. */
export function parseStrataRequests(requests: unknown[] | undefined): StrataSamples {
  const out: StrataSamples = { prefill: [], decode: [], reuse: [], drafts: [] };
  for (const r of requests ?? []) {
    if (typeof r !== 'object' || r === null) continue;
    const req = r as Record<string, unknown>;
    const time = finiteNumber(req.time);
    if (time === undefined) continue; // no clock, no sample — never a guess
    const at = time * 1000;
    if (!Number.isFinite(at)) continue; // overflow guard, same doctrine
    const read = finiteNumber(req.prompt_read);
    const promptMs = finiteNumber(req.prompt_ms);
    const promptTokens = finiteNumber(req.prompt_tokens);
    const decodeTps = finiteNumber(req.decode_tok_s);
    if (read !== undefined && promptMs !== undefined && promptMs > 0) {
      out.prefill.push({ at, tokens: read, tokensPerSecond: read / (promptMs / 1000) });
    }
    if (decodeTps !== undefined && promptTokens !== undefined) {
      out.decode.push({ at, tokens: promptTokens, tokensPerSecond: decodeTps });
    }
    const reused = finiteNumber(req.reused);
    if (promptTokens !== undefined && reused !== undefined) {
      out.reuse.push({ at, incoming: promptTokens, reused });
    }
    const accepted = finiteNumber(req.drafts_accepted);
    const offered = finiteNumber(req.drafts_offered);
    if (accepted !== undefined && offered !== undefined) out.drafts.push({ accepted, offered });
  }
  return out;
}

/** Strata's KV kind string → bits per value, for the pool-quality signal.
 * Unknown kinds yield undefined (UNKNOWN, never a guess). */
export function strataKvBitsPerValue(kv: string | undefined): number | undefined {
  switch (kv) {
    case 'int8':
      return 8;
    case 'int4':
      return 4;
    case 'fp16':
      return 16;
    default:
      return undefined;
  }
}

/** Mean draft-acceptance rate over the samples, when any exist. */
export function draftAcceptanceRate(drafts: DraftSample[]): number | undefined {
  const offered = drafts.reduce((a, d) => a + d.offered, 0);
  if (offered <= 0) return undefined;
  return drafts.reduce((a, d) => a + d.accepted, 0) / offered;
}
