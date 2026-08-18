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
  patchOnlyTools,
  writeOnlyTools,
  hasLargeExistingFile,
  WHOLE_FILE_REWRITE_LIMIT_BYTES,
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

  it('refuses a NEW file written as a stub — the case the size guard cannot see', async () => {
    // The observed failure: six brand-new modules written straight to disk as
    // skeletons. P3 only fires when the target already exists, so a first write
    // had nothing to shrink from and sailed through.
    mkdirSync(join(dir, 'js'), { recursive: true });
    const stub = [
      '/**',
      ' * Player Module — Stub',
      ' */',
      'const Player = (function () {',
      '  return { init() {}, update() {}, draw() {}, moveUp() {}, shoot() {}, reset() {} };',
      '})();',
    ].join('\n');
    mockChatSequence([
      call('write_file', { path: 'js/player.js', content: stub }),
      call('finish', { summary: 'done' }, 't2'),
    ]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('build the player module');
    expect(existsSync(join(dir, 'js/player.js'))).toBe(false);
  });

  it('still writes a real implementation of the same module', async () => {
    // The bar that matters: refusing stubs is worthless if it also refuses code.
    mkdirSync(join(dir, 'js'), { recursive: true });
    const real = [
      'const Player = (function () {',
      '  let x = 0, vx = 0;',
      '  function init(c) { x = c.width / 2; }',
      '  function update(dt) { x += vx * dt; if (x < 0) x = 0; }',
      '  function draw(ctx) { ctx.fillRect(x, 10, 20, 20); }',
      '  function moveLeft() { vx = -200; }',
      '  function shoot(bs) { bs.push({ x }); }',
      '  return { init, update, draw, moveLeft, shoot };',
      '})();',
    ].join('\n');
    mockChatSequence([
      call('write_file', { path: 'js/player.js', content: real }),
      call('finish', { summary: 'done' }, 't2'),
    ]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('build the player module');
    expect(readFileSync(join(dir, 'js/player.js'), 'utf-8')).toBe(real);
  });

  it('UAP_DELIVER_ALLOW_STUBS=1 permits a deliberately empty-bodied file', async () => {
    mkdirSync(join(dir, 'js'), { recursive: true });
    process.env.UAP_DELIVER_ALLOW_STUBS = '1';
    try {
      const stub = 'const A = { a() {}, b() {}, c() {}, d() {}, e() {}, f() {} };';
      mockChatSequence([
        call('write_file', { path: 'js/iface.js', content: stub }),
        call('finish', { summary: 'done' }, 't2'),
      ]);
      const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
      await exec('write the interface');
      expect(readFileSync(join(dir, 'js/iface.js'), 'utf-8')).toBe(stub);
    } finally {
      delete process.env.UAP_DELIVER_ALLOW_STUBS;
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
  // Pin the threshold rather than inheriting the shipped default: these tests
  // assert the BEHAVIOUR (nudge fires, then forcing, non-consecutively) at a
  // known round, so they must not break when the default is tuned. They also
  // exercise the env override itself.
  beforeEach(() => {
    process.env.UAP_DELIVER_WRITE_NUDGE_AFTER = '5';
    dir = mkdtempSync(join(tmpdir(), 'agx-nudge-'));
    writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
  });
  afterEach(() => {
    delete process.env.UAP_DELIVER_WRITE_NUDGE_AFTER;
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

    // Stripping the read tools is only half of it: the forced round must also
    // CARRY the current content of what the model was reading, or it composes
    // the edit from memory. That blind edit is the measured failure — 50% of
    // forced rounds broke syntax on the Octopus run, and the recovery was to
    // re-emit the whole file. Assert the grounding reached the wire, not just
    // that the helper exists.
    const forcedMessages = round7.messages as Array<{ role: string; content: string | null }>;
    const grounded = forcedMessages.some(
      (m) => typeof m.content === 'string' && m.content.includes('CURRENT on-disk content'),
    );
    expect(grounded).toBe(true);
    const groundingMsg = forcedMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('CURRENT on-disk content'),
    )!;
    // It must be the real file body from disk, not a placeholder.
    expect(groundingMsg.content).toContain('const a = 1;');
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

describe('createAgenticExecutor — empty-finish refusal', () => {
  let dir: string;
  beforeEach(() => {
    process.env.UAP_DELIVER_EMPTY_FINISH_REFUSALS = '2';
    dir = mkdtempSync(join(tmpdir(), 'agx-finish-'));
    writeFileSync(join(dir, 'a.js'), 'const a = 1;\n');
  });
  afterEach(() => {
    delete process.env.UAP_DELIVER_EMPTY_FINISH_REFUSALS;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const readCall = (n: number) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: `r${n}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
    ],
  });
  const finishCall = (n: number) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: `f${n}`, type: 'function', function: { name: 'finish', arguments: '{"summary":"all done"}' } },
    ],
  });
  const writeCall = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'w1',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"b.js","content":"const b = 2;"}' },
      },
    ],
  };

  /** Script the chat endpoint and capture every outgoing request body. */
  function run(responses: Array<Record<string, unknown>>) {
    const bodies: string[] = [];
    let i = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    return { bodies, done: exec('remove the duplicate title') };
  }

  it('refuses a finish from a turn that modified nothing', async () => {
    // The Octopus run-E shape: read one file, declare completion. Before this
    // guard the turn ended at round 2 having done nothing, and every turn after
    // it scored identically.
    const { bodies, done } = run([readCall(1), finishCall(1), writeCall, finishCall(2)]);
    await done;
    expect(bodies.some((b) => b.includes('REFUSED'))).toBe(true);
    // The refusal must not end the turn — the write that follows has to land.
    expect(existsSync(join(dir, 'b.js'))).toBe(true);
  });

  it('refuses a SILENT exit from a turn that modified nothing', async () => {
    // The shape that cost 100 minutes (octopus_invaders_v4, 2026-08-18): the
    // model calls one read-only tool, then returns a message with NO tool call
    // at all. That is the same no-op the finish branch refuses, arriving
    // without saying so — and it was the one exit with no mutation check.
    //
    // 856 agent sessions in that run; 837 took exactly this path and the
    // orchestrator respawned each one. 39 writes came out of 967 read-only
    // rounds.
    const silent = { role: 'assistant', content: 'Everything looks correct already.' };
    const { bodies, done } = run([readCall(1), silent, writeCall, finishCall(1)]);
    await done;
    expect(bodies.some((b) => b.includes('without modifying any file'))).toBe(true);
    // The refusal must not end the turn — the write that follows has to land.
    expect(existsSync(join(dir, 'b.js'))).toBe(true);
  });

  it('lets a silent exit stand once the turn has written something', async () => {
    const silent = { role: 'assistant', content: 'Done.' };
    const { bodies, done } = run([writeCall, silent]);
    const result = await done;
    expect(bodies.some((b) => b.includes('without modifying any file'))).toBe(false);
    expect(result).toBe('Done.');
  });

  it('bounds silent-exit refusals so a turn cannot deadlock', async () => {
    // Never writes, never calls a tool. Must still terminate rather than
    // burning the round budget — the gate ladder decides completion, not this.
    const silent = { role: 'assistant', content: 'Nothing to do.' };
    const { bodies, done } = run([silent]);
    const result = await done;
    const refusals = bodies.filter((b) => b.includes('without modifying any file')).length;
    expect(refusals).toBeLessThanOrEqual(3);
    expect(result).toBe('Nothing to do.');
  });

  it('accepts a finish from a turn that wrote something', async () => {
    const { bodies, done } = run([writeCall, finishCall(1), readCall(9)]);
    const result = await done;
    expect(bodies.some((b) => b.includes('REFUSED'))).toBe(false);
    expect(result).toBe('all done');
  });

  it('bounds the refusals so a genuinely-done turn cannot deadlock', async () => {
    // Never writes, only ever finishes. Must still terminate, and must not
    // burn the whole round budget doing it.
    const { bodies, done } = run([finishCall(1)]);
    const result = await done;
    expect(result).toBe('all done');
    const refusals = bodies.filter((b) => b.includes('REFUSED')).length;
    // Body N carries refusal N-1, so 2 refusals appear in bodies 2 and 3.
    expect(refusals).toBeLessThanOrEqual(4);
    expect(bodies.length).toBeLessThan(10);
  });

  it('escalates the existing write rail rather than only scolding', async () => {
    const { bodies, done } = run([finishCall(1)]);
    await done;
    // First refusal arms the soft nudge; the last arms the forced round.
    expect(bodies.some((b) => b.includes('STOP exploring'))).toBe(true);
  });

  it('credits a recovered-from-text write, so that turn is not refused', async () => {
    // The model emitted file content as prose instead of calling write_file;
    // the executor materialized it. That is a real mutation, so the finish that
    // follows must be honoured. Asserting on the REFUSAL rather than on the
    // summary matters: the refusal budget means a wrongly-refused turn still
    // ends with the right summary a few rounds later, which hides the bug.
    const { bodies, done } = run([
      { content: ['```file:js/calc.js', 'module.exports = (a, b) => a + b;', '```'].join('\n') },
      finishCall(1),
      readCall(9),
    ]);
    const result = await done;
    expect(existsSync(join(dir, 'js/calc.js'))).toBe(true);
    expect(bodies.some((b) => b.includes('REFUSED'))).toBe(false);
    expect(result).toBe('all done');
  });

  it('is disabled by UAP_DELIVER_EMPTY_FINISH_REFUSALS=0', async () => {
    process.env.UAP_DELIVER_EMPTY_FINISH_REFUSALS = '0';
    const { bodies, done } = run([finishCall(1)]);
    const result = await done;
    expect(result).toBe('all done');
    expect(bodies.some((b) => b.includes('REFUSED'))).toBe(false);
  });
});

/**
 * A NO-OP must not be bankable as progress.
 *
 * The whole no-op guard rests on the executor testing `toolResult.startsWith('OK')`
 * to decide whether a round mutated anything. That coupling is a STRING PREFIX:
 * reword the message to "OK (no-op): …" and every string-level test still passes
 * while the live loop returns in full — a model banks a mutation for a round that
 * changed nothing, and the empty-finish rail stops refusing.
 *
 * So assert the consequence, not the wording.
 */
describe('a no-op edit does not count as a mutation', () => {
  let dir: string;
  const SRC = 'function add(a, b) {\n    return a + b;\n}\n';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-noop-'));
    writeFileSync(join(dir, 'calc.js'), SRC, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const editCall = (oldStr: string, newStr: string) => ({
    content: null,
    tool_calls: [{
      id: 'e1',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: JSON.stringify({ path: 'calc.js', old_string: oldStr, new_string: newStr }),
      },
    }],
  });
  const finish = {
    content: null,
    tool_calls: [{ id: 'f1', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }],
  };

  it('refuses a finish whose only "edit" changed nothing', async () => {
    const spy = mockChatSequence([editCall('return a + b;', 'return a + b;'), finish]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('go');
    // The refusal is delivered back to the model, so it shows up in a later
    // request body rather than in the return value.
    const sent = spy.mock.calls
      .map((c) => String((c[1] as { body?: unknown } | undefined)?.body ?? ''))
      .join('\n');
    expect(sent).toMatch(/REFUSED|without modifying|no files/i);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toBe(SRC);
  });

  it('accepts a finish once an edit really changed the file', async () => {
    const spy = mockChatSequence([editCall('return a + b;', 'return a * b;'), finish]);
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('go');
    const sent = spy.mock.calls
      .map((c) => String((c[1] as { body?: unknown } | undefined)?.body ?? ''))
      .join('\n');
    expect(sent).not.toMatch(/REFUSED/i);
    expect(readFileSync(join(dir, 'calc.js'), 'utf-8')).toContain('a * b');
  });
});

describe('whole-file re-emit rail', () => {
  // Throughput, not correctness. Measured (octopus_invaders_v4, 2026-08-18):
  // one forced round re-emitted a 40KB file and spent ~19 MINUTES decoding on
  // a local 35B; the equivalent patch lands in seconds. That cost is paid
  // BEFORE the tool call arrives, so refusing the write on receipt cannot
  // recover it — the capability has to be gone at the point of choice.

  it('drops write_file but keeps the surgical mutators', () => {
    const names = patchOnlyTools(true).map((t) => t.function.name);
    expect(names).not.toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('finish');
  });

  it('still drops the read tools, like any forced round', () => {
    const names = patchOnlyTools(true).map((t) => t.function.name);
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('list_dir');
  });

  it('is strictly narrower than the ordinary forced set', () => {
    // The ordinary forced round MUST keep write_file — a new file can only be
    // created with it, and forced rounds alternate so the next round restores
    // everything anyway.
    expect(writeOnlyTools(true).map((t) => t.function.name)).toContain('write_file');
  });

  it('fires only when a grounded file is actually large', () => {
    const cache = { seen: new Map([['read_file:big.js', { round: 1, path: 'big.js' }]]) } as never;
    const big = () => WHOLE_FILE_REWRITE_LIMIT_BYTES;
    const small = () => WHOLE_FILE_REWRITE_LIMIT_BYTES - 1;
    expect(hasLargeExistingFile(cache, '/proj', big)).toBe(true);
    expect(hasLargeExistingFile(cache, '/proj', small)).toBe(false);
  });

  it('ignores directories and unreadable paths', () => {
    // list_dir entries name a directory, not a file — statting one as evidence
    // of a large file would arm the rail on any project with a big folder.
    const cache = { seen: new Map([['list_dir:.', { round: 1, path: '.' }]]) } as never;
    expect(hasLargeExistingFile(cache, '/proj', () => 10_000_000)).toBe(false);

    const missing = { seen: new Map([['read_file:gone.js', { round: 1, path: 'gone.js' }]]) } as never;
    expect(
      hasLargeExistingFile(missing, '/proj', () => {
        throw new Error('ENOENT');
      })
    ).toBe(false);
  });
});

describe('a stripped tool is refused, not executed', () => {
  // Removing a tool from the offered list is a HINT to the model, not a
  // control on the harness: runTool dispatches on the name alone, so a model
  // that calls a stripped tool anyway still gets it executed. That made both
  // forced-round strips advisory — the read-tool strip that breaks a
  // read-forever loop, and the write_file strip that stops a 19-minute
  // whole-file re-emit. Observed live: write_file executed three times on
  // rounds where it had been stripped.
  let dir: string;
  beforeEach(() => {
    process.env.UAP_DELIVER_WRITE_NUDGE_AFTER = '1';
    process.env.UAP_DELIVER_FORCE_WRITE_AFTER = '2';
    dir = mkdtempSync(join(tmpdir(), 'agx-strip-'));
    // Large enough to arm the whole-file rail.
    writeFileSync(join(dir, 'big.js'), `// big\n${'const x = 1;\n'.repeat(900)}`);
  });
  afterEach(() => {
    delete process.env.UAP_DELIVER_WRITE_NUDGE_AFTER;
    delete process.env.UAP_DELIVER_FORCE_WRITE_AFTER;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const readBig = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"big.js"}' } },
    ],
  };
  const wholeFileWrite = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'w',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"big.js","content":"// GUTTED"}' },
      },
    ],
  };

  it('refuses write_file on a forced large-file round instead of running it', async () => {
    const bodies: string[] = [];
    let i = 0;
    const seq = [readBig, readBig, readBig, wholeFileWrite, wholeFileWrite, wholeFileWrite];
    vi.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
      bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
      const msg = seq[Math.min(i, seq.length - 1)];
      i++;
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) } as unknown as Response;
    });
    const exec = createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://localhost:9/v1' });
    await exec('shrink it');

    // The refusal must reach the model...
    expect(bodies.some((b) => b.includes('was not offered this round'))).toBe(true);
    // ...and the write must NOT have landed. This is the assertion that fails
    // without the fix: the file would read "// GUTTED".
    expect(readFileSync(join(dir, 'big.js'), 'utf-8')).not.toContain('GUTTED');
  });
});
