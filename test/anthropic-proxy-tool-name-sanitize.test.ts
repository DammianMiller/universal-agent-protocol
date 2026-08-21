import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Upstream-safe tool names.
 *
 * Measured 2026-08-21 against the live llama-server: a tool named
 * `uap-router_deliver` (opencode's "<mcp-server>_<tool>" spelling) makes
 * every request with tool_choice=required fail with HTTP 400 "Failed to
 * initialize samplers: failed to parse grammar"; the identical schema named
 * `uap_router_deliver` succeeds. The proxy's RECON hard tier restores exactly
 * that tool and forces `required`, so the client's stream died and the
 * opencode session sat idle for ten hours.
 *
 * The real functions are sliced out of anthropic_proxy.py and run under
 * python3 (logger stubbed) — a source-text assertion cannot prove a rename
 * round-trips.
 */
const proxyPath = join(process.cwd(), 'tools/agents/scripts/anthropic_proxy.py');

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\ndef ', start);
  return source.slice(start, end === -1 ? undefined : end);
}

function py(body: string): { out: string; status: number | null } {
  const r = spawnSync('python3', ['-'], { input: body, encoding: 'utf-8', timeout: 30_000 });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

const source = readFileSync(proxyPath, 'utf-8');
const prelude = [
  'import json, re',
  'class _L:',
  '    def info(self, *a, **k): pass',
  '    def warning(self, *a, **k): pass',
  'logger = _L()',
  '_UPSTREAM_TOOL_NAME_BAD_RE = re.compile(r"[^A-Za-z0-9_]")',
  '_UPSTREAM_TOOL_NAME_MAP = {}',
  sliceFunction(source, '_sanitize_tool_name'),
  sliceFunction(source, '_sanitize_tool_names_for_upstream'),
  sliceFunction(source, '_restore_tool_name'),
  sliceFunction(source, '_is_gemma4_peg_parse_failure'),
  sliceFunction(source, '_relax_tool_choice_for_gemma4_peg_retry'),
].join('\n');

describe('anthropic_proxy upstream tool-name sanitization', () => {
  it('renames hyphen/dot names on the way up and restores them on the way down', () => {
    const r = py(`${prelude}
body = {
  "tools": [
    {"type": "function", "function": {"name": "uap-router_deliver", "parameters": {}}},
    {"type": "function", "function": {"name": "mcp__claude-in-chrome__navigate", "parameters": {}}},
    {"type": "function", "function": {"name": "edit", "parameters": {}}},
  ],
  "messages": [
    {"role": "assistant", "tool_calls": [{"id": "1", "type": "function", "function": {"name": "uap-router_deliver", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "1", "content": "ok"},
  ],
  "tool_choice": {"type": "function", "function": {"name": "uap-router_deliver"}},
}
n = _sanitize_tool_names_for_upstream(body)
names = [t["function"]["name"] for t in body["tools"]]
print(json.dumps({
  "n": n,
  "names": names,
  "history": body["messages"][0]["tool_calls"][0]["function"]["name"],
  "choice": body["tool_choice"]["function"]["name"],
  "restored": [_restore_tool_name(x) for x in names],
  "again": _sanitize_tool_names_for_upstream(body),
  "unknown": _restore_tool_name("edit"),
}))
`);
    expect(r.status).toBe(0);
    const got = JSON.parse(r.out.trim().split('\n').pop() as string);
    expect(got.n).toBe(2);
    expect(got.names).toEqual(['uap_router_deliver', 'mcp__claude_in_chrome__navigate', 'edit']);
    expect(got.history).toBe('uap_router_deliver');
    expect(got.choice).toBe('uap_router_deliver');
    expect(got.restored).toEqual(['uap-router_deliver', 'mcp__claude-in-chrome__navigate', 'edit']);
    expect(got.again).toBe(0); // idempotent on a retry
    expect(got.unknown).toBe('edit');
  });

  it('never collides a sanitized name with a tool that already owns it', () => {
    const r = py(`${prelude}
body = {"tools": [
  {"type": "function", "function": {"name": "a_b", "parameters": {}}},
  {"type": "function", "function": {"name": "a-b", "parameters": {}}},
  {"type": "function", "function": {"name": "a.b", "parameters": {}}},
], "messages": []}
_sanitize_tool_names_for_upstream(body)
names = [t["function"]["name"] for t in body["tools"]]
print(json.dumps({"names": names, "back": [_restore_tool_name(x) for x in names]}))
`);
    expect(r.status).toBe(0);
    const got = JSON.parse(r.out.trim().split('\n').pop() as string);
    expect(new Set(got.names).size).toBe(3);
    expect(got.names[0]).toBe('a_b');
    expect(got.back).toEqual(['a_b', 'a-b', 'a.b']);
  });

  it('treats the 400 "failed to parse grammar" like the PEG failure: relax required -> auto and retry', () => {
    const r = py(`${prelude}
err = '{"error":{"code":400,"message":"Failed to initialize samplers: failed to parse grammar","type":"invalid_request_error"}}'
body = {"tools": [{"type": "function", "function": {"name": "x"}}], "tool_choice": "required"}
hit = _is_gemma4_peg_parse_failure(400, err)
relaxed = _relax_tool_choice_for_gemma4_peg_retry(body, "test")
print(json.dumps({"hit": hit, "relaxed": relaxed, "choice": body["tool_choice"],
  "ctx_overflow_not_hit": _is_gemma4_peg_parse_failure(400, "request exceeds the context size"),
  "peg_still_hit": _is_gemma4_peg_parse_failure(500, "Failed to parse input at pos 3: <|tool_call>call:x")}))
`);
    expect(r.status).toBe(0);
    const got = JSON.parse(r.out.trim().split('\n').pop() as string);
    expect(got.hit).toBe(true);
    expect(got.relaxed).toBe(true);
    expect(got.choice).toBe('auto');
    expect(got.ctx_overflow_not_hit).toBe(false);
    expect(got.peg_still_hit).toBe(true);
  });

  it('guardrail lookups accept the sanitized spelling the upstream actually uses', () => {
    const r = py(`${prelude}
${sliceFunction(source, '_tool_schema_map_from_anthropic_body')}
${sliceFunction(source, '_anthropic_tools_by_name')}
body = {"tools": [{"name": "uap-router_deliver", "input_schema": {"type": "object"}}, {"name": "edit", "input_schema": {}}]}
a = _tool_schema_map_from_anthropic_body(body); b = _anthropic_tools_by_name(body)
print(json.dumps({"a": sorted(a), "b": sorted(b), "same": a["uap_router_deliver"] is a["uap-router_deliver"]}))
`);
    expect(r.status).toBe(0);
    const got = JSON.parse(r.out.trim().split('\n').pop() as string);
    expect(got.a).toEqual(['edit', 'uap-router_deliver', 'uap_router_deliver']);
    expect(got.b).toEqual(['edit', 'uap-router_deliver', 'uap_router_deliver']);
    expect(got.same).toBe(true);
  });

  it('is applied once, right before the wire, in the Messages handler', () => {
    const idx = source.indexOf('_sanitize_tool_names_for_upstream(openai_body)');
    expect(idx).toBeGreaterThan(-1);
    // before the guarded/stream/non-stream split so all three POST paths get it
    expect(source.indexOf('use_guarded_non_stream = _should_use_guarded_non_stream(', idx)).toBeGreaterThan(idx);
    // and restored on every tool_use emission path
    expect(source.match(/_restore_tool_name\(fn\.get\("name", ""\)\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
