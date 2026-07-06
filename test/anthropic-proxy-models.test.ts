import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const proxyPath = join(rootDir, 'tools/agents/scripts/anthropic_proxy.py');

// Mirrors tools/agents/tests/test_anthropic_proxy_streaming.py::TestModelsEndpoint —
// these checks are content-level (do the string IDs appear in the proxy file?)
// while the Python tests exercise the actual /v1/models response. Both should
// be updated together whenever the canonical model list changes.
describe('Anthropic proxy model list', () => {
  const content = readFileSync(proxyPath, 'utf-8');

  it('includes Shannon canonical Claude IDs (haiku 4.5, sonnet 4.6, opus 4.8)', () => {
    // Driven by ~/dev/shannon-keygraph/.env defaults
    // ANTHROPIC_SMALL/MEDIUM/LARGE_MODEL
    expect(content).toContain('claude-haiku-4-5-20251001');
    expect(content).toContain('claude-sonnet-4-6');
    expect(content).toContain('claude-opus-4-8');
  });

  it('includes the local Qwen model ID for actual routing target', () => {
    // With ANTHROPIC_PASSTHROUGH_MODELS=__local_only__ all advertised IDs
    // (including the Claude ones above) actually round-trip to this local
    // backend. The qwen36-35b-a3b-iq4xs entry is what the proxy genuinely
    // serves as of the 2026-05-17 switch back to Qwen3.6-35B-A3B MoE.
    expect(content).toContain('qwen36-35b-a3b-iq4xs');
  });

  it('drops stale upstream model IDs no longer served', () => {
    // Pre-2026-05 the list advertised dated 4-6 IDs (now superseded by
    // 4-7 family) and gpt-5 entries that the proxy never routed to (it
    // doesn't speak the OpenAI Models API upstream). Also drops the
    // superseded local-model labels: qwen35-a3b-iq4xs (pre-2026-05-15)
    // and qwen36-27b-iq4xs (the 27B dense, replaced 2026-05-17 by the
    // switch back to 35B-A3B). Substring negative-checks avoid false
    // positives — we look for the exact stale model IDs as quoted strings.
    expect(content).not.toContain('"claude-opus-4-6-20260101"');
    expect(content).not.toContain('"claude-sonnet-4-6-20250514"');
    expect(content).not.toContain('"claude-opus-4-6-20250616"');
    expect(content).not.toContain('"gpt-5.4"');
    expect(content).not.toContain('"gpt-5.3-codex"');
    expect(content).not.toContain('"qwen35-a3b-iq4xs"');
    expect(content).not.toContain('"qwen36-27b-iq4xs"');
  });
});
