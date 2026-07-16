import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import {
  lockContractFiles,
  looksTruncated,
  selectExecutorMode,
  protectedKey,
  noopApplier,
  createAgenticExecutor,
} from '../../src/delivery/agentic-executor.js';

/** Build a fake /chat/completions response body. */
function chatResponse(message: Record<string, unknown>) {
  return { ok: true, json: async () => ({ choices: [{ message }] }) };
}

/** Mock global.fetch to return a scripted sequence of chat responses. */
function mockChatSequence(responses: Array<Record<string, unknown>>) {
  let i = 0;
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    const msg = responses[Math.min(i, responses.length - 1)];
    i++;
    return chatResponse(msg) as unknown as Response;
  });
}

const MODEL = { id: 'm', apiModel: 'm', endpoint: 'http://localhost:9/v1' } as never;

describe('selectExecutorMode', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('honors explicit blind / agentic regardless of context', () => {
    expect(selectExecutorMode('blind', dir, true)).toBe('blind');
    expect(selectExecutorMode('agentic', dir, false)).toBe('agentic');
  });

  it('auto → agentic when gates exist', () => {
    expect(selectExecutorMode('auto', dir, true)).toBe('agentic');
  });

  it('auto → agentic when the project has inspectable content', () => {
    writeFileSync(join(dir, 'main.py'), 'print(1)\n');
    expect(selectExecutorMode('auto', dir, false)).toBe('agentic');
  });

  it('auto → blind for an empty/scaffold-only project with no gates', () => {
    writeFileSync(join(dir, 'package.json'), '{}'); // scaffolding is ignored
    expect(selectExecutorMode('auto', dir, false)).toBe('blind');
  });
});

describe('protectedKey', () => {
  it('normalizes to lowercase forward-slash relative path', () => {
    const root = `${sep}proj`;
    expect(protectedKey(root, `${sep}proj${sep}Tests${sep}Spec.TS`)).toBe('tests/spec.ts');
  });
});

describe('noopApplier', () => {
  it('reports nothing applied and no error (success, not "no blocks found")', async () => {
    const r = await noopApplier();
    expect(r.filesWritten).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.error).toBeUndefined();
  });
});

