import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';

const PROXY = 'tools/agents/scripts/anthropic_proxy.py';

// The repo's slice-real-code pattern (see anthropic-proxy-garbled-args.test.ts):
// slice the actual Python helpers out of the proxy and exercise them with the
// payloads they see in production, so the test can never drift from the
// implementation it verifies.
const source = readFileSync(PROXY, 'utf-8');

const havePython = spawnSync('python3', ['-c', 'print(1)']).status === 0;

function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`def ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\ndef ', start);
  return src.slice(start, end === -1 ? undefined : end);
}

const harness = (scenario: string) => `
import hashlib

def _hash_fault_excerpt(excerpt: str) -> str:
    if not excerpt:
        return ""
    normalized = " ".join(excerpt.lower().split())[:200]
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

${sliceFunction(source, '_fault_fingerprint')}
${sliceFunction(source, '_retry_temperature')}
${sliceFunction(source, '_contamination_reset_cause')}

PROXY_ATTRACTOR_TEMP_OVERRIDE = 1.20
PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE = 0.05

class SessionMonitor:
    def __init__(self, invalid=0, malformed=0, required_miss=0):
        self.invalid_tool_call_streak = invalid
        self.malformed_tool_streak = malformed
        self.required_tool_miss_streak = required_miss

${scenario}
`;

function runScenario(scenario: string) {
  const result = spawnSync('python3', ['-'], {
    input: harness(scenario),
    timeout: 30_000,
    encoding: 'utf-8',
  });
  return { out: (result.stdout ?? '') + (result.stderr ?? ''), status: result.status ?? -1 };
}

// The live 2026-10-30 fault shape: every garbled Execute heredoc logged
// text_len=0 — the assistant message carries ONLY tool_calls, no text.
const garbledHeredocA =
  '{"command":"cd /home/cogtek/dev/cogtek/pipelines/visual/koral-ros-postgres && python3 <<\'PYEOF\'\\nimport io\\np=\'src/koral_node.cpp\'\\nraw=open(p,\'rb\').read().decode(\'utf-8\')\\nNL=\'\\r\\n\'\\ndef blk(lines) 00000000398398859738 398859738398859738';
const garbledHeredocB =
  '{"command":"cd /home/cogtek/dev/cogtek/pipelines/visual/koral-ros-postgres && python3 <<\'PYEOF\'\\nimport io\\np=\'src/koral_node.cpp\'\\nraw=open(p,\'rb\').read().decode(\'utf-8\')\\nNL=\'\\r\\n\'\\ndef blk(l) 11111111211221122112 221122112211221122';

describe('_fault_fingerprint (tool-call attractor fingerprinting)', () => {
  it.skipIf(!havePython)(
    'fingerprints a tool-call fault whose assistant text is EMPTY (live 2026-10-30: hash-of-empty-text left attractor detection blind)',
    () => {
      const scenario = `
assert _fault_fingerprint("", "", []) == "", "no signal at all must stay empty"
h = _fault_fingerprint("", ${JSON.stringify(garbledHeredocA.slice(0, 200))}, ["Execute"])
assert h, "garbled-args fallback must produce a NON-empty fingerprint"
print("OK")
`;
      const { out, status } = runScenario(scenario);
      expect(out).toContain('OK');
      expect(status).toBe(0);
    },
  );

  it.skipIf(!havePython)(
    'the SAME degenerate command head across resets hashes EQUAL (attractor detectable), different tools hash DIFFERENT',
    () => {
      const scenario = `
