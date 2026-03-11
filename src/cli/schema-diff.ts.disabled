import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

interface SchemaDiffOptions {
  expected?: string;
  actual?: string;
  format?: 'text' | 'json';
}

export async function schemaDiffCommand(
  schemaFile: string,
  options: SchemaDiffOptions = {}
): Promise<void> {
  const outputFormat = options.format || 'text';

  try {
    // Read expected schema from file or use built-in
    let expectedSchema: Record<string, unknown>;
    if (options.expected) {
      if (!fs.existsSync(options.expected)) {
        console.error(chalk.red(`Expected schema file not found: ${options.expected}`));
        process.exit(1);
      }
      expectedSchema = JSON.parse(fs.readFileSync(options.expected, 'utf-8'));
    } else {
      // Load default expected schema from memory system
      expectedSchema = await loadDefaultExpectedSchema();
    }

    // Read actual schema from database or file
    let actualSchema: Record<string, unknown>;
    if (options.actual) {
      if (!fs.existsSync(options.actual)) {
        console.error(chalk.red(`Actual schema file not found: ${options.actual}`));
        process.exit(1);
      }
      actualSchema = JSON.parse(fs.readFileSync(options.actual, 'utf-8'));
    } else {
      // Query actual database schema
      actualSchema = await getDatabaseSchema(schemaFile);
    }

    // Perform diff
    const diff = compareSchemas(expectedSchema, actualSchema);

    if (outputFormat === 'json') {
      console.log(JSON.stringify(diff, null, 2));
    } else {
      printDiffReport(diff);
    }

    // Exit with appropriate code
    if (diff.matches) {
      console.log(chalk.green('\n✅ Schema validation PASSED'));
      process.exit(0);
    } else {
      console.log(chalk.red('\n❌ Schema validation FAILED'));
      process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red('Schema diff failed:'), error);
    process.exit(1);
  }
}

async function loadDefaultExpectedSchema(): Promise<Record<string, unknown>> {
  // Load expected schema from memory system
  const memorySchema = {
    tables: {
      memories: {
        columns: ['id', 'timestamp', 'type', 'content', 'project_id', 'importance'],
        indexes: ['idx_memories_project_id', 'idx_memories_timestamp', 'idx_memories_type'],
      },
      session_memories: {
        columns: ['id', 'session_id', 'timestamp', 'type', 'content', 'importance'],
        indexes: ['idx_session_unique', 'idx_session_id', 'idx_session_importance'],
      },
    },
  };

  return memorySchema;
}

async function getDatabaseSchema(dbPath: string): Promise<Record<string, unknown>> {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);

  try {
    const tables: Record<string, unknown> = {};

    // Get all tables
    const tableResult = db.pragma("sqlite_master WHERE type='table'") as Array<{ name: string }>;
    
    for (const table of tableResult) {
      if (table.name.startsWith('sqlite_')) continue;

      const columns = db.pragma(`PRAGMA table_info(${table.name})`) as Array<{ name: string }>;
      const indexes = db.pragma(`PRAGMA index_list(${table.name})`) as Array<{ name: string }>;

      tables[table.name] = {
        columns: columns.map((c) => c.name),
        indexes: indexes.map((i) => i.name),
      };
    }

    return { tables };
  } finally {
    db.close();
  }
}

function compareSchemas(expected: Record<string, unknown>, actual: Record<string, unknown>): {
  matches: boolean;
  differences: Array<{ table: string; field: string; expected?: unknown; actual?: unknown }>;
} {
  const differences: Array<{ table: string; field: string; expected?: unknown; actual?: unknown }> = [];

  if (expected.tables && actual.tables) {
    for (const [tableName, tableDef] of Object.entries(expected.tables)) {
      if (!actual.tables[tableName]) {
        differences.push({
          table: tableName,
          field: 'table',
          expected: 'exists',
          actual: 'missing',
        });
        continue;
      }

      const expectedTable = tableDef as Record<string, unknown>;
      const actualTable = actual.tables[tableName] as Record<string, unknown>;

      // Compare columns
      if (expectedTable.columns && actualTable.columns) {
        for (const column of expectedTable.columns) {
          if (!actualTable.columns.includes(column)) {
            differences.push({
              table: tableName,
              field: `column:${column}`,
              expected: 'exists',
              actual: 'missing',
            });
          }
        }
      }

      // Compare indexes
      if (expectedTable.indexes && actualTable.indexes) {
        for (const index of expectedTable.indexes) {
          if (!actualTable.indexes.includes(index)) {
            differences.push({
              table: tableName,
              field: `index:${index}`,
              expected: 'exists',
              actual: 'missing',
            });
          }
        }
      }
    }
  }

  return {
    matches: differences.length === 0,
    differences,
  };
}

function printDiffReport(diff: { matches: boolean; differences: Array<{ table: string; field: string; expected?: unknown; actual?: unknown }> }): void {
  console.log('\n=== Schema Diff Report ===\n');

  if (diff.matches) {
    console.log(chalk.green('✅ No differences found'));
    return;
  }

  console.log(chalk.red(`❌ Found ${diff.differences.length} difference(s):\n`));

  for (const diffItem of diff.differences) {
    console.log(
      chalk.yellow(`Table: ${diffItem.table}`) +
      chalk.dim(` | Field: ${diffItem.field}`) +
      chalk.red(` | Expected: ${diffItem.expected}`) +
      chalk.gray(` -> Actual: ${diffItem.actual}`)
    );
  }

  console.log('');
}

export function registerSchemaDiffCommand(program: Command): void {
  program
    .command('schema-diff')
    .description('Compare expected vs actual database schema')
    .argument('<database>', 'Path to SQLite database')
    .option('-e, --expected <file>', 'Expected schema JSON file')
    .option('-a, --actual <file>', 'Actual schema JSON file (override DB query)')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action(async (database: string, options: SchemaDiffOptions) => {
      await schemaDiffCommand(database, options);
    });
}
