import { z } from 'zod';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

type Plugin = (params: any) => Promise<any>;

interface ToolDef {
  description: string;
  args?: any;
  execute?: (...args: any[]) => any;
  schema?: any;
}

const tool = (def: ToolDef): ToolDef => {
  const result: ToolDef = {
    ...def,
    schema: {
      string: () => def,
      boolean: () => def,
    },
  };
  return result;
};

/**
 * UAP Droids Plugin - Strict Schema Edition (Option 1A)
 */

const CoordinationSchema = z.object({
  channels: z.array(z.string()).optional(),
  claims: z.array(z.enum(['exclusive', 'shared'])).optional(),
  batches_deploy: z.boolean().default(false),
});

export const DROID_SCHEMA = z.object({
  name: z.string().min(1, 'Droid name required'),
  description: z.string().min(5, 'Description must be at least 5 chars'),
  model: z.enum(['inherit', 'dedicated']).default('inherit'),
  coordination: CoordinationSchema.optional(),
});

interface DroidMeta {
  name: string;
  description: string;
  model: string;
  path: string;
  channels?: Array<string>;
}

export async function discoverDroids(projectDir: string): Promise<DroidMeta[]> {
  const droids: DroidMeta[] = [];
  const droidsDir = join(projectDir, '.factory', 'droids');

  try {
    const entries = await readdir(droidsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const droidPath = join(droidsDir, entry.name);

      try {
        const content = await readFile(droidPath, 'utf-8');

        // Parse JSON frontmatter (not YAML)
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let name: string;
        let description: string;
        let model: string = 'inherit';
        let channelsArray: Array<string> | undefined;

        if (fmMatch) {
          const fm = fmMatch[1].trim();

          try {
            // Try JSON parsing first (strict mode)
            const metadata = JSON.parse(fm);

            const parseResult = DROID_SCHEMA.safeParse(metadata);
            if (!parseResult.success) {
              console.warn(`⚠️  Invalid droid schema: ${entry.name}`);
              continue;
            }

            name = metadata.name;
            description = metadata.description || '';
            model = metadata.model || 'inherit';
            channelsArray = metadata.coordination?.channels || [];
          } catch (e) {
            console.warn(`⚠️  Not valid JSON: ${entry.name}`);
            continue;
          }
        } else {
          name = entry.name.replace('.md', '');
          description = '';
        }

        droids.push({
          name,
          description,
          model,
          path: droidPath,
          channels: channelsArray,
        });
      } catch (e) {
        console.warn(`⚠️  Could not read droid: ${entry.name}`);
      }
    }
  } catch (err) {
    // Droids directory doesn't exist - return empty array gracefully
  }

  return droids;
}

// Re-export the full decoder-first gate from tasks/decoder-gate.ts
export { validateDecoderFirst as validateDecoderFirstFull } from './tasks/decoder-gate.js';

// Option #2A: Simplified Decoder-First Gate Validator (lightweight, no ambiguity detection)
interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export async function validateDecoderFirst(
  droidName: string,
  taskContext: { availableTools?: string[] } = {}
): Promise<ValidationResult> {
  const errors: string[] = [];

  try {
    const projectDir = process.cwd();
    const droids = await discoverDroids(projectDir);

    const found = droids.find((d) => d.name === droidName);
    if (!found) {
      return {
        valid: false,
        errors: [`Droid '${droidName}' not found in .factory/droids/`],
      };
    }

    // Step 1-3 validation already done by discoverDroids

    // Verify Read tool is accessible from the provided tool registry.
    // If no tool list is provided, check for common file-reading tools
    // in the environment (e.g., the `cat` command as a proxy).
    const hasReadTool = taskContext.availableTools
      ? taskContext.availableTools.some(
          (t) =>
            t.toLowerCase() === 'read' ||
            t.toLowerCase() === 'readfile' ||
            t.toLowerCase() === 'cat' ||
            t.toLowerCase().includes('read')
        )
      : await checkReadToolAvailable();

    if (!hasReadTool) {
      errors.push('Required "Read" tool not accessible — provide availableTools in taskContext');
    }

    return {
      valid: errors.length === 0,
      ...(errors.length > 0 ? { errors } : {}),
    };
  } catch (err) {
    return {
      valid: false,
      errors: [`Decoder gate validation error: ${String(err)}`],
    };
  }
}

