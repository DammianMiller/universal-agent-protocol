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

describe('no-tool thinking floor', () => {
  it('bumps small no-tool max_tokens so evaluator verdicts survive Qwen mandatory thinking', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    // Without this floor, acceptance-judge/critic/ideation calls (~4096
    // max_tokens, tools=0) are consumed entirely by <think> and come back as
    // unparseable de-tagged reasoning — observed live on every judgment.
    expect(contents).toContain('PROXY_THINKING_MIN_NO_TOOLS');
    expect(contents).toContain('thinking-floor (no-tool)');
  });
});

describe('json-response grammar (evaluator verdicts)', () => {
  it('grammar-constrains header-tagged no-tool requests so verdicts always parse', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    expect(contents).toContain('PROXY_JSON_RESPONSE_GRAMMAR');
    expect(contents).toContain('x-uap-json-response');
    expect(contents).toContain('_apply_json_response_grammar');
  });
});

describe('stuck-break guardrail (self-aware loop + rate-limited API)', () => {
  it('forces a terminal turn on sustained self-reported-stuck or API-retry loops', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    expect(contents).toContain('PROXY_STUCK_BREAK');
    expect(contents).toContain('_maybe_inject_stuck_break');
    expect(contents).toContain('note_assistant_text');
    // steers to the non-rate-limited channels
    expect(contents).toContain('api.github.com');
    expect(contents).toMatch(/git clone|browser tool/);
    // releases tool coercion so a plain text/synthesis turn is allowed
    expect(contents).toContain("openai_body[\"tool_choice\"] = \"auto\"");
  });
});

describe('shared-secret auth — loopback exemption', () => {
  it('exempts loopback clients so enabling PROXY_AUTH_TOKEN does not 401 local UAP clients', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    // env toggle (default on) + loopback host set
    expect(contents).toContain('PROXY_AUTH_TRUST_LOOPBACK');
    expect(contents).toContain('_LOOPBACK_HOSTS');
    expect(contents).toContain('127.0.0.1');
    expect(contents).toContain('::1');
    // the auth gate is skipped for a trusted-local client
    expect(contents).toContain('_trusted_local');
    expect(contents).toContain('and not _trusted_local');
  });

  it('still requires the token for remote requests (gate only skipped for loopback)', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    // _trusted_local is gated on BOTH the toggle AND the client being loopback,
    // so a remote host never gets the exemption
    expect(contents).toMatch(/_trusted_local\s*=\s*_PROXY_AUTH_TRUST_LOOPBACK and _client_host in _LOOPBACK_HOSTS/);
    // constant-time compare still present for the remote path
    expect(contents).toContain('compare_digest');
  });
});

describe('sleep-poll break guardrail', () => {
  it('detects and nudges sustained `sleep N && check` polling of blocking tools', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    // env-tunable, on by default, with a consecutive-turn threshold
    expect(contents).toContain('PROXY_SLEEP_POLL_BREAK');
    expect(contents).toContain('PROXY_SLEEP_POLL_THRESHOLD');
    // leading-sleep detector + streak state + should_force + injector
    expect(contents).toContain('_SLEEP_POLL_RE');
    expect(contents).toContain('sleep_poll_streak');
    expect(contents).toContain('should_force_sleep_poll_break');
    expect(contents).toContain('_maybe_inject_sleep_poll_break');
    // the directive tells the model blocking tools already return their result
    expect(contents).toContain('STOP SLEEP-POLLING');
    // the ANCHORED detector actually drives the counter (not dead code): a
    // command must OPEN with `sleep N` (.match, not .search) to count
    expect(contents).toContain('_SLEEP_POLL_RE.match');
    expect(contents).toContain('self.sleep_poll_streak += 1');
    // "only SUSTAINED polling trips it": the streak MUST reset (a write or any
    // non-leading-sleep tool turn) or the nudge would fire forever once tripped
    expect(contents).toContain('self.sleep_poll_streak = 0');
  });

  it('is additive — the injector never changes tool_choice (unlike the forcing guards)', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    const start = contents.indexOf('def _maybe_inject_sleep_poll_break');
    const end = contents.indexOf('\ndef ', start + 1);
    expect(start).toBeGreaterThan(-1);
    const body = contents.slice(start, end === -1 ? undefined : end);
    // no tool_choice MUTATION inside the sleep-poll injector body (the docstring
    // may mention the word; what matters is it never assigns openai_body's choice)
    expect(body).not.toContain('openai_body["tool_choice"]');
    // it yields to the urgent terminal guards
    expect(body).toContain('recon_convergence_pending');
    expect(body).toContain('should_force_stuck_break');
    // and it is wired into the injection pipeline
    expect(contents).toContain('_maybe_inject_sleep_poll_break(openai_body, monitor)');
  });
});

