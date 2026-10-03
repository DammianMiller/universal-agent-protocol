import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * A `required` tool turn that returns a substantive final answer is a
 * COMPLETION, not a miss.
 *
 * Measured live (opencode + qwen38, 2026-10-03 13:24-13:40): the proxy's
 * tool state machine had forced tool_choice=required for 32 consecutive
 * turns; the model had FINISHED its task and kept emitting session summaries
 * ("Session summary (all uncommitted, 13 files, 234 tests passing): …").
 * Every summary was classified required_tool_miss, retries demanded a tool
 * call, and the streak fed the contamination breaker (3 resets → forced
 * finalize). The forced-finalize branch cleared the malformed/invalid
 * streaks but NOT required_tool_miss_streak — and that streak is itself a
 * reset trigger — so finalize re-fired on EVERY subsequent request
 * (contamination_resets 3→6, four finalize turns in a row, ~4 min of GPU
 * burn) until the client gave up. Operator symptom: "the opencode client
 * keeps stopping or looping".
 *
 * The new decision logic (_required_tool_miss_exempt reusing the reviewed
 * _final_answer_content_exempt gate) and the classification wiring are
 * exercised for real: the functions are sliced out of anthropic_proxy.py
 * and run under python3 against the live shapes — the session-summary
 * completion, the short deflection that must stay caught, and the long
 * deferral capitulation the deferral gate must keep herded back to work.
 */

const proxyPath = join(process.cwd(), 'tools', 'agents', 'scripts', 'anthropic_proxy.py');

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\ndef ', start);
  return source.slice(start, end === -1 ? undefined : end);
}

function sliceAssignment(source: string, name: string): string {
  const start = source.indexOf(`${name} = `);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf(')\n') + 2;
  expect(end).toBeGreaterThan(1);
  return rest.slice(0, end);
}

function sliceClass(source: string, name: string): string {
  // Include the @dataclass decorator when present — without it the sliced
  // class has field annotations but no generated __init__.
  const classStart = source.indexOf(`class ${name}:`);
  expect(classStart).toBeGreaterThan(-1);
  const start = source.lastIndexOf('@dataclass', classStart);
  const sliceFrom = start !== -1 && classStart - start < 40 ? start : classStart;
  const end = source.indexOf('\n\n\n', classStart);
  expect(end).toBeGreaterThan(-1);
  return source.slice(sliceFrom, end);
}

