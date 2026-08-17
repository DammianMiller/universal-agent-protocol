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
  /**
   * Did an analyser actually UNDERSTAND this file?
   *
   * The gate blocks on `breaking`, so "no breaking changes" must mean "I read
   * it and it is fine", never "I had no idea what this was". Without this
   * flag they are the same value: a helm chart, a file with no baseline, or
   * one that could not be opened all produced an empty change list, and the
   * gate reported "schema-diff ran ... no breaking changes" for bytes nothing
   * had parsed. Verified: a new migrations/002.sql containing DROP TABLE
   * users; was cleared exactly that way.
   */
  analysed: boolean;
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
 * Blank out SQL comments, preserving offsets and line structure.
 *
 * Everything below counts parentheses and splits on commas, and a comment is
 * allowed to contain both. `-- natural key (see ADR-14` raised the paren depth
 * and swallowed the rest of the file, so the table it belonged to contributed
 * NO columns; if that happened on one side of the diff only, every column read
 * as removed and an added comment became a BREAKING verdict. Replacing with
 * spaces rather than deleting keeps every offset valid for the callers that
 * index back into the string.
 */
function stripSqlComments(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const two = content.slice(i, i + 2);
    if (two === '--') {
      while (i < content.length && content[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (two === '/*') {
      while (i < content.length && content.slice(i, i + 2) !== '*/') {
        out += content[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    // A quoted literal may legitimately contain -- or parens; copy it whole.
    if (content[i] === "'" || content[i] === '"') {
      const quote = content[i];
      out += content[i];
      i++;
      while (i < content.length) {
        out += content[i];
        if (content[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

/** Contents between `content[open]` ('(') and its matching ')', or null. */
function tableBody(content: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) return content.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Extract SQLite CREATE TABLE columns from SQL or source code.
 */
function extractSQLiteColumns(raw: string): Map<string, string> {
  const columns = new Map<string, string>();
  const content = stripSqlComments(raw);

  const createTables = content.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi
  );

  for (const table of createTables) {
    const tableName = table[1];
    // Paren-matched, not `\(([\s\S]*?)\)`: the non-greedy form stopped at the
    // FIRST `)`, so one `amt DECIMAL(10,2)` hid every column declared after it
    // — including a later NOT NULL addition, which a blocking gate must see.
    const body = tableBody(content, (table.index ?? 0) + table[0].length - 1);
    if (body === null) continue;
    const colMatches = body.matchAll(
      /(\w+)\s+(INTEGER|TEXT|REAL|BLOB|DATETIME|BOOLEAN|VARCHAR[^,]*)/gi
    );
    for (const col of colMatches) {
      columns.set(`${tableName}.${col[1]}`, col[2].trim());
    }
  }

  return columns;
}

/** Top-level comma split: `DECIMAL(10,2)` is one part, not two. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Clauses that describe the TABLE, not a column. */
const TABLE_CONSTRAINT = /^\s*(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX|EXCLUDE|LIKE|INHERITS)\b/i;

/**
 * Columns the schema makes MANDATORY: NOT NULL with nothing to fill them.
 *
 * Needed because the generic added-field rule ("breaking unless the type says
 * optional or ?") is Zod/TypeScript-shaped and reads every SQL type as
 * required — so a plain `ADD COLUMN note TEXT`, the most common and most
 * harmless migration there is, was reported BREAKING. Harmless while the
 * checker only printed advice; not harmless now that a gate blocks on the
 * verdict, where it would refuse ordinary additive migrations and teach people
 * to reach for the waiver.
 *
 * A column is only genuinely breaking to add when existing rows and existing
 * INSERTs cannot satisfy it: NOT NULL, no DEFAULT, and not self-filling
 * (SERIAL/IDENTITY/AUTOINCREMENT/GENERATED).
 *
 * The table body is matched by counting parens rather than with the
 * non-greedy `\(([\s\S]*?)\)` used elsewhere here, which stops at the first
 * `)` and so loses every column after a `DECIMAL(10,2)`. Over-collecting is
 * safe: this set only ever classifies names the diff already produced.
 */
function sqlRequiredColumns(raw: string): Set<string> {
  const required = new Set<string>();
  const content = stripSqlComments(raw);
  const heads = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`\[\]]+)\s*\(/gi);
  for (const head of heads) {
    const table = (head[1] ?? '').replace(/["`[\]]/g, '').split('.').pop() ?? '';
    const body = tableBody(content, (head.index ?? 0) + head[0].length - 1);
    if (body === null) continue;
    for (const part of splitTopLevel(body)) {
      if (TABLE_CONSTRAINT.test(part)) continue;
      const name = part.trim().match(/^["`[]?(\w+)/)?.[1];
      if (!name) continue;
      const notNull = /\bNOT\s+NULL\b/i.test(part);
      const filled = /\b(DEFAULT|SERIAL|BIGSERIAL|SMALLSERIAL|AUTOINCREMENT|IDENTITY|GENERATED)\b/i.test(part);
      if (notNull && !filled) required.add(`${table}.${name}`);
    }
  }
  return required;
}

/**
 * Apply the SQL rule to `added` verdicts produced by the generic differ.
 *
 * Only additions are re-scored: removals and type changes keep the generic
 * judgement, which is right for SQL too.
 */
function rescoreSqlAdditions(
  changes: SchemaChange[],
  afterContent: string,
  context: string
): SchemaChange[] {
  const required = sqlRequiredColumns(afterContent);
  return changes.map((c) => {
    if (c.type !== 'added') return c;
    const column = c.path.startsWith(`${context}.`) ? c.path.slice(context.length + 1) : c.path;
    const breaking = required.has(column);
    if (breaking === c.breaking) return c;
    return {
      ...c,
      breaking,
      description: breaking
        ? `${c.description.replace(/ \(required — breaking\)$/, '')} (NOT NULL with no default — breaking)`
        : c.description.replace(/ \(required — breaking\)$/, ''),
    };
  });
}

/**
 * Destructive DDL statements, as human-readable descriptions.
 *
 * The CREATE TABLE differ can only speak about a file that HAS a previous
 * version to compare against, which excludes the single most common breaking
 * change there is: a brand-new migration whose whole content is `DROP TABLE
 * users;`. Nothing was removed relative to the old file, because there is no
 * old file -- so the differ said "no changes" and the gate cleared it.
 *
 * These statements are breaking on sight, no baseline required.
 */
function destructiveDdl(raw: string): string[] {
  const sql = stripSqlComments(raw);
  const found: string[] = [];
  const scan = (re: RegExp, describe: (m: RegExpMatchArray) => string) => {
    for (const m of sql.matchAll(re)) found.push(describe(m));
  };

  scan(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."`[\]]+)/gi, (m) => `DROP TABLE ${m[1]}`);
  scan(/\bDROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?([\w."`[\]]+)/gi, (m) => `DROP VIEW ${m[1]}`);
  scan(/\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?([\w."`[\]]+)/gi, (m) => `DROP INDEX ${m[1]}`);
  scan(/\bTRUNCATE\s+(?:TABLE\s+)?([\w."`[\]]+)/gi, (m) => `TRUNCATE ${m[1]}`);
  scan(
    /\bALTER\s+TABLE\s+([\w."`[\]]+)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([\w."`[\]]+)/gi,
    (m) => `ALTER TABLE ${m[1]} DROP COLUMN ${m[2]}`
  );
  scan(
    /\bALTER\s+TABLE\s+([\w."`[\]]+)\s+RENAME\s+(?:COLUMN\s+)?([\w."`[\]]+)\s+TO\s+([\w."`[\]]+)/gi,
    (m) => `ALTER TABLE ${m[1]} RENAME ${m[2]} TO ${m[3]}`
  );
  scan(
    /\bALTER\s+TABLE\s+([\w."`[\]]+)\s+RENAME\s+TO\s+([\w."`[\]]+)/gi,
    (m) => `ALTER TABLE ${m[1]} RENAME TO ${m[2]}`
  );
  scan(
    /\bALTER\s+TABLE\s+([\w."`[\]]+)\s+ALTER\s+(?:COLUMN\s+)?([\w."`[\]]+)\s+(?:SET\s+DATA\s+)?TYPE\b/gi,
    (m) => `ALTER TABLE ${m[1]} ALTER COLUMN ${m[2]} TYPE`
  );
  scan(
    /\bALTER\s+TABLE\s+([\w."`[\]]+)\s+ALTER\s+(?:COLUMN\s+)?([\w."`[\]]+)\s+SET\s+NOT\s+NULL/gi,
    (m) => `ALTER TABLE ${m[1]} SET NOT NULL on ${m[2]}`
  );

  // ADD COLUMN is breaking only when existing rows cannot satisfy it, the same
  // rule sqlRequiredColumns applies inside CREATE TABLE.
  for (const m of sql.matchAll(
    /\bALTER\s+TABLE\s+([\w."`[\]]+)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w."`[\]]+)([^;]*)/gi
  )) {
    const tail = m[3] ?? '';
    const notNull = /\bNOT\s+NULL\b/i.test(tail);
    const filled = /\b(DEFAULT|SERIAL|BIGSERIAL|SMALLSERIAL|AUTOINCREMENT|IDENTITY|GENERATED)\b/i.test(tail);
    if (notNull && !filled) {
      found.push(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} NOT NULL with no default`);
    }
  }
  return found;
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

/**
 * Blob SHA of each path's WORKTREE content — the bytes this run actually reads.
 *
 * Per path, deliberately. The batched `--stdin-paths` form failed the WHOLE
 * set on one unreadable path — and a deletion in the change set is enough —
 * which blanked every sha, rendered bare paths, and made the enforcer read the
 * result as a legacy marker: one `git rm` silently disabled content scoping for
 * the entire commit. A spawn per examined file is the cost of not doing that.
 *
 * A path that cannot be hashed yields an empty sha rather than dropping out of
 * the set, so the entry is still auditable; the enforcer skips what it cannot
 * verify rather than blocking on it.
 */
/** A path's index blob and worktree blob — the two versions a commit can take. */
export interface FileVersions {
  /** Blob sha in the index, '' when not staged. */
  index: string;
  /** Blob sha of the worktree copy, '' when absent/unreadable. */
  worktree: string;
}

/**
 * Both versions of a path, because a commit may take either.
 *
 * `git commit` stores the INDEX; `git commit -a` stores the WORKTREE. Callers
 * need to know both to decide which one a given commit will take — but only
 * the analysed one is ever RECORDED (see committedVersion), because a marker
 * that names bytes nothing inspected is the bug this whole change exists to
 * remove.
 */
async function fileVersions(path: string, cwd: string): Promise<FileVersions> {
  const { execFileSync } = await import('child_process');
  const opts = { cwd, env: gitEnv(), encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[] };
  const hex = (s: string) => (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s) ? s : '');
  let index = '';
  let worktree = '';
  try {
    index = hex(execFileSync('git', ['rev-parse', `:${path}`], opts).trim());
  } catch {
    /* not staged */
  }
  try {
    worktree = hex(execFileSync('git', ['hash-object', '--', path], opts).trim());
  } catch {
    /* deleted, unreadable, sparse */
  }
  return { index, worktree };
}

/**
 * The version that will be committed, and the bytes to analyse.
 *
 * INDEX-preferred, because `git commit` stores the index. Recording the
 * worktree instead is what let a staged-malicious / benign-worktree pair clear
 * a gate claiming to cover "staged content"; and recording BOTH without
 * analysing both would re-open exactly that, since the marker would vouch for
 * bytes nothing inspected. So the analysed bytes and the recorded sha are the
 * same object, always.
 *
 * When the worktree has since diverged, only the index version is vouched for.
 * A subsequent `git commit -a` would take the worktree, which the enforcer then
 * finds uncovered and blocks — clearable with `git add` and a re-run.
 */
async function committedVersion(
  path: string,
  cwd: string,
  source: 'index' | 'worktree' = 'index'
): Promise<{ sha: string; content: string | null }> {
  const { execFileSync } = await import('child_process');
  const opts = {
    cwd,
    env: gitEnv(),
    encoding: 'utf-8' as const,
    stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[],
  };
  const v = await fileVersions(path, cwd);
  // `commit -a` / `--all` stores the worktree; everything else the index. The
  // GATE decides which and tells us, so the bytes examined here are the bytes
  // that command will store — no inference, no drift.
  const preferWorktree = source === 'worktree';
  if (!preferWorktree && v.index) {
    try {
      const content = execFileSync('git', ['cat-file', 'blob', v.index], {
        ...opts,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { sha: v.index, content };
    } catch {
      return { sha: v.index, content: null };
    }
  }
  if (v.worktree) {
    const abs = isAbsolute(path) ? path : join(cwd, path);
    try {
      return { sha: v.worktree, content: readFileSync(abs, 'utf-8') };
    } catch {
      return { sha: v.worktree, content: null };
    }
  }
  return { sha: '', content: null };
}

async function hashFiles(
  paths: string[],
  cwd: string,
  source: 'index' | 'worktree' = 'index'
): Promise<ExaminedFile[]> {
  if (paths.length === 0) return [];
  const out: ExaminedFile[] = [];
  for (const path of paths) {
    // The source's OWN blob, with no cross-source fallback.
    // committedVersion falls back to the worktree when the index has no entry,
    // which is right for choosing bytes to analyse but wrong as an identity
    // claim: for `git rm --cached x` it reported the worktree sha for a path
    // the index no longer holds, so the gate's sha comparison disagreed and a
    // precisely-detected staged deletion decayed into "could not answer".
    // Empty means "this source holds nothing here" — itself a fact the gate
    // needs, since that is exactly what a deletion looks like.
    const v = await fileVersions(path, cwd);
    out.push({ path, sha: source === 'worktree' ? v.worktree : v.index });
  }
  return out;
}

export async function diffFileSchema(
  filePath: string,
  baseBranch: string = 'HEAD~1',
  cwd: string = process.cwd(),
  source: 'index' | 'worktree' = 'index'
): Promise<SchemaDiffResult> {
  const changes: SchemaChange[] = [];
  const isSql = filePath.endsWith('.sql');
  // False until an analyser proves otherwise. Every early exit and the outer
  // catch therefore report "not analysed", which the gate treats as uncovered
  // rather than as clean.
  let analysed = false;

  try {
    // Get the "before" version from git
    let beforeContent: string;
    let hasBaseline = true;
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
      // No previous version. Adding fields to something that did not exist
      // cannot break a reader of the OLD schema -- but the file's own
      // statements still can, and a new migration is where they usually live.
      // Returning "no changes" here is what cleared a brand-new
      // migrations/002.sql whose entire content was DROP TABLE users;.
      beforeContent = '';
      hasBaseline = false;
    }

    // Get the "after" version from working tree
    // Resolved against the run's cwd: `git diff --name-only` emits
    // repo-root-relative paths, so reading them against process.cwd() made
    // every file look DELETED when run from a subdirectory — reporting
    // breaking:true for each and blocking the very commit it was asked to
    // clear. (join() leaves an absolute path untouched.)
    // Analyse the version that will be COMMITTED (index-preferred), so the
    // bytes inspected here are the same object whose sha the marker records.
    // Reading the worktree while recording the index — or the reverse — is how
    // a marker ends up vouching for bytes nothing looked at.
    const committed = await committedVersion(filePath, cwd, source);
    const absPath = isAbsolute(filePath) ? filePath : join(cwd, filePath);

    // A path removed from the INDEX is a staged deletion even though the
    // worktree copy is still sitting there. committedVersion falls back to the
    // worktree when the index has no entry, so `git rm --cached x` was
    // analysed as "worktree vs HEAD: unchanged" -- clean -- while the commit
    // removed the file. Verified.
    if (hasBaseline && source === 'index' && !(await fileVersions(filePath, cwd)).index) {
      return {
        file: filePath,
        changes: [
          {
            type: 'removed',
            path: filePath,
            description: `File "${filePath}" was removed from the index (staged deletion)`,
            breaking: true,
          },
        ],
        breaking: true,
        analysed: true,
      };
    }

    if (committed.content === null && !existsSync(absPath)) {
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
        analysed: true,
      };
    }

    const afterContent = committed.content ?? readFileSync(absPath, 'utf-8');

    // Statements that are breaking on their own terms, baseline or not.
    const before = new Set(hasBaseline ? destructiveDdl(beforeContent) : []);
    for (const stmt of destructiveDdl(afterContent)) {
      if (before.has(stmt)) continue; // already in the base; not new here
      changes.push({
        type: 'removed',
        path: filePath,
        description: `Destructive statement: ${stmt}`,
        breaking: true,
      });
    }

    // Detect schema type and extract fields
    let understood = isSql; // .sql is covered: CREATE TABLE diff + DDL scan
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) {
      // Only meaningful against a baseline -- there is no TS analogue of the
      // DDL scan, so a new file tells us nothing about what it breaks.
      understood = hasBaseline;
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
        changes.push(
          ...rescoreSqlAdditions(diffFields(beforeCols, afterCols, 'sqlite'), afterContent, 'sqlite')
        );
      }
    }

    // SQL files
    if (filePath.endsWith('.sql')) {
      const beforeCols = extractSQLiteColumns(beforeContent);
      const afterCols = extractSQLiteColumns(afterContent);
      changes.push(
        ...rescoreSqlAdditions(diffFields(beforeCols, afterCols, 'sql'), afterContent, 'sql')
      );
    }

    // JSON schema files
    if (
      filePath.endsWith('.json') &&
      (filePath.includes('schema') || filePath.includes('config'))
    ) {
      try {
        const beforeObj = JSON.parse(beforeContent);
        const afterObj = JSON.parse(afterContent);
        understood = hasBaseline;
        const flatBefore = flattenObject(beforeObj) as Record<string, unknown>;
        const flatAfter = flattenObject(afterObj) as Record<string, unknown>;
        const beforeKeys = new Map(Object.keys(flatBefore).map((k) => [k, typeof flatBefore[k]]));
        const afterKeys = new Map(Object.keys(flatAfter).map((k) => [k, typeof flatAfter[k]]));
        changes.push(...diffFields(beforeKeys, afterKeys, 'json'));
      } catch {
        // Not valid JSON — say so rather than reporting a clean parse.
        understood = false;
      }
    }

    analysed = understood;
  } catch {
    // Git or file read error. `analysed` stays false: the gate must not read a
    // failed read as an all-clear.
  }

  return {
    file: filePath,
    changes,
    breaking: changes.some((c) => c.breaking),
    analysed,
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
/** A file the run examined, with the blob SHA of the bytes it read. */
export interface ExaminedFile {
  path: string;
  /** Worktree blob SHA — the content actually inspected. Empty when unhashable. */
  sha: string;
}

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
  /**
   * Schema-relevant files the run actually examined (not only those with
   * changes), each with the blob SHA of the content read. The SHAs are what
   * let the gate verify a pass covers the bytes about to be committed, rather
   * than merely that some run happened within the hour.
   */
  examined: ExaminedFile[];
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

/**
 * What the GATE watches — kept identical to WATCHED_RE in
 * src/policies/enforcers/schema_diff_gate.py.
 *
 * The two sets must agree, because the gate now demands that every watched path
 * be covered by the marker, and only paths this CLI EXAMINES get into the
 * marker. When the gate watched a superset, the difference was a permanent
 * deadlock: `infra/helm_charts/pgdog/values.yaml` matched none of the filters
 * below, so it could never be recorded, and the refusal told the operator to
 * re-run a command that produced the identical marker. Verified before the fix.
 *
 * These files are hashed and recorded even though diffFileSchema cannot parse
 * YAML — coverage is about "these bytes were seen", which is exactly the claim
 * the marker needs to support. Any change to the enforcer's WATCHED_RE must be
 * mirrored here; test/cli/gate-watched-mirror.test.ts pins that.
 */
export // `s` (dotAll) so `.` spans a newline: a path may legally contain one, and
// without the flag `migrations/a\nb.sql` matched nothing — the gate did not
// consider it watched at all, and a column drop in it was never examined.
const GATE_WATCHED_RE =
  /(migrations\/.*\.sql|infra\/postgres-spock\/|infra\/helm_charts\/[^/]*pgdog|infra\/helm_charts\/[^/]*cnpg|infra\/helm_charts\/[^/]*redis|infra\/helm_charts\/[^/]*envoy|infra\/helm_charts\/[^/]*sentinel)/is;

/** git's empty tree — diffing against it means "every tracked file is new". */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Version of the --json verdict shape.
 *
 * Bump on any change to the fields the gate reads. The gate refuses a contract
 * it does not recognise and falls back rather than guessing, so an old gate
 * paired with a new CLI degrades instead of misreading.
 */
export const SCHEMA_DIFF_CONTRACT = 1;

/** What the GATE controls, kept off the positional parameter list. */
export interface SchemaDiffOptions {
  /**
   * Restrict the examined set to these paths. The gate passes its own watched
   * set, so checker and gate cannot disagree about scope — the enumeration
   * mismatch that made helm/spock YAML permanently uncoverable.
   */
  only?: string[];
  /** Which bytes to read: the index (a plain commit) or the worktree (`-a`). */
  source?: 'index' | 'worktree';
  /** Suppress the human report so stdout carries the JSON verdict alone. */
  quiet?: boolean;
}

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
  baseIsDefault: boolean = false,
  opts: SchemaDiffOptions = {}
): Promise<SchemaDiffRun> {
  const { only, source = 'index', quiet = false } = opts;
  const results: SchemaDiffResult[] = [];
  let examined: ExaminedFile[] = [];
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
        GATE_WATCHED_RE.test(f) ||
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

    // `only` REPLACES this enumeration rather than intersecting it. The list
    // above comes from `git diff --name-only <base>`, which compares the
    // WORKTREE — so a staged-only change whose worktree copy still matches the
    // base does not appear in it at all. Intersecting would have dropped
    // exactly those paths, handed the gate an empty `examined`, and let the
    // staged change through as "covered": the same class of hole as verifying
    // the index while `-a` commits the worktree. The gate derives its watched
    // set from the source it is about to commit, and it is authoritative.
    const scopedFiles = only ? [...new Set(only)] : schemaFiles;

    // Past this point git has produced a real file list, so the run is genuine
    // even if nothing schema-relevant changed.
    ran = true;
    // Hash what we are about to read, so the marker binds to content. Batched
    // in one process rather than one per file: this runs inside a gate remedy.
    examined = await hashFiles(scopedFiles, cwd, source);

    for (const file of scopedFiles) {
      const result = await diffFileSchema(file, effectiveBase, cwd, source);
      // Every examined path gets a result, not just the ones with changes: the
      // gate needs `analysed` for the quiet ones too, and "absent from the
      // list" is precisely the ambiguity between "clean" and "never looked at"
      // that this change exists to remove. The human report still prints only
      // files with changes.
      results.push(result);
    }

    // Print results. In --json mode the verdict IS the output: a stray human
    // line here would break the gate's JSON parse, and a gate that cannot read
    // its checker falls back to allow-with-warning — silently unarmed.
    const changed = results.filter((r) => r.changes.length > 0);
    if (quiet) {
      // caller renders the verdict
    } else if (changed.length === 0) {
      console.log('No schema changes detected.');
    } else {
      const hasBreaking = changed.some((r) => r.breaking);
      console.log(`\nSchema Diff Results (${changed.length} files with changes):`);
      console.log(hasBreaking ? '  BREAKING CHANGES DETECTED' : '  No breaking changes');
      console.log('');

      for (const result of changed) {
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
/**
 * How many `path@sha` entries a marker may carry before it degrades to a
 * legacy (time-only) marker.
 *
 * Content scoping needs EVERY examined path in the marker — a truncated list
 * would leave the omitted paths uncovered and block them with no way for the
 * operator to produce a covering marker. Rather than deadlock, an oversized
 * change records `(truncated)` and the gate falls back to time-only. 100
 * entries is roughly 5KB, above any realistic schema change and well under the
 * size where one memory row starts crowding recall.
 */
const MAX_MARKER_ENTRIES = 100;

/** Marker rendering. `path@sha7` is what makes a pass content-scoped. */
function fileList(examined: ExaminedFile[]): string {
  if (examined.length === 0) return '(none changed)';
  if (examined.length > MAX_MARKER_ENTRIES) {
    return `(truncated: ${examined.length} files)`;
  }
  return examined
    .map((f) => {
      // A path containing the delimiters can forge a second, parsable entry:
      // a file named `xschema@<40hex>,migrations/002.sql@<benign sha>` parses
      // into a bogus coverage claim for 002.sql that overwrites the real one.
      // Such a path is recorded WITHOUT identity, so the enforcer treats that
      // one path as uncovered instead of trusting an attacker-built entry.
      const safe = !f.path.includes(',') && !f.path.includes('@');
      return f.sha && safe ? `${f.path}@${f.sha}` : f.path;
    })
    .join(',');
}

export async function recordSchemaDiffPass(
  baseBranch: string,
  examined: ExaminedFile[],
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
    // --- the inline-gate contract -------------------------------------------
    // The enforcer calls this directly instead of hunting for a marker written
    // by some earlier run. That deletes an entire class of defect: a stored
    // verdict can be stale, forged, truncated, format-drifted, scoped to a
    // different file set, or written by another worktree — and every one of
    // those actually happened here. A verdict computed now, over the exact
    // paths the gate is about to allow, can be none of them.
    .option('--json', 'Emit a machine-readable verdict for the gate (implies no marker write)')
    .option(
      '--paths-from <file>',
      'Read NUL-separated paths from a file. Preferred over --paths: a comma or ' +
        'newline in a filename cannot corrupt the list, and git C-quotes such ' +
        'names in --name-only output, which made the checker examine a path ' +
        'that does not exist and report it clean.'
    )
    .option(
      '--paths <csv>',
      'Restrict the check to these paths. The GATE passes its own watched set, ' +
        'so the checker and the gate can never disagree about what was examined.'
    )
    .option(
      '--source <which>',
      'Which bytes to examine: "index" (what `git commit` stores) or "worktree" (what `commit -a` stores)'
    )
    .action(async (options: {
      base?: string;
      json?: boolean;
      paths?: string;
      pathsFrom?: string;
      source?: string;
    }) => {
      const baseIsDefault = options.base === undefined;
      const base = options.base ?? 'HEAD~1';
      // No trimming on this path: a leading or trailing space is part of the
      // filename, and silently trimming it produced a path the checker could
      // not open while the gate still counted it as covered.
      const only = options.pathsFrom
        ? readFileSync(options.pathsFrom, 'utf-8').split('\0').filter(Boolean)
        : options.paths
          ? options.paths.split(',').map((p) => p.trim()).filter(Boolean)
          : undefined;
      const run = await runSchemaDiff(base, process.cwd(), baseIsDefault, {
        only,
        source: options.source === 'worktree' ? 'worktree' : 'index',
        quiet: Boolean(options.json),
      });
      const hasBreaking = run.results.some((r) => r.breaking);

      if (options.json) {
        // The gate reads THIS, not an exit code: exit 1 conflates "breaking
        // change found" with "the run never happened", and those must lead to
        // opposite decisions (block vs fall back).
        //
        // One entry per requested path, each carrying the evidence the gate
        // needs to decide whether to believe it:
        //   sha       the blob actually read. The gate re-derives it and
        //             compares. Without it the old `examined` was a list of
        //             the gate's own argument echoed back -- it could only
        //             fail on a whitespace artefact, never on "nothing was
        //             read", which is exactly the case it existed to catch.
        //   analysed  whether any analyser understood the file at all. An
        //             empty `breaking` from a helm chart is not an all-clear.
        // `contract` lets a future gate refuse a shape it does not know
        // instead of misreading it.
        const byPath = new Map(run.results.map((r) => [r.file, r]));
        console.log(
          JSON.stringify({
            contract: SCHEMA_DIFF_CONTRACT,
            ran: run.ran,
            base: run.effectiveBase,
            files: run.examined.map((f) => {
              const r = byPath.get(f.path);
              return {
                path: f.path,
                sha: f.sha,
                analysed: r ? r.analysed : false,
                breaking: r
                  ? r.changes.filter((c) => c.breaking).map((c) => c.description)
                  : [],
              };
            }),
          })
        );
        process.exitCode = hasBreaking ? 1 : 0;
        return;
      }
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
