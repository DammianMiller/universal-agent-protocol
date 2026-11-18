import type { Plugin } from '@opencode/plugin';
import { $, toolInput, toolResult } from '../lib/uap-plugin-kit';
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';

/**
 * UAP Skills Plugin
 *
 * Provides skill loading capabilities equivalent to Claude Code's
 * .claude/skills/ system. Skills are loaded on-demand via a tool
 * and injected into the system prompt.
 *
 * Skill sources (searched in order):
 * 1. .claude/skills/   (Claude Code skills)
 * 2. .factory/skills/  (Factory skills)
 * 3. skills/           (Project-level skills)
 */

interface SkillMeta {
  name: string;
  description: string;
  path: string;
  source: string;
}

async function discoverSkills(projectDir: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];
  const searchDirs = [
    { dir: join(projectDir, '.claude', 'skills'), source: 'claude' },
    { dir: join(projectDir, '.factory', 'skills'), source: 'factory' },
    { dir: join(projectDir, 'skills'), source: 'project' },
  ];

  for (const { dir, source } of searchDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = join(dir, entry.name, 'SKILL.md');
        try {
          const content = await readFile(skillPath, 'utf-8');
          // Parse YAML frontmatter
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          let name = entry.name;
          let description = '';
          if (fmMatch) {
            const fm = fmMatch[1];
            const nameMatch = fm.match(/^name:\s*(.+)$/m);
            const descMatch = fm.match(/^description:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].trim();
          }
          skills.push({ name, description, path: skillPath, source });
        } catch {
          /* SKILL.md not found in this dir */
        }
      }
    } catch {
      /* directory doesn't exist */
    }
  }

  return skills;
}

// Track loaded skills to inject into system prompt
const loadedSkills = new Map<string, string>();

const plugin: Plugin.Plugin = {
  id: 'uap-skills',
  async setup(ctx) {
    const projectDir = ctx.location.directory || '.';

    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'uap_skill_list',
        description:
          'List all available UAP skills that can be loaded for domain-specific guidance.',
        input: toolInput.object({}),
        async execute() {
          const skills = await discoverSkills(projectDir);
          if (skills.length === 0) return toolResult('No skills found.');
          return toolResult(
            skills
              .map((s) => `- **${s.name}** (${s.source}): ${s.description || 'No description'}`)
              .join('\n')
          );
        },
      });

      editor.add({
        name: 'uap_skill_load',
        description:
          'Load a UAP skill to get domain-specific instructions and guidance. The skill content will be injected into context for the current session.',
        input: toolInput.object(
          {
            name: toolInput.string(
              'Name of the skill to load (use uap_skill_list to see available skills)'
            ),
          },
          ['name']
        ),
        async execute(input) {
          const { name } = input as { name: string };
          const skills = await discoverSkills(projectDir);
          const skill = skills.find(
            (s) => s.name === name || basename(s.path).replace('/SKILL.md', '') === name
          );
          if (!skill) {
            return toolResult(
              `Skill '${name}' not found. Available: ${
                skills.length > 0 ? skills.map((s) => s.name).join(', ') : 'none'
              }`
            );
          }
          const content = await readFile(skill.path, 'utf-8');
          // Strip frontmatter for injection
          const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
          loadedSkills.set(skill.name, body);
          return toolResult(`Skill '${skill.name}' loaded.\n\n${body}`);
        },
      });
    });

    // Inject loaded skills into the system prompt (V2 context hook)
    await ctx.session.hook('context', (event) => {
      if (loadedSkills.size > 0) {
        const skillContext = Array.from(loadedSkills.entries())
          .map(([name, body]) => `<uap-skill name="${name}">\n${body}\n</uap-skill>`)
          .join('\n\n');
        event.system.push({ type: 'text', text: skillContext });
      }
    });
  },
};

export default plugin;