describe('createAgenticExecutor — file recovery when the model skips tool calls', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-rec-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes files emitted as fenced blocks in text (no tool_calls), then finishes', async () => {
    // Turn 1: model emits file CONTENT as text, no tool_calls (the failure mode).
    // Turn 2: model calls finish.
    mockChatSequence([
      {
        content: ['Here is the file:', '```file:js/calc.js', 'module.exports = (a, b) => a + b;', '```'].join(
          '\n'
        ),
      },
      { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }] },
    ]);

    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    const summary = await exec('Create js/calc.js.');

    expect(existsSync(join(dir, 'js/calc.js'))).toBe(true);
    expect(readFileSync(join(dir, 'js/calc.js'), 'utf-8')).toContain('a + b');
    expect(summary).toBe('done');
  });

  it('recovers a language-tagged fence with the path in a heading (lenient decode)', async () => {
    mockChatSequence([
      { content: ['### src/util.js', '```javascript', 'exports.x = 1;', '```'].join('\n') },
      { content: 'all set' }, // no tool_calls, no blocks → final
    ]);

    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('do it');
    expect(existsSync(join(dir, 'src/util.js'))).toBe(true);
    expect(readFileSync(join(dir, 'src/util.js'), 'utf-8')).toContain('exports.x = 1;');
  });

  it('still returns plain text as final when there are no recoverable file blocks', async () => {
    mockChatSequence([{ content: 'I analyzed the repo and found no changes are needed.' }]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    const summary = await exec('check');
    expect(summary).toContain('no changes are needed');
  });

  it('does NOT write a protected test file recovered from text', async () => {
    writeFileSync(join(dir, 'calc.test.js'), 'original');
    mockChatSequence([
      { content: ['```file:calc.test.js', 'expect(true).toBe(true);', '```'].join('\n') },
      { content: 'done' },
    ]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      protectedFiles: new Set(['calc.test.js']),
    });
    await exec('go');
    expect(readFileSync(join(dir, 'calc.test.js'), 'utf-8')).toBe('original');
  });

  const bashCall = (cmd: string) => ({
    content: null,
    tool_calls: [{ id: 'b1', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: cmd }) } }],
  });
  const finishCall = { content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }] };

  it('refuses run_bash by default (unsandboxed) — the command never executes (audit X3)', async () => {
    const marker = join(dir, 'bash-ran.txt');
    mockChatSequence([bashCall(`touch ${marker}`), finishCall]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('go');
    expect(existsSync(marker)).toBe(false); // command did NOT run
  });

  it('when run_bash is disabled: system prompt tells the model NOT to self-verify (gates are automatic)', async () => {
    const bodies: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as { body?: string })?.body ?? ''));
      return chatResponse(finishCall.tool_calls ? finishCall : { content: 'done' }) as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' }); // allowBash false
    await exec('go');
    const sys = JSON.parse(bodies[0]).messages.find((m: { role: string }) => m.role === 'system').content as string;
    expect(sys).toMatch(/CANNOT run shell commands/);
    expect(sys).toMatch(/do NOT try to run tests/i);
    expect(sys).toMatch(/Verification is AUTOMATIC/i);
  });

  it('run_bash refusal tells the model verification is automatic and not to retry', async () => {
    const bodies: string[] = [];
    let i = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as { body?: string })?.body ?? ''));
      const msg = i++ === 0 ? bashCall('npm test') : finishCall;
      return chatResponse(msg) as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('go');
    // The 2nd request carries the tool result (the refusal) fed back to the
    // model — identify it by the refusal's unique phrase (the system prompt
    // also mentions run_bash, so match on 'do NOT need it').
    const allText = JSON.stringify(JSON.parse(bodies[1]).messages);
    expect(allText).toMatch(/do NOT need it/i);
    expect(allText).toMatch(/delivery gates run the tests/i);
    expect(allText).toMatch(/do NOT retry/i);
  });

  it('runs run_bash when explicitly allowed (--allow-bash)', async () => {
    const marker = join(dir, 'bash-ran-2.txt');
    mockChatSequence([bashCall(`touch ${marker}`), finishCall]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1', allowBash: true });
    await exec('go');
    expect(existsSync(marker)).toBe(true);
  });

  it('auto-allows run_bash under uap sandbox (UAP_SANDBOX_ACTIVE=1)', async () => {
    const marker = join(dir, 'bash-ran-3.txt');
    const prev = process.env.UAP_SANDBOX_ACTIVE;
    process.env.UAP_SANDBOX_ACTIVE = '1';
    try {
      mockChatSequence([bashCall(`touch ${marker}`), finishCall]);
      const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
      await exec('go');
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.UAP_SANDBOX_ACTIVE;
      else process.env.UAP_SANDBOX_ACTIVE = prev;
    }
  });
});


describe('lockContractFiles (contracts-first epics)', () => {
  it('locks source files, skips manifests/lockfiles/gate-configs/tests, dedupes', () => {
    const lock = new Set<string>();
    const root = '/proj';
    const locked = lockContractFiles(lock, root, [
      'src/registry.ts',
      'src/types.ts',
      'Cargo.toml',
      'package.json',
      'yarn.lock',
      'tsconfig.json',
      'src/registry.test.ts',
    ]);
    expect(locked).toEqual(['src/registry.ts', 'src/types.ts']);
    expect(lock.has(protectedKey(root, '/proj/src/registry.ts'))).toBe(true);
    expect(lock.has(protectedKey(root, '/proj/Cargo.toml'))).toBe(false);
    // Re-locking is a no-op (already locked → not reported again).
    expect(lockContractFiles(lock, root, ['src/registry.ts'])).toEqual([]);
  });
});

