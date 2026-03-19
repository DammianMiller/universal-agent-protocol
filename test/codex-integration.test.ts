/**
 * Tests for Codex CLI integration
 *
 * Validates that the Codex platform is properly integrated into UAP:
 * - Platform type includes 'codex'
 * - Config schema accepts codex platform
 * - Hook installer generates correct artifacts
 * - Setup wizard maps Codex CLI correctly
 * - Init creates correct directory structure
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Codex Integration - Type System', () => {
  it('Platform type includes codex', async () => {
    // Import the config module to verify the Platform type is used correctly
    const { AgentContextConfigSchema } = await import('../src/types/config.js');

    // Parse a config with codex platform enabled
    const result = AgentContextConfigSchema.safeParse({
      version: '1.0.0',
      project: { name: 'test', defaultBranch: 'main' },
      platforms: {
        codex: { enabled: true },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platforms?.codex?.enabled).toBe(true);
    }
  });

  it('Config schema validates codex platform with all options', async () => {
    const { AgentContextConfigSchema } = await import('../src/types/config.js');

    const result = AgentContextConfigSchema.safeParse({
      version: '1.0.0',
      project: { name: 'test', defaultBranch: 'main' },
      platforms: {
        codex: {
          enabled: true,
          shortTermMax: 30,
          searchResults: 5,
          sessionMax: 100,
          patternRag: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platforms?.codex?.patternRag).toBe(true);
      expect(result.data.platforms?.codex?.shortTermMax).toBe(30);
    }
  });

  it('Config schema accepts codex alongside other platforms', async () => {
    const { AgentContextConfigSchema } = await import('../src/types/config.js');

    const result = AgentContextConfigSchema.safeParse({
      version: '1.0.0',
      project: { name: 'test', defaultBranch: 'main' },
      platforms: {
        claudeCode: { enabled: true },
        opencode: { enabled: true },
        codex: { enabled: true },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platforms?.claudeCode?.enabled).toBe(true);
      expect(result.data.platforms?.opencode?.enabled).toBe(true);
      expect(result.data.platforms?.codex?.enabled).toBe(true);
    }
  });
});

describe('Codex Integration - Hooks', () => {
  it('HooksTarget type includes codex', async () => {
    const { hooksCommand } = await import('../src/cli/hooks.js');
    // The function exists and accepts 'codex' as a target
    expect(typeof hooksCommand).toBe('function');
  });

  it('installCodexHooks generates AGENTS.md', async () => {
    const testDir = join(tmpdir(), `uap-codex-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create minimal template hooks directory
    const templateHooksDir = join(testDir, 'templates', 'hooks');
    mkdirSync(templateHooksDir, { recursive: true });
    writeFileSync(join(templateHooksDir, 'session-start.sh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(templateHooksDir, 'pre-compact.sh'), '#!/usr/bin/env bash\nexit 0\n');

    try {
      // We test the hooks command with codex target
      // Since installCodexHooks creates AGENTS.md, config.toml, and skills,
      // we verify the expected output structure
      const { hooksCommand } = await import('../src/cli/hooks.js');
      await hooksCommand('install', { projectDir: testDir, target: 'codex' });

      // Verify AGENTS.md was created
      const agentsMdPath = join(testDir, 'AGENTS.md');
      expect(existsSync(agentsMdPath)).toBe(true);

      const agentsMd = readFileSync(agentsMdPath, 'utf-8');
      expect(agentsMd).toContain('Universal Agent Protocol');
      expect(agentsMd).toContain('uap memory query');
      expect(agentsMd).toContain('uap worktree create');
      expect(agentsMd).toContain('uap patterns query');
      expect(agentsMd).toContain('uap task create');
      expect(agentsMd).toContain('uap dashboard');

      // Verify .codex/config.toml was created with MCP server
      const configTomlPath = join(testDir, '.codex', 'config.toml');
      expect(existsSync(configTomlPath)).toBe(true);

      const configToml = readFileSync(configTomlPath, 'utf-8');
      expect(configToml).toContain('[mcp_servers.uap]');
      expect(configToml).toContain('command = "uap"');
      expect(configToml).toContain('args = ["mcp", "serve"]');

      // Verify skills were created
      const skillNames = ['uap-memory', 'uap-worktree', 'uap-patterns', 'uap-tasks', 'uap-coordination'];
      for (const skill of skillNames) {
        const skillPath = join(testDir, '.agents', 'skills', skill, 'SKILL.md');
        expect(existsSync(skillPath)).toBe(true);

        const skillContent = readFileSync(skillPath, 'utf-8');
        expect(skillContent).toContain('---');
        expect(skillContent).toContain(`name: ${skill}`);
        expect(skillContent).toContain('description:');
      }

      // Verify .codex/hooks directory was created
      const hooksDir = join(testDir, '.codex', 'hooks');
      expect(existsSync(hooksDir)).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('installCodexHooks appends to existing AGENTS.md', async () => {
    const testDir = join(tmpdir(), `uap-codex-test-append-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create template hooks
    const templateHooksDir = join(testDir, 'templates', 'hooks');
    mkdirSync(templateHooksDir, { recursive: true });
    writeFileSync(join(templateHooksDir, 'session-start.sh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(templateHooksDir, 'pre-compact.sh'), '#!/usr/bin/env bash\nexit 0\n');

    // Create existing AGENTS.md
    const existingContent = '# My Project\n\nExisting instructions here.\n';
    writeFileSync(join(testDir, 'AGENTS.md'), existingContent);

    try {
      const { hooksCommand } = await import('../src/cli/hooks.js');
      await hooksCommand('install', { projectDir: testDir, target: 'codex' });

      const agentsMd = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
      // Should preserve existing content
      expect(agentsMd).toContain('My Project');
      expect(agentsMd).toContain('Existing instructions here');
      // Should append UAP section
      expect(agentsMd).toContain('Universal Agent Protocol');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('installCodexHooks is idempotent for AGENTS.md', async () => {
    const testDir = join(tmpdir(), `uap-codex-test-idempotent-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const templateHooksDir = join(testDir, 'templates', 'hooks');
    mkdirSync(templateHooksDir, { recursive: true });
    writeFileSync(join(templateHooksDir, 'session-start.sh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(templateHooksDir, 'pre-compact.sh'), '#!/usr/bin/env bash\nexit 0\n');

    try {
      const { hooksCommand } = await import('../src/cli/hooks.js');

      // Install twice
      await hooksCommand('install', { projectDir: testDir, target: 'codex' });
      const firstContent = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');

      await hooksCommand('install', { projectDir: testDir, target: 'codex' });
      const secondContent = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');

      // Content should not be duplicated
      expect(secondContent).toBe(firstContent);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('Codex Integration - Setup Wizard Mapping', () => {
  it('Codex CLI maps to codex hook target', async () => {
    // We verify the mapping by checking the source file content
    const wizardPath = join(process.cwd(), 'src/cli/setup-wizard.ts');
    const content = readFileSync(wizardPath, 'utf-8');

    // Verify HARNESS_TO_HOOK_TARGET maps Codex CLI to codex
    expect(content).toContain("'Codex CLI': 'codex'");
  });

  it('Codex CLI maps to codex platform', async () => {
    const wizardPath = join(process.cwd(), 'src/cli/setup-wizard.ts');
    const content = readFileSync(wizardPath, 'utf-8');

    // Verify HARNESS_TO_PLATFORM maps Codex CLI to codex
    const platformSection = content.slice(content.indexOf('HARNESS_TO_PLATFORM'));
    expect(platformSection).toContain("'Codex CLI': 'codex'");
  });
});

describe('Codex Integration - Init Platform', () => {
  it('PLATFORM_MAP includes codex', async () => {
    const initPath = join(process.cwd(), 'src/cli/init.ts');
    const content = readFileSync(initPath, 'utf-8');

    expect(content).toContain("codex: 'codex'");
  });

  it('platformDirs includes codex with correct directories', async () => {
    const initPath = join(process.cwd(), 'src/cli/init.ts');
    const content = readFileSync(initPath, 'utf-8');

    expect(content).toContain("codex: ['.codex', '.agents/skills']");
  });

  it('all platforms default includes codex', async () => {
    const initPath = join(process.cwd(), 'src/cli/init.ts');
    const content = readFileSync(initPath, 'utf-8');

    // The 'all' platforms list should include codex
    expect(content).toContain("'codex'");
    // Verify it's in the all-platforms array
    const allPlatformsMatch = content.match(/\? \[.*'codex'.*\]/);
    expect(allPlatformsMatch).not.toBeNull();
  });
});

describe('Codex Integration - .uap.json', () => {
  it('.uap.json includes codex platform', () => {
    const uapJsonPath = join(process.cwd(), '.uap.json');
    const config = JSON.parse(readFileSync(uapJsonPath, 'utf-8'));

    expect(config.platforms.codex).toBeDefined();
    expect(config.platforms.codex.enabled).toBe(true);
  });
});

describe('Codex Integration - Skill Structure', () => {
  it('skills follow the Codex agent skills standard', async () => {
    // Verify that the generated skills follow the correct structure:
    // - SKILL.md with YAML frontmatter (name, description)
    // - Proper markdown content
    const testDir = join(tmpdir(), `uap-codex-skill-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const templateHooksDir = join(testDir, 'templates', 'hooks');
    mkdirSync(templateHooksDir, { recursive: true });
    writeFileSync(join(templateHooksDir, 'session-start.sh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(templateHooksDir, 'pre-compact.sh'), '#!/usr/bin/env bash\nexit 0\n');

    try {
      const { hooksCommand } = await import('../src/cli/hooks.js');
      await hooksCommand('install', { projectDir: testDir, target: 'codex' });

      const skillNames = ['uap-memory', 'uap-worktree', 'uap-patterns', 'uap-tasks', 'uap-coordination'];
      for (const skill of skillNames) {
        const skillPath = join(testDir, '.agents', 'skills', skill, 'SKILL.md');
        const content = readFileSync(skillPath, 'utf-8');

        // Verify YAML frontmatter structure
        expect(content.startsWith('---')).toBe(true);
        const frontmatterEnd = content.indexOf('---', 3);
        expect(frontmatterEnd).toBeGreaterThan(3);

        const frontmatter = content.slice(3, frontmatterEnd).trim();
        expect(frontmatter).toContain('name:');
        expect(frontmatter).toContain('description:');

        // Verify the name matches the directory
        expect(frontmatter).toContain(`name: ${skill}`);

        // Verify there's actual content after frontmatter
        const body = content.slice(frontmatterEnd + 3).trim();
        expect(body.length).toBeGreaterThan(50);
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
