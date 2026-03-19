/**
 * Schema Diff Validation Tool
 *
 * Detects breaking changes in Zod schemas, TypeScript interfaces,
 * database schemas (SQLite), and API contracts by comparing before/after
 * snapshots of schema-defining files.
 *
 * Replaces the v3.0.0 stub with a working implementation.
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';

export interface SchemaDiffResult {
  file: string;
  changes: SchemaChange[];
  breaking: boolean;
}

export interface SchemaChange {
  type: 'added' | 'removed' | 'modified';
  path: string;
  description: string;
  breaking: boolean;
}

/**
 * Extract Zod schema field names from source code.
 * Matches patterns like: z.object({ fieldName: z.string(), ... })
 */
function extractZodFields(content: string): Map<string, string> {
  const fields = new Map<string, string>();

  // Match z.object({ ... }) blocks
  const objectBlocks = content.matchAll(/z\.object\(\s*\{([\s\S]*?)\}\s*\)/g);

  for (const block of objectBlocks) {
    const body = block[1];
    // Match field: z.type() patterns
    const fieldMatches = body.matchAll(
      /(\w+)\s*:\s*(z\.\w+(?:\([^)]*\))?(?:\.\w+(?:\([^)]*\))?)*)/g
    );
    for (const fm of fieldMatches) {
      fields.set(fm[1], fm[2]);
    }
  }

  return fields;
}

/**
 * Extract TypeScript interface/type fields from source code.
 * Matches patterns like: interface Foo { bar: string; baz?: number; }
 */
function extractTypeScriptFields(content: string): Map<string, string> {
  const fields = new Map<string, string>();

  // Match interface/type blocks
  const blocks = content.matchAll(
    /(?:interface|type)\s+\w+\s*(?:extends\s+\w+\s*)?\{([\s\S]*?)\}/g
  );

  for (const block of blocks) {
    const body = block[1];
    // Match field: type patterns (including optional ?)
    const fieldMatches = body.matchAll(/(\w+)\??\s*:\s*([^;]+)/g);
    for (const fm of fieldMatches) {
      fields.set(fm[1], fm[2].trim());
    }
  }

  return fields;
}

/**
 * Extract SQLite CREATE TABLE columns from SQL or source code.
 */
function extractSQLiteColumns(content: string): Map<string, string> {
  const columns = new Map<string, string>();

  const createTables = content.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)/gi
  );

  for (const table of createTables) {
    const tableName = table[1];
    const body = table[2];
    const colMatches = body.matchAll(
      /(\w+)\s+(INTEGER|TEXT|REAL|BLOB|DATETIME|BOOLEAN|VARCHAR[^,]*)/gi
    );
    for (const col of colMatches) {
      columns.set(`${tableName}.${col[1]}`, col[2].trim());
    }
  }

  return columns;
}

/**
 * Compare two field maps and produce a list of changes.
 */
function diffFields(
  before: Map<string, string>,
  after: Map<string, string>,
  context: string
): SchemaChange[] {
  const changes: SchemaChange[] = [];

  // Check for removed fields (breaking)
  for (const [name, type] of before) {
    if (!after.has(name)) {
      changes.push({
        type: 'removed',
        path: `${context}.${name}`,
        description: `Field "${name}" (${type}) was removed`,
        breaking: true,
      });
    }
  }

  // Check for added fields
  for (const [name, type] of after) {
    if (!before.has(name)) {
      // Added fields are only breaking if they're required (no ? or .optional())
      const isRequired = !type.includes('optional') && !type.includes('?');
      changes.push({
        type: 'added',
        path: `${context}.${name}`,
        description: `Field "${name}" (${type}) was added${isRequired ? ' (required — breaking)' : ''}`,
        breaking: isRequired,
      });
    }
  }

  // Check for modified fields
  for (const [name, beforeType] of before) {
    const afterType = after.get(name);
    if (afterType && afterType !== beforeType) {
      // Type changes are breaking if the type narrowed or changed fundamentally
      const isBreaking = !afterType.includes(beforeType);
      changes.push({
        type: 'modified',
        path: `${context}.${name}`,
        description: `Field "${name}" type changed: "${beforeType}" → "${afterType}"`,
        breaking: isBreaking,
      });
    }
  }

  return changes;
}

/**
 * Diff a single file's schema between two versions (git-based).
 */
