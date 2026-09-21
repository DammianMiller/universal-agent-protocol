import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelPresets } from '../src/models/types.js';
import { QWEN38_PROFILE } from '../src/self-tuning/profiles/qwen38.js';

/**
 * The local backend's description drifted for roughly a month.
 *
 * Between 2026-08-19 and 2026-09-21 a dozen files across src/, tools/ and
 * scripts/ asserted the local engine was `ninfer-serve` — "NOT llama.cpp",
 * "--max-concurrency 1", "serves none of /props, /slots, /metrics",
 * "chat_template_kwargs REJECTED". Every one of those was false by the end,
 * and the belief did not stay cosmetic: it left `maxContextTokens: 131072`
 * (above the per-session cap a client is actually allowed) and
 * `modelConcurrency.slots: 1` (against a server running two rails).
 *
 * These tests chain the declared values back to a single source of truth —
 * `config/model-profiles/qwen38.json` — which is itself checked against the
 * live systemd unit by test/model-profiles-qwen38-rails.test.ts. So the chain
 * is: systemd unit -> model profile -> the constants in src/.
 *
 * CAVEAT, so nobody over-trusts it: the unit-file end of that chain is
 * `it.skipIf(geom === null)`. On a box without
 * ~/.config/systemd/user/uap-gsq-rco-server.service — CI, or anyone else's
 * machine — it degrades to profile-INTERNAL consistency, and a unit edit
 * (the -np 4->3->2->1->2 churn that file's own header records) would pass
 * unnoticed. Locally it is a real chain; in CI it is a self-consistency check.
 */

const ROOT = resolve(__dirname, '..');
const readText = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const profile = JSON.parse(readText('config/model-profiles/qwen38.json'));

describe('local model constants track the model profile', () => {
  const entry = ModelPresets['qwen38-27b'];

  it('has the local qwen38 entry', () => {
    expect(entry).toBeDefined();
  });

  it('sizes the context to the PER-SESSION cap, not the shared pool', () => {
    // 131072 stood here from the single-rail era. The server now runs
    // -c 229376 with --kv-unified, so that number is ONE SHARED pool across
    // both rails and -np does not divide it; the profile caps a session at
    // half. A client sizing to 131072 aims past what its session is allowed.
    expect(entry.maxContextTokens).toBe(profile.context_window);
  });

  it('keeps the documented 1024-token margin under that cap', () => {
    expect(entry.modelContextBudget).toBe(profile.context_window - 1024);
    expect(entry.modelContextBudget!).toBeLessThan(entry.maxContextTokens);
  });

  it('never declares more context than the shared pool could serve', () => {
    expect(entry.maxContextTokens).toBeLessThanOrEqual(
      profile.server_optimization.kv_capacity,
    );
  });

  it('routes through the guardrail proxy, not the raw inference port', () => {
    expect(entry.endpoint).toBe(profile.routing.endpoint);
  });

  it('does not pin a backend-specific alias, which a switch would break', () => {
    // model-switch.sh swaps backends; a pinned alias turns that into an
    // outage. The proxy is local-only and routes on its own rules, so a
    // generic id answers whatever is serving. Same reasoning as 'local-auto'.
    //
    // Asserts the PROPERTY (generic, not backend-specific), not "differs from
    // the profile" — that inverted form would fail for free the day a backend
    // happens to advertise the generic id, with nothing actually broken.
    expect(entry.apiModel).not.toMatch(/gsq-rco|iq[0-9]|exl3|flash-next|signal|ampere|swift/i);
  });
});

describe('self-tuning concurrency tracks the real rail count', () => {
  it('declares the rails the server actually runs', () => {
    // Was 1, justified by "ninfer --max-concurrency 1". Declaring fewer than
    // the server runs leaves throughput on the table; declaring more gets one
    // running and the rest queued, and the adaptive controller then reads the
    // queueing delay as backpressure on a server that was never saturated.
    expect(QWEN38_PROFILE['modelConcurrency.slots']).toBe(
      profile.server_optimization.parallel_rails,
    );
  });

  it('keeps the adaptive controller on so a real overload still backs off', () => {
    expect(QWEN38_PROFILE['modelConcurrency.adaptive']).toBe(true);
  });
});

