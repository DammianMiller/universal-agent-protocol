import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('Anthropic proxy guardrail fallbacks', () => {
  const proxyPath = join(process.cwd(), 'tools/agents/scripts/anthropic_proxy.py');
  const source = readFileSync(proxyPath, 'utf-8');
  const opencodePath = join(process.cwd(), 'opencode.json');
  const opencodeConfigPath = join(process.cwd(), '.opencode/config.json');
  const opencode = JSON.parse(readFileSync(opencodePath, 'utf-8'));
  const opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, 'utf-8'));

  it('uses non-terminal tool_calls finish reason for active-loop fallback', () => {
    expect(source).toContain(
      'fallback_finish_reason = "tool_calls" if active_loop else "stop"'
    );
    expect(source).toContain('returning non-terminal active-loop fallback');
  });

  it('maps tool_calls finish reason to anthropic tool_use stop reason', () => {
    expect(source).toContain('"tool_calls": "tool_use"');
  });

  it('uses a bounded fallback response instead of a 529 loop-breaker for preview empty-visible streaming turns', () => {
    expect(source).toContain('def _build_empty_visible_stream_fallback_response');
    expect(source).toContain(
      'serving bounded fallback response instead of terminal retry-loop breaker'
    );
    expect(source).toContain('monitor.last_completion_classification = "stream:empty_visible_fallback"');
    expect(source).toContain('fallback_text = _build_actionable_reasoning_summary(');
    expect(source).toContain('preview_reasoning_chunks');
  });

  it('rejects placeholder Bash commands before they can loop through the client workflow', () => {
    expect(source).toContain('_BASH_PLACEHOLDER_VALUES = {');
    expect(source).toContain("reason=\"arguments for 'Bash' used a placeholder command value\"");
    expect(source).toContain('not schema field names or placeholders like `command`, `description`, or `timeout`');
  });

  it('derives an actionable reasoning summary before generic retry fallback text', () => {
    expect(source).toContain('def _build_actionable_reasoning_summary');
    expect(source).toContain('fallback_text = _build_actionable_reasoning_summary(reasoning_chunks)');
    expect(source).toContain('Actionable summary from model reasoning:');
  });

  it('pins opencode proxy endpoint to the local proxy on 127.0.0.1:4000', () => {
    expect(opencode.provider['qwen-proxy'].options.baseURL).toBe('http://127.0.0.1:4000/v1');
    expect(opencodeConfig.agent.api_endpoint).toBe('http://127.0.0.1:4000/v1');
  });

  it('proxies /v1/models from the active local llama runtime instead of stale Claude ids', () => {
    expect(source).toContain('async def models():');
    expect(source).toContain('resp = await http_client.get(f"{LLAMA_CPP_BASE}/models", timeout=10.0)');
    expect(source).toContain('data.append({"id": model_id, "object": "model"})');
    expect(source).not.toContain('{"id": "claude-sonnet-4-20250514", "object": "model"}');
    expect(source).not.toContain('{"id": "claude-3-5-sonnet-20241022", "object": "model"}');
  });

  it('reduces client output budgets and disables default thinking mode for the local stack', () => {
    expect(opencode.provider['qwen-proxy'].models['qwen35-a3b-iq4xs'].limit.output).toBe(16384);
    expect(opencode.provider['llama.cpp-direct'].models['qwen35-a3b-iq4xs'].limit.output).toBe(16384);
    expect(opencodeConfig.model.max_tokens).toBe(8192);
    expect(opencodeConfig.prompt_settings.default_mode).toBe('default');
    expect(opencodeConfig.prompt_settings.settings_file).toBeUndefined();
  });

  it('keeps local session failures bounded with lower timeout and lower variance decoding defaults', () => {
    expect(opencodeConfig.model.timeout_ms).toBe(180000);
    expect(opencodeConfig.model.temperature).toBe(0.2);
    expect(opencodeConfig.model.top_p).toBe(0.85);
  });
});
