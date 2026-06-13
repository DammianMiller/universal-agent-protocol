import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const proxyPath = join(
  process.cwd(),
  'tools',
  'agents',
  'scripts',
  'anthropic_proxy.py'
);
const grammarPath = join(
  process.cwd(),
  'tools',
  'agents',
  'config',
  'thinking.gbnf'
);
const startupScriptPath = join(
  process.cwd(),
  'scripts',
  'run-anthropic-proxy-continuity.sh'
);

describe('anthropic_proxy thinking grammar toggle', () => {
  it('ships a thinking.gbnf file with the Q/M/K/R/V slot grammar', () => {
    expect(existsSync(grammarPath)).toBe(true);
    const gbnf = readFileSync(grammarPath, 'utf-8');
    expect(gbnf).toContain('root ::= think out');
    expect(gbnf).toContain('"Q="');
    expect(gbnf).toContain('"M="');
    expect(gbnf).toContain('"K="');
    expect(gbnf).toContain('"R="');
    expect(gbnf).toContain('"V="');
    expect(gbnf).toMatch(/q\s*::=\s*"solve"\s*\|\s*"prove"/);
    expect(gbnf).toMatch(/v\s*::=\s*"ok"\s*\|\s*"fail"/);
  });

  it('exposes PROXY_THINKING_GRAMMAR env toggle that defaults to off', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    expect(contents).toContain('PROXY_THINKING_GRAMMAR');
    expect(contents).toContain('PROXY_THINKING_GRAMMAR_PATH');
    expect(contents).toContain('thinking.gbnf');
    // Default must be off so existing deployments are unaffected
    expect(contents).toMatch(
      /PROXY_THINKING_GRAMMAR["'],\s*"off"/
    );
  });

  it('defines _apply_thinking_grammar that skips tool turns and existing grammar', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    expect(contents).toContain('def _apply_thinking_grammar');
    expect(contents).toContain('THINKING_GBNF');
    // Must early-return on tool turns (tool-call grammar takes precedence)
    expect(contents).toMatch(
      /def _apply_thinking_grammar[\s\S]{0,800}request_body\.get\("tools"\)/
    );
    // Must early-return when grammar is already set (don't clobber profile/tool grammar)
    expect(contents).toMatch(
      /def _apply_thinking_grammar[\s\S]{0,800}request_body\.get\("grammar"\)/
    );
    // Must be invoked from the request builder
    expect(contents).toContain('_apply_thinking_grammar(openai_body)');
  });

  it('startup script wires the toggle and points at thinking.gbnf', () => {
    const sh = readFileSync(startupScriptPath, 'utf-8');
    expect(sh).toContain('PROXY_THINKING_GRAMMAR');
    expect(sh).toContain('PROXY_THINKING_GRAMMAR_PATH');
    expect(sh).toContain('thinking.gbnf');
    // Must default off in the startup script too
    expect(sh).toMatch(/PROXY_THINKING_GRAMMAR:-off/);
  });

  it('logs thinking grammar status at startup', () => {
    const contents = readFileSync(proxyPath, 'utf-8');
    expect(contents).toContain('Thinking grammar: enabled=%s loaded=%s path=%s');
  });
});
