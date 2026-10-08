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

function sliceFunction(src: string, name: string, extraStops: string[] = []): string {
  // async defs first: 'def name(' would match INSIDE 'async def name(' and
  // slice off the async keyword.
  const asyncStart = src.indexOf(`async def ${name}(`);
  const start = asyncStart > -1 ? asyncStart : src.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\ndef ', start);
  const endAsync = src.indexOf('\nasync def ', start);
  const stops = [end, endAsync, ...extraStops.map((p) => src.indexOf(p, start))].filter(
    (i) => i > start,
  );
  const stop = stops.length ? Math.min(...stops) : -1;
  return src.slice(start, stop === -1 ? undefined : stop + 1);
}

function sliceClass(src: string, name: string): string {
  // Column-0 boundaries only: the class BODY's indented defs/decorators
  // must not end the slice.
  const start = src.indexOf(`class ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const stops = ['\nclass ', '\ndef ', '\nasync def ', '\n@']
    .map((p) => src.indexOf(p, start))
    .filter((i) => i > start);
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
    "retry_after_header": resp.headers.get("retry-after"),
    "type": body["type"],
    "error_type": body["error"]["type"],
    "message": body["error"]["message"],
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
    // The re-poll floor is also a header for non-SDK tooling.
    expect(out.retry_after_header).toBe('2');
    expect(out.type).toBe('error');
    expect(out.error_type).toBe('model_placement_pending');
    // message is the one field every Anthropic SDK surface renders to the
    // human — the operator instructions live there (api-designer sign-off).
    expect(String(out.message)).toContain('Qwen3.8-27B');
    expect(String(out.message)).toContain('uap models pending');
    expect(String(out.message)).toMatch(/plc-[0-9a-f]{6}/);
    expect(String(out.placement_id)).toMatch(/^plc-[0-9a-f]{6}$/);
    expect(out.requested_model).toBe('Qwen3.8-27B');
    // Read-only admission (no controller): a different operator action than
    // not_resident — start the dashboard / set PROXY_PLACEMENT_CONTROLLER.
    expect(out.reason).toBe('no_controller');
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

describe('proxy placement: in-flight view at the send() choke point', () => {
  it('generation calls register per target; probes and controller posts do not', () => {
    // Found live: the first registration guarded only _post_with_retry, and
    // a real request went through a guardrail pass that posts directly —
    // the drain view showed an empty list mid-generation. The registration
    // belongs where every call site funnels: the client's send().
    const out = runPython(`
import asyncio, contextvars, json, logging, os, re, time, uuid
import httpx
logger = logging.getLogger('t')

_current_placement_target = contextvars.ContextVar('tgt', default=None)
_current_request_client = contextvars.ContextVar('cli', default=None)
_current_request_session = contextvars.ContextVar('sess', default=None)
_placement_inflight = {}

${sliceFunction(source, '_placement_inflight_register')}
${sliceFunction(source, '_placement_inflight_remove', ['\n\n\n#'])}

def main():
    # Not generation calls: a slot probe GET, the controller admit POST,
    # and a loopback refresh POST stay out of the drain view.
    t_probe, e_probe = _placement_inflight_register(httpx.Request('GET', 'http://h/slots'))
    t_admit, e_admit = _placement_inflight_register(httpx.Request('POST', 'http://h/api/placement/admit'))
    probes_out = dict(_placement_inflight)

    # Default bucket: a chat completion with no target set.
    _current_request_client.set('claude-code')
    t_def, e_def = _placement_inflight_register(httpx.Request('POST', 'http://h/v1/chat/completions'))
    default_keys = sorted(_placement_inflight.keys())
    default_entry = dict(_placement_inflight['default'][0])
    _placement_inflight_remove(t_def, e_def)
    default_clean = dict(_placement_inflight)

    # Target bucket: the admission gate set device:endpoint for this request.
    _current_placement_target.set('gpu0:http://192.168.1.165:8080/v1')
    t_tgt, e_tgt = _placement_inflight_register(httpx.Request('POST', 'http://h/completions'))
    target_keys = sorted(_placement_inflight.keys())
    _placement_inflight_remove(t_tgt, e_tgt)
    target_clean = dict(_placement_inflight)

    # Double-remove is a no-op (the ValueError path), not a crash.
    _placement_inflight_remove(t_tgt, e_tgt)
    double_remove_ok = all(len(v) == 0 for v in _placement_inflight.values())

    # Non-generation calls returned (None, None) markers.
    return {
        "probe_skipped": t_probe is None and e_probe is None,
        "admit_skipped": t_admit is None and e_admit is None,
        "probes_out": probes_out,
        "default_keys": default_keys,
        "default_entry": default_entry,
        # Empty list KEPT: "target known, nothing in flight" — the honest
        # session-idle signal the §4.5 preview distinguishes from unknown.
        "default_clean": default_clean,
        "target_keys": target_keys,
        "target_clean": target_clean,
        "double_remove_ok": double_remove_ok,
    }
print(json.dumps(main()))
`);
    expect(out.probe_skipped).toBe(true);
    expect(out.admit_skipped).toBe(true);
    expect(out.probes_out).toEqual({});
    expect(out.default_keys).toEqual(['default']);
    expect(out.default_entry.client).toBe('claude-code');
    expect(out.default_entry.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.default_clean).toEqual({ default: [] });
    // 'default' is KEPT (empty) from the default-bucket removal above —
    // keys persist once a target is known; lists go empty, not absent.
    expect(out.target_keys).toEqual(['default', 'gpu0:http://192.168.1.165:8080/v1']);
    expect(out.target_clean).toEqual({
      default: [],
      'gpu0:http://192.168.1.165:8080/v1': [],
    });
    expect(out.double_remove_ok).toBe(true);
  });

  it('the send() choke point wires the registration, and _post_with_retry no longer double-registers', () => {
    // Structure, not behavior: send() must bracket super().send with the
    // register/remove pair (the wiring the live smoke verified), and
    // _post_with_retry must NOT append to _placement_inflight anymore (it
    // did before the move; double registration would double-count).
    const sendSrc = sliceClass(source, 'DisconnectAwareClient');
    expect(sendSrc).toContain('_placement_inflight_register(request)');
    expect(sendSrc).toContain('_placement_inflight_remove(_inflight_target, _inflight_entry)');
    // Streaming: removal is handed to the response (close/read), because
    // send(stream=True) returns at HEADERS while generation continues.
    expect(sendSrc).toContain('kwargs.get("stream")');
    expect(sendSrc).toContain('_placement_inflight_hold_stream(resp, _inflight_target, _inflight_entry)');
    expect(sendSrc).toContain('_inflight_entry = None  # the response owns removal now');
    const retrySrc = sliceFunction(source, '_post_with_retry');
    expect(retrySrc).not.toContain('_placement_inflight.setdefault');
    expect(retrySrc).toContain('_release_upstream_slot(_placement_target)');
  });

  it('streaming entries live until the response closes or is fully read (send() returns at headers)', () => {
    // The blocker found by review: a streamed generation runs on AFTER
    // send() returns (headers only). Removing at send()'s finally reported
    // idle mid-stream, and a drain acting on that view hard-kills the
    // active generation. Removal must fire on close/read — and once only.
    const out = runPython(`
import asyncio, contextvars, json, logging, os, re, time, uuid
import httpx
logger = logging.getLogger('t')

_current_placement_target = contextvars.ContextVar('tgt', default=None)
_current_request_client = contextvars.ContextVar('cli', default=None)
_current_request_session = contextvars.ContextVar('sess', default=None)
_placement_inflight = {}

${sliceFunction(source, '_placement_inflight_register')}
${sliceFunction(source, '_placement_inflight_remove', ['\n\n\n#'])}
${sliceFunction(source, '_placement_inflight_hold_stream', ['\n\n\n#'])}

class FakeStreamedResponse:
    """Duck-typed httpx.Response: only the four close/read surfaces."""
    def __init__(self):
        self.closed = False
    def close(self):
        self.closed = True
    async def aclose(self):
        self.closed = True
    def read(self):
        return b""
    async def aread(self):
        return b""

def snap():
    # DEEP-enough snapshot: dict(...) is shallow, so the shared entry list
    # would keep mutating under later removals and lie about past states.
    return {k: list(v) for k, v in _placement_inflight.items()}

def main():
    _current_placement_target.set('gpu0:http://192.168.1.165:8080/v1')
    resp = FakeStreamedResponse()
    target, entry = _placement_inflight_register(
        httpx.Request('POST', 'http://h/v1/chat/completions')
    )
    _placement_inflight_hold_stream(resp, target, entry)
    # send() has returned at headers; the entry must still be live.
    mid_stream_live = len(_placement_inflight.get('gpu0:http://192.168.1.165:8080/v1', [])) == 1
    asyncio.run(resp.aclose())  # aclose is async — await it or it never runs
    after_close = snap()
    resp.close()  # idempotent: second hook does not resurrect or crash
    resp.read()
    after_double = snap()
    # Full read instead of close: aread() exhausts and removes.
    resp2 = FakeStreamedResponse()
    t2, e2 = _placement_inflight_register(
        httpx.Request('POST', 'http://h/v1/chat/completions')
    )
    _placement_inflight_hold_stream(resp2, t2, e2)
    before_read_live = len(_placement_inflight.get('gpu0:http://192.168.1.165:8080/v1', [])) == 1
    asyncio.run(resp2.aread())
    after_read = snap()
    # Entries are identity-distinct (uuid id): two identical requests do not
    # alias each other on removal.
    t3, e3 = _placement_inflight_register(
        httpx.Request('POST', 'http://h/v1/chat/completions')
    )
    t4, e4 = _placement_inflight_register(
        httpx.Request('POST', 'http://h/v1/chat/completions')
    )
    distinct = e3["id"] != e4["id"]
    _placement_inflight_remove(t3, e3)
    _placement_inflight_remove(t4, e4)
    return {
        "mid_stream_live": mid_stream_live,
        "after_close": after_close,
        "after_double": after_double,
        "before_read_live": before_read_live,
        "after_read": after_read,
        "distinct_ids": distinct,
    }
print(json.dumps(main()))
`);
    expect(out.mid_stream_live).toBe(true);
    // Empty list KEPT after removal: the target is known-idle, not unknown.
    expect(out.after_close).toEqual({ 'gpu0:http://192.168.1.165:8080/v1': [] });
    expect(out.after_double).toEqual({ 'gpu0:http://192.168.1.165:8080/v1': [] });
    expect(out.before_read_live).toBe(true);
    expect(out.after_read).toEqual({ 'gpu0:http://192.168.1.165:8080/v1': [] });
    expect(out.distinct_ids).toBe(true);
  });
});
