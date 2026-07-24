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
  isSuspectedGutting,
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

  it('P3: refuses a write_file that GUTS a large file, leaving it intact', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const big = 'export const x = 1;\n'.repeat(200); // ~4000 bytes
    writeFileSync(join(dir, 'src/big.ts'), big);
    mockChatSequence([
      call('write_file', { path: 'src/big.ts', content: '// stub\n' }), // guts it to ~8 bytes
      call('finish', { summary: 'done' }, 't2'),
    ]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('rewrite big');
    expect(readFileSync(join(dir, 'src/big.ts'), 'utf-8')).toBe(big); // unchanged — gutting refused
  });

  it('P3: UAP_DELIVER_ALLOW_GUTTING=1 permits the deliberate shrinking write', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/big.ts'), 'export const x = 1;\n'.repeat(200));
    process.env.UAP_DELIVER_ALLOW_GUTTING = '1';
    try {
      mockChatSequence([
        call('write_file', { path: 'src/big.ts', content: '// intentional full rewrite\n' }),
        call('finish', { summary: 'done' }, 't2'),
      ]);
      const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
      await exec('rewrite big');
      expect(readFileSync(join(dir, 'src/big.ts'), 'utf-8')).toBe('// intentional full rewrite\n');
    } finally {
      delete process.env.UAP_DELIVER_ALLOW_GUTTING;
    }
  });

  it('#2a: fires onToolProgress after EACH tool execution (per-tool-call heartbeat)', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    let progress = 0;
    mockChatSequence([
      call('list_dir', { path: '.' }),
      call('write_file', { path: 'src/a.ts', content: 'export const a = 1;\n' }),
      call('finish', { summary: 'done' }, 't3'),
    ]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      onToolProgress: () => { progress++; },
    });
    await exec('do stuff');
    // one callback per real tool call (list_dir + write_file) — NOT just once at
    // turn end, so a long working turn keeps the heartbeat fresh.
    expect(progress).toBeGreaterThanOrEqual(2);
  });

  it('#2a: does NOT stamp onToolProgress when a turn makes no tool calls', async () => {
    let progress = 0;
    // A finish-only turn (no read/write/bash) — the wedge signal must stay
    // untouched so a genuinely no-tool-progress run can still be detected.
    mockChatSequence([{ content: 'Nothing to do; the repo already satisfies the spec.' }]);
    const exec = createAgenticExecutor(MODEL, {
      projectRoot: dir,
      endpoint: 'http://localhost:9/v1',
      onToolProgress: () => { progress++; },
    });
    await exec('noop');
    expect(progress).toBe(0);
  });
});

