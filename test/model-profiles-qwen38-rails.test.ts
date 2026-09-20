import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Guards the 2-rail invariants for the local Qwen3.8 stack.
 *
 * Context (2026-09-20): uap-gsq-rco-server.service runs `-np 2 -c 229376` and
 * the fork forces `--kv-unified`, so 229376 is ONE SHARED POOL — `/slots`
 * reports n_ctx=229376 for BOTH slots and either rail may address all of it.
 * The proxy auto-detects that number and hands it to every session, so the
 * only thing stopping two concurrent agents from demanding 2x the pool is the
 * qwen38 profile's per-session `context_window`.
 *
 * An earlier version of this file asserted `SERVER_POOL / SERVER_RAILS` where
 * both operands were constants declared HERE — a profile-internal consistency
 * check that could never detect the drift it was written for (the unit's own
 * history shows -np going 4→3→2→1→2 and -c going 393216→262144→229376 inside
 * two weeks). The geometry is now READ FROM THE UNIT, so a hand-transcription
 * error fails instead of passing quietly.
 */

const ROOT = resolve(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const PROFILE_PATH = 'config/model-profiles/qwen38.json';
const UNIT_PATH = resolve(homedir(), '.config/systemd/user/uap-gsq-rco-server.service');

/** Parse the real geometry out of the systemd unit's ExecStart. */
function unitGeometry(): { pool: number; rails: number } | null {
  if (!existsSync(UNIT_PATH)) return null;
  const flags = readFileSync(UNIT_PATH, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  const pool = /(?:^|\s)-c\s+(\d+)/.exec(flags);
  const rails = /(?:^|\s)-np\s+(\d+)/.exec(flags);
  if (!pool || !rails) return null;
  return { pool: Number(pool[1]), rails: Number(rails[1]) };
}

const geom = unitGeometry();

describe('qwen38 profile — 2-rail context invariants', () => {
  const profile = readJson(PROFILE_PATH);

  it('caps a session at the pool divided by the rail count', () => {
    // The load-bearing invariant, checked against the profile's own recorded
    // geometry (which the unit-file test below ties back to reality).
    const pool = profile.server_optimization.kv_capacity;
    const rails = profile.server_optimization.parallel_rails;
    expect(profile.context_window).toBe(pool / rails);
  });

  it('records the whole pool as capacity, not the per-session slice', () => {
    expect(profile.server_optimization.kv_capacity).toBe(
      profile.server_optimization.max_context,
    );
    expect(profile.context_window).toBeLessThan(profile.server_optimization.kv_capacity);
  });

  it('marks KV as shared, because VBR forces --kv-unified above one rail', () => {
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
    // Previously `toBeLessThanOrEqual(2)`, which PASSED at the exact value its
    // own comment forbade. The profile, the proxy env written by
    // scripts/sync-local-agent-configs.sh, and the rail count now move as one.
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

describe('qwen38 profile — matches the unit that is actually installed', () => {
  const profile = readJson(PROFILE_PATH);

  it.skipIf(geom === null)('records the unit\'s real pool size', () => {
    expect(profile.server_optimization.kv_capacity).toBe(geom!.pool);
  });

  it.skipIf(geom === null)('records the unit\'s real rail count', () => {
    expect(profile.server_optimization.parallel_rails).toBe(geom!.rails);
  });

  it.skipIf(geom === null)('derives the session cap from the unit, not a guess', () => {
    expect(profile.context_window).toBe(geom!.pool / geom!.rails);
  });
});

describe('qwen38 profile — describes the engine that is actually running', () => {
  const profile = readJson(PROFILE_PATH);
  const blob = JSON.stringify(profile);

  it('names the llama.cpp fork, not the retired ninfer engine', () => {
    expect(profile._engine).toMatch(/llama/i);
    // Not `^`-anchored: "llama.cpp shim over ninfer-serve" would have slipped
    // past an anchored check.
    expect(profile._engine).not.toMatch(/ninfer/i);
  });

  it('does not assert that llama.cpp endpoints are missing', () => {
    // Guards the CLASS of claim, not one historical sentence.
    expect(blob).not.toMatch(/does not serve[^"]*\/(props|slots|metrics)/i);
    expect(blob).not.toMatch(/serves no \/slots/i);
  });

  it('uses the model alias the server advertises', () => {
    expect(profile.model).toBe('qwen38-gsq-rco-27b');
  });

  it('records the DFlash2 draft model rather than built-in MTP', () => {
    const spec = profile.server_optimization.speculative_decoding;
    expect(spec.enabled).toBe(true);
    expect(spec.type).toBe('draft-dflash');
    expect(spec.draft_model).toMatch(/DFlash2/);
  });

  it('routes through the guardrail proxy, not the inference server', () => {
    expect(profile.routing.endpoint).toBe('http://127.0.0.1:4000/v1');
  });

  it('does not quote a decode number without naming workload and depth', () => {
    // A single rep on "count from 1 to 40" produced 72 tok/s at 90% draft
    // acceptance; real code work is ~43 at ~71% and prose ~27 at ~34%.
    const m = profile.measured;
    expect(m._decode_comment).toMatch(/depth/i);
    expect(m.decode_tokens_per_second).toBeLessThan(50);
    expect(m.draft_acceptance).toBeLessThan(0.85);
  });

  it('does not claim concurrent throughput it has not measured', () => {
    expect(profile.measured.concurrent_2_rail_throughput).toBeNull();
  });
});

describe('project opencode config agrees with the profile', () => {
  const profile = readJson(PROFILE_PATH);
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

  it('enables reasoning, since the server separates thinking output', () => {
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
