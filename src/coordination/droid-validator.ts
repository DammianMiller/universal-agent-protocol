import { z } from 'zod';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { Dirent } from 'fs';

/**
 * Droid JSON Schema Validator
 *
 * Validates droid markdown files against the strict UAP droid schema.
 * Extracts YAML/JSON frontmatter and checks required fields.
 */

export interface DroidValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  droidPath?: string;
}

const CoordinationSchema = z.object({
  channels: z.array(z.string()).optional(),
  claims: z.array(z.enum(['exclusive', 'shared'])).optional(),
  batches_deploy: z.boolean().default(false),
});

export const DroidFrontmatterSchema = z.object({
  name: z.string().min(1, 'Droid name is required'),
  description: z.string().min(5, 'Description must be at least 5 characters'),
  model: z.enum(['inherit', 'dedicated']).default('inherit'),
  coordination: CoordinationSchema.optional(),
});

export type DroidFrontmatter = z.infer<typeof DroidFrontmatterSchema>;

/**
 * Extract frontmatter block from a markdown file's content.
 * Supports both JSON and YAML-style frontmatter delimited by `---`.
 */
function extractFrontmatter(content: string): { raw: string; format: 'json' | 'yaml' } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const raw = match[1].trim();
  if (!raw) return null;

  // Detect format: if it starts with `{`, treat as JSON
  const format = raw.startsWith('{') ? 'json' : 'yaml';
  return { raw, format };
}

/**
 * Parse frontmatter string into an object.
 * Supports JSON directly; for YAML, does a simple key-value parse
 * (covers the common flat-object case without requiring a full YAML parser at import time).
 */
async function parseFrontmatter(
  raw: string,
  format: 'json' | 'yaml'
): Promise<Record<string, unknown>> {
  if (format === 'json') {
    return JSON.parse(raw) as Record<string, unknown>;
  }

  // Use js-yaml for YAML parsing
  const yaml = await import('js-yaml');
  const parsed = yaml.load(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('YAML frontmatter did not parse to an object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validate a single droid markdown file against the schema.
 */
export async function validateDroidSchema(droidPath: string): Promise<DroidValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let content: string;
  try {
    content = await readFile(droidPath, 'utf-8');
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to read file: ${String(err)}`],
      warnings: [],
      droidPath,
    };
  }

  // Extract frontmatter
  const fm = extractFrontmatter(content);
  if (!fm) {
    return {
      valid: false,
      errors: ['No frontmatter block found (expected --- delimited block at start of file)'],
      warnings: [],
      droidPath,
    };
  }

  // Parse frontmatter
  let metadata: Record<string, unknown>;
  try {
    metadata = await parseFrontmatter(fm.raw, fm.format);
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to parse ${fm.format.toUpperCase()} frontmatter: ${String(err)}`],
      warnings: [],
      droidPath,
    };
  }

  // Validate against Zod schema
  const parseResult = DroidFrontmatterSchema.safeParse(metadata);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      errors.push(`${path}: ${issue.message}`);
    }
  }

  // Warnings for optional best practices
  if (!metadata['coordination']) {
    warnings.push(
      'No coordination block defined; droid will not participate in multi-agent coordination'
    );
  }

  if (metadata['model'] === 'dedicated') {
    warnings.push('Droid uses dedicated model; ensure resource allocation is configured');
  }

  // Check that the file has body content beyond frontmatter
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  if (!body) {
    warnings.push('Droid file has no instruction body after frontmatter');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    droidPath,
  };
}

/**
 * Validate all droid `.md` files in a directory.
 */
export async function validateAllDroids(droidsDir: string): Promise<DroidValidationResult[]> {
  const results: DroidValidationResult[] = [];

  let entries: Dirent[];
  try {
    entries = (await readdir(droidsDir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    return [
      {
        valid: false,
        errors: [`Failed to read droids directory '${droidsDir}': ${String(err)}`],
        warnings: [],
      },
    ];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const droidPath = join(droidsDir, entry.name);
    const result = await validateDroidSchema(droidPath);
    results.push(result);
  }

  return results;
}
