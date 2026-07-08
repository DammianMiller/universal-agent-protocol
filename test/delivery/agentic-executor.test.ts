import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import {
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