describe('edit_file tool (P1, plan D3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-edit-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/big.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const call = (name: string, args: object, id = 't1') =>
    ({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

  it('applies an exact-once anchored replacement without re-emitting the file', async () => {
    mockChatSequence([
      call('edit_file', { path: 'src/big.ts', old_string: 'export const b = 2;', new_string: 'export const b = 20;' }),
      call('finish', { summary: 'done' }, 't2'),
    ]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('bump b');
    const out = readFileSync(join(dir, 'src/big.ts'), 'utf-8');
    expect(out).toContain('b = 20');
    expect(out).toContain('a = 1');
    expect(out).toContain('c = 3');
  });

  it('refuses ambiguous or missing anchors with an actionable error', async () => {
    writeFileSync(join(dir, 'src/big.ts'), 'dup;\ndup;\n');
    mockChatSequence([
      call('edit_file', { path: 'src/big.ts', old_string: 'dup;', new_string: 'once;' }),
      call('finish', { summary: 'done' }, 't2'),
    ]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('dedupe');
    // Ambiguous without occurrence -> unchanged.
    expect(readFileSync(join(dir, 'src/big.ts'), 'utf-8')).toBe('dup;\ndup;\n');
  });

  it('occurrence selects the nth match', async () => {
    writeFileSync(join(dir, 'src/big.ts'), 'dup;\ndup;\n');
    mockChatSequence([
      call('edit_file', { path: 'src/big.ts', old_string: 'dup;', new_string: 'second;', occurrence: 2 }),
      call('finish', { summary: 'done' }, 't2'),
    ]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('replace second');
    expect(readFileSync(join(dir, 'src/big.ts'), 'utf-8')).toBe('dup;\nsecond;\n');
  });

  it('refuses protected test files exactly like write_file', async () => {
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test/x.test.ts'), 'expect(1).toBe(1);\n');
    mockChatSequence([
      call('edit_file', { path: 'test/x.test.ts', old_string: 'toBe(1)', new_string: 'toBe(2)' }),
      call('finish', { summary: 'done' }, 't2'),
    ]);
    const protectedFiles = new Set([protectedKey(dir, join(dir, 'test/x.test.ts'))]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1', protectedFiles });
    await exec('cheat the test');
    expect(readFileSync(join(dir, 'test/x.test.ts'), 'utf-8')).toContain('toBe(1)');
  });
});

describe('looksTruncated (truncated-emit guard)', () => {
  it('flags code cut mid-block, ignores balanced/complete files and non-code', () => {
    const cut = 'export class UIManager {\n  constructor(ctx) {\n    this.ctx = ctx;\n' + '    this.x = 1;\n'.repeat(20); // never closes
    expect(looksTruncated('space-shooter/ui.js', cut)).toContain('unclosed {');

    const whole = 'export class UIManager {\n  constructor(ctx) { this.ctx = ctx; }\n}\n' + '// pad\n'.repeat(60);
    expect(looksTruncated('space-shooter/ui.js', whole)).toBeNull();

    // braces inside strings/comments/templates must not count
    const tricky = [
      'const s = "{{{{";',
      "const t = '{ not a block {';",
      'const u = `brace { ${1 + 1} still fine`;',
      '/* { { { */',
      '// {',
      'function f() { return s + t + u; }',
      '// pad'.repeat(40),
    ].join('\n');
    expect(looksTruncated('a.ts', tricky)).toBeNull();

    // non-code files and small stubs are never flagged
    expect(looksTruncated('README.md', '#{ {'.repeat(100))).toBeNull();
    expect(looksTruncated('a.js', 'const x = {')).toBeNull(); // < 200 chars
  });
});

describe('createAgenticExecutor — read-only-streak write nudge', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-nudge-'));
    writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const readCall = (n: number) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
    ],
  });

  it('injects the write-now order after 5 mutation-free rounds', async () => {
    const bodies: string[] = [];
    let i = 0;
    const responses = [
      readCall(1), readCall(2), readCall(3), readCall(4), readCall(5), readCall(6),
      { role: 'assistant', content: 'done reading', tool_calls: [] },
    ];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: msg }] }),
      } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('close the gaps');
    // The 6th request (round 6) must carry the injected nudge.
    const nudged = bodies.findIndex((b) => b.includes('STOP exploring'));
    expect(nudged).toBeGreaterThanOrEqual(5);
    expect(nudged).toBeLessThanOrEqual(6);
  });

  it('a successful write resets the streak — no nudge for productive sessions', async () => {
    const bodies: string[] = [];
    let i = 0;
    const writeCall = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.js","content":"const b = 2;"}' } },
      ],
    };
    const responses = [
      readCall(1), readCall(2), readCall(3), writeCall, readCall(4), readCall(5), readCall(6),
      { role: 'assistant', content: 'ok', tool_calls: [] },
    ];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: msg }] }),
      } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('do the work');
    expect(bodies.some((b) => b.includes('STOP exploring'))).toBe(false);
  });
});