export async function diffFileSchema(
  filePath: string,
  baseBranch: string = 'HEAD~1'
): Promise<SchemaDiffResult> {
  const changes: SchemaChange[] = [];

  try {
    // Get the "before" version from git
    const { execSync } = await import('child_process');
    let beforeContent: string;
    try {
      beforeContent = execSync(`git show ${baseBranch}:${filePath}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // File didn't exist before — all fields are new (non-breaking)
      return { file: filePath, changes: [], breaking: false };
    }

    // Get the "after" version from working tree
    if (!existsSync(filePath)) {
      // File was deleted — all fields removed (breaking)
      return {
        file: filePath,
        changes: [
          {
            type: 'removed',
            path: filePath,
            description: `File "${filePath}" was deleted`,
            breaking: true,
          },
        ],
        breaking: true,
      };
    }

    const afterContent = readFileSync(filePath, 'utf-8');

    // Detect schema type and extract fields
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) {
      // Check for Zod schemas
      if (beforeContent.includes('z.object') || afterContent.includes('z.object')) {
        const beforeFields = extractZodFields(beforeContent);
        const afterFields = extractZodFields(afterContent);
        changes.push(...diffFields(beforeFields, afterFields, 'zod'));
      }

      // Check for TypeScript interfaces/types
      const beforeTsFields = extractTypeScriptFields(beforeContent);
      const afterTsFields = extractTypeScriptFields(afterContent);
      if (beforeTsFields.size > 0 || afterTsFields.size > 0) {
        changes.push(...diffFields(beforeTsFields, afterTsFields, 'typescript'));
      }

      // Check for SQLite schemas in code
      if (beforeContent.includes('CREATE TABLE') || afterContent.includes('CREATE TABLE')) {
        const beforeCols = extractSQLiteColumns(beforeContent);
        const afterCols = extractSQLiteColumns(afterContent);
        changes.push(...diffFields(beforeCols, afterCols, 'sqlite'));
      }
    }

    // SQL files
    if (filePath.endsWith('.sql')) {
      const beforeCols = extractSQLiteColumns(beforeContent);
      const afterCols = extractSQLiteColumns(afterContent);
      changes.push(...diffFields(beforeCols, afterCols, 'sql'));
    }

    // JSON schema files
    if (
      filePath.endsWith('.json') &&
      (filePath.includes('schema') || filePath.includes('config'))
    ) {
      try {
        const beforeObj = JSON.parse(beforeContent);
        const afterObj = JSON.parse(afterContent);
        const flatBefore = flattenObject(beforeObj) as Record<string, unknown>;
        const flatAfter = flattenObject(afterObj) as Record<string, unknown>;
        const beforeKeys = new Map(Object.keys(flatBefore).map((k) => [k, typeof flatBefore[k]]));
        const afterKeys = new Map(Object.keys(flatAfter).map((k) => [k, typeof flatAfter[k]]));
        changes.push(...diffFields(beforeKeys, afterKeys, 'json'));
      } catch {
        // Not valid JSON
      }
    }
  } catch {
    // Git or file read error
  }

  return {
    file: filePath,
    changes,
    breaking: changes.some((c) => c.breaking),
  };
}

/**
 * Flatten a nested object into dot-notation keys.
 */
function flattenObject(obj: Record<string, unknown>, prefix: string = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * Run schema diff on all changed files that contain schemas.
 */
export async function schemaDiffCommand(
  baseBranch: string = 'HEAD~1'
): Promise<SchemaDiffResult[]> {
  const results: SchemaDiffResult[] = [];

  try {
    const { execSync } = await import('child_process');

    // Get list of changed files
    const changedFiles = execSync(`git diff --name-only ${baseBranch}`, {
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    // Filter to schema-relevant files
    const schemaFiles = changedFiles.filter(
      (f) =>
        f.includes('schema') ||
        f.includes('types') ||
        f.includes('config') ||
        f.includes('database') ||
        f.endsWith('.sql') ||
        (f.endsWith('.ts') &&
          (f.includes('types/') ||
            f.includes('schemas/') ||
            f.includes('coordination/database') ||
            f.includes('memory/short-term/schema') ||
            f.includes('tasks/database') ||
            f.includes('tasks/types')))
    );

    for (const file of schemaFiles) {
      const result = await diffFileSchema(file, baseBranch);
      if (result.changes.length > 0) {
        results.push(result);
      }
    }

    // Print results
    if (results.length === 0) {
      console.log('No schema changes detected.');
    } else {
      const hasBreaking = results.some((r) => r.breaking);
      console.log(`\nSchema Diff Results (${results.length} files with changes):`);
      console.log(hasBreaking ? '  BREAKING CHANGES DETECTED' : '  No breaking changes');
      console.log('');

      for (const result of results) {
        console.log(`  ${result.breaking ? 'BREAKING' : 'OK'} ${result.file}`);
        for (const change of result.changes) {
          const icon = change.breaking ? '  !!!' : '     ';
          console.log(`${icon} ${change.type}: ${change.description}`);
        }
      }
    }
  } catch (err) {
    console.error(`Schema diff error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return results;
}

export function registerSchemaDiffCommand(program: Command): void {
  program
    .command('schema-diff')
    .description('Detect breaking schema changes between branches')
    .option('-b, --base <branch>', 'Base branch/commit to compare against', 'HEAD~1')
    .action(async (options: { base: string }) => {
      const results = await schemaDiffCommand(options.base);
      const hasBreaking = results.some((r) => r.breaking);
      if (hasBreaking) {
        console.log('\nBreaking changes require explicit approval before proceeding.');
        process.exitCode = 1;
      }
    });
}
