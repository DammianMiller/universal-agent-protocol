import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
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


const QWEN_SHARP = join(process.cwd(), 'tools', 'agents', 'config', 'qwen-sharp.jinja');
const RENDERER = join(process.cwd(), 'test', 'fixtures', 'render_chat_template.py');

/** Render a template. Returns null when python3/jinja2 is unavailable so the suite skips. */
function render(templatePath: string, payload: unknown): string | null {
  try {
    const out = execFileSync('python3', [RENDERER, templatePath], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.startsWith('SKIP:') ? null : out;
  } catch {
    return null;
  }
}

const SYS = { role: 'system', content: 'CALLER-SYSTEM-PROMPT' };
const USER = { role: 'user', content: 'read the file' };
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'read a file',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    },
  },
];

/**
 * qwen-sharp.jinja is the template ALL Qwen models run on as of 2026-08-20
 * (peculiar-ragdoll/Qwen-Sharp-Chat-Templates, template_version qwen3.8-froggeric-v22.1).
 *
 * These tests RENDER the template. An earlier version of this file grepped template
 * SOURCE for expected substrings, which cannot see the failures that actually matter:
 * the template ships BOTH a JSON and an XML tool-call emitter and picks one at render
 * time via `_tool_format`, so a grep for the XML emitter's source passes even if the
 * default flips to JSON and every tool call on the box changes wire format.
 */
describe('qwen-sharp chat template -- rendered contract', () => {
  it('defaults to the XML tool-call contract the proxy parses, not the JSON one', () => {
    const out = render(QWEN_SHARP, {
      messages: [
        SYS,
        USER,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/tmp/a.txt' } } }],
        },
      ],
      tools: TOOLS,
      add_generation_prompt: false,
    });
    if (out === null) return; // python3/jinja2 unavailable
    // The contract anthropic_proxy.py's _HERMES_FUNCTION_RE / _TOOL_CALL_XML_RE parse.
    expect(out).toContain('<function=Read>');
    expect(out).toContain('<parameter=file_path>');
    // The JSON emitter must NOT have been selected.
    expect(out).not.toContain('{"name": "Read"');
  });

  it('appends the terseness block to the caller prompt, exactly once, without replacing it', () => {
    const out = render(QWEN_SHARP, { messages: [SYS, USER], tools: [] });
    if (out === null) return;
    // The caller's own prompt survives -- this is the append-vs-replace invariant.
    expect(out).toContain('CALLER-SYSTEM-PROMPT');
    // Rendered, not source: a double splice sends it twice and wastes context.
    expect(out.split('Never: open with preamble').length - 1).toBe(1);
  });

  it('honours enable_thinking in the generation prompt (proxy prefill fix)', () => {
    const on = render(QWEN_SHARP, { messages: [SYS, USER], tools: [] });
    const off = render(QWEN_SHARP, {
      messages: [SYS, USER],
      tools: [],
      kwargs: { enable_thinking: false },
    });
    if (on === null || off === null) return;
    expect(on.endsWith('<think>\n')).toBe(true);
    // Thinking off => pre-closed block, so the model emits no reasoning.
    expect(off.endsWith('<think>\n\n</think>\n\n')).toBe(true);
    expect(on).not.toBe(off);
  });

  it('renders a mid-conversation system message inline instead of raising', () => {
    const out = render(QWEN_SHARP, {
      messages: [
        SYS,
        USER,
        { role: 'assistant', content: 'a' },
        { role: 'system', content: 'MEMORY-INJECTION' },
        { role: 'user', content: 'q2' },
      ],
      tools: [],
    });
    if (out === null) return;
    expect(out).not.toContain('RAISE:');
    expect(out).toContain('MEMORY-INJECTION');
  });

  /**
   * The real regression this swap fixes, pinned on the exact input that triggers it.
   *
   * qwen3.5-enhanced.jinja scans backwards for a user turn that is not wrapped in
   * <tool_response>, and hard-raises 'No user query found in messages.' when there is
   * none -- a server-side failure for the whole request. That is reachable two ways
   * UAP actually produces: a continuation whose only user turns are tool results, and
   * a system+assistant transcript with no user turn at all.
   *
   * NOTE: it is NOT triggered by a mid-conversation system message -- both templates
   * handle that fine. That is why this asserts on the rendered raise rather than on
   * the template source.
   */
  it.each([
    [
      'every user turn is a tool response',
      [SYS, { role: 'user', content: '<tool_response>\nfile contents\n</tool_response>' }],
    ],
    ['no user turn at all', [SYS, { role: 'assistant', content: 'a' }]],
  ])('does not raise when %s', (_label, messages) => {
    const fresh = render(QWEN_SHARP, { messages, tools: TOOLS });
    if (fresh === null) return;
    expect(fresh).not.toContain('RAISE:');

    // And the template it replaced did raise on exactly this input.
    const legacyPath = join(process.cwd(), 'tools', 'agents', 'config', 'qwen3.5-enhanced.jinja');
    if (existsSync(legacyPath)) {
      const legacy = render(legacyPath, { messages, tools: TOOLS });
      if (legacy !== null) {
        expect(legacy).toContain('No user query found in messages.');
      }
    }
  });
});

/**
 * The vendored file is a third-party artifact that steers every local Qwen call.
 * Pin it so a re-vendor from a changed -- or compromised -- upstream fails loudly
 * rather than silently changing the prompt contract. Upstream revision
 * 3dc34df52c63dd22ada21f96435e069deaa8d7da (peculiar-ragdoll/Qwen-Sharp-Chat-Templates).
 */
describe('qwen-sharp chat template -- vendored artifact integrity', () => {
  it('matches the pinned upstream sha256', () => {
    const digest = createHash('sha256').update(readFileSync(QWEN_SHARP)).digest('hex');
    expect(digest).toBe('d1f22a89eac3609dcfaa7b471b1f7d23bee2f084d275d26f4f8231d1d7908f4e');
  });
});

describe('qwen llama-profiles -- all point at a qwen-sharp.jinja that EXISTS', () => {
  for (const profile of ['qwen38-27b-mtp.env', 'qwen36-35b-a3b.env']) {
    it(`${profile} points at qwen-sharp.jinja`, () => {
      const env = readFileSync(join(process.cwd(), 'config', 'llama-profiles', profile), 'utf-8');
      const line = env.split('\n').find((l) => l.startsWith('LLAMA_CHAT_TEMPLATE_FILE='));
      expect(line).toBeDefined();
      expect(line).toContain('tools/agents/config/qwen-sharp.jinja');
    });
  }
});
