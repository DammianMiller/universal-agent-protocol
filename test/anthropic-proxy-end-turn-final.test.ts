import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The unexpected-end-turn retry must not fight a FINISHED model.
 *
 * Measured live (opencode + qwen38, 2026-10-03 01:00-03:00): the model
 * completed its task and ended its turn with a real final answer
 * ("Task complete — recap delivered and one concrete defect fixed. Summary:…",
 * 2211 chars). _is_unexpected_end_turn saw only "end_turn without tool_use in
 * a conversation with tool results" — true, but not a stall. The retry
 * coerced the finished model back into a tool call 96 times over two hours;
 * a coerced finished model emits a degenerate no-op (the identical
 * `git status` call every cycle), so the loop spun until the retry itself
 * refused. Operator symptom: "the opencode client keeps stopping or looping".
 *
 * The fix is behavioral, so it is exercised for real: the classifier is
 * sliced out of anthropic_proxy.py with its helpers and run under python3
 * against the live shapes — the 2211-char completion, the empty thinking-
 * runaway stall it must keep catching, and the short "I'll wait" stall.
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
  // Module-level re.compile(...) call: ends at the line that closes the call.
  const rest = source.slice(start);
  const end = rest.indexOf(')\n') + 2;
  expect(end).toBeGreaterThan(1);
  return rest.slice(0, end);
}

function runClassifier(pythonBody: string): { out: string; status: number | null } {
  const r = spawnSync('python3', ['-'], { input: pythonBody, encoding: 'utf-8', timeout: 30_000 });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

const harness = (source: string, scenario: string) => `
import re

PROXY_END_TURN_FINAL_CHARS = 800

${sliceFunction(source, '_message_has_tool_result')}

${sliceFunction(source, '_conversation_has_tool_results')}

${sliceFunction(source, '_last_assistant_was_text_only')}

${sliceAssignment(source, '_DEFERRAL_PHRASE_RE')}

${sliceFunction(source, '_final_answer_content_exempt')}

${sliceFunction(source, '_is_unexpected_end_turn')}

${scenario}
`;

// A conversation with tool results: the "active loop" precondition that made
// the live completion look unexpected in the first place.
const activeLoopBody = `{
  "tools": [{"name": "bash"}],
  "messages": [
    {"role": "user", "content": "fix the defect"},
    {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "function": {"name": "bash", "arguments": "{}"}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "fixed"}]}
  ]
}`;

describe('anthropic_proxy unexpected-end-turn classifier', () => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
  const havePython = python.status === 0;
  const source = readFileSync(proxyPath, 'utf-8');

  it.skipIf(!havePython)('lets the live 2211-char completion end the loop (not unexpected)', () => {
    const scenario = `
body = ${activeLoopBody}
base = ("Task complete — recap delivered and one concrete defect fixed. Summary: " +
        "the guard clause in tools/agents/scripts/anthropic_proxy.py dropped the token " +
        "count on retry paths; verified with the regression suite, and the recap covers " +
        "the remaining known gaps. All checks green. ")
final_text = base * 3
resp = {"choices": [{"finish_reason": "stop", "message": {"content": final_text, "tool_calls": None}}]}
assert len(final_text.strip()) >= 800, "scenario setup: completion must clear the threshold"
assert _is_unexpected_end_turn(resp, body) is False, "a substantive final answer was retried as a stall"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('still catches the empty thinking-runaway stall it was built for', () => {
    // The 2026-09-17 repro shape: reasoning burned the budget, content empty,
    // end_turn mid-loop. This is the case the retry MUST keep firing on.
    const scenario = `
body = ${activeLoopBody}
resp = {"choices": [{"finish_reason": "stop", "message": {"content": "", "tool_calls": None}}]}
assert _is_unexpected_end_turn(resp, body) is True, "empty thinking-runaway end_turn is not unexpected"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('still catches a short mid-loop stall below the threshold', () => {
    // A terse "done for now" is NOT a final answer the client can act on;
    // the retry keeps herding the model back to work.
    const scenario = `
body = ${activeLoopBody}
resp = {"choices": [{"finish_reason": "stop", "message": {"content": "I think that's it.", "tool_calls": None}}]}
assert _is_unexpected_end_turn(resp, body) is True, "short stall below the threshold is not unexpected"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('never treats a tool-call response or a no-tools request as unexpected', () => {
    const scenario = `
body = ${activeLoopBody}
tool_resp = {"choices": [{"finish_reason": "tool_calls", "message": {"content": "", "tool_calls": [{"id": "t2", "function": {"name": "bash", "arguments": "{}"}}]}}]}
assert _is_unexpected_end_turn(tool_resp, body) is False, "tool-call turn classified unexpected"

no_tools = {"messages": [{"role": "user", "content": "hi"}]}
end_resp = {"choices": [{"finish_reason": "stop", "message": {"content": "Hello!", "tool_calls": None}}]}
assert _is_unexpected_end_turn(end_resp, no_tools) is False, "no-tools request classified unexpected"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('still retries a LONG deferral that clears the length threshold', () => {
    // The one legitimate regression the length gate alone would open: a model
    // that writes 800+ chars of "I need more cycles before acting" is
    // stalling, not finishing. The existing deferral regex keeps the retry
    // armed for it (architect review P1, 2026-10-03).
    const scenario = `
body = ${activeLoopBody}
base = ("I am not done yet. Before I can safely apply the fix I need more cycles " +
        "of investigation: the failing path touches the retry helper, the state " +
        "machine, and the stream counter, and each has its own invariants I must " +
        "verify first. Let me lay out the remaining analysis in full detail here. ")
deferral_text = base * 3
assert len(deferral_text.strip()) >= 800, "scenario setup: deferral must clear the length threshold"
assert _DEFERRAL_PHRASE_RE.search(deferral_text), "scenario setup: deferral must match the regex"
resp = {"choices": [{"finish_reason": "stop", "message": {"content": deferral_text, "tool_calls": None}}]}
assert _is_unexpected_end_turn(resp, body) is True, "a long deferral was exempted as a final answer"
print("OK")
`;
    const { out, status } = runClassifier(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it('wires the exemption into the classifier with the env knob and no repr-length trap', () => {
    // Source-text guards: the exemption and its env knob must exist; content
    // that is neither str nor list-of-parts must NOT be counted by length of
    // its repr (which would always clear the threshold).
    expect(source).toContain('PROXY_END_TURN_FINAL_CHARS');
    expect(source).toContain('isinstance(part, dict)');
    expect(source).toMatch(/if PROXY_END_TURN_FINAL_CHARS > 0:|PROXY_END_TURN_FINAL_CHARS <= 0/);
    // The exemption must stay gated on the deferral regex so a long
    // capitulation is never exempted as a final answer.
    expect(source).toMatch(/not _DEFERRAL_PHRASE_RE\.search\(content\)/);
    // The stream path must not count an exempted final answer into the
    // malformed_tool_streak (forced-tool dampener feed).
    expect(source).toMatch(/not _final_answer_content_exempt\(accumulated_text\)/);
  });
});
