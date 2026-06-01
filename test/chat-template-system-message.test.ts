import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression guard for the gateway 529 / Jinja error:
 *   "System message must be at the beginning."
 *
 * The qwen3.5-enhanced chat template used to hard-`raise_exception` whenever a
 * system/developer message appeared anywhere but index 0. UAP's memory and
 * context-injection layers legitimately emit system messages mid-conversation,
 * so the template must tolerate them by rendering inline (matching the lenient
 * chat_template.jinja) instead of failing the whole request server-side.
 */
describe('qwen3.5-enhanced chat template — system message ordering', () => {
  const templatePath = join(
    process.cwd(),
    'tools',
    'agents',
    'config',
    'qwen3.5-enhanced.jinja'
  );
  const template = readFileSync(templatePath, 'utf-8');

  it('must not hard-raise on a non-first system message', () => {
    // The exact exception text that surfaced as the gateway 529.
    expect(template).not.toContain('System message must be at the beginning.');
  });

  it('renders a later system/developer message inline as a system block', () => {
    // The tolerant branch emits the message instead of throwing.
    const loopBlock = template.slice(template.indexOf('{%- for message in messages %}'));
    expect(loopBlock).toContain("'<|im_start|>system\\n' + content + '<|im_end|>'");
  });
});

describe('chat_template.jinja — system message ordering', () => {
  it('still tolerates a non-first system message as a regular message', () => {
    const template = readFileSync(
      join(process.cwd(), 'tools', 'agents', 'config', 'chat_template.jinja'),
      'utf-8'
    );
    // Guard against this lenient template regressing back to a hard raise.
    expect(template).not.toContain('System message must be at the beginning');
    expect(template).toContain("message.role == 'system' and not loop.first");
  });
});
