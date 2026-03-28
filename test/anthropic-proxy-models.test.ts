import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const proxyPath = join(rootDir, 'tools/agents/scripts/anthropic_proxy.py');

describe('Anthropic proxy model list', () => {
  const content = readFileSync(proxyPath, 'utf-8');

  it('includes the Claude Opus and Sonnet 4.6 model IDs', () => {
    expect(content).toContain('claude-opus-4-6-20260101');
    expect(content).toContain('claude-sonnet-4-6-20250514');
  });

  it('includes the GPT 5.x and Qwen3.5 model IDs', () => {
    expect(content).toContain('gpt-5.4');
    expect(content).toContain('gpt-5.3-codex');
    expect(content).toContain('qwen35-a3b-iq4xs');
  });
});
