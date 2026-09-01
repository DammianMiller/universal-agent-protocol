/**
 * Run write ledger (deliver-hardening review blocker, 2026-07-13).
 *
 * The agentic executor writes through its own tools behind a no-op applier, so
 * `filesApplied` was empty BY CONSTRUCTION on the default executor — and
 * keep-best's E2 scoped restore, which reads exactly that write-set, silently
 * did nothing when a run regressed. These tests pin the fix: the executor
 * records every path it writes (tool writes at the writeFileSync sites, shell
 * writes via the turn-end sweep's `changed` set) into a caller-owned ledger
 * that the applier drains into ApplyResult.filesWritten.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTool, createAgenticExecutor } from '../../src/delivery/agentic-executor.js';

const MODEL = { id: 'm', apiModel: 'm', endpoint: 'http://localhost:9/v1' } as never;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-ledger-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REAL_JS = `export function add(a, b) { return a + b; }\n`;

describe('runTool write ledger', () => {
  it('records a write_file path', () => {
    const dir = tmp();
    const ledger = new Set<string>();
    const out = runTool(dir, 'write_file', { path: 'src/a.js', content: REAL_JS }, 1000, new Set(), false, false,
      undefined, undefined, undefined, ledger);
    expect(out).toMatch(/^OK:/);
    expect(ledger).toEqual(new Set(['src/a.js']));
  });

  it('records an edit_file path', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'b.js'), 'const x = 1;\n');
    const ledger = new Set<string>();
    const out = runTool(dir, 'edit_file',
      { path: 'b.js', old_string: 'const x = 1;', new_string: 'const x = 2;' }, 1000, new Set(), false, false,
      undefined, undefined, undefined, ledger);
    expect(out).toMatch(/^OK:/);
    expect(ledger).toEqual(new Set(['b.js']));
  });

  it('records an edit_range path', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'c.js'), 'line1\nline2\nline3\n');
    const ledger = new Set<string>();
    const out = runTool(dir, 'edit_range',
      { path: 'c.js', start_line: 2, end_line: 2, new_text: 'LINE2' }, 1000, new Set(), false, false,
      undefined, undefined, undefined, ledger);
    expect(out).toMatch(/^OK:/);
    expect(ledger).toEqual(new Set(['c.js']));
  });

  it('does NOT record a refused write', () => {
    const dir = tmp();
    const ledger = new Set<string>();
    // edit_file on a nonexistent file is refused with steering to write_file.
    const out = runTool(dir, 'edit_file',
      { path: 'missing.js', old_string: 'a', new_string: 'b' }, 1000, new Set(), false, false,
      undefined, undefined, undefined, ledger);
    expect(out).toMatch(/^ERROR:/);
    expect(ledger.size).toBe(0);
    expect(existsSync(join(dir, 'missing.js'))).toBe(false);
  });

  it('records without a sweep — bash disabled is the common case', () => {
    // The ledger deliberately does NOT piggyback on the sweep's `authorised`
    // map: that map is a no-op when bash is disabled, which is the default.
    const dir = tmp();
    const ledger = new Set<string>();
    const out = runTool(dir, 'write_file', { path: 'solo.js', content: REAL_JS }, 1000, new Set(), false, false,
      undefined, undefined, undefined, ledger);
    expect(out).toMatch(/^OK:/);
    expect(ledger.has('solo.js')).toBe(true);
  });
});

describe('agentic executor: ledger end to end', () => {
  const bashEnv = ['UAP_SANDBOX_ACTIVE', 'UAP_DELIVER_ALLOW_BASH'] as const;
  const priorBash = bashEnv.map((k) => [k, process.env[k]] as const);
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const k of bashEnv) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of priorBash) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  function mockChatSequence(responses: Array<Record<string, unknown>>) {
    let i = 0;
    return vi.spyOn(global, 'fetch').mockImplementation(async () => {
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) } as unknown as Response;
    });
  }
  const finishCall = {
    content: null,
    tool_calls: [{ id: 'f1', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }],
  };

  it('a write_file tool call lands in the run ledger', async () => {
    const dir = tmp();
    mockChatSequence([
      {
        content: null,
        tool_calls: [
          {
            id: 'w1',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'player.js', content: REAL_JS }) },
          },
        ],
      },
      finishCall,
    ]);
    const ledger = new Set<string>();
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      writeLedger: ledger,
    });
    await exec('build the player');
    expect(readFileSync(join(dir, 'player.js'), 'utf-8')).toBe(REAL_JS);
    expect(ledger.has('player.js')).toBe(true);
  });

  it('a SHELL write lands in the run ledger via the sweep', async () => {
    // run_bash bypasses the tool handlers by definition — the turn-end sweep's
    // `changed` set is the only attribution channel, and it must feed the same
    // ledger or scoped rollback would miss shell-written files.
    const dir = tmp();
    mockChatSequence([
      {
        content: null,
        tool_calls: [
          {
            id: 'b1',
            type: 'function',
            function: {
              name: 'run_bash',
              arguments: JSON.stringify({ command: `cat > shell.js <<'EOF'\n${REAL_JS}EOF` }),
            },
          },
        ],
      },
      finishCall,
    ]);
    const ledger = new Set<string>();
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      allowBash: true,
      writeLedger: ledger,
    });
    await exec('build via shell');
    expect(existsSync(join(dir, 'shell.js'))).toBe(true);
    expect(ledger.has('shell.js')).toBe(true);
  });

  it('a read-only turn leaves the ledger empty', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'existing.js'), REAL_JS);
    mockChatSequence([
      {
        content: null,
        tool_calls: [
          {
            id: 'r1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'existing.js' }) },
          },
        ],
      },
      finishCall,
    ]);
    const ledger = new Set<string>();
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      writeLedger: ledger,
    });
    await exec('just look');
    expect(ledger.size).toBe(0);
  });
});
