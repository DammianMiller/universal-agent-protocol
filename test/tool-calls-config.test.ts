import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Tool call server configuration', () => {
  it('should expose UAP_LLM_SERVER override in tool call wrapper', () => {
    const content = readFileSync(
      join(process.cwd(), 'tools', 'agents', 'scripts', 'tool_call_wrapper.py'),
      'utf-8'
    );
    expect(content).toContain('UAP_LLM_SERVER');
    expect(content).toContain('http://127.0.0.1:4000');
  });

  it('should advertise Shannon canonical model IDs in proxy', () => {
    // Mirrors test/anthropic-proxy-models.test.ts and the Python
    // TestModelsEndpoint assertions. Driven by Shannon's .env defaults.
    const content = readFileSync(
      join(process.cwd(), 'tools', 'agents', 'scripts', 'anthropic_proxy.py'),
      'utf-8'
    );
    expect(content).toContain('claude-haiku-4-5-20251001');
    expect(content).toContain('claude-sonnet-4-6');
    expect(content).toContain('claude-opus-4-8');
    expect(content).toContain('qwen36-35b-a3b-iq4xs');
  });

  it('should show updated model names in dashboard list', () => {
    const content = readFileSync(join(process.cwd(), 'web', 'dashboard.html'), 'utf-8');
    expect(content).toContain('gpt-5.4');
    expect(content).toContain('gpt-5.3-codex');
    expect(content).toContain('sonnet-4.6');
  });
});
