import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Model placement admission gate (spec §4.3), exercised for real.
 *
 * The gate is behavioral, so — like the end-turn classifier tests — its
 * functions are sliced out of anthropic_proxy.py with their helpers and run
 * under python3 against the live shapes:
 *
 *   - mode=off is byte-identical: the gate returns None (forward) before
 *     touching anything, and _reconcile_wire_model still rewrites as today.
 *   - ask mode parks a non-resident id as 409 model_placement_pending with
 *     the contract body (placement_id, requested_model, retry_after_ms,
 *     resolve_with), and dedupes (client, model) retries onto one
 *     placement_id.
 *   - ask mode forwards a resident id and forwards on no-knowledge
 *     (upstream ids unprobed: the same fail-open direction the reconciler
 *     takes with the same cache).
 *   - a controller forward answer sets the per-request placement target,
 *     which the per-target semaphore budget keys off.
 *   - in ask mode the reconciler no longer silently rewrites an unserved id
 *     to ids[0] — parking is the operator's answer, not an automatic swap.
 *   - the per-target semaphore map gives non-default targets their own
 *     budget while the default bucket stays the module-global semaphore.
 *   - invalidate_upstream_caches clears every process-lifetime view of the
 *     upstream, and an operator pin (chat_template_kwargs=on) survives a
 *     swap while a probe result does not.
 */

const proxyPath = join(process.cwd(), 'tools', 'agents', 'scripts', 'anthropic_proxy.py');
const source = readFileSync(proxyPath, 'utf-8');

function sliceFunction(src: string, name: string): string {
  // async defs first: 'def name(' would match INSIDE 'async def name(' and
  // slice off the async keyword.
  const asyncStart = src.indexOf(`async def ${name}(`);
  const start = asyncStart > -1 ? asyncStart : src.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\ndef ', start);
  const endAsync = src.indexOf('\nasync def ', start);
  const stops = [end, endAsync].filter((i) => i > start);
  const stop = stops.length ? Math.min(...stops) : -1;
  return src.slice(start, stop === -1 ? undefined : stop + 1);
}

