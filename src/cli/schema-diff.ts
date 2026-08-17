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
import { isAbsolute, join } from 'path';
import { SQLiteShortTermMemory } from '../memory/short-term/sqlite.js';
import { shortTermDbPath } from '../memory/paths.js';
import { loadUapConfig } from '../utils/config-loader.js';

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
/**
 * git resolves GIT_DIR/GIT_WORK_TREE BEFORE cwd, so passing `cwd` is not enough:
 * inside a git hook (which exports them) git answers about the hook's repo and
 * the cwd argument is silently ignored. This repo has a documented incident
 * from exactly that — see _common.py's _clean_env and worktree.ts.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
    delete env[k];
  }
  return env;
}

export async function diffFileSchema(
  filePath: string,
  baseBranch: string = 'HEAD~1',
  cwd: string = process.cwd()
): Promise<SchemaDiffResult> {
  const changes: SchemaChange[] = [];

  try {
    // Get the "before" version from git
    let beforeContent: string;
    try {
      // execFileSync with an argv array: the old template string ran through a
      // shell, and `filePath` comes straight from `git diff --name-only`, which
      // does not quote ASCII metacharacters — a file named `a;$(id).sql`
      // executed. `baseBranch` is user-supplied via -b, same exposure.
      const { execFileSync } = await import('child_process');
      beforeContent = execFileSync('git', ['show', `${baseBranch}:${filePath}`], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: gitEnv(),
      });
    } catch {
      // File didn't exist before — all fields are new (non-breaking)
      return { file: filePath, changes: [], breaking: false };
    }

    // Get the "after" version from working tree
    // Resolved against the run's cwd: `git diff --name-only` emits
    // repo-root-relative paths, so reading them against process.cwd() made
    // every file look DELETED when run from a subdirectory — reporting
    // breaking:true for each and blocking the very commit it was asked to
    // clear. (join() leaves an absolute path untouched.)
    const absPath = isAbsolute(filePath) ? filePath : join(cwd, filePath);
    if (!existsSync(absPath)) {
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

    const afterContent = readFileSync(absPath, 'utf-8');

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
/** Outcome of a schema-diff run, including whether it actually ran. */
export interface SchemaDiffRun {
  /**
   * True only when the diff completed against a real base. False when git
   * threw — a bad `--base`, a shallow clone, a repo with one commit.
   *
   * Without this, a failed run is indistinguishable from a clean one: the
   * catch below returns an empty array, `hasBreaking` is false, and the gate
   * marker gets written anyway. Verified before the fix:
   *   `uap schema-diff -b definitely-not-a-real-ref`
   *   -> "fatal: ambiguous argument" ... "Recorded schema-diff pass", exit 0
   * which then cleared the gate for a staged `DROP TABLE` nothing examined.
   */
  ran: boolean;
  /** Schema-relevant files the run actually examined (not only those with changes). */
  examined: string[];
  /**
   * The base actually compared against. Differs from the requested base when
   * the repo has no baseline; recording the REQUESTED one would let a run that
   * compared against nothing look like a full diff in the audit trail.
   */
  effectiveBase: string;
  results: SchemaDiffResult[];
}

export async function schemaDiffCommand(
  baseBranch: string = 'HEAD~1'
): Promise<SchemaDiffResult[]> {
  return (await runSchemaDiff(baseBranch)).results;
}

/** True when `base` names a real commit here — not a filename git would
 *  refuse as ambiguous, and not a typo. */
