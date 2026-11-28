import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the geometry invariants for the DeepSeek-V4.1-Flash fleet arm —
 * the 552B-backbone / 8B-prefill / 16B-decode CED MoE reasoner tier
 * (basalt arm, 2026-11-27 era, round 12).
 *
 * Context (2026-11-27): the backend is uap-deepseek41-server on
 * :8080 (Basalt 0.5.7, jesdga DeepSeek-V4.1-Flash-1017-UD-IQ1_M.basalt
 * 260 GB, kv fp8, level 1 = one full-window rail, vision dynamic), serving
 * the fleet through the anthropic-proxy on :4000. The profile was drafted
 * the same day; its wire id and measured block were finalized from the
 * install's LIVE MEASUREMENTS at the smoke, never from vendor docs.
 *
 * Same doctrine as the inkling2/hy4flash rails: read the geometry from
 * reality, never transcribe it here. The live chain probes /props on :8080
 * and enforces ONLY when the arm answering is the deepseek arm (arm-gated —
 * another arm serving :8080 means these assertions skip). The
 * profile-internal consistency tests run everywhere (CI included).
 *
 * Honest-flag invariants pinned here deliberately:
 * 1. The wire id is a SMOKE-FINALIZED constant: the profile field, this
 *    file's ARM_ALIAS and both client entries (Droid customModels +
 *    opencode) updated together at the install smoke.
 * 2. max_tokens documents the ADVERTISED cap (65536), NOT a measured engine
 *    clamp — the inkling arm measured its answer-room clamp at 32768 on
 *    this engine family; this arm's clamp ladder is unmeasured. The test
 *    pins the advertised value and its relation to the window, no more.
 * 3. This arm is LEVEL 1 by decision (no --parallel, one full 524288 rail):
 *    upstream's own batch table shows --parallel is a LOSS at scale even on
 *    two cards for this model, so the rails stay at 1 until the tuner
 *    measures otherwise — profile, test and unit move together if raised.
 */

const ROOT = resolve(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const BACKEND_URL = 'http://127.0.0.1:8080';
const ARM_ALIAS = 'DeepSeek-V4.1-Flash-1017 UD-IQ1_M';

/** Probe the live backend's geometry: /props carries the model alias, rail
 *  count and the advertised window on this basalt engine. Null when
 *  unreachable or the shape is not what the arm exposes — the live chain
 *  then skips. */
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

describe('deepseek41 profile — basalt MoE reasoner-tier geometry invariants', () => {
  const profile = readJson('config/model-profiles/deepseek41.json');

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

  it('marks KV as shared — one window the rail addresses in full', () => {
    expect(profile.concurrency.kv_capacity_shared).toBe(true);
  });

  it('keeps parallel requests equal to the rails it ships with', () => {
    expect(profile.concurrency.max_parallel_requests).toBe(
      profile.server_optimization.parallel_rails,
    );
  });

  it('ships level 1 — ONE rail until the tuner measures otherwise', () => {
    // Upstream's own batch table for this model shows --parallel is a loss
    // at scale even on two cards (-11% at 4 slots, -31% at 8), and the arm
    // runs without UAP_PARALLEL_DEEPSEEK41 in parallel.env (level 1). If
    // this ever changes, profile + test + the unit's tuner posture move
    // together — this pin is what makes the drift visible.
    expect(profile.server_optimization.parallel_rails).toBe(1);
  });

  it('max_tokens is the ADVERTISED cap, and the engine clamp stays flagged', () => {
    // The inkling arm measured its answer-room clamp at 32768 on this engine
    // family; this arm's clamp ladder is UNMEASURED (the install smoke only
    // sent max_tokens 4096). The profile documents the advertised 65536 and
    // its comment carries the re-measure flag; this test pins the relation to
    // the window so a future clamp measurement updates both together.
    expect(profile.max_tokens).toBe(65536);
    expect(profile.max_tokens).toBeLessThan(profile.context_window);
    expect(profile._max_tokens_comment).toMatch(/UNMEASURED/i);
  });

  it('carries NO stop sequences — this engine owns its EOS', () => {
    // The pack embeds DeepSeek's own chat template, and the smoke showed
    // every measured turn ending finish=stop with no explicit markers.
    // Carrying another family's marker here would be transcription, not
    // measurement.
    expect(profile.stop_sequences).toEqual([]);
  });

  it('ships the batching suffix on the engine-family evidence, flagged', () => {
    // The suffix was MEASURED on the inkling basalt arm (sequential without,
    // parallel with). This arm's smoke verified a native single tool call
    // but not multi-tool emission — the profile enables the suffix on family
    // evidence and its comment says so. If that comment ever claims a
    // deepseek measurement that was never taken, this test fails the
    // honesty check.
    expect(profile.tool_call_batching.enabled).toBe(true);
    expect(profile.tool_call_batching.system_prompt_suffix).toMatch(/ALL of them/i);
    expect(profile.tool_call_batching._comment).toMatch(/UNMEASURED/i);
  });

  it('enables thinking — native effort map, wire shape flagged unverified', () => {
    expect(profile.enable_thinking).toBe(true);
    expect(profile._thinking_comment).toMatch(/UNVERIFIED/i);
  });

  it('the wire id is exact — clients must send it as basalt validates the field', () => {
    // Finalized at the 2026-11-27 smoke from the live /v1/models read — the
    // quant tag rides the id exactly as the hy4 precedent predicted. The
    // live drift-check below runs whenever this arm serves :8080; this pin
    // is the drift alarm.
    expect(profile.model).toBe(ARM_ALIAS);
  });
});

describe('deepseek41 profile — live arm drift-check (arm-gated)', () => {
  const profile = readJson('config/model-profiles/deepseek41.json');

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
