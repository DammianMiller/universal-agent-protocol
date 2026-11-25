import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Guards the geometry invariants for the local Qwen3.8 stack — basalt
 * fleet-arm era (2026-11-21).
 *
 * Context (2026-11-21): the backend is the basalt-fn NVFP4-DQ6_K arm on
 * :8080 (uap-basalt-fn-server, the miller-tech-prime DEFAULT arm) — ONE
 * rail, a 262144-cell int8-KV pool. Its predecessors were the HyperQwen
 * patched-vLLM arm (2026-11-19, 131072 pool), the strata serve layer
 * (2026-10-04), and buun-llama-cpp behind uap-gsq-rco-server (2026-09-20,
 * `-np 2 -c 229376`); those units are INACTIVE but still installed, and
 * `systemctl show` still reports their ExecStart — which is exactly how
 * `uap inference health` came to print a stale pool size for a live
 * backend.
 *
 * The chain therefore no longer runs through any unit file (it would tie
 * the profile to a DEAD process). It runs through the LIVE backend: /slots
 * and /props on :8080 when the llama.cpp/strata arms serve, /v1/models when
 * a vLLM-class arm serves (the alias — pool and rails are unknowable on
 * that wire), degrading to profile-INTERNAL consistency elsewhere (CI).
 * Same doctrine as before: read the geometry from reality, never transcribe
 * it here — the history shows -np going 4→3→2→1→2 and backends changing
 * twice in six weeks.
 */