async function baseResolves(base: string, cwd: string): Promise<boolean> {
  try {
    // `await import`, NOT a bare require: this module is built and shipped as
    // ESM, where `require` is not a binding. A bare one type-checks (@types/node
    // declares it globally) and works under vitest (vite-node injects one), so
    // the build and the entire suite stayed green while the SHIPPED artifact
    // threw ReferenceError — swallowed by the catch below, making this function
    // return false unconditionally and silently disabling the check it exists
    // to perform. Verified against dist: the CLI announced "HEAD~1 is not a
    // commit here" for a repo where it plainly was, and recorded a pass.
    const { execFileSync } = await import('child_process');
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
      cwd,
      stdio: 'ignore',
      env: gitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** git's empty tree — diffing against it means "every tracked file is new". */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function runSchemaDiff(
  baseBranch: string = 'HEAD~1',
  cwd: string = process.cwd(),
  /**
   * True when the caller did not pass -b, i.e. `HEAD~1` is our default rather
   * than the operator's choice. Only then may an unresolvable base fall back to
   * the empty tree.
   *
   * Without that distinction, removing the rubber stamp DEADLOCKED a repo at
   * its initial commit or a shallow CI clone: `HEAD~1` does not resolve, the
   * run reports ran=false, no marker is written, and the gate refuses every
   * commit with no waiver and no override — verified. Falling back
   * unconditionally would instead resurrect the stamp for `-b typo`.
   */
  baseIsDefault: boolean = false
): Promise<SchemaDiffRun> {
  const results: SchemaDiffResult[] = [];
  let examined: string[] = [];
  let ran = false;
  let effectiveBase = baseBranch;

  try {

    // Get list of changed files
    const { execFileSync } = await import('child_process');
    const listChanged = (base: string): string[] =>
      execFileSync('git', ['diff', '--name-only', base, '--'], {
        encoding: 'utf-8',
        cwd,
        env: gitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .trim()
        .split('\n')
        .filter(Boolean);

    let changedFiles: string[];
    try {
      changedFiles = listChanged(baseBranch);
    } catch (err) {
      // Fall back ONLY when the base is provably not a commit. Inferring
      // "unresolvable" from any `git diff` failure was a full bypass: git
      // refuses an argument that is BOTH a revision and an existing path
      // ("fatal: ambiguous argument"), so `touch 'HEAD~1'` in an ordinary repo
      // forced the fallback and manufactured a pass for a staged DROP TABLE.
      // Verified. `--verify --quiet <base>^{commit}` cannot be confused with a
      // filename, so it answers the question the fallback actually depends on.
      if (!baseIsDefault || (await baseResolves(baseBranch, cwd))) throw err;

      // Genuinely baseline-free (initial commit, shallow clone): there is
      // nothing to compare against, so record that honestly rather than
      // deadlocking the gate. The per-file loop is skipped — every `git show`
      // against the empty tree fails by construction, so it can only burn
      // process spawns to conclude nothing.
      console.log(
        `Note: ${baseBranch} is not a commit here (initial commit or shallow clone) — no baseline to diff against.`
      );
      effectiveBase = `${EMPTY_TREE} (no baseline)`;
      ran = true;
      examined = [];
      return { ran, examined, effectiveBase, results };
    }

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

    // Past this point git has produced a real file list, so the run is genuine
    // even if nothing schema-relevant changed.
    ran = true;
    examined = schemaFiles;

    for (const file of schemaFiles) {
      const result = await diffFileSchema(file, effectiveBase, cwd);
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

  return { ran, examined, effectiveBase, results };
}

/**
 * Record a successful schema-diff run in SHORT-TERM memory.
 *
 * The schema-diff-gate enforcer (src/policies/enforcers/schema_diff_gate.py)
 * clears commits/pushes only when short_term.db carries a memory row LIKE
 * '%schema-diff%pass%' newer than one hour — but until this function, nothing
 * ever wrote that row: this CLI printed and exited, and `uap memory store`
 * REJECTS the marker via the quality write-gate (it scores ~0.05) unless
 * --force is used. The gate's documented remedy ("run `uap schema-diff` and
 * re-commit") therefore could not succeed. The check now records its own
 * result, exactly like a test runner writing its report.
 *
 * Written directly through SQLiteShortTermMemory (not the write-gate path):
 * this is a gate-contract record, deliberately below the memory quality bar.
 * Best-effort — a recording failure must never fail the diff itself.
 */
/** Bounded rendering: one branch touching hundreds of schema files otherwise
 *  writes a multi-kilobyte row into the shared short-term store, at high
 *  importance, where it crowds out real context and survives pruning. */
function fileList(examined: string[]): string {
  if (examined.length === 0) return '(none changed)';
  const head = examined.slice(0, 20).join(',');
  return examined.length > 20 ? `${head} (+${examined.length - 20} more)` : head;
}

export async function recordSchemaDiffPass(
  baseBranch: string,
  examined: string[],
  cwd: string = process.cwd()
): Promise<void> {
  try {
    // Resolve to the git toplevel first. shortTermDbPath() anchors to the main
    // checkout by stripping a `.worktrees/` segment, but only if it is GIVEN a
    // path containing one — from a SUBDIRECTORY (say <repo>/migrations) it
    // would happily create a stray agents/data/memory/short_term.db there,
    // print "Recorded schema-diff pass", and leave the gate reading a different
    // database and still blocking.
    let root = cwd;
    try {
      const { execFileSync } = await import('child_process');
      root =
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          // This call picks the DATABASE the marker lands in. Under a poisoned
          // GIT_DIR it answers for another repo, the marker is written there,
          // the CLI prints success, and the gate never sees it — a silent,
          // unbreakable block. A wrong diff is loud; a wrong marker location
          // is not.
          env: gitEnv(),
        }).trim() || cwd;
    } catch {
      /* not a git repo — fall back to the caller's directory */
    }
    const config = loadUapConfig(root);
    const dbPath = shortTermDbPath(root, config?.memory?.shortTerm?.path);
    const db = new SQLiteShortTermMemory({
      dbPath,
      projectId: config?.project?.name ?? 'project',
      maxEntries: config?.memory?.shortTerm?.maxEntries || 50,
    });
    await db.store(
      'action',
      // FIXED PREFIX, matched anchored by the enforcer. The gate used to accept
      // any text LIKE '%schema-diff%pass%' anywhere in memory — which its own
      // refusal message ("...require `uap schema-diff` to pass") satisfies, so
      // an agent storing the blocker as a lesson unblocked itself. The file
      // list is recorded so a human can audit what a given pass actually covered.
      `schema-diff pass: base ${baseBranch} | files: ${fileList(examined)}`,
      // High importance so the rolling-window prune (which orders by
      // importance) does not evict the marker inside its 1h validity window.
      8
    );
    await db.close();
    console.log('Recorded schema-diff pass for the schema-diff-gate (1h window).');
  } catch (err) {
    // Recording IS the deliverable for a gate remedy: a diff nobody can act on
    // is worse than a non-zero exit. Swallowing this printed success while the
    // gate stayed shut, with the only documented remedy being the command that
    // had just "succeeded".
    console.error(
      `Could not record the pass marker — the schema-diff-gate will keep blocking. ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}

export function registerSchemaDiffCommand(program: Command): void {
  program
    .command('schema-diff')
    .description('Detect breaking schema changes between branches')
    // No commander default: an omitted -b must be distinguishable from an
    // explicit one, because only the default may fall back to the empty tree.
    .option('-b, --base <branch>', 'Base branch/commit to compare against (default: HEAD~1)')
    .action(async (options: { base?: string }) => {
      const baseIsDefault = options.base === undefined;
      const base = options.base ?? 'HEAD~1';
      const run = await runSchemaDiff(base, process.cwd(), baseIsDefault);
      const hasBreaking = run.results.some((r) => r.breaking);
      if (hasBreaking) {
        console.log('\nBreaking changes require explicit approval before proceeding.');
        process.exitCode = 1;
      } else if (!run.ran) {
        // Do NOT record: git never produced a file list, so this run verified
        // nothing. Recording here is what turned the documented remedy into a
        // rubber stamp obtainable with one bad --base.
        console.error(
          `\nSchema diff did not complete against "${base}" — nothing was checked, so no pass ` +
            'was recorded. If that base does not exist here, re-run without -b.'
        );
        process.exitCode = 1;
      } else {
        await recordSchemaDiffPass(run.effectiveBase, run.examined);
      }
    });
}
