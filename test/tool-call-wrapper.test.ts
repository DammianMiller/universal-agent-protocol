import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression guard for `uap tool-calls test`. The wrapper passed llama.cpp
 * sampling params (top_k / min_p / grammar) as DIRECT kwargs to the OpenAI SDK's
 * `chat.completions.create()`, which rejects them ("unexpected keyword argument
 * 'top_k'") — so every tool-call test failed before reaching the model. They
 * must be forwarded via `extra_body`. (Verified end-to-end: 6/6 against a live
 * model after the fix.)
 */
const WRAPPER = join(process.cwd(), 'tools', 'agents', 'scripts', 'tool_call_wrapper.py');

describe('tool_call_wrapper request params', () => {
  const src = readFileSync(WRAPPER, 'utf-8');

  it('does NOT pass non-OpenAI params as top-level kwargs to create()', () => {
    // These would be sent to chat.completions.create(**request_params) and rejected.
    expect(src).not.toMatch(/request_params\["top_k"\]\s*=/);
    expect(src).not.toMatch(/request_params\["min_p"\]\s*=/);
    expect(src).not.toMatch(/request_params\["grammar"\]\s*=/);
  });

  it('routes top_k / min_p / grammar through extra_body', () => {
    expect(src).toMatch(/extra_body\["top_k"\]\s*=/);
    expect(src).toMatch(/extra_body\["min_p"\]\s*=/);
    expect(src).toMatch(/extra_body\["grammar"\]\s*=/);
    // and the assembled extra_body is attached to the request.
    expect(src).toMatch(/request_params\["extra_body"\]\s*=\s*extra_body/);
  });

  it('keeps `stop` (a standard OpenAI param) as a top-level kwarg', () => {
    expect(src).toMatch(/request_params\["stop"\]\s*=/);
  });
});
