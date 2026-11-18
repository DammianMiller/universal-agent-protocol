import type { Plugin } from '@opencode/plugin';
import { $, toolInput, toolResult } from '../lib/uap-plugin-kit';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * UAP Droids Plugin
 *
 * Provides droid (specialized agent) capabilities equivalent to
 * Claude Code's Task(subagent_type) system. Droids are loaded from
 * .factory/droids/ and can be invoked as tools.
 *
 * Each droid has a YAML frontmatter with name, description, model,
 * and coordination config, followed by markdown instructions.
 */

interface DroidMeta {
  name: string;
  description: string;
  model: string;
  path: string;
  channels: string[];
}

// Droid discovery cache: avoids re-reading filesystem on every invocation
let _droidCache: { droids: DroidMeta[]; timestamp: number } | null = null;
const DROID_CACHE_TTL_MS = 60_000; // 1 minute

async function discoverDroids(projectDir: string): Promise<DroidMeta[]> {
  // Return cached results if fresh
  if (_droidCache && Date.now() - _droidCache.timestamp < DROID_CACHE_TTL_MS) {
    return _droidCache.droids;
  }

  const droids: DroidMeta[] = [];
  const droidsDir = join(projectDir, '.factory', 'droids');

  try {
    const entries = await readdir(droidsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const droidPath = join(droidsDir, entry.name);
      try {
        const content = await readFile(droidPath, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let name = entry.name.replace('.md', '');
        let description = '';
        let model = 'inherit';
        let channels: string[] = [];

        if (fmMatch) {
          const fm = fmMatch[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          const modelMatch = fm.match(/^model:\s*(.+)$/m);
          const channelsMatch = fm.match(/channels:\s*\[([^\]]*)\]/);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].trim();
          if (modelMatch) model = modelMatch[1].trim();
          if (channelsMatch) {
            channels = channelsMatch[1].split(',').map((c) => c.trim().replace(/['"]/g, ''));
          }
        }
        droids.push({ name, description, model, path: droidPath, channels });
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* droids directory doesn't exist */
  }

  // Update cache
  _droidCache = { droids, timestamp: Date.now() };
  return droids;
}

const plugin: Plugin.Plugin = {
  id: 'uap-droids',
  async setup(ctx) {
    const projectDir = ctx.location.directory || '.';

    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'uap_droid_list',
        description:
          'List all available UAP droids (specialized agents) that can be invoked for domain-specific tasks like code review, security auditing, performance optimization, etc.',
        input: toolInput.object({}),
        async execute() {
          const droids = await discoverDroids(projectDir);
          if (droids.length === 0) return toolResult('No droids found in .factory/droids/');
          return toolResult(
            droids
              .map(
                (d) =>
                  `- **${d.name}** (model: ${d.model || 'inherit'}): ${d.description || 'No description'}`
              )
              .join('\n')
          );
        },
      });

      editor.add({
        name: 'uap_droid_invoke',
        description:
          "Invoke a UAP droid (specialized agent) with a specific task. The droid's full instructions will be loaded and the task will be executed according to its specialized protocol.",
        input: toolInput.object(
          {
            droid: toolInput.string(
              'Name of the droid to invoke (use uap_droid_list to see available droids)'
            ),
            task: toolInput.string('The task description for the droid to execute'),
          },
          ['droid', 'task']
        ),
        async execute(input, tctx) {
          const { droid, task } = input as { droid: string; task: string };
          const droids = await discoverDroids(projectDir);
          const found = droids.find((d) => d.name === droid);
          if (!found) {
            return toolResult(
              `Droid '${droid}' not found. Available: ${droids.map((d) => d.name).join(', ')}`
            );
          }

          const content = await readFile(found.path, 'utf-8');
          const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

          // Query CapabilityRouter for routing context
          let routingContext = '';
          try {
            const routeResult = await $`node -e "
              import { getCapabilityRouter } from './dist/coordination/capability-router.js';
              const r = getCapabilityRouter();
              const result = r.routeTask({ title: '${task.replace(/'/g, "\\'")}', type: 'task', labels: [] });
              console.log(JSON.stringify({ droids: result.recommendedDroids, skills: result.recommendedSkills, confidence: result.confidence }));
            " 2>/dev/null`
              .quiet()
              .nothrowMode();
            if (routeResult.exitCode === 0 && routeResult.stdout) {
              const parsed = JSON.parse(routeResult.stdout.toString().trim()) as {
                droids?: string[];
                skills?: string[];
                confidence?: number;
              };
              if ((parsed.droids && parsed.droids.length > 0) || (parsed.skills && parsed.skills.length > 0)) {
                routingContext = `\n### Capability Routing\nRecommended droids: ${(parsed.droids || []).join(', ') || 'none'}\nRecommended skills: ${(parsed.skills || []).join(', ') || 'none'}\nConfidence: ${((parsed.confidence || 0) * 100).toFixed(0)}%\n`;
              }
            }
          } catch {
            /* routing is best-effort */
          }

          // Query PatternRouter for applicable patterns
          let patternContext = '';
          try {
            const patResult = await $`node -e "
              import { getPatternRouter } from './dist/coordination/pattern-router.js';
              const r = getPatternRouter();
              const checklist = r.getEnforcementChecklist('${task.replace(/'/g, "\\'")}');
              console.log(JSON.stringify(checklist.map(p => p.id + ': ' + p.title)));
            " 2>/dev/null`
              .quiet()
              .nothrowMode();
            if (patResult.exitCode === 0 && patResult.stdout) {
              const patterns = JSON.parse(patResult.stdout.toString().trim()) as string[];
              if (patterns.length > 0) {
                patternContext = `\n### Enforcement Patterns\n${patterns.map((p) => `- ${p}`).join('\n')}\n`;
              }
            }
          } catch {
            /* patterns are best-effort */
          }

          const droidContext = `<uap-droid name="${found.name}">
## Droid: ${found.name}
${found.description || 'No description available'}
${routingContext}${patternContext}
### Instructions
${body}

### Current Task
${task}
</uap-droid>

Follow the droid instructions above to complete the task. Apply all mandatory pre-checks and protocols specified.`;

          // Load the droid context into the session as a follow-up prompt
          // (V2: the session API takes plain text). Best-effort: if the
          // prompt fails, fall back to returning it as the tool result.
          try {
            await ctx.session.prompt({ sessionID: tctx.sessionID, text: droidContext });
            return toolResult(
              `Droid '${found.name}' loaded as a session prompt \u2014 follow its instructions to complete the task.`
            );
          } catch {
            return toolResult(droidContext);
          }
        },
      });

      editor.add({
        name: 'uap_droid_review',
        description:
          'Run the code-quality-guardian droid to review recent changes. Shortcut for the most common droid invocation.',
        input: toolInput.object(
          {
            scope: toolInput.string(
              "What to review: 'staged' (git staged), 'diff' (unstaged), or a file path"
            ),
          },
          []
        ),
        async execute(input) {
          const { scope } = input as { scope?: string };
          const what = scope ?? 'staged';
          let diffOutput: string;
          try {
            if (what === 'staged') {
              const result = await $`git diff --cached`.quiet();
              diffOutput = result.stdout.toString().trim();
            } else if (what === 'diff') {
              const result = await $`git diff`.quiet();
              diffOutput = result.stdout.toString().trim();
            } else {
              const result = await $`git diff -- ${what}`.quiet();
              diffOutput = result.stdout.toString().trim();
            }
          } catch {
            diffOutput = '(unable to get diff)';
          }

          if (!diffOutput) return toolResult('No changes to review.');

          const droids = await discoverDroids(projectDir);
          const guardian = droids.find((d) => d.name === 'code-quality-guardian');
          if (!guardian)
            return toolResult(`Code quality guardian droid not found. Diff:\n${diffOutput}`);

          const content = await readFile(guardian.path, 'utf-8');
          const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

          return toolResult(`<uap-droid name="code-quality-guardian">
${body}

### Changes to Review
\`\`\`diff
${diffOutput.slice(0, 8000)}
\`\`\`
</uap-droid>

Review the changes above following the code quality guardian protocol.`);
        },
      });
    });
  },
};

export default plugin;
