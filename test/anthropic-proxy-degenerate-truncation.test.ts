import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The degenerate-repetition guard must not CORRUPT what it salvages.
 *
 * Measured live (statlib gate authoring, 2026-08-13): the guard truncated a
 * degenerate bash script mid-line and stamped it finish_reason=stop. The
 * caller (deliver's self-gate loop) received a script ending inside a quoted
 * string that looked complete, burned an authoring attempt on "unexpected
 * EOF", and told the model to fix a defect it never produced. The guard now
 * cuts on a line boundary and reports "length" — the honest "this text is not
 * complete" signal that clients with a truncation retry can act on.
 *
 * The function is exercised for real: sliced out of anthropic_proxy.py along
 * with its real helpers and run under python3 with only the logger stubbed. A
 * source-text assertion cannot prove behavior, and this guard exists precisely
 * because text that "looks right" can be broken.
 */

const proxyPath = join(process.cwd(), 'tools/agents/scripts/anthropic_proxy.py');

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\ndef ', start);
  return source.slice(start, end === -1 ? undefined : end);
}

function runGuard(pythonBody: string): { out: string; status: number | null } {
  const r = spawnSync('python3', ['-'], { input: pythonBody, encoding: 'utf-8', timeout: 30_000 });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

// The guard's helpers are sliced from the REAL source, not reimplemented: a
// hand-written stub of _openai_message_text would keep these tests green while
// the shipped helper (and therefore the shipped guard) drifts — the exact
// "text that looks right" failure mode this guard exists to prevent. Only the
// logger, which has no behavior under test, is stubbed.
const harness = (source: string, scenario: string) => `
import json

class _Logger:
    def warning(self, *a, **k): pass
    def info(self, *a, **k): pass

logger = _Logger()

${sliceFunction(source, '_extract_openai_choice')}

${sliceFunction(source, '_openai_message_text')}

${sliceFunction(source, '_detect_and_truncate_degenerate_repetition')}

${scenario}
`;

describe('anthropic_proxy degenerate-repetition guard', () => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
  const havePython = python.status === 0;

  it.skipIf(!havePython)('cuts repetitive line-oriented output on a line boundary and reports finish_reason=length', () => {
    const source = readFileSync(proxyPath, 'utf-8');
    const scenario = `
good = "#!/bin/bash\\nset -e\\nnode -e \\"assert(1)\\"\\n"
bad_line = "echo checking the mode function output again\\n"
resp = {"choices": [{"message": {"content": good + bad_line * 40}, "finish_reason": "stop"}]}
out, was_degenerate = _detect_and_truncate_degenerate_repetition(resp)
content = out["choices"][0]["message"]["content"]
assert was_degenerate, "guard did not fire on 40 repeated lines"
finish = out["choices"][0]["finish_reason"]
assert finish == "length", f"expected honest finish_reason=length, got {finish}"
# The cut must land on a line boundary: no partial trailing line.
assert content == content.rstrip(), "trailing whitespace survived"
last = content.split("\\n")[-1]
assert last in ("node -e \\"assert(1)\\"", "echo checking the mode function output again"), (
    f"cut mid-line: last line is {last!r}"
)
print("OK")
`;
    const { out, status } = runGuard(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('falls back to a mid-line cut when the repetition has no newline, still reporting length', () => {
    const source = readFileSync(proxyPath, 'utf-8');
    const scenario = `
# One giant line of inline repetition — the exact shape a stuck model emits.
resp = {"choices": [{"message": {"content": "echo hi; " * 60}, "finish_reason": "stop"}]}
out, was_degenerate = _detect_and_truncate_degenerate_repetition(resp)
assert was_degenerate, "guard did not fire on inline repetition"
finish = out["choices"][0]["finish_reason"]
assert finish == "length", f"expected finish_reason=length, got {finish}"
content = out["choices"][0]["message"]["content"]
assert 0 < len(content) < len("echo hi; " * 60), "no truncation happened"
print("OK")
`;
    const { out, status } = runGuard(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('leaves non-repetitive output untouched with its original finish_reason', () => {
    const source = readFileSync(proxyPath, 'utf-8');
    const scenario = `
text = "\\n".join(f"line {i}: distinct content {i * 7}" for i in range(60))
resp = {"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}
out, was_degenerate = _detect_and_truncate_degenerate_repetition(resp)
assert not was_degenerate, "guard misfired on distinct lines"
assert out["choices"][0]["message"]["content"] == text
assert out["choices"][0]["finish_reason"] == "stop"
print("OK")
`;
    const { out, status } = runGuard(harness(source, scenario));
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });
});
