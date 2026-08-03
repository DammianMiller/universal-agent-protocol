/**
 * Plan-time gates need writers.
 *
 * Two enforcers gate planning on evidence that nothing produced:
 *   - codebase-read-before-plan reads .uap/read_log.state — no hook wrote it,
 *     so its entries aged past the 30-minute window and it blocked every
 *     ExitPlanMode with a remedy ("read the codebase first") that could not clear.
 *   - memory-before-plan reads a session_memories row of type 'memory_query' —
 *     `uap memory query` never wrote one, so its own remedy could not clear it.
 *
 * These tests cover the two writers that close those loops.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { recordMemoryQuery } from '../src/cli/memory.js';

const ROOT = process.cwd();
const HOOK = join(ROOT, '.claude/hooks/post-tool-use-read.sh');

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'uap-plan-gate-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Run the read-logger hook with a PostToolUse payload, as Claude Code would. */
function runHook(payload: unknown): { status: number | null; log: string } {
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: work },
    encoding: 'utf-8',
  });
  const logPath = join(work, '.uap/read_log.state');
  return { status: res.status, log: existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '' };
}

describe('read-log writer hook', () => {
  it('is installed and executable — the enforcer has no other evidence source', () => {
    expect(existsSync(HOOK)).toBe(true);
    // Shipped to new installs too; a fix that skips templates/ gets reverted by
    // the next `uap worktree create`.
    expect(existsSync(join(ROOT, 'templates/hooks/post-tool-use-read.sh'))).toBe(true);
  });

  it('the live copy and the template do not drift apart', () => {
    // Hook-template drift is a repeat offender here: `.claude/hooks` gets the
    // fix, templates/ keeps the old version, and the next worktree resurrects it.
    expect(readFileSync(HOOK, 'utf-8')).toBe(
      readFileSync(join(ROOT, 'templates/hooks/post-tool-use-read.sh'), 'utf-8')
    );
  });

  it('is wired into this repo\'s own settings.json, not merely present', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf-8'));
    const rule = settings.hooks.PostToolUse.find((r: { matcher?: string }) => r.matcher === 'Read|Grep|Glob');
    expect(rule?.hooks?.[0]?.command).toContain('post-tool-use-read.sh');
  });

  it('is wired for every platform that gets the script copied', () => {
    // copyHookScripts() drops the script into all platform dirs, but each
    // platform needs its own matcher. Claude Code had one and Factory/Cursor did
    // not, so those agents would hit the same permanent block this branch fixes.
    const src = readFileSync(join(ROOT, 'src/cli/hooks.ts'), 'utf-8');
    const wirings = src.match(/post-tool-use-read\.sh/g) ?? [];
    // 1 copy-list entry + 1 hooks-status entry + 1 per platform settings writer.
    expect(wirings.length).toBeGreaterThanOrEqual(6);
    for (const dir of ['.claude', '.factory', '.cursor']) {
      expect(src).toContain(`${dir}/hooks/post-tool-use-read.sh`);
    }
  });

  it('cannot forge extra log records from a crafted Grep pattern', () => {
    // A record is "<epoch>\t<path>\n" and the pattern is model-supplied, so an
    // embedded tab/newline would let one read fabricate additional evidence.
    const { log } = runHook({ tool_input: { pattern: 'a\tb\n9999999999\tforged' } });
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).not.toContain('9999999999\tforged');
  });

  it('refuses to append through a symlink', () => {
    // `>>` follows symlinks: a link planted at read_log.state would turn every
    // read in the session into an append to the link target.
    const victim = join(work, 'victim');
    mkdirSync(join(work, '.uap'), { recursive: true });
    symlinkSync(victim, join(work, '.uap/read_log.state'));

    expect(runHook({ tool_input: { file_path: `${work}/a.ts` } }).status).toBe(0);
    expect(existsSync(victim)).toBe(false);
  });
});