describe('no source file asserts the retired engine as current fact', () => {
  // Retractions ("this once said X") and DATED measurements ("Measured
  // 2026-08-19 against ninfer-serve") are correct and must survive — erasing
  // dated history would falsify the record. What must not survive is a
  // present-tense claim that the local engine is ninfer.
  // Deliberately spans src/, tools/, scripts/ AND test/. The first version of
  // this guard listed only the four src/ files — which are the ones that were
  // already fixed — leaving the three trees where stale claims actually
  // survived (a test asserting the retired engine in the present tense, and a
  // python test contradicting the very source comment this change corrected)
  // completely unguarded.
  const FILES = [
    'src/models/types.ts',
    'src/utils/model-slots.ts',
    'src/cli/wizard-config.ts',
    'src/self-tuning/profiles/qwen38.ts',
    'scripts/lib/llama-upstream.sh',
    'tools/agents/scripts/anthropic_proxy.py',
    'tools/agents/scripts/confidence_escalation.py',
    'test/llama-upstream-discovery.test.ts',
    'tools/agents/tests/test_thinking_template_kwargs.py',
    'tools/agents/tests/test_confidence_escalation.py',
    'tools/agents/tests/test_anthropic_proxy_streaming.py',
  ];

  // The rule, stated once: a mention of the retired engine is fine if it is
  // QUALIFIED — either retracted ("this once said X") or dated ("measured
  // 2026-08-19 against ninfer-serve"). Dated history is not a stale claim and
  // erasing it would falsify the record. What must not survive is an
  // UNQUALIFIED present-tense assertion.
  //
  // An earlier version demanded a retraction keyword from every file, which
  // rejected three files carrying perfectly good dated history — the exact
  // thing this change set out to preserve.
  const QUALIFIER =
    /CORRECTED|SUPERSEDED|no longer|once read|then ran|at the time|as of \d{4}|since been replaced|back on llama|measured \d{4}|measured live/i;

  it.each(FILES)('%s carries no UNQUALIFIED ninfer claim', (file) => {
    const text = readText(file);
    // Assertions that are wrong in any tense, with no qualifier nearby.
    expect(text).not.toMatch(/local (engine|backend) is ninfer/i);
    expect(text).not.toMatch(/ninfer serves no \/slots endpoint\)/i);
    expect(text).not.toMatch(/is served by\s*\n?\s*\*?\s*`?ninfer-serve/i);
    // "llama.cpp ignored ...; ninfer validates it" — directly contradicted the
    // source comment sitting beside it.
    expect(text).not.toMatch(/;\s*ninfer validates it/i);
  });

  it.each(FILES)('%s qualifies any ninfer mention (retracted or dated)', (file) => {
    const text = readText(file);
    if (!/ninfer/i.test(text)) return;
    expect(text).toMatch(QUALIFIER);
  });

  it('does not claim the llama.cpp endpoints are missing', () => {
    // These endpoints are live and the tooling reads them; asserting otherwise
    // is what kept the model profile describing a server that was not running.
    //
    // Checked with QUOTED spans removed: a retraction has to restate the claim
    // it is retracting ("this said 'serves none of the llama.cpp endpoints'"),
    // and a naive substring search flags the correction as the defect. The
    // rule is that the phrase must not appear as an unquoted assertion.
    const unquoted = (t: string) => t.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '');
    for (const file of FILES) {
      expect(unquoted(readText(file))).not.toMatch(/serves none of the llama\.cpp endpoints/i);
      // Scoped to a claim about THIS backend. A bare "not llama.cpp" is fine
      // and appears legitimately: model-slots.ts reasons that any server which
      // 404s /slots is not llama.cpp, which is true of foreign engines and
      // says nothing about the local one.
      expect(unquoted(readText(file))).not.toMatch(
        /(local|this) (engine|backend)[^.]{0,40}not llama\.cpp/i,
      );
    }
  });
});