describe('isSuspectedGutting (P3 anti-gutting)', () => {
  it('flags gutting a substantial file to under 35% of its size', () => {
    // The real incident: deliver.ts ~120000 bytes -> ~20000 (17%).
    expect(isSuspectedGutting(120000, 20000)).toBe(true);
    expect(isSuspectedGutting(2000, 400)).toBe(true); // 20%
  });
  it('allows minor shrinks and edits of a large file', () => {
    expect(isSuspectedGutting(2000, 1900)).toBe(false); // 95%
    expect(isSuspectedGutting(2000, 800)).toBe(false);  // 40% — above the 35% floor
  });
  it('never guards a small file (legitimate rewrites are common)', () => {
    expect(isSuspectedGutting(500, 10)).toBe(false);   // below the 1500-byte floor
    expect(isSuspectedGutting(1499, 0)).toBe(false);
  });
  it('a brand-new file (prevLen 0) is never gutting', () => {
    expect(isSuspectedGutting(0, 5000)).toBe(false);
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

  it('forces a write when the soft nudge is ignored: read tools stripped, tool_choice required', async () => {
    // The live failure (qwen35-a3b, 2026-07-21): the model treated the soft
    // nudge as more prose and kept reading. After the nudge (round 6) is
    // ignored, round 7 must strip the read tools and require a call.
    const bodies: string[] = [];
    let i = 0;
    const responses = [
      readCall(1), readCall(2), readCall(3), readCall(4), readCall(5), readCall(6),
      readCall(7), readCall(8),
      { role: 'assistant', content: 'stopped', tool_calls: [] },
    ];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('close the gaps');

    // Rounds 1-6 offer read_file with tool_choice auto (the model can explore).
    const round6 = JSON.parse(bodies[5]);
    expect(round6.tool_choice).toBe('auto');
    expect(round6.tools.some((t: { function: { name: string } }) => t.function.name === 'read_file')).toBe(true);

    // Round 7 (post-nudge) is the forced-write round.
    const round7 = JSON.parse(bodies[6]);
    expect(round7.tool_choice).toBe('required');
    const names7 = round7.tools.map((t: { function: { name: string } }) => t.function.name);
    expect(names7).not.toContain('read_file');
    expect(names7).not.toContain('list_dir');
    expect(names7).toContain('write_file');
    expect(names7).toContain('edit_file');
    expect(names7).toContain('finish');
  });

  it('forces NON-consecutively: the round after a forced round restores read tools', async () => {
    // A model whose correct move is a surgical edit_file needs to re-read to
    // build a valid match. If forcing were sticky it would be trapped read-less
    // until the budget burned. The round after any forced round must be normal.
    const bodies: string[] = [];
    let i = 0;
    const responses = [
      readCall(1), readCall(2), readCall(3), readCall(4), readCall(5), readCall(6),
      readCall(7), readCall(8), readCall(9),
      { role: 'assistant', content: 'stopped', tool_calls: [] },
    ];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('close the gaps');
    // Round 7 forced, round 8 restored (auto), round 9 forced again.
    expect(JSON.parse(bodies[6]).tool_choice).toBe('required'); // round 7
    expect(JSON.parse(bodies[7]).tool_choice).toBe('auto'); // round 8 — recovery
    expect(JSON.parse(bodies[7]).tools.some((t: { function: { name: string } }) => t.function.name === 'read_file')).toBe(
      true
    );
    expect(JSON.parse(bodies[8]).tool_choice).toBe('required'); // round 9
  });

  it('a clean run_bash (exit=0) resets the streak — never forces a bash-productive session', async () => {
    const bodies: string[] = [];
    let i = 0;
    const bashOk = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'b1', type: 'function', function: { name: 'run_bash', arguments: '{"command":"echo built"}' } }],
    };
    // Bash writes files every few rounds; the streak must never reach the force
    // threshold, and run_bash must never be stripped.
    const responses = [
      readCall(1), readCall(2), bashOk, readCall(3), readCall(4), bashOk, readCall(5),
      { role: 'assistant', content: 'ok', tool_calls: [] },
    ];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1', allowBash: true });
    await exec('build via bash');
    expect(bodies.every((b) => JSON.parse(b).tool_choice === 'auto')).toBe(true);
  });

  it('never forces a write on a productive session (streak reset keeps read tools)', async () => {
    const bodies: string[] = [];
    let i = 0;
    const writeCall = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.js","content":"const b=2;"}' } },
      ],
    };
    // A write every few rounds keeps roundsWithoutWrite below the threshold.
    const responses = [
      readCall(1), readCall(2), writeCall, readCall(3), readCall(4), writeCall, readCall(5),
      { role: 'assistant', content: 'ok', tool_calls: [] },
    ];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('do the work');
    // No request should ever have been forced.
    expect(bodies.every((b) => JSON.parse(b).tool_choice === 'auto')).toBe(true);
  });
});

