import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const proxyPath = join(
  process.cwd(),
  'tools',
  'agents',
  'scripts',
  'anthropic_proxy.py'
);

describe('anthropic_proxy guardrails', () => {
  it('adds client rate logging controls', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    expect(contents).toContain('PROXY_CLIENT_RATE_WINDOW_SECS');
    expect(contents).toContain('PROXY_CLIENT_RATE_LOG_MIN_SECS');
    expect(contents).toContain('CLIENT_RATE:');
  });

  it('caps Opus 4.6 max_tokens at high context', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    expect(contents).toContain('PROXY_OPUS46_CTX_THRESHOLD');
    expect(contents).toContain('PROXY_OPUS46_MAX_TOKENS_HIGH_CTX');
    expect(contents).toContain('opus');
    expect(contents).toContain('4.6');
  });
});
