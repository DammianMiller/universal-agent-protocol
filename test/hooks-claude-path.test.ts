import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Regression: Claude/VSCode hook commands used a relative `.claude/hooks/...`
 * path, which fails with "No such file or directory" whenever a tool call runs
 * from a subdir or worktree. They must use an absolute `${CLAUDE_PROJECT_DIR}`
 * prefix (like the Factory installer already does).
 */
describe('Claude hook commands use an absolute project-dir path', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  async function installAndRead(target: 'claude' | 'vscode'): Promise<string> {
    const dir = join(tmpdir(), `uap-claudepath-${target}-${Date.now()}`);
    dirs.push(dir);
    const { hooksCommand } = await import('../src/cli/hooks.js');
    await hooksCommand('install', { projectDir: dir, target });
    const settingsPath = join(dir, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    return readFileSync(settingsPath, 'utf-8');
  }

  it('claude install wires ${CLAUDE_PROJECT_DIR}-prefixed commands, never bare relative', async () => {
    const s = await installAndRead('claude');
    expect(s).toContain('${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/');
    // The fragile relative form must be gone.
    expect(s).not.toMatch(/"bash \.claude\/hooks\//);
  });

  it('vscode install (claude-format) also uses the absolute prefix', async () => {
    const s = await installAndRead('vscode');
    expect(s).toContain('${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/');
    expect(s).not.toMatch(/"bash \.claude\/hooks\//);
  });
});
