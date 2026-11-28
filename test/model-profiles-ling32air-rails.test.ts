import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the geometry invariants for the Ling-3.2-air fleet arm — the
 * 124B-total / 5.5B-activated hybrid-linear MoE + VL tier (llama.cpp arm,
 * 2026-11-28 era, round 13).
 *
 * Context (2026-11-28): the backend is uap-ling32air-server on :8080
 * (llama.cpp b12814, bartowski Ling-3.2-air Q4_K_M GGUF 80.39 GB in 3
 * splits, --ctx-size 262144 = the native window, --parallel 1, --spec-type
 * draft-mtp, --n-cpu-moe 35, one slot), serving the fleet through the
 * anthropic-proxy on :4000. The profile was drafted the same day, its
 * wire id and measured block finalized from the install's LIVE
 * MEASUREMENTS at the smoke, never from vendor docs.
 *
 * Same doctrine as the inkling2/deepseek41 rails: read the geometry from
 * reality, never transcribe it here. The live chain probes the llama.cpp
 * server (/v1/models for the alias, /props for the rails and window) and
 * enforces ONLY when the arm answering is the ling arm (arm-gated —
 * another arm serving :8080 means these assertions skip). The
 * profile-internal consistency tests run everywhere (CI included).
 *
 * Honest-flag invariants pinned here deliberately:
 * 1. The wire id is a SMOKE-FINALIZED constant: the profile field, this
 *    file's ARM_ALIAS and both client entries (Droid customModels +
 *    opencode) updated together at the install smoke.
 * 2. max_tokens documents the ADVERTISED cap (65536), NOT a measured
 *    engine clamp — the clamp ladder is unmeasured on this arm. The test
 *    pins the advertised value and its relation to the window, no more.
 * 3. This arm is ONE SLOT by decision, and the pin is load-bearing:
 *    llama-server DEFAULTS TO 4 SLOTS without --parallel, which would
 *    split the 262144 window 4-ways and break the one-rail doctrine —
 *    the smoke caught the default live (total_slots 4) before the pin.
 *    The 80 GB pack splits its experts across GPU + CPU, so slots would
 *    multiply the CPU expert traffic per token. The rails stay at 1
 *    until a measured multi-slot run — profile, test and unit move
 *    together if raised.
 */