/**
 * Check if a file-reading tool is available in the environment.
 * Uses `cat --version` as a lightweight proxy for file-read capability.
 */
async function checkReadToolAvailable(): Promise<boolean> {
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('cat', ['--version'], { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch {
    // cat not available — still allow if we're in a Node.js environment
    // where fs.readFile is always available
    try {
      const { accessSync, constants } = await import('fs');
      accessSync('.', constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

// Option #3: Worktree Enforcer
interface WorktreeResult {
  exists: boolean;
  branch?: string;
}

export async function ensureWorktree(droidName: string): Promise<WorktreeResult> {
  try {
    const { execa } = await import('execa');

    const result = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentBranch = result.stdout.trim();

    return {
      exists: true,
      branch: currentBranch !== 'HEAD' ? currentBranch : undefined,
    };
  } catch (err) {
    console.warn(`⚠️  Could not verify worktree for ${droidName}: ${String(err).slice(0, 100)}`);
    return { exists: false };
  }
}

export const UAPDroidsStrict: Plugin = async ({ $: _$, directory: _directory }) => {
  const projectDir = _directory || '.';

  return {
    tool: {
      uap_droid_list: tool({
        description: 'List all available UAP droids with strict JSON schema validation',
        args: {},
        async execute() {
          const droids = await discoverDroids(projectDir);

          if (droids.length === 0) return 'No valid droids found in .factory/droids/';

          for (const droid of droids) {
            const validation = await validateDecoderFirst(droid.name);
            if (!validation.valid && (validation.errors?.length || 0) > 0) {
              console.warn(`⚠️  ${droid.name}: ${(validation.errors || [])[0]}`);
            }
          }

          return droids
            .map((d: any) => `- **${d.name}** (model: ${d.model}): ${d.description}`)
            .join('\n');
        },
      }),

      uap_droid_invoke: tool({
        description: 'Invoke a UAP droid with strict schema validation and decoder-first gate',
        args: {
          droid: (tool as any).schema.string().describe('Name of the droid'),
          task: (tool as any).schema.string().describe('The task to execute'),
          requireWorktree: (tool as any).schema
            .boolean()
            .default(false)
            .optional()
            .describe('Require active worktree before execution (Option #3)'),
        },
        async execute({ droid, task, requireWorktree }: any) {
          // Option #2A: Decoder-First Gate Validation
          const validation = await validateDecoderFirst(droid);
          if (!validation.valid && (validation.errors?.length || 0) > 0) {
            return `❌ Droid '${droid}' failed decoder gate:\n${(validation.errors || []).join('\n')}`;
          }

          // Option #3: Worktree Enforcement (if required)
          if (requireWorktree === true) {
            const worktree = await ensureWorktree(droid);
            if (!worktree.exists && !worktree.branch) {
              return `❌ Droid '${droid}' requires active worktree. Run:\nuap worktree create <slug>`;
            }
          }

          // Find droid and load instructions
          const droids = await discoverDroids(projectDir);
          const found = droids.find((d: any) => d.name === droid);

          if (!found) {
            return `❌ Droid '${droid}' not found. List available: uap_droid_list`;
          }

          // Extract body (skip JSON frontmatter)
          const content = await readFile(found.path, 'utf-8');
          const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

          return `<uap-droid name="${found.name}" validated="true">
## Droid: ${droid}
${found.description || ''}

### Instructions
${body.substring(0, 8000)}

### Task Context
${task.slice(0, 2000)}`;
        },
      }),
    },
  };
};