describe('the applied enforcers', () => {
  // The patches/enforcers/ staging area these once guarded is gone: the fixes
  // it carried are applied in src/policies/enforcers/ as of this branch, and
  // their behaviour is covered directly by the Python suite
  // (tools/agents/tests/, `npm run test:enforcers`) rather than by checking
  // that a copy still compiles.
  it('codebase-read-before-plan degrades to advisory when its writer hook is absent', () => {
    // The half of the contract this repo's own writer hook depends on.
    const src = readFileSync(
      join(ROOT, 'src/policies/enforcers/codebase_read_before_plan.py'),
      'utf-8'
    );
    expect(src).toContain('writer_installed');
    expect(src).toContain('post-tool-use-read.sh');
  });

  it('logs a Read as "<epoch>\\t<path>" that lands inside the enforcer window', () => {
    const { status, log } = runHook({ tool_input: { file_path: `${work}/src/types/config.ts` } });
    expect(status).toBe(0);

    const [ts, path] = log.trim().split('\t');
    expect(path).toBe('src/types/config.ts'); // project-relative
    // The enforcer accepts entries younger than 1800s; a fresh write must be one.
    expect(Date.now() / 1000 - Number(ts)).toBeLessThan(60);
  });

  it('logs Grep/Glob, which carry `path`/`pattern` rather than `file_path`', () => {
    expect(runHook({ tool_input: { pattern: 'PrinciplesSchema', path: 'src' } }).log).toContain('src');
  });

  it('never fails the tool call on an unusable payload', () => {
    // A hook that exits non-zero on junk would break every Read in the session.
    expect(runHook({}).status).toBe(0);
    expect(spawnSync('bash', [HOOK], { input: '', encoding: 'utf-8' }).status).toBe(0);
  });
});

describe('recordMemoryQuery', () => {
  const dbPath = () => join(work, 'agents/data/memory/short_term.db');

  function rows(): Array<{ timestamp: string; type: string; content: string }> {
    const db = new Database(dbPath(), { readonly: true });
    const out = db
      .prepare('SELECT timestamp, type, content FROM session_memories ORDER BY id')
      .all() as Array<{ timestamp: string; type: string; content: string }>;
    db.close();
    return out;
  }

  it('writes the row memory-before-plan looks for', () => {
    recordMemoryQuery(work, 'deliver prompt injection');

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('memory_query');
    // The enforcer also matches on content LIKE '%uap memory query%'.
    expect(all[0].content).toContain('uap memory query');
    // Timestamps are compared as UTC; a local-time string would misdate the row.
    expect(all[0].timestamp).toMatch(/Z$/);
  });

  it('refreshes the timestamp when the same query is re-run', () => {
    // (session_id, content) is UNIQUE. INSERT OR IGNORE would keep the FIRST
    // timestamp, so a repeated query would leave stale evidence and the gate
    // would stay shut — the exact bug this writer exists to fix.
    recordMemoryQuery(work, 'same topic');

    // Backdate rather than sleep: asserting on wall-clock needs a real delay,
    // which is both slow and clock-dependent. Backdating tests the same thing.
    const stale = '2000-01-01T00:00:00.000Z';
    const db = new Database(dbPath());
    db.prepare('UPDATE session_memories SET timestamp = ?').run(stale);
    db.close();

    recordMemoryQuery(work, 'same topic');

    const after = rows();
    expect(after).toHaveLength(1); // upserted, not duplicated
    expect(after[0].timestamp).not.toBe(stale);
  });

  it('creates the memory directory when a project has none yet', () => {
    expect(existsSync(dbPath())).toBe(false);
    recordMemoryQuery(work, 'fresh project');
    expect(existsSync(dbPath())).toBe(true);
  });

  it('never throws — bookkeeping must not break the query itself', () => {
    // Point the config at an unwritable path; the query must still succeed.
    mkdirSync(join(work, 'agents/data/memory'), { recursive: true });
    writeFileSync(join(work, '.uap.json'), JSON.stringify({ memory: { shortTerm: { path: '/proc/nope/x.db' } } }));
    expect(() => recordMemoryQuery(work, 'unwritable')).not.toThrow();
  });
});
