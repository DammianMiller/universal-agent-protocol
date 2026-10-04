import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Guards the geometry invariants for the local Qwen3.8 stack — strata era.
 *
 * Context (2026-10-04): the backend is the strata serve layer on :8080 —
 * ONE rail, a 131072-cell pool (kv int8, fixed tier), no systemd unit. Its
 * predecessor (2026-09-20) was buun-llama-cpp behind
 * uap-gsq-rco-server.service with `-np 2 -c 229376`, a SHARED pool; that unit
 * is now INACTIVE but still installed, and `systemctl show` still reports its
 * ExecStart — which is exactly how `uap inference health` came to print a
 * stale 229,376-cell pool for the live 131,072 backend.
 *
 * The chain therefore no longer runs through the unit file (it would tie the
 * profile to a DEAD process). It runs through the LIVE backend: /slots and
 * /props on :8080 when reachable (this machine), degrading to
 * profile-INTERNAL consistency elsewhere (CI). Same doctrine as before: read
 * the geometry from reality, never transcribe it here — the history shows -np
 * going 4→3→2→1→2 and backends changing twice in six weeks.
 */

const ROOT = resolve(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const BACKEND_URL = 'http://127.0.0.1:8080';

/** Probe the live backend once: /slots for pool+rail count, /props for the
 * advertised alias. Null when unreachable — the live-chain tests skip, same
 * posture the old unit-file tests had for absent units. Both fetches carry
 * an AbortSignal timeout so a wedged-but-listening socket skips the chain
 * instead of hanging the whole suite at module load. */
async function liveGeometry(): Promise<{ pool: number; rails: number; alias: string } | null> {
  try {
    const slotsRes = await fetch(`${BACKEND_URL}/slots`, { signal: AbortSignal.timeout(2000) });
    if (!slotsRes.ok) return null;
    const slots = (await slotsRes.json()) as Array<{ n_ctx?: number }>;
    const propsRes = await fetch(`${BACKEND_URL}/props`, { signal: AbortSignal.timeout(2000) });
    if (!propsRes.ok) return null;
    const props = (await propsRes.json()) as { model_alias?: string };
    if (!Array.isArray(slots) || typeof slots[0]?.n_ctx !== 'number' || !props.model_alias) {
      return null;
    }
    return { pool: slots[0].n_ctx, rails: slots.length, alias: props.model_alias };
  } catch {
    return null;
  }
}

// Resolved once at module load (top-level await), so it.skipIf can branch on
// the REAL reachability at registration time — a beforeAll would run after
// every it() had already registered as runnable.
const geom = await liveGeometry();

describe('qwen38 profile — strata geometry invariants', () => {
  const profile = readJson('config/model-profiles/qwen38.json');

  it('records the whole pool as capacity, not the per-session slice', () => {
    expect(profile.server_optimization.kv_capacity).toBe(
      profile.server_optimization.max_context,
    );
    expect(profile.context_window).toBeLessThan(profile.server_optimization.kv_capacity);
  });

  it('keeps the session cap at or under the pool the rails can serve', () => {
    // Strata (one rail, 131072 pool) keeps 114688 — deliberately BELOW the
    // pool so a session at the cap leaves the engine its own working room.
    // The cap may never EXCEED pool/rails: that is the overcommit the
    // per-session cap exists to prevent (two 114688 sessions demanded
    // 229376 cells from this 131072 pool under the 2-rail-era admission).
    const servable = profile.server_optimization.kv_capacity / profile.server_optimization.parallel_rails;
    expect(profile.context_window).toBeLessThanOrEqual(servable);
  });

  it('marks KV as shared — one pool the rail addresses in full', () => {
    expect(profile.concurrency.kv_capacity_shared).toBe(true);
  });

  it('leaves room for reasoning tokens, with margin above the half-window floor', () => {
    // Chain-of-thought lands in a separate reasoning_content field, so a tight
    // cap yields an EMPTY completion with finish_reason=length rather than a
    // short one. `>=` at exact equality gave zero margin, so a future window
    // change would surface as a confusing max_tokens failure.
    expect(profile.max_tokens).toBeGreaterThanOrEqual(profile.context_window / 2);
    expect(profile.max_tokens).toBeLessThan(profile.context_window);
  });

  it('keeps parallel requests equal to the rails it ships with', () => {
    // The profile, the proxy env written by scripts/sync-local-agent-configs.sh,
    // and the rail count move as one — 2 in the llama.cpp era, 1 in the strata
    // era. A profile of 1 against a proxy still admitting 2 overcommits the
    // 131072 pool.
    expect(profile.concurrency.max_parallel_requests).toBe(
      profile.server_optimization.parallel_rails,
    );
  });

  it('does not let compaction be pushed above the per-session cap', () => {
    // The trap this change hit: compaction forcing was computed from the
    // shared pool, landing its trigger ABOVE the session cap so it could never
    // fire and the destructive pruner became the only context manager.
    const assumed = 200_000;            // PROXY_CLIENT_ASSUMED_WINDOW
    const frac = 0.58;                  // PROXY_COMPACT_TARGET_FRACTION
    const pruneThreshold = 0.70;        // PROXY_CONTEXT_PRUNE_THRESHOLD
    const target = profile.context_window * frac;
    const compactAt = (assumed * 0.925) / (assumed / target);
    expect(compactAt).toBeLessThan(profile.context_window * pruneThreshold);
  });
});

describe('qwen38 profile — matches the backend that is actually serving', () => {
  const profile = readJson('config/model-profiles/qwen38.json');

  it.skipIf(geom === null)('records the live pool size', () => {
    expect(profile.server_optimization.kv_capacity).toBe(geom!.pool);
  });

  it.skipIf(geom === null)('records the live rail count', () => {
    expect(profile.server_optimization.parallel_rails).toBe(geom!.rails);
  });

  it.skipIf(geom === null)('derives the session cap under the servable pool, not a guess', () => {
    expect(profile.context_window).toBeLessThanOrEqual(geom!.pool / geom!.rails);
  });

  it.skipIf(geom === null)('uses the model alias the backend advertises', () => {
    expect(profile.model).toBe(geom!.alias);
  });
});

describe('qwen38 profile — describes the engine that is actually running', () => {
  const profile = readJson('config/model-profiles/qwen38.json');
  const blob = JSON.stringify(profile);

  it('names the strata serve layer, not a retired engine', () => {
    expect(profile._engine).toMatch(/strata/i);
    // The 2026-10-04 correction explicitly supersedes the llama.cpp-era
    // description; an unqualified present-tense llama.cpp claim is the exact
    // class of drift this suite was written for.
    expect(profile._engine).not.toMatch(/^buun-llama-cpp/i);
    expect(profile._engine_history).toMatch(/SUPERSEDED 2026-10-04/);
  });

  it('does not assert that llama.cpp-shaped endpoints are missing', () => {
    // Guards the CLASS of claim, not one historical sentence.
    expect(blob).not.toMatch(/does not serve[^"]*\/(props|slots|metrics)/i);
    expect(blob).not.toMatch(/serves no \/slots/i);
  });

  it('records the strata MTP speculative path, not a separate draft model', () => {
    const spec = profile.server_optimization.speculative_decoding;
    expect(spec.enabled).toBe(true);
    expect(spec.type).toBe('mtp');
    // The DFlash2 draft model belonged to the retired llama.cpp backend; it
    // may survive only as dated history inside documentation keys.
    const stripDocs = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(stripDocs);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, val]) => [k, stripDocs(val)]),
        );
      }
      return v;
    };
    expect(JSON.stringify(stripDocs(spec))).not.toMatch(/DFlash2/);
  });

  it('routes through the guardrail proxy, not the inference port', () => {
    expect(profile.routing.endpoint).toBe('http://127.0.0.1:4000/v1');
  });

  it('does not quote a decode number without naming workload and depth', () => {
    // 47 is a mid-depth code-workload observation on strata; prose reached ~25
    // and counting ~93 on the predecessor. One number is always a
    // simplification — the comment must say so.
    const m = profile.measured;
    expect(m._decode_comment).toMatch(/depth/i);
    expect(m.decode_tokens_per_second).toBeLessThan(50);
    expect(m.draft_acceptance).toBeLessThan(0.85);
  });

  it('does not claim concurrent throughput it has not measured', () => {
    // Moot at one rail, and kept null so no claim survives from the 2-rail era.
    expect(profile.measured.concurrent_2_rail_throughput).toBeNull();
  });
});