function runClassifier(pythonBody: string): { out: string; status: number | null } {
  const r = spawnSync('python3', ['-'], { input: pythonBody, encoding: 'utf-8', timeout: 30_000 });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

const harness = (source: string, scenario: string) => `
from __future__ import annotations
import re
from dataclasses import dataclass

PROXY_FINAL_ANSWER_CHARS = 800
PROXY_TOOL_ARGS_PREFLIGHT = True

${sliceAssignment(source, '_DEFERRAL_PHRASE_RE')}

${sliceFunction(source, '_final_answer_content_exempt')}

${sliceFunction(source, '_required_tool_miss_exempt')}

${sliceFunction(source, '_extract_openai_choice')}

${sliceFunction(source, '_openai_message_text')}

${sliceFunction(source, '_extract_openai_tool_calls')}

${sliceFunction(source, '_openai_has_tool_calls')}

${sliceClass(source, 'ToolResponseIssue')}

def _is_malformed_tool_response(openai_resp, anthropic_body):
    return False

${sliceFunction(source, '_classify_tool_response_issue')}

${scenario}
`;

const toolBody = `{"tools": [{"name": "edit"}], "messages": []}`;

// Modeled on the live 2026-10-03 13:29-13:36 excerpts: the model finished
// its task and answered with a structured session summary, no tool call.
const sessionSummary = `
summary = (
    "## Session summary\\n"
    "**Code (src/rust-pg-ext, all uncommitted):**\\n"
    "- pipeline_stages.rs — registered actuator ids (from mt_pub subscriptions) now receive the deliberated action values;\\n"
    "- signal_processing/mod.rs — benchmark harness uses std::hint::black_box so the optimizer cannot fold the kernels;\\n"
    "- signal_processing/kernels.rs — the FIR filter window is applied in-place, removing the intermediate buffer allocation;\\n"
    "- telemetry bridge: mt_pub subscription handles are drained before shutdown, so late actuator frames no longer dangle;\\n"
    "- 13 files changed, +254/-3350, 234 tests passing, docs consolidated into the V4 unified-cognition set.\\n"
    "**Verification:** " + "cargo test --all green — 234/234 passing, no warnings. " * 6 +
    "\\n**Remaining:** commit the doc consolidation, re-run the full suite, and hand off the actuator-id broadcast review."
)
resp = {
    "choices": [{
        "finish_reason": "stop",
        "message": {"content": summary, "tool_calls": None},
    }]
}
assert len(summary) >= 800, "scenario setup: summary must clear the threshold"
`;

describe('anthropic_proxy required-tool-miss exemption', () => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
  const havePython = python.status === 0;
  const source = readFileSync(proxyPath, 'utf-8');

  it.skipIf(!havePython)('exempts the live session-summary completion from required_tool_miss', () => {
    const scenario = `
body = ${toolBody}
${sessionSummary}
assert _required_tool_miss_exempt(resp) is True, "a finished model's summary is a miss"
issue = _classify_tool_response_issue(resp, body, required_tool_choice=True)
assert not issue.has_issue(), "substantive completion on a required turn was classified: " + issue.kind
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('still classifies short deflections as required_tool_miss', () => {
    // The cold-start "tries to chat instead of calling a tool" case the
    // forced-required state machine exists for — must stay caught.
    const scenario = `
body = ${toolBody}
resp = {"choices": [{"finish_reason": "stop", "message": {"content": "Let me look at that next.", "tool_calls": None}}]}
assert _required_tool_miss_exempt(resp) is False, "a short deflection was exempted"
issue = _classify_tool_response_issue(resp, body, required_tool_choice=True)
assert issue.has_issue() and issue.kind == "required_tool_miss", "short deflection was not classified required_tool_miss"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('keeps long deferral capitulations herded back to work', () => {
    // The deferral gate from the end-turn fix carries over: 800+ chars of
    // "I need more cycles" is a stall, not a final answer.
    const scenario = `
body = ${toolBody}
text = ("I need more exploration cycles to complete the plan before I can proceed. " +
        "Let me continue investigating the remaining modules, then I will need more passes " +
        "to validate the approach end to end. ") * 6
resp = {"choices": [{"finish_reason": "stop", "message": {"content": text, "tool_calls": None}}]}
assert len(text.strip()) >= 800, "scenario setup: deferral must clear the length threshold"
assert _required_tool_miss_exempt(resp) is False, "long deferral capitulation was exempted"
issue = _classify_tool_response_issue(resp, body, required_tool_choice=True)
assert issue.has_issue() and issue.kind == "required_tool_miss", "long deferral was not classified required_tool_miss"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('never exempts a response that carries tool calls', () => {
    const scenario = `
body = ${toolBody}
resp = {"choices": [{"finish_reason": "tool_calls", "message": {
    "content": "x" * 900,
    "tool_calls": [{"id": "t1", "function": {"name": "edit", "arguments": "{}"}}],
}}]}
assert _required_tool_miss_exempt(resp) is False, "tool-carrying response was exempted"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('disables the exemption with PROXY_FINAL_ANSWER_CHARS=0', () => {
    // 0 = always retry, the documented escape hatch — shared with the
    // end-turn exemption, so it must gate this one too.
    const scenario = `
body = ${toolBody}
${sessionSummary}
globals()["PROXY_FINAL_ANSWER_CHARS"] = 0
assert _required_tool_miss_exempt(resp) is False, "exemption active with knob at 0"
issue = _classify_tool_response_issue(resp, body, required_tool_choice=True)
assert issue.has_issue() and issue.kind == "required_tool_miss", "knob 0 did not restore required_tool_miss"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('does not exempt list-parts content via its repr (security P2-1)', () => {
    // _openai_message_text's str() fallback would stringify a parts list to
    // its repr (~700 chars for ~400 chars of text), inflating short content
    // past the threshold. The exemption must see the RAW content so the
    // count-only-text-parts guard in _final_answer_content_exempt applies.
    const scenario = `
body = ${toolBody}
content = [{"type": "text", "text": "Part summary of the work completed so far today. " * 16}]
resp = {"choices": [{"finish_reason": "stop", "message": {"content": content, "tool_calls": None}}]}
raw_len = sum(len(p.get("text", "")) for p in content if isinstance(p, dict))
assert 400 <= raw_len < 800, "scenario setup: raw text must sit below the threshold"
assert len(repr(content)) >= 800, "scenario setup: repr must inflate past the threshold (raw=" + str(raw_len) + " repr=" + str(len(repr(content))) + ")"
assert _required_tool_miss_exempt(resp) is False, "list-parts repr inflation was exempted"
issue = _classify_tool_response_issue(resp, body, required_tool_choice=True)
assert issue.has_issue() and issue.kind == "required_tool_miss", "repr-inflated parts payload was not a miss"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('does not exempt a max_tokens-truncated completion (finish_reason=length)', () => {
    // A truncated response did not FINISH — its length says nothing about
    // intent, and the truncation paths own that class (architect follow-up).
    const scenario = `
body = ${toolBody}
${sessionSummary}
resp["choices"][0]["finish_reason"] = "length"
assert _required_tool_miss_exempt(resp) is False, "truncated response was exempted"
issue = _classify_tool_response_issue(resp, body, required_tool_choice=True)
assert issue.has_issue() and issue.kind == "required_tool_miss", "truncated completion was not classified required_tool_miss"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('recon-convergence streak does not advance on a substantive completion', () => {
    // The last same-family site (architect follow-up): a finished model's
    // final answer must not count as a no-write stall turn.
    const scenario = `
${sliceFunction(source, '_record_last_assistant_tool_calls')}
# --- minimal monitor + helpers for the sliced function ---
def _extract_text(x):
    return x if isinstance(x, str) else ""

def _seed_tool_history_from_request(monitor, messages):
    pass

class Monitor:
    def __init__(self):
        self.no_tool_turns = 0
        self.last_tool_result_snippet = ""
    def note_tool_result_error(self, tr, err):
        pass
    def note_no_tool_turn(self):
        self.no_tool_turns += 1
    def note_doubling_signal(self, fp, tr, msg_count=0, result_error=None):
        pass
    def record_tool_calls(self, names, tool_targets=None, fingerprint=None):
        pass

summary_text = ("## Session summary\\nAll work complete: the actuator-id broadcast landed, " +
                "234 tests passing, docs consolidated. Hand-off review remains.") * 7
assert len(summary_text.strip()) >= 800, "scenario setup: summary must clear the threshold"
done_body = {"messages": [
    {"role": "user", "content": "do the work"},
    {"role": "assistant", "content": summary_text},
]}
m = Monitor()
_record_last_assistant_tool_calls(done_body, m)
assert m.no_tool_turns == 0, "recon streak advanced on a substantive completion"

stall_body = {"messages": [
    {"role": "user", "content": "do the work"},
    {"role": "assistant", "content": "Looking into it, will continue shortly."},
]}
m2 = Monitor()
_record_last_assistant_tool_calls(stall_body, m2)
assert m2.no_tool_turns == 1, "recon streak did not advance on a short prose stall"

# Multi-block completion parity (architect P2): a summary split across two
# sub-threshold text blocks must still be one completion, not a stall.
split_body = {"messages": [
    {"role": "user", "content": "do the work"},
    {"role": "assistant", "content": [
        {"type": "text", "text": "## Session summary\\nAll work complete: the actuator-id broadcast landed. " * 7},
        {"type": "text", "text": "234 tests passing, docs consolidated. Hand-off review remains. " * 7},
    ]},
]}
block_lens = [len(b["text"]) for b in split_body["messages"][1]["content"]]
assert all(400 <= L < 800 for L in block_lens), "scenario setup: each block alone must sit below the threshold"
m3 = Monitor()
_record_last_assistant_tool_calls(split_body, m3)
assert m3.no_tool_turns == 0, "recon streak advanced on a multi-block completion (last-block-wins bug)"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('never exempts a malformed pseudo-tool payload by length alone', () => {
    // The classification ordering is load-bearing: _is_malformed_tool_response
    // runs BEFORE the exemption, so an 800+ char response carrying tool-XML
    // markers is malformed_payload with exempt=False (the pre-fold code
    // suppressed the miss streak for long malformed prose by length alone).
    // The stub stands in for the real malformed detector; what this pins is
    // the ordering: a malformed detection must win over the length gate.
    const scenario = `
body = ${toolBody}
text = ("<function=edit> " + "let me rewrite the whole module with these changes applied carefully. " * 12 + " </function>")
resp = {"choices": [{"finish_reason": "stop", "message": {"content": text, "tool_calls": None}}]}
assert len(text.strip()) >= 800, "scenario setup: payload must clear the length threshold"
def _is_malformed_tool_response(r, b):
    return True  # the real detector would flag the <function=...> markers
globals()["_is_malformed_tool_response"] = _is_malformed_tool_response
issue = _classify_tool_response_issue(resp, body, required_tool_choice=True)
assert issue.has_issue() and issue.kind == "malformed_payload", "malformed payload was not classified malformed"
assert issue.exempt is False, "malformed payload was exempted by length"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it('wires the exemption into the streak, dampener, retry, and finalize sites (source guard)', () => {
    // The classifier sets exempt=True from the single gate evaluation.
    expect(source).toMatch(
      /if _required_tool_miss_exempt\(openai_resp\):\s*\n\s*return ToolResponseIssue\(exempt=True\)\s*\n\s*return ToolResponseIssue\(\s*\n\s*kind="required_tool_miss"/,
    );
    // The primary streak-increment and dampener gates read issue.exempt — one
    // evaluation, no per-site re-runs (evaluation drift is how this bug family
    // propagates).
    expect(source).toMatch(
      /issue = _classify_tool_response_issue\(\s*\n\s*working_resp,\s*\n\s*anthropic_body,\s*\n\s*required_tool_choice=required_tool_choice,\s*\n\s*\)\s*\n(?:\s*#[^\n]*\n)+(?:\s*#[^\n]*\n)*\s*if required_tool_choice and not has_tool_calls and not issue\.exempt:\s*\n\s*monitor\.required_tool_miss_streak \+= 1/,
    );
    expect(source).toMatch(
      /if required_tool_choice and not has_tool_calls and not issue\.exempt:\s*\n\s*monitor\.maybe_activate_forced_tool_dampener\("required_tool_miss"\)/,
    );
    // The retry path reads retry_issue.exempt from its own single evaluation.
    expect(source).toMatch(
      /retry_issue = _classify_tool_response_issue\(\s*\n\s*retry_working,\s*\n\s*anthropic_body,\s*\n\s*required_tool_choice=retry_required,\s*\n\s*\)\s*\n(?:\s*#[^\n]*\n)*\s*if \(\s*\n\s*retry_required\s*\n\s*and not retry_has_tool_calls\s*\n\s*and not retry_issue\.exempt\s*\n\s*\):\s*\n\s*monitor\.required_tool_miss_streak \+= 1/,
    );
    // The forced-finalize branch must clear the required-miss streak too —
    // otherwise a condemned session re-forces finalize on every request.
    expect(source).toMatch(
      /reason="contamination_loop"\s*\)[\s\S]{0,900}monitor\.required_tool_miss_streak = 0/,
    );
    // The knob accepts the renamed spelling with the old env as fallback.
    expect(source).toMatch(
      /PROXY_FINAL_ANSWER_CHARS = int\(\s*\n\s*os\.environ\.get\("PROXY_FINAL_ANSWER_CHARS"\)\s*\n\s*or os\.environ\.get\("PROXY_END_TURN_FINAL_CHARS"\)\s*\n\s*or "800"\s*\n\)/,
    );
    // The recon-convergence Fix B gate consults the shared exemption.
    expect(source).toMatch(
      /if assistant_had_text and not _final_answer_content_exempt\(assistant_prose\):\s*\n\s*monitor\.note_no_tool_turn\(\)/,
    );
  });
});