describe('PROXY_AUTH_TOKEN never leaks off-machine', () => {
  let dir: string;
  let prevToken: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-tok-'));
    prevToken = process.env.PROXY_AUTH_TOKEN;
    process.env.PROXY_AUTH_TOKEN = 'proxy-secret-do-not-leak';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevToken === undefined) delete process.env.PROXY_AUTH_TOKEN;
    else process.env.PROXY_AUTH_TOKEN = prevToken;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the token to a LOOPBACK endpoint', async () => {
    const spy = mockChatSequence([{ tool_calls: [{ function: { name: 'finish', arguments: '{}' } }] }]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('noop');
    const headers = (spy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer proxy-secret-do-not-leak');
  });

  it('withholds it from a keyless plaintext remote (no throw, no header)', async () => {
    // Regression: this path attached Authorization with no local-endpoint guard,
    // while its sibling in openai-compat-client.ts refused. Once PROXY_AUTH_TOKEN
    // became a fallback, a preset aimed at a remote endpoint would have shipped
    // the local proxy secret in cleartext.
    const spy = mockChatSequence([{ tool_calls: [{ function: { name: 'finish', arguments: '{}' } }] }]);
    const remote = { id: 'm', apiModel: 'm', endpoint: 'http://api.example.com/v1' } as never;
    const exec = createAgenticExecutor(remote, { projectRoot: dir, endpoint: 'http://api.example.com/v1' });
    // The executor traps turn errors into its summary rather than rejecting, so
    // assert on the surfaced reason — the refusal must reach the caller either way.
    // With the token now scoped to LOCAL endpoints, a keyless plaintext remote no
    // longer throws — it simply carries no credential. That is the property worth
    // asserting: the request may proceed, the secret may not travel.
    await exec('noop');
    expect(spy).toHaveBeenCalled();
    const headers = (spy.mock.calls[0][1] as { headers?: Record<string, string> })?.headers ?? {};
    expect(headers.Authorization).toBeUndefined();
  });

  it('WITHHOLDS it from a remote https host — the token belongs to one local process', async () => {
    // An earlier version of this test asserted the opposite. Refusing only
    // *cleartext* still handed the proxy token to any hosted provider over TLS,
    // and that token grants use of the operator's proxy — including its Anthropic
    // passthrough, i.e. their spend. There is no correct third-party recipient,
    // so the fallback is scoped to local endpoints instead of merely encrypted ones.
    const spy = mockChatSequence([{ tool_calls: [{ function: { name: 'finish', arguments: '{}' } }] }]);
    const remote = { id: 'm', apiModel: 'm', endpoint: 'https://api.example.com/v1' } as never;
    const exec = createAgenticExecutor(remote, { projectRoot: dir, endpoint: 'https://api.example.com/v1' });
    await exec('noop');
    const headers = (spy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends it to a PRIVATE-NETWORK host (the LAN-proxy deployment)', async () => {
    const spy = mockChatSequence([{ tool_calls: [{ function: { name: 'finish', arguments: '{}' } }] }]);
    const lan = { id: 'm', apiModel: 'm', endpoint: 'http://192.168.1.165:4000/v1' } as never;
    const exec = createAgenticExecutor(lan, { projectRoot: dir, endpoint: 'http://192.168.1.165:4000/v1' });
    await exec('noop');
    const headers = (spy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer proxy-secret-do-not-leak');
  });

  it('is not fooled by a hostname that merely STARTS with a private range', async () => {
    // `10.evil.com` is a registerable DNS name — RFC 1123 allows a leading digit.
    // The old unanchored prefix regex classified it as private and would have sent
    // the token in cleartext to a public host.
    const spy = mockChatSequence([{ tool_calls: [{ function: { name: 'finish', arguments: '{}' } }] }]);
    const spoof = { id: 'm', apiModel: 'm', endpoint: 'http://10.evil.com/v1' } as never;
    const exec = createAgenticExecutor(spoof, { projectRoot: dir, endpoint: 'http://10.evil.com/v1' });
    await exec('noop');
    const headers = (spy.mock.calls[0][1] as { headers?: Record<string, string> }).headers ?? {};
    expect(headers.Authorization).toBeUndefined();
  });

  it('still reaches a keyless plaintext remote WITHOUT a token (no spurious throw)', async () => {
    delete process.env.PROXY_AUTH_TOKEN;
    const spy = mockChatSequence([{ tool_calls: [{ function: { name: 'finish', arguments: '{}' } }] }]);
    const remote = { id: 'm', apiModel: 'm', endpoint: 'http://api.example.com/v1' } as never;
    const exec = createAgenticExecutor(remote, { projectRoot: dir, endpoint: 'http://api.example.com/v1' });
    await exec('noop');
    expect(spy).toHaveBeenCalled();
    const headers = (spy.mock.calls[0][1] as { headers?: Record<string, string> }).headers ?? {};
    expect(headers.Authorization).toBeUndefined();
  });

  it('REFUSES an explicit provider key over plaintext to a remote host', async () => {
    process.env.UAP_TEST_PROVIDER_KEY = 'sk-provider';
    try {
      const spy = mockChatSequence([{ tool_calls: [{ function: { name: 'finish', arguments: '{}' } }] }]);
      const remote = {
        id: 'm',
        apiModel: 'm',
        endpoint: 'http://api.example.com/v1',
        apiKeyEnvVar: 'UAP_TEST_PROVIDER_KEY',
      } as never;
      const exec = createAgenticExecutor(remote, { projectRoot: dir, endpoint: 'http://api.example.com/v1' });
      const summary = await exec('noop');
      expect(JSON.stringify(summary)).toMatch(/Refusing to send UAP_TEST_PROVIDER_KEY/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env.UAP_TEST_PROVIDER_KEY;
    }
  });
});