describe('project opencode config agrees with the profile', () => {
  const profile = readJson('config/model-profiles/qwen38.json');
  const oc = readJson('opencode.json');
  const proxyProvider = oc.provider['qwen-proxy'];
  const proxyModel = proxyProvider.models['Qwen3.8-27B'];

  it('sizes the proxy model to the profile window, not the pool', () => {
    expect(proxyModel.limit.context).toBe(profile.context_window);
  });

  it('selects the qwen38 profile via header, or the cap never applies', () => {
    expect(proxyProvider.options.headers['x-uap-model-profile']).toBe('qwen38');
  });

  it('points at loopback rather than a LAN address', () => {
    expect(proxyProvider.options.baseURL).toBe('http://127.0.0.1:4000/v1');
  });

  it('no longer uses the retired qwen35 model id in any live value', () => {
    // `_`-prefixed keys are documentation and legitimately cite the old id as
    // history; strip them so the check covers values the tools actually read.
    const stripDocs = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(stripDocs);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, val]) => [k, stripDocs(val)]),
        );
      }
      return v;
    };
    expect(JSON.stringify(stripDocs(oc))).not.toMatch(/qwen35-a3b-iq4xs/);
  });

  it('enables reasoning, since the backend separates thinking output', () => {
    expect(proxyModel.reasoning).toBe(true);
  });

  it('references the proxy token by env var, never as a literal', () => {
    // This file is tracked. The live token belongs only in the untracked
    // global config, which the sync script writes.
    const envRef = /^\{env:[A-Z0-9_]+\}$/;
    expect(proxyProvider.options.apiKey).toMatch(envRef);
    expect(proxyProvider.options.headers['x-uap-proxy-token']).toMatch(envRef);
  });

  it('keeps the declared output under the proxy tool-turn cap', () => {
    // The profile's max_tokens (57344) is what the proxy writes into the body;
    // PROXY_TOOL_TURN_MAX_TOKENS clamps it to 32768 on any turn carrying
    // tools, which is nearly every agentic turn. The client limit must not
    // promise more than it can get.
    expect(proxyModel.limit.output).toBeLessThanOrEqual(32768);
    expect(proxyModel.limit.output).toBeLessThan(profile.max_tokens);
  });

  it('gives the guardrail-free direct path the full pool', () => {
    const direct = oc.provider['llama.cpp-direct'].models['qwen38-gsq-rco-27b'];
    expect(direct.limit.context).toBe(profile.server_optimization.kv_capacity);
  });
});
