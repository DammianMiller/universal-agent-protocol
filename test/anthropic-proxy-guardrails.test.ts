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

describe('recon-convergence write-tool class', () => {
  it('recognizes OpenAI-style tool-loop write tools so agentic builds never count as recon', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    // uap deliver's agentic executor writes via write_file; if the recon
    // detector stops counting it as a write, the proxy re-poisons mid-build
    // agentic sessions with "synthesize now" directives (no_write_streak=62
    // observed live before this guard).
    expect(contents).toContain('"write_file"');
    expect(contents).toContain('"edit_file"');
  });
});

