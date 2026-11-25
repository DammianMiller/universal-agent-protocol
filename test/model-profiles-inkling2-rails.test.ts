import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the geometry invariants for the Inkling 2 Mini fleet arm — the
 * looped-MoE basalt arm (2026-11-25 era).
 *
 * Context (2026-11-25): the backend is uap-basalt-inkling2-server on :8080
 * (Inkling-2-Mini-NVFP4-q8, Thinking Machines looped MoE, DSpark drafting,
 * fp8 KV, 1048576 ctx elastic, vision dynamic), serving the fleet through
 * the anthropic-proxy on :4000. The profile was created from LIVE
 * MEASUREMENTS the same day (probes via :4000, the engine unit journal,
 * and the machine-local model registry) — never from vendor docs.
 *
 * Same doctrine as the qwen38 rails: read the geometry from reality, never
 * transcribe it here. The live chain probes /slots + /props on :8080 and
 * enforces ONLY when the arm answering is the inkling arm (arm-gated —
 * another arm serving :8080 means these assertions skip, exactly how the
 * qwen38 rails skip when this arm is resident). The profile-internal
 * consistency tests run everywhere (CI included).
 *
 * The doctrine DIFFERENCE from qwen38, pinned here deliberately: this arm
 * thinks SERVER-SIDE (answer-room auto inside the engine — the wire carries
 * only the answer; no reasoning_content field), so the qwen38 half-window
 * max_tokens rule (>= context_window/2, because a tight cap empties the
 * answer when reasoning spends the completion budget) DOES NOT APPLY. The
 * honest max_tokens here is the engine's own output clamp (32768, measured
 * answer-room pairs 6144/8192 → 43008/57344).
 */

const ROOT = resolve(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const BACKEND_URL = 'http://127.0.0.1:8080';
const ARM_ALIAS = 'Inkling 2 Mini';

/** Probe the live backend's geometry: /slots + /props carry pool, rail count
 *  and the model alias on this basalt engine. Null when unreachable or the
 *  shape is not what the arm exposes — the live chain then skips. */
async function liveGeometry(): Promise<{ pool: number | null; rails: number | null; alias: string } | null> {
  try {
    const propsRes = await fetch(`${BACKEND_URL}/props`, { signal: AbortSignal.timeout(2000) });
    if (!propsRes.ok) return null;
    const props = (await propsRes.json()) as {
      model_alias?: string;
      total_slots?: number;
      default_generation_settings?: { n_ctx?: number };
    };
    if (typeof props.model_alias !== 'string' || !props.model_alias) return null;
    const pool = props.default_generation_settings?.n_ctx ?? null;
    const rails = typeof props.total_slots === 'number' ? props.total_slots : null;
    return { pool, rails, alias: props.model_alias };
  } catch {
    return null;
  }
}

const live = await liveGeometry();
const armIsLive = live?.alias === ARM_ALIAS;

describe('inkling2 profile — looped-MoE basalt geometry invariants', () => {
  const profile = readJson('config/model-profiles/inkling2.json');

  it('records the whole pool as capacity, not the per-session slice', () => {
    expect(profile.server_optimization.kv_capacity).toBe(
      profile.server_optimization.max_context,
    );
    expect(profile.context_window).toBeLessThan(profile.server_optimization.kv_capacity);
  });

  it('keeps the session cap at or under what the rails can serve', () => {
    const servable =
      profile.server_optimization.kv_capacity / profile.server_optimization.parallel_rails;
    expect(profile.context_window).toBeLessThanOrEqual(servable);
  });

  it('marks KV as shared — one pool the rail addresses in full', () => {
    expect(profile.concurrency.kv_capacity_shared).toBe(true);
  });

  it('keeps parallel requests equal to the rails it ships with', () => {
    expect(profile.concurrency.max_parallel_requests).toBe(
      profile.server_optimization.parallel_rails,
    );
  });

  it('max_tokens is the ENGINE output clamp, NOT the qwen38 half-window rule', () => {
    // The qwen38 invariant (max_tokens >= context_window/2) exists because
    // that arm's reasoning spends the WIRE completion budget — a tight cap
    // there empties the answer. This arm thinks server-side (answer-room
    // auto; no reasoning field on the wire) and the engine clamps output at
    // 32768: requesting more is accepted but wasted, requesting starved
    // values SHRINKS the thinking budget. The honest value is the clamp.
    expect(profile.max_tokens).toBe(32768);
    expect(profile.max_tokens).toBeLessThan(profile.context_window);
  });

  it('carries NO stop sequences — this engine owns its EOS', () => {
    // Measured: every probed turn ended end=stop with no explicit markers.
    // The qwen38 <|im_end|> marker is chat-template-specific and would
    // never match this llama-lineage looped-MoE template; carrying it would
    // be transcribing, not measuring.
    expect(profile.stop_sequences).toEqual([]);
  });

  it('ships the batching suffix — this arm is sequential by default', () => {
    // Measured 2026-11-25: one tool call per turn without the suffix; both
    // tools in one turn with it. Without this, agent loops pay one
    // round-trip per tool on this arm.
    expect(profile.tool_call_batching.enabled).toBe(true);
    expect(profile.tool_call_batching.system_prompt_suffix).toMatch(/ALL of them/i);
  });

  it('enables thinking — native, server-side', () => {
    expect(profile.enable_thinking).toBe(true);
  });
});

describe('inkling2 profile — live arm drift-check (arm-gated)', () => {
  const profile = readJson('config/model-profiles/inkling2.json');

  it.skipIf(!armIsLive)(
    'the profile model field matches the alias the arm advertises',
    () => {
      expect(live?.alias).toBe(profile.model);
    },
  );

  it.skipIf(!armIsLive || live?.pool == null)(
    'the profile pool matches the live n_ctx',
    () => {
      expect(live?.pool).toBe(profile.server_optimization.kv_capacity);
    },
  );

  it.skipIf(!armIsLive || live?.rails == null)(
    'the profile rail count matches the live total_slots',
    () => {
      expect(live?.rails).toBe(profile.server_optimization.parallel_rails);
    },
  );
});
