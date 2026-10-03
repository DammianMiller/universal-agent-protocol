import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';

const PROXY = 'tools/agents/scripts/anthropic_proxy.py';

// Slice the real Python classifier out of the proxy and exercise it with the
// exact payloads it sees in production (the repo's slice-real-code pattern:
// the test can never drift from the implementation it verifies).
const source = readFileSync(PROXY, 'utf-8');

const havePython = spawnSync('python3', ['-c', 'print(1)']).status === 0;

function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\ndef ', start);
  return src.slice(start, end === -1 ? undefined : end);
}

const garbledRegexes = (source.match(/_GARBLED_\w+_RE = re\.compile\(.*\)/g) ?? []).join('\n');
expect(garbledRegexes.length).toBeGreaterThan(0);

const harness = (scenario: string) => `
import json
import re

${garbledRegexes}

${sliceFunction(source, '_is_garbled_tool_arguments')}

${scenario}
`;

function runClassifier(scenario: string) {
  const result = spawnSync('python3', ['-'], {
    input: harness(scenario),
    timeout: 30_000,
    encoding: 'utf-8',
  });
  return { out: (result.stdout ?? '') + (result.stderr ?? ''), status: result.status ?? -1 };
}

describe('_is_garbled_tool_arguments (garbled-args classifier)', () => {
  it.skipIf(!havePython)(
    'does NOT flag a valid-JSON edit payload whose code excerpt has unbalanced braces (live 2026-10-03 case)',
    () => {
      // The live incident: the model's edit carried a Rust TAIL excerpt in
      // oldString (3 closing braces, 0 opening braces) inside a perfectly
      // parseable JSON payload. The raw-string brace-balance check read the
      // payload content as corrupt structure, the edit was rejected, the
      // model retried the identical edit, and the loop burned three
      // session-contamination resets and a forced finalize mid-task.
      const scenario = `
args = json.dumps({
    "filePath": "/home/cogtek/dev/cogtek/cognition-engine/src/rust-pg-ext/src/signal_processing/mod.rs",
    "oldString": "magnitudes[k] = (re * re + im * im).sqrt() / n as f64;\\n            }\\n        }\\n    }\\n}\\n",
    "newString": "let mags = black_box(compute(input));\\n    mags\\n}\\n",
})
assert json.loads(args), "scenario setup: payload must be valid JSON"
assert args.count("{") != args.count("}"), "scenario setup: braces must be unbalanced"
assert _is_garbled_tool_arguments(args) is False, "a valid JSON code-edit payload was rejected as garbled"
print("OK")
`;
      const { out, status } = runClassifier(scenario);
      expect(out).toContain('OK');
      expect(status).toBe(0);
    },
  );

  it.skipIf(!havePython)('still flags an UNPARSEABLE payload with unbalanced braces (truncated JSON)', () => {
    // Truncation is the corruption case the balance check exists for: the
    // JSON is cut mid-string, so braces are genuinely unmatched.
    const scenario = `
args = '{"filePath": "/x/mod.rs", "oldString": "fn main() {\\n    loop {\\n        do_work()'
assert _is_garbled_tool_arguments(args) is True, "truncated JSON was not flagged"
print("OK")
`;
    const { out, status } = runClassifier(scenario);
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('still flags degenerate digit artifacts even inside valid JSON', () => {
    // Digit-loop/long-run signals are degenerate CONTENT, meaningful even in
    // a payload that parses cleanly — they stay unconditional.
    const scenario = `
for bad in [
    json.dumps({"cmd": "run 0000000000 times"}),
    json.dumps({"data": "398859738398859738398859738"}),
]:
    assert _is_garbled_tool_arguments(bad) is True, "degenerate digit artifact was not flagged: " + bad
print("OK")
`;
    const { out, status } = runClassifier(scenario);
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('does NOT flag runaway braces inside a valid JSON string value (minified code)', () => {
    // Interior }}}}} inside oldString/newString is payload content — e.g.
    // minified JS/JSON the model is editing — while the classic degenerate
    // form (runaway closers appended after the JSON) does not parse and is
    // still caught by the structural branch.
    const scenario = `
interior = json.dumps({"filePath": "/x/bundle.js", "oldString": "f(a);f(b)}}}}  return x"})
assert json.loads(interior), "scenario setup: payload must be valid JSON"
assert _is_garbled_tool_arguments(interior) is False, "legit minified-code excerpt was rejected as garbled"

appended = '{"a": 1}}}}}'
assert _is_garbled_tool_arguments(appended) is True, "appended runaway closers were not flagged"
print("OK")
`;
    const { out, status } = runClassifier(scenario);
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('absorbs deeply nested degenerate input without crashing', () => {
    // The json.loads probe must never raise out of the classifier: a runaway
    // nesting artifact (the exact degenerate family this check absorbs)
    // raises RecursionError, not ValueError, and used to crash the response
    // conversion path.
    const scenario = `
deep = "{" * 10000 + '"x": 1' + "}" * 10000
assert _is_garbled_tool_arguments(deep) is True, "deeply nested degenerate payload was not flagged"
print("OK")
`;
    const { out, status } = runClassifier(scenario);
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it.skipIf(!havePython)('accepts ordinary tool arguments', () => {
    const scenario = `
for good in [
    "{}",
    "",
    json.dumps({"filePath": "/x/a.rs", "oldString": "let a = 1;\\nlet b = 2;\\n", "newString": "let a = 3;\\nlet b = 2;\\n"}),
    json.dumps({"command": "cargo test --release"}),
]:
    assert _is_garbled_tool_arguments(good) is False, "ordinary args were rejected as garbled: " + good
print("OK")
`;
    const { out, status } = runClassifier(scenario);
    expect(out).toContain('OK');
    expect(status).toBe(0);
  });

  it('gates the brace-balance check on a json.loads attempt in the source', () => {
    // Source-text guard: the balance check must live under the parse
    // failure path, not the raw string — and the parse must absorb
    // deeply-nested degenerate input (RecursionError) without crashing the
    // response-conversion path.
    expect(source).toMatch(
      /try:\s*\n\s*json\.loads\(arguments_str\)\s*\n\s*except[^\n]*RecursionError[^\n]*:\s*\n[\s\S]*?abs\(open_count - close_count\) > 2/,
    );
  });
});