const ROOT = resolve(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const BACKEND_URL = 'http://127.0.0.1:8080';

/** Probe the live backend: /slots + /props for pool+rail count and the
 * advertised alias (the llama.cpp/strata arms), falling back to the
 * OpenAI-shaped /v1/models for the alias alone (the vLLM-class fleet arms —
 * hyperqwen, live since 2026-11-19 — have no /props or /slots). Null when
 * unreachable — the live-chain tests skip, same posture the old unit-file
 * tests had for absent units. Both fetches carry an AbortSignal timeout so
 * a wedged-but-listening socket skips the chain instead of hanging the
 * whole suite at module load. On the /v1/models wire pool and rails are
 * UNKNOWABLE (vLLM's max_model_len is a per-request ceiling, not the pool),
 * so they come back null and the geometry assertions skip rather than
 * assert a number the engine does not expose. */
async function liveGeometry(): Promise<{ pool: number | null; rails: number | null; alias: string } | null> {
  try {
    const slotsRes = await fetch(`${BACKEND_URL}/slots`, { signal: AbortSignal.timeout(2000) });
    if (slotsRes.ok) {
      const slots = (await slotsRes.json()) as Array<{ n_ctx?: number }>;
      const propsRes = await fetch(`${BACKEND_URL}/props`, { signal: AbortSignal.timeout(2000) });
      if (propsRes.ok) {
        const props = (await propsRes.json()) as { model_alias?: string };
        if (Array.isArray(slots) && typeof slots[0]?.n_ctx === 'number' && props.model_alias) {
          return { pool: slots[0].n_ctx, rails: slots.length, alias: props.model_alias };
        }
      }
    }
    const modelsRes = await fetch(`${BACKEND_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (modelsRes.ok) {
      const models = (await modelsRes.json()) as { data?: Array<{ id?: string }> };
      const ids = (models.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      // A single served id names the alias unambiguously; a multi-id list
      // is a router box, not a nameable arm.
      if (ids.length === 1) return { pool: null, rails: null, alias: ids[0] as string };
    }
    return null;
  } catch {
    return null;
  }
}

// Resolved once at module load (top-level await), so it.skipIf can branch on
// the REAL reachability at registration time — a beforeAll would run after
// every it() had already registered as runnable.
const live = await liveGeometry();

// 2026-10-18 (363): the profile now TRACKS the alias the backend
// advertises (swift-1.5-iq3_s for the A/B trial), so the live chain stays
// ENFORCED while the trial runs -- a profile that drifts away from the
// serving backend must fail these assertions, not skip them. An
// unreachable backend still skips (the probe itself returns null).
const geom = live;

describe('qwen38 profile — strata geometry invariants', () => {
  const profile = readJson('config/model-profiles/qwen38.json');

  it('records the whole pool as capacity, not the per-session slice', () => {
    expect(profile.server_optimization.kv_capacity).toBe(
      profile.server_optimization.max_context,
    );
    expect(profile.context_window).toBeLessThan(profile.server_optimization.kv_capacity);
  });

  it('keeps the session cap at or under the pool the rails can serve', () => {
    // Strata (one rail, 196608 pool) keeps 180224 — deliberately BELOW the
    // pool so a session at the cap leaves the engine its own working room.
    // The cap may never EXCEED pool/rails: that is the overcommit the
    // per-session cap exists to prevent (two 180224 sessions would demand
    // 360448 cells from this 196608 pool; the 2-rail-era admission made
    // exactly this mistake against its own pool).
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
    // 196608 pool.
    expect(profile.concurrency.max_parallel_requests).toBe(
      profile.server_optimization.parallel_rails,
    );
  });

  it('does not let compaction be pushed above the per-session cap', () => {
    // The trap this change hit: compaction forcing was computed from the
    // shared pool, landing its trigger ABOVE the session cap so it could never
    // fire and the destructive pruner became the only context manager.
    // 2026-11-17: constants track the operator band that ships with the
    // 180224 window (assumed 180224, target 0.66, prune 0.80). The live
    // 4.36-scale loop incident (board #266) was the opposite failure — the
    // trigger landing BELOW the client's unprunable floor; this invariant
    // guards the direction that silently disables compaction.
    const assumed = 180_224;            // PROXY_CLIENT_ASSUMED_WINDOW
    const frac = 0.66;                  // PROXY_COMPACT_TARGET_FRACTION
    const pruneThreshold = 0.80;        // PROXY_CONTEXT_PRUNE_THRESHOLD
    const target = profile.context_window * frac;
    const compactAt = (assumed * 0.925) / (assumed / target);
    expect(compactAt).toBeLessThan(profile.context_window * pruneThreshold);
  });
});

describe('qwen38 profile — matches the backend that is actually serving', () => {
  const profile = readJson('config/model-profiles/qwen38.json');

  // The fleet's arms are panel-switchable and the operator changes them freely
  // (abliterated-iq2_xs/iq3_s, swift, …); this profile documents the DEFAULT
  // arm (v31). The alias assertion can only run while the default is the arm
  // actually serving — otherwise it fails on every operator arm switch, which
  // is not drift.
  // 2026-11-14: a version bump was blocked by exactly this, the fleet healthy
  // on a different arm. The alias check was default-gated then.
  // 2026-11-25: the Inkling 2 Mini arm (1M-cell KV pool vs the default arm's
  // 262144) broke the assumption that geometry is uniform across arms — the
  // exact-equality pool/rails checks fail on a healthy non-default arm the
  // same way the alias check did. Geometry checks are default-gated too; the
  // pool-independent invariants (cap under pool, margin floors, compaction
  // ordering) stay unconditional in the describes above.
  const defaultArmServing = geom !== null && geom.alias === profile.model;
  it.skipIf(!defaultArmServing || geom === null || geom.pool === null)('records the live pool size', () => {
    expect(profile.server_optimization.kv_capacity).toBe(geom!.pool);
  });

  it.skipIf(!defaultArmServing || geom === null || geom.rails === null)('records the live rail count', () => {
    expect(profile.server_optimization.parallel_rails).toBe(geom!.rails);
  });

  it.skipIf(!defaultArmServing || geom === null || geom.pool === null || geom.rails === null)('derives the session cap under the servable pool, not a guess', () => {
    expect(profile.context_window).toBeLessThanOrEqual(geom!.pool! / geom!.rails!);
  });

  it.skipIf(!defaultArmServing)('uses the model alias the backend advertises', () => {
    expect(profile.model).toBe(geom!.alias);
  });
});

describe('qwen38 profile — describes the engine that is actually running', () => {
  const profile = readJson('config/model-profiles/qwen38.json');
  const blob = JSON.stringify(profile);

  it('names the live engine, not a retired one', () => {
    // 2026-11-19: the fleet moved :8080 to the HyperQwen vLLM arm; the
    // strata/speedy serve-layer text is history (kept in _engine_history).
    // The engine claim must follow the arm, or this suite green-lights a
    // profile describing a dead backend.
    expect(profile._engine).toMatch(/hyperqwen/i);
    expect(profile._engine).toMatch(/vllm/i);
    // The 2026-10-04 correction explicitly supersedes the llama.cpp-era
    // description; an unqualified present-tense llama.cpp claim is the exact
    // class of drift this suite was written for.
    expect(profile._engine).not.toMatch(/^buun-llama-cpp/i);
    expect(profile._engine_history).toMatch(/SUPERSEDED 2026-10-04/);
    expect(profile._engine_history).toMatch(/SUPERSEDED 2026-11-19/);
  });

  it('does not assert that llama.cpp-shaped endpoints are missing', () => {
    // Guards the CLASS of claim, not one historical sentence.
    expect(blob).not.toMatch(/does not serve[^"]*\/(props|slots|metrics)/i);
    expect(blob).not.toMatch(/serves no \/slots/i);
  });

  it('records the MTP drafter the live arm runs, not a transcribed one', () => {
    const spec = profile.server_optimization.speculative_decoding;
    expect(spec.enabled).toBe(true);
    expect(spec.type).toBe('mtp');
    // 2026-11-19: the serving arm is the HyperQwen vLLM 27B fleet arm
    // (uap-hyperqwen-server), which drafts with the model's OWN MTP head
    // in-engine — --speculative-config {method mtp,
    // num_speculative_tokens 3, draft_sample_method probabilistic}. There
    // is NO external draft artifact on this arm, so draft_model is EMPTY
    // BY REALITY, not omission (the strata-data/mtp/rt path belongs to the
    // flash-next arms and returns with a panel switch back), and
    // probabilistic draft sampling exposes no confidence floor (draft_conf
    // null — the 0.70 spec_min_p floor was a strata-arm value). Live
    // SpecDecoding metrics 2026-11-19: per-position acceptance
    // 0.869/0.686/0.577, mean acceptance length 2.52-3.13 — pin those
    // facts; update this pin on every arm switch. The DFlash2 doctrine
    // (strata_control/drafting.py _SLOWER on sm_86; this box's own
    // 2026-10-28 A/B at -5.5% mean decode) still governs any future
    // drafter change, and the stripDocs assertion below enforces that.
    expect(String(spec.draft_model)).toBe('');
    expect(spec.draft_max).toBe(3);
    expect(spec.draft_conf).toBeNull();
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
    expect(JSON.stringify(stripDocs(spec))).not.toMatch(/dflash2/i);
  });

  it('routes through the guardrail proxy, not the inference port', () => {
    expect(profile.routing.endpoint).toBe('http://127.0.0.1:4000/v1');
  });

  it('does not quote a decode number without naming workload and depth', () => {
    // 2026-11-19 (HyperQwen vLLM arm, measured live): 82.7 tok/s on a fresh
    // 400-token burst and 69.4 tok/s at a 101728-token prompt depth — the
    // comment must carry the PAIR. One number is always a simplification;
    // the band below is the honest sanity window for this arm (the strata
    // era observed 36-52; the 2026-11-18 llama external-draft arm 18-19.4).
    const m = profile.measured;
    expect(m._decode_comment).toMatch(/depth/i);
    expect(m.decode_tokens_per_second).toBeGreaterThan(50);
    expect(m.decode_tokens_per_second).toBeLessThan(100);
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
    // The profile's max_tokens (90112) is what the proxy writes into the body;
    // PROXY_TOOL_TURN_MAX_TOKENS clamps it to 32768 on any turn carrying
    // tools, which is nearly every agentic turn. The client limit must not
    // promise more than it can get.
    expect(proxyModel.limit.output).toBeLessThanOrEqual(32768);
    expect(proxyModel.limit.output).toBeLessThan(profile.max_tokens);
  });

  it('gives the guardrail-free direct path the full pool, on the alias the engine enforces', () => {
    // 2026-11-19: the HyperQwen vLLM arm 404s any direct-route model id
    // except the served alias (fleet log 18:39:37 — the strata-era
    // "ignores requested ids" continuity argument died with the arm), so
    // the direct entry must carry the profile's model field. Read it from
    // the profile, never transcribe it — the suite's own doctrine.
    const direct = oc.provider['llama.cpp-direct'].models[profile.model];
    expect(direct, 'the direct entry does not carry the profile alias').toBeTruthy();
    expect(direct!.limit.context).toBe(profile.server_optimization.kv_capacity);
  });
});

describe('client sync tooling follows the profile, not transcribed ids', () => {
  const readText = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

  it('derives the client model id from the profile instead of hardcoding one', () => {
    // 2026-10-07: the installer shipped MODEL_ALIAS="qwen38-gsq-rco-27b" as a
    // literal, so every harness advertised an id no longer served (the engine
    // tolerates any id, which is why it kept working — and why nobody
    // noticed). The profile is the one place a backend swap updates; the
    // installer must read it so a re-run converges every harness.
    const script = readText('scripts/sync-local-agent-configs.sh');
    expect(script).toMatch(/model-profiles\/\$\{PROFILE_NAME\}\.json/);
    expect(script).toContain('["model"]');
    // The alias must come from the profile read, never a transcribed constant
    // (retired ids may appear only in migration rules, not as the alias).
    expect(script).not.toMatch(/MODEL_ALIAS="qwen/);
  });

  it('keeps the bench script on the served alias too', () => {
    const bench = readText('scripts/bench-decode-reps.sh');
    expect(bench).toMatch(/model-profiles\/qwen38\.json/);
    expect(bench).not.toContain('qwen38-gsq-rco-27b');
    expect(bench).not.toContain('qwen35-a3b-iq4xs');
    // The last-resort fallback must not transcribe a model id either — it
    // would rot silently at the next backend swap.
    expect(bench).not.toMatch(/MODEL="q/);
  });

  it('expects the sandbox test to read the alias from the profile, not transcribe it', () => {
    // The sandbox test may name retired ids in FIXTURES — that is what a
    // migration fixture is — but its EXPECTATIONS must be profile-derived,
    // or the test goes stale on the next backend swap exactly like the
    // rails assertions did (they expected 2 rails into the 1-rail era).
    const sandbox = readText('scripts/test-sync-sandbox.sh');
    expect(sandbox).toMatch(/model-profiles\/qwen38\.json/);
    expect(sandbox).not.toMatch(/=="qwen38-gsq-rco-27b"/);
    expect(sandbox).not.toMatch(/=="qwen35-a3b-iq4xs"/);
    expect(sandbox).toMatch(/parallel_rails/);
  });
});
