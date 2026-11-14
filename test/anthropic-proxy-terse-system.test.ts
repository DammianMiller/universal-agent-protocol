import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { join } from 'path';

/**
 * O-D — the proxy-side terse-prompt shim
 * (docs/plans/droid-client-performance-options.md).
 *
 * The strata engine has no serve-time chat-template override (GGUF-embedded
 * templates only), so the Sharp-template round (inference-panel PR #4) could
 * not reach any strata arm. What the proxy CAN do is what the template's
 * terse block does at render time: prepend the terse directive to the
 * system prompt. These tests exercise the REAL anthropic_proxy.py via the
 * importlib pattern (same as test/hooks/deliver-autoroute-default.test.ts)
 * — no slicing, so the module's actual state is what runs.
 *
 * Default ON (UAP_PROXY_TERSE_SYSTEM=0 disables) mirrors the Sharp
 * template's own default-on `terse` kwarg.
 */

const PROXY = join(process.cwd(), 'tools', 'agents', 'scripts', 'anthropic_proxy.py');

const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
const havePython = python.status === 0;

/** Runs a scenario inside the real proxy module with the toggle preset. */
function runScenario(toggle: string, scenario: string): string {
  const script = `
import importlib.util, os, json, sys
os.environ['UAP_PROXY_TERSE_SYSTEM'] = ${JSON.stringify(toggle)}
spec = importlib.util.spec_from_file_location('ap', ${JSON.stringify(PROXY)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def check(body):
    msgs = m.anthropic_to_openai_messages(body)
    return [mm.get('content') for mm in msgs if mm.get('role') == 'system']

${scenario}
`;
  try {
    return execFileSync('python3', ['-'], {
      input: script,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 60_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('anthropic_proxy terse-system shim (O-D)', () => {
  it.skipIf(!havePython)(
    'prepends the Sharp terse directive ahead of a string system prompt (default on)',
    () => {
      const out = runScenario('1', `
systems = check({'system': 'CALLER-SYSTEM-PROMPT', 'messages': []})
assert len(systems) == 1, f"expected exactly one system message, got {len(systems)}"
s = systems[0]
assert s.startswith('Answer directly and concisely.'), "directive is not leading the system prompt"
assert 'Never: open with preamble or pleasantries' in s, "terse core block missing"
assert 'ask a sharp question' in s, "ambiguity directive missing"
assert s.endswith('CALLER-SYSTEM-PROMPT'), "caller system prompt was not preserved verbatim after the directive"
print('OK')
`);
      expect(out).toContain('OK');
    }
  );

  it.skipIf(!havePython)(
    'merges content-block system prompts the same way (not just strings)',
    () => {
      const out = runScenario('1', `
systems = check({'system': [{'type': 'text', 'text': 'BLOCK-A'}, {'type': 'text', 'text': 'BLOCK-B'}], 'messages': []})
assert len(systems) == 1, f"expected exactly one system message, got {len(systems)}"
s = systems[0]
assert s.startswith('Answer directly and concisely.'), "directive missing on block-form system"
assert s.endswith('BLOCK-A\\nBLOCK-B'), f"blocks not joined in order after directive: {s!r}"
print('OK')
`);
      expect(out).toContain('OK');
    }
  );

  it.skipIf(!havePython)(
    'serves the directive standalone when the client sent no system prompt at all',
    () => {
      const out = runScenario('1', `
systems = check({'messages': [{'role': 'user', 'content': 'hi'}]})
assert len(systems) == 1, f"expected exactly one system message, got {len(systems)}"
assert systems[0].startswith('Answer directly and concisely.'), "standalone directive missing"
assert 'CALLER' not in systems[0], "unexpected caller text"
print('OK')
`);
      expect(out).toContain('OK');
    }
  );

  it.skipIf(!havePython)(
    'UAP_PROXY_TERSE_SYSTEM=0 passes the system prompt through byte-identical (A/B off-arm)',
    () => {
      const out = runScenario('0', `
systems = check({'system': 'CALLER-SYSTEM-PROMPT', 'messages': []})
assert systems == ['CALLER-SYSTEM-PROMPT'], f"off-arm must be byte-identical, got {systems!r}"
empty = check({'messages': [{'role': 'user', 'content': 'hi'}]})
assert empty == [], f"off-arm must not inject a system message when none was sent, got {empty!r}"
print('OK')
`);
      expect(out).toContain('OK');
    }
  );
});