function runPython(body: string): Record<string, unknown> {
  const r = spawnSync('python3', ['-'], { input: body, encoding: 'utf-8', timeout: 60_000 });
  if (r.status !== 0) {
    throw new Error(`python3 harness failed (${r.status}): ${r.stdout}${r.stderr}`);
  }
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

const GATE_PREAMBLE = `
import asyncio, contextvars, json, logging, re, time, uuid
from fastapi import Response

logger = logging.getLogger('t')

PROXY_PLACEMENT_MODE = '__MODE__'
PROXY_PLACEMENT_CONTROLLER = '__CONTROLLER__'
PROXY_PLACEMENT_HOLD_SECS = 0.0
_PLACEMENT_BURST_DEDUPE_SECS = 5.0
_PLACEMENT_TARGET_RE = re.compile(r"^[A-Za-z0-9_.\\-]+:\\S+$")
_PLACEMENT_MAX_TARGETS = 8

http_client = None
LLAMA_CPP_BASE = 'http://harness.invalid/v1'
_upstream_model_ids = __IDS__
_current_placement_target = contextvars.ContextVar('t', default=None)
_placement_pending = {}

${sliceFunction(source, '_placement_controller_admit')}
${sliceFunction(source, '_upstream_model_ids_cached')}
${sliceFunction(source, '_placement_park_response')}
${sliceFunction(source, '_placement_admit')}
`;

describe('proxy placement gate', () => {
  it('mode=off is byte-identical: the gate forwards before touching anything', () => {
    const out = runPython(GATE_PREAMBLE
      .replace('__MODE__', 'off')
      .replace('__CONTROLLER__', 'http://127.0.0.1:3847')
      .replace('__IDS__', "['qwen3.8-flash-next-iq3_s']")
      + `
out = {"res": asyncio.run(_placement_admit('Qwen3.8-27B', 'claude-code', 's1')),
       "pending": len(_placement_pending)}
print(json.dumps(out))
`);
    // Forwarded (None), and nothing was recorded even though a controller was
    // configured and the model is not resident — off means off, first line.
    expect(out.res).toBeNull();
    expect(out.pending).toBe(0);
  });

  it('ask mode, no controller: parks a non-resident id as 409 model_placement_pending', () => {
    const out = runPython(GATE_PREAMBLE
      .replace('__MODE__', 'ask')
      .replace('__CONTROLLER__', '')
      .replace('__IDS__', "['qwen3.8-flash-next-iq3_s']")
      + `
resp = asyncio.run(_placement_admit('Qwen3.8-27B', 'claude-code', 's1'))
body = json.loads(resp.body)
out = {
    "status": resp.status_code,
    "media_type": resp.media_type,
    "type": body["type"],
    "error_type": body["error"]["type"],
    "placement_id": body["error"]["placement_id"],
    "requested_model": body["error"]["requested_model"],
    "reason": body["error"]["reason"],
    "has_retry": isinstance(body["error"].get("retry_after_ms"), int),
    "has_resolve": bool(body["error"].get("resolve_with")),
    "pending_map": len(_placement_pending),
}
print(json.dumps(out))
`);
    expect(out.status).toBe(409);
    expect(out.media_type).toBe('application/json');
    expect(out.type).toBe('error');
    expect(out.error_type).toBe('model_placement_pending');
    expect(String(out.placement_id)).toMatch(/^plc-[0-9a-f]{6}$/);
    expect(out.requested_model).toBe('Qwen3.8-27B');
    expect(out.reason).toBe('not_resident');
    expect(out.has_retry).toBe(true);
    expect(out.has_resolve).toBe(true);
    expect(out.pending_map).toBe(1);
  });

  it('ask mode dedupes (client, model) retries onto one placement_id', () => {
    const out = runPython(GATE_PREAMBLE
      .replace('__MODE__', 'ask')
      .replace('__CONTROLLER__', '')
      .replace('__IDS__', "['qwen3.8-flash-next-iq3_s']")
      + `
r1 = asyncio.run(_placement_admit('Qwen3.8-27B', 'claude-code', 's1'))
r2 = asyncio.run(_placement_admit('Qwen3.8-27B', 'claude-code', 's2'))
r3 = asyncio.run(_placement_admit('Qwen3.8-27B', 'codex', 's3'))
out = {"ids": [json.loads(r.body)["error"]["placement_id"] for r in (r1, r2, r3)],
       "pending_map": len(_placement_pending)}
print(json.dumps(out))
`);
    const ids = out.ids as string[];
    expect(ids[0]).toBe(ids[1]); // same (client, model) → same id, one prompt
    expect(ids[2]).not.toBe(ids[0]); // different client → its own prompt
    expect(out.pending_map).toBe(2);
  });

  it('ask mode forwards a resident id, and forwards on no-knowledge (unprobed)', () => {
    const out = runPython(GATE_PREAMBLE
      .replace('__MODE__', 'ask')
      .replace('__CONTROLLER__', '')
      .replace('__IDS__', "['qwen3.8-flash-next-iq3_s', 'Qwen3.8-27B']")
      + `
resident = asyncio.run(_placement_admit('Qwen3.8-27B', 'claude-code', 's1'))
_upstream_model_ids = None   # cache cold: the same fail-open the reconciler takes
unknown = asyncio.run(_placement_admit('Qwen3.8-27B', 'claude-code', 's1'))
out = {"resident": resident, "unknown": unknown, "pending_map": len(_placement_pending)}
print(json.dumps(out))
`);
    expect(out.resident).toBeNull();
    expect(out.unknown).toBeNull();
    expect(out.pending_map).toBe(0);
  });

  it('a controller forward answer sets the per-request placement target', () => {
    const out = runPython(GATE_PREAMBLE
      .replace('__MODE__', 'ask')
      .replace('__CONTROLLER__', 'http://127.0.0.1:3847')
      .replace('__IDS__', 'None')
      + `
async def _placement_controller_admit(model_id, client_id, session_id):
    return {"decision": "forward", "target_id": "gpu0:http://192.168.1.165:8080/v1"}

# Awaited directly inside ONE coroutine, like the real handler: the gate is
# awaited in the request handler's own context (asyncio.run would copy the
# context into a task and the set would not escape it).
async def main():
    res = await _placement_admit('Qwen3.8-27B', 'claude-code', 's1')
    return {"res": res, "target": _current_placement_target.get()}
print(json.dumps(asyncio.run(main())))
`);
    expect(out.res).toBeNull();
    expect(out.target).toBe('gpu0:http://192.168.1.165:8080/v1');
  });

  it('a controller park answer carries the controller placement_id and reason', () => {
    const out = runPython(GATE_PREAMBLE
      .replace('__MODE__', 'ask')
      .replace('__CONTROLLER__', 'http://127.0.0.1:3847')
      .replace('__IDS__', "['qwen3.8-flash-next-iq3_s']")
      + `
async def _placement_controller_admit(model_id, client_id, session_id):
    return {"decision": "park", "placement_id": "plc-7f2a", "reason": "no_measured_config"}
resp = asyncio.run(_placement_admit('Qwen3.8-27B', 'claude-code', 's1'))
body = json.loads(resp.body)
out = {"status": resp.status_code, "id": body["error"]["placement_id"],
       "reason": body["error"]["reason"], "pending_map": len(_placement_pending)}
print(json.dumps(out))
`);
    expect(out.status).toBe(409);
    expect(out.id).toBe('plc-7f2a');
    expect(out.reason).toBe('no_measured_config');
    expect(out.pending_map).toBe(1);
  });

  it('parks with reason unroutable_target when the controller forwards an id this upstream does not serve', () => {
    // Multi-backend guard: the controller may vouch for a resident on ANOTHER
    // endpoint; this proxy posts to one discovered upstream, so an id the
    // upstream does not serve parks rather than being sent to it raw.
    const out = runPython(GATE_PREAMBLE
      .replace('__MODE__', 'ask')
      .replace('__CONTROLLER__', 'http://127.0.0.1:3847')
      .replace('__IDS__', "['qwen3.8-flash-next-iq3_s']")
      + `
async def _placement_controller_admit(model_id, client_id, session_id):
    return {"decision": "forward", "target_id": "gpu1:http://192.168.1.166:8080/v1"}
async def main():
    resp = await _placement_admit('Qwen3.8-27B', 'claude-code', 's1')
    body = json.loads(resp.body)
    return {"status": resp.status_code, "reason": body["error"]["reason"],
            "target": _current_placement_target.get()}
print(json.dumps(asyncio.run(main())))
`);
    expect(out.status).toBe(409);
    expect(out.reason).toBe('unroutable_target');
    // The off-route target was never adopted as a concurrency budget key.
    expect(out.target).toBeNull();
  });
});

describe('proxy placement: reconciler and per-target budget', () => {
  it('ask mode disables the silent rewrite; off mode keeps it (byte-identical)', () => {
    const harness = (mode: string, ids: string | null, model: string) => `
import asyncio, json, logging, time, uuid
logger = logging.getLogger('t')

PROXY_PLACEMENT_MODE = '${mode}'
http_client = None
_upstream_model_ids = ${ids ?? 'None'}
_rewritten_model_ids = set()

${sliceFunction(source, '_upstream_model_ids_cached')}
${sliceFunction(source, '_reconcile_wire_model')}

async def main():
    body = {"model": "${model}"}
    await _reconcile_wire_model(body)
    return body["model"]
print(json.dumps({"model": asyncio.run(main())}))
`;
    // off: the legacy silent fallback rewrites an unserved id to ids[0].
    expect(runPython(harness('off', "['strata-id']", 'Qwen3.8-27B')).model).toBe('strata-id');
    // ask: the gate replaces the fallback — an unserved id is NEVER rewritten.
    expect(runPython(harness('ask', "['strata-id']", 'Qwen3.8-27B')).model).toBe('Qwen3.8-27B');
    // off, served id: untouched (the reconciler only touches what it must).
    expect(runPython(harness('off', "['Qwen3.8-27B']", 'Qwen3.8-27B')).model).toBe('Qwen3.8-27B');
  });

  it('per-target semaphore map: default is the legacy global, others get their own budget', () => {
    const out = runPython(`
import asyncio, json, re
PROXY_CONCURRENCY_LIMIT = 1
upstream_semaphore = asyncio.Semaphore(1)
_upstream_semaphores = {}
_PLACEMENT_MAX_TARGETS = 8

${sliceFunction(source, '_semaphore_for')}

async def main():
    default_sem = _semaphore_for(None)
    named_sem = _semaphore_for('gpu0:http://192.168.1.165:8080/v1')
    cached_sem = _semaphore_for('gpu0:http://192.168.1.165:8080/v1')
    # Independent budgets: the named target's slot does not touch default's.
    async with named_sem:
        default_free = not default_sem.locked()
    return {
        "default_is_global": default_sem is upstream_semaphore,
        "default_before_init_is_none": _semaphore_for('never-inited') is not upstream_semaphore,
        "named_distinct": named_sem is not upstream_semaphore,
        "named_cached": named_sem is cached_sem,
        "independent": default_free,
    }
print(json.dumps(asyncio.run(main())))
`);
    expect(out.default_is_global).toBe(true);
    expect(out.default_before_init_is_none).toBe(true);
    expect(out.named_distinct).toBe(true);
    expect(out.named_cached).toBe(true);
    expect(out.independent).toBe(true);
  });

  it('invalidate_upstream_caches clears every view; operator pins survive, probe results do not', () => {
    // Probe-era state ('auto'): everything resets.
    const resultAuto = runPython(rawHarness('auto', 'True', 'True'));
    expect(resultAuto.cleared).toContain('upstream_model_ids');
    expect(resultAuto.cleared).toContain('chat_template_kwargs_probe');
    expect(resultAuto.cleared).toContain('context_window');
    expect(resultAuto.cleared).toContain('vision');
    expect(resultAuto.ids_none).toBe(true);
    expect(resultAuto.ctx).toBe(0);
    expect(resultAuto.ctx_measured).toBe(false);
    expect(resultAuto.vision).toBe(false);
    expect(resultAuto.vision_recheck_armed).toBe(true);
    expect(resultAuto.admitted).toBe(0);
    // A parked request does not keep re-parking after a swap: the burst map
    // clears with everything else (spec §4.6 step 7).
    expect(resultAuto.cleared).toContain('placement_pending');
    expect(resultAuto.placement_pending).toBe(0);
    expect(resultAuto.ctk_supported).toBeNull();
    expect(resultAuto.ctk_probed).toBe(false);
    expect(resultAuto.ctk_attempts).toBe(0);
    // Operator pin ('on'): the pin survives the swap — it is an assertion
    // about THIS operator's backends, not a probe result to re-run.
    const resultPin = runPython(rawHarness('on', 'True', 'True'));
    expect((resultPin.cleared as string[])).not.toContain('chat_template_kwargs_probe');
    expect(resultPin.ctk_supported).toBe(true);
  });

  function rawHarness(ctk: string, supported: string, probed: string): string {
    return `
import json, logging, time
logger = logging.getLogger('t')
from collections import OrderedDict

PROXY_CHAT_TEMPLATE_KWARGS = '${ctk}'
_upstream_model_ids = ['strata-id']
_rewritten_model_ids = {'old-id'}
_ctk_supported = ${supported}
_ctk_probed = ${probed}
_ctk_probe_attempts = 3
default_context_window = 114688
_context_window_measured = True
_last_ctx_recheck_ts = 123.0
upstream_vision = True
_last_vision_recheck_ts = 5.0
_admitted_sessions = OrderedDict({'s1': 1.0, 's2': 2.0})
_now = time.time()
_placement_pending = {
    ('claude-code', 'Qwen3.8-27B'): {
        'placement_id': 'plc-stale', 'reason': 'not_resident',
        'created_at': _now, 'expires_at': _now + 3.0,
    }
}

${sliceFunction(source, 'invalidate_upstream_caches')}

cleared = invalidate_upstream_caches()
print(json.dumps({
    "cleared": cleared,
    "ids_none": _upstream_model_ids is None,
    "ctx": default_context_window,
    "ctx_measured": _context_window_measured,
    "vision": upstream_vision,
    "vision_recheck_armed": _last_vision_recheck_ts == 0.0,
    "admitted": len(_admitted_sessions),
    "placement_pending": len(_placement_pending),
    "ctk_supported": _ctk_supported,
    "ctk_probed": _ctk_probed,
    "ctk_attempts": _ctk_probe_attempts,
}))
`;
  }
});
