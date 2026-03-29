import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('uap tool-calls CLI wiring', () => {
  const cliPath = join(process.cwd(), 'src/bin/cli.ts');
  const cliSource = readFileSync(cliPath, 'utf-8');

  it('registers the tool-calls top-level command', () => {
    expect(cliSource).toContain("new Command('tool-calls')");
    expect(cliSource).toContain('program.addCommand(toolCallsCmd)');
  });

  it('routes tool-calls subcommands through lazy loader', () => {
    expect(cliSource).toContain("toolCalls: () => import('../cli/tool-calls.js')");
    expect(cliSource).toContain("(await lazy.toolCalls())('test')");
  });
});
