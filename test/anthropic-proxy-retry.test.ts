import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const proxyPath = join(process.cwd(), 'tools/agents/scripts/anthropic_proxy.py');

describe('anthropic_proxy upstream retry', () => {
  it('defines upstream retry environment variables', () => {
    const content = readFileSync(proxyPath, 'utf-8');
    expect(content).toContain('PROXY_UPSTREAM_RETRY_MAX');
    expect(content).toContain('PROXY_UPSTREAM_RETRY_DELAY_SECS');
  });

  it('routes non-stream requests through retry helper', () => {
    const content = readFileSync(proxyPath, 'utf-8');
    expect(content).toContain('def _post_with_retry');
    expect(content).toContain('await _post_with_retry(');
  });
});