const ROOT = resolve(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const BACKEND_URL = 'http://127.0.0.1:8080';
const ARM_ALIAS = 'Ling-3.2-air Q4_K_M';

/** Probe the live backend's geometry: /v1/models carries the alias the
 *  server was started with (--alias), /props carries the slot count and
 *  the advertised window on this llama.cpp server. Null when unreachable
 *  or the shape is not what the arm exposes — the live chain then skips. */
async function liveGeometry(): Promise<{ pool: number | null; rails: number | null; alias: string } | null> {
  try {
    const modelsRes = await fetch(`${BACKEND_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!modelsRes.ok) return null;
    const models = (await modelsRes.json()) as { data?: { id?: string }[] };
    const alias = models.data?.[0]?.id;
    if (typeof alias !== 'string' || !alias) return null;
    let pool: number | null = null;
    let rails: number | null = null;
    try {
      const propsRes = await fetch(`${BACKEND_URL}/props`, { signal: AbortSignal.timeout(2000) });
      if (propsRes.ok) {
        const props = (await propsRes.json()) as {
          total_slots?: number;
          default_generation_settings?: { n_ctx?: number };
        };
        pool = props.default_generation_settings?.n_ctx ?? null;
        rails = typeof props.total_slots === 'number' ? props.total_slots : null;
      }
    } catch {
      // /props unreachable: the alias gate still runs, geometry skips.
    }
    return { pool, rails, alias };
  } catch {
    return null;
  }
}

const live = await liveGeometry();
const armIsLive = live?.alias === ARM_ALIAS;

describe('ling32air profile — llama.cpp hybrid-MoE tier geometry invariants', () => {
  const profile = readJson('config/model-profiles/ling32air.json');

  it('records the advertised window as capacity, not the per-session slice', () => {
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

  it('caps the session at half the rail — the single-rail morning posture', () => {
    // The inkling2/deepseek41 doctrine: a session at cap leaves >= 2x
    // headroom for the elastic caches and the prompt workspaces. The ling
    // rail equals the model's NATIVE window (262144 — a larger pool would
    // invite positions beyond the trained window), so the cap is half of
    // exactly that. If the cap ever moves, profile + clients move together.
    expect(profile.context_window).toBe(
      profile.server_optimization.kv_capacity / 2,
    );
  });

  it('marks KV as shared — one window the rail addresses in full', () => {
    expect(profile.concurrency.kv_capacity_shared).toBe(true);
  });

  it('keeps parallel requests equal to the rails it ships with', () => {
    expect(profile.concurrency.max_parallel_requests).toBe(
      profile.server_optimization.parallel_rails,
    );
  });

  it('ships ONE slot — tuner key parked until a measured multi-slot run', () => {
    // The unit runs no --parallel (one llama-server slot) and wraps no
    // basalt-autotune helper: llama-server's slot model differs, and
    // slots would multiply the CPU expert traffic per token on this
    // GPU+CPU split pack. If this ever changes, profile + test + the
    // unit's posture move together — this pin is what makes the drift
    // visible.
    expect(profile.server_optimization.parallel_rails).toBe(1);
  });

  it('max_tokens is the ADVERTISED cap, and the engine clamp stays flagged', () => {
    // The clamp ladder is UNMEASURED on this arm (the inkling arm measured
    // its answer-room clamp at 32768 on its engine family). The profile
    // documents the advertised 65536 and its comment carries the
    // re-measure flag; this test pins the relation to the window so a
    // future clamp measurement updates both together.
    expect(profile.max_tokens).toBe(65536);
    expect(profile.max_tokens).toBeLessThan(profile.context_window);
    expect(profile._max_tokens_comment).toMatch(/UNMEASURED/i);
  });

  it('carries NO stop sequences — the GGUF template owns its EOS', () => {
    // The pack embeds the model's own Bailing V3 chat template (--jinja),
    // and the smoke must show every measured turn ending finish=stop with
    // no explicit markers. Carrying another family's marker here would be
    // transcription, not measurement.
    expect(profile.stop_sequences).toEqual([]);
  });

  it('ships the batching suffix on the engine-family evidence, flagged', () => {
    // The suffix was MEASURED on the inkling basalt arm (sequential
    // without, parallel with). This arm's smoke verifies a native single
    // tool call but not multi-tool emission — the profile enables the
    // suffix on family evidence and its comment says so. If that comment
    // ever claims a ling measurement that was never taken, this test
    // fails the honesty check.
    expect(profile.tool_call_batching.enabled).toBe(true);
    expect(profile.tool_call_batching.system_prompt_suffix).toMatch(/ALL of them/i);
    expect(profile.tool_call_batching._comment).toMatch(/UNMEASURED/i);
  });

  it('enables thinking — vendor default on, wire shape flagged unverified', () => {
    expect(profile.enable_thinking).toBe(true);
    expect(profile._thinking_comment).toMatch(/UNVERIFIED/i);
  });

  it('the wire id is exact — clients must send it as the alias serves it', () => {
    // Finalized at the 2026-11-28 smoke from the live /v1/models read —
    // the quant tag rides the id exactly as the hy4/deepseek41
    // precedents predicted. The live drift-check below runs whenever
    // this arm serves :8080; this pin is the drift alarm.
    expect(profile.model).toBe(ARM_ALIAS);
  });
});

describe('ling32air profile — live arm drift-check (arm-gated)', () => {
  const profile = readJson('config/model-profiles/ling32air.json');

  it.skipIf(!armIsLive)(
    'the profile model field matches the alias the arm advertises',
    () => {
      expect(live?.alias).toBe(profile.model);
    },
  );

  it.skipIf(!armIsLive || live?.pool == null)(
    'the profile capacity matches the live n_ctx',
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
