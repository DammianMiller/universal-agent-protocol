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


describe('unexpected-end-turn guardrail retry', () => {
  it('disables thinking on the retry so tool_choice=required cannot be defeated by <think> runaway', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    // Reproduced live 2026-09-17 on qwen38-gsq-rco-27b: with thinking on, a
    // required retry burned 5917 reasoning chars and hit the length cap with
    // zero tool_calls; thinking-off + required returned a clean tool_call.
    // The retry is a recovery path — determinism beats reasoning depth there.
    const fnStart = contents.indexOf('async def _apply_unexpected_end_turn_guardrail');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = contents.slice(fnStart, fnStart + 4000);
    expect(fnBody).toContain('_set_thinking(retry_body, False)');
  });

  it('keeps the retry forced (tool_choice=required) and non-stream', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    const fnStart = contents.indexOf('async def _apply_unexpected_end_turn_guardrail');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = contents.slice(fnStart, fnStart + 4000);
    expect(fnBody).toContain('retry_body["tool_choice"] = "required"');
    expect(fnBody).toContain('retry_body["stream"] = False');
    // thinking-off must land on the retry body BEFORE the grammar application
    // and upstream POST, not leak onto the caller's original request body
    expect(fnBody.indexOf('_set_thinking(retry_body, False)')).toBeLessThan(
      fnBody.indexOf('_apply_tool_call_grammar(retry_body')
    );
    expect(fnBody).not.toContain('_set_thinking(openai_body, False)');
  });
});