a1 = _fault_fingerprint("", ${JSON.stringify(garbledHeredocA.slice(0, 150))}, ["Execute"])
a2 = _fault_fingerprint("", ${JSON.stringify(garbledHeredocB.slice(0, 150))}, ["Execute"])
assert a1 == a2, "same command head (stable prefix) must match across resets"
# args-first precedence: the garbled-args excerpt dominates the tool name
assert _fault_fingerprint("", ${JSON.stringify(garbledHeredocA.slice(0, 150))}, ["Edit"]) == a1
# tool-name-only fallback (no-args faults, e.g. unknown-tool): distinct per tool
c = _fault_fingerprint("", "", ["Execute"])
d = _fault_fingerprint("", "", ["Edit"])
assert c and d and c != d, "tool-name-only fallback must be non-empty and distinct"
text = _fault_fingerprint("prose summary here", ${JSON.stringify(garbledHeredocA.slice(0, 150))}, ["Execute"])
assert text == _fault_fingerprint("Prose   summary here", "", []), "text excerpt still wins when present"
print("OK")
`;
      const { out, status } = runScenario(scenario);
      expect(out).toContain('OK');
      expect(status).toBe(0);
    },
  );
});

describe('_retry_temperature (garble retry ladder)', () => {
  it.skipIf(!havePython)(
    'garbled retries escalate to the attractor-escape temp from attempt 3; malformed retries keep the deterministic ladder',
    () => {
      const scenario = `
assert _retry_temperature(1, True) == 0.05, "attempt 1 stays deterministic"
assert _retry_temperature(2, True) == 0.5, "attempt 2 breaks the local minimum"
assert _retry_temperature(3, True) == 1.2, "attempt 3+ garbled escapes the attractor"
assert _retry_temperature(7, True) == 1.2, "late garbled attempts stay at escape temp"
assert _retry_temperature(3, False) == 0.5, "malformed-JSON retries never escalate"
assert _retry_temperature(1, False) == 0.05, "first malformed retry is deterministic"
print("OK")
`;
      const { out, status } = runScenario(scenario);
      expect(out).toContain('OK');
      expect(status).toBe(0);
    },
  );
});

describe('_contamination_reset_cause (post-reset temp policy driver)', () => {
  it.skipIf(!havePython)(
    'prioritizes the dominant streak so garble-driven resets are exempt from the 0.10 clamp',
    () => {
      const scenario = `
assert _contamination_reset_cause(SessionMonitor(invalid=3, malformed=1)) == "invalid_tool_args"
assert _contamination_reset_cause(SessionMonitor(invalid=1, malformed=3)) == "malformed_payload"
assert _contamination_reset_cause(SessionMonitor(required_miss=3)) == "required_tool_miss"
assert _contamination_reset_cause(SessionMonitor()) == "generic"
print("OK")
`;
      const { out, status } = runScenario(scenario);
      expect(out).toContain('OK');
      expect(status).toBe(0);
    },
  );
});

describe('garble-loop fix wiring (source assertions)', () => {
  it('fault site uses the fingerprint helper and passes collected tool names', () => {
    expect(source).toContain(
      'monitor.last_fault_excerpt_hash = _fault_fingerprint(',
    );
    expect(source).toContain('fault_tool_names: list[str] = []');
  });

  it('post-contamination 0.10 clamp is gated on the exempt cause set', () => {
    expect(source).toMatch(
      /monitor\.contamination_cause\s*\n?\s*not in PROXY_CONTAMINATION_LOW_TEMP_EXEMPT_KINDS/,
    );
    expect(source).toContain('PROXY_CONTAMINATION_LOW_TEMP_EXEMPT_KINDS');
  });

  it('late garbled retries cap degeneration room', () => {
    expect(source).toContain('RETRY GARBLED LATE CAP');
    expect(source).toContain('PROXY_GARBLE_LATE_CAP');
    expect(source).toMatch(/is_garbled and attempt >= 3 and PROXY_GARBLE_LATE_CAP > 0/);
  });

  it('garble retry hint demands simplification; unknown-tool hint names alternatives', () => {
    expect(source).toContain('SIMPLIFY and SHORTEN the operation');
    expect(source).toContain('is not available on this turn');
    expect(source).toMatch(/Call exactly one of: \{known\}/);
  });
});
