import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the geometry invariants for the Hy4-Flash fleet arm — the
 * 220B/12B-active multimodal MoE quality tier (basalt arm, 2026-11-26 era).
 *
 * Context (2026-11-26): the backend is uap-hy4flash-server on :8080 (Basalt
 * 0.5.7, jesdga Hy4-flash-NVFP4.basalt 158.7 GB, kv fp8, --parallel 2, vision
 * dynamic), serving the fleet through the anthropic-proxy on :4000. The
 * profile was created the same day from the install's LIVE MEASUREMENTS —
 * direct :8080 probes plus a proxied marker — never from vendor docs. The
 * wire id CARRIES the quant tag ('Hy4-flash NVFP4'), unlike the inkling
 * family's bare id.
 *
 * Same doctrine as the inkling2 rails: read the geometry from reality, never
 * transcribe it here. The live chain probes /props on :8080 and enforces ONLY
 * when the arm answering is the hy4 arm (arm-gated — another arm serving
 * :8080 means these assertions skip). The profile-internal consistency tests
 * run everywhere (CI included).
 *
 * Two honest-flag invariants this arm differs on, pinned here deliberately:
 * 1. max_tokens documents the ADVERTISED cap (65536), NOT a measured engine
 *    clamp — the inkling arm measured its answer-room clamp at 32768 on the
 *    same engine family; hy4's own clamp ladder is unmeasured. The test pins
 *    the advertised value and its relation to the window, nothing more.
 * 2. The np=2 rails are a CONCURRENCY posture on this 220B MoE (measured
 *    59.9 tok/s aggregate vs 48-50 single — no multiplier), so the
 *    context_window halves exactly like inkling2's evening posture.
 */

const ROOT = resolve(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const BACKEND_URL = 'http://127.0.0.1:8080';
const ARM_ALIAS = 'Hy4-flash NVFP4';

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

describe('hy4flash profile — basalt MoE quality-tier geometry invariants', () => {
  const profile = readJson('config/model-profiles/hy4flash.json');

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

  it('max_tokens is the ADVERTISED cap, and the engine clamp stays flagged', () => {
    // The inkling arm measured its answer-room clamp at 32768 on this engine
    // family; hy4's own clamp ladder is UNMEASURED (the install smoke only
    // ran 512-token caps). The profile documents the advertised 65536 and
    // its comment carries the re-measure flag; this test pins the relation
    // to the window so a future clamp measurement updates both together.
    expect(profile.max_tokens).toBe(65536);
    expect(profile.max_tokens).toBeLessThan(profile.context_window);
    expect(profile._max_tokens_comment).toMatch(/UNMEASURED/i);
  });

  it('carries NO stop sequences — this engine owns its EOS', () => {
    // Measured: echo, tool-call and decode probes all ended finish=stop with
    // no explicit markers. Carrying the qwen38 <|im_end|> marker here would
    // be transcription, not measurement.
    expect(profile.stop_sequences).toEqual([]);
  });

  it('ships the batching suffix on the engine-family evidence, flagged', () => {
    // The suffix was MEASURED on the inkling basalt arm (sequential without,
    // parallel with). The hy4 smoke verified a native single tool call but
    // not multi-tool emission — the profile enables the suffix on family
    // evidence and its comment says so. If that comment ever claims a hy4
    // measurement that was never taken, this test fails the honesty check.
    expect(profile.tool_call_batching.enabled).toBe(true);
    expect(profile.tool_call_batching.system_prompt_suffix).toMatch(/ALL of them/i);
    expect(profile.tool_call_batching._comment).toMatch(/UNMEASURED/i);
  });

  it('enables thinking — native, with the wire shape flagged unverified', () => {
    expect(profile.enable_thinking).toBe(true);
    expect(profile._thinking_comment).toMatch(/NOT separately probed|was NOT separately probed/i);
  });

  it('the wire id carries the quant tag — clients must send it exactly', () => {
    // Unlike the inkling family's bare 'Inkling 2 Mini', this arm's id is
    // 'Hy4-flash NVFP4': basalt validates the model field, and the Droid +
    // opencode entries register exactly this string.
    expect(profile.model).toBe(ARM_ALIAS);
  });
});

describe('hy4flash profile — live arm drift-check (arm-gated)', () => {
  const profile = readJson('config/model-profiles/hy4flash.json');

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
