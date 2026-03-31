import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('Anthropic proxy guardrail fallbacks', () => {
  const proxyPath = join(process.cwd(), 'tools/agents/scripts/anthropic_proxy.py');
  const source = readFileSync(proxyPath, 'utf-8');

  it('uses non-terminal tool_calls finish reason for active-loop fallback', () => {
    expect(source).toContain(
      'fallback_finish_reason = "tool_calls" if active_loop else "stop"'
    );
    expect(source).toContain('returning non-terminal active-loop fallback');
  });

  it('maps tool_calls finish reason to anthropic tool_use stop reason', () => {
    expect(source).toContain('"tool_calls": "tool_use"');
  });
});
