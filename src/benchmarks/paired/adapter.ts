/**
 * Agent adapters — drive the "agent under test" for one run.
 *
 * Two real adapters (opencode, claude) spawn the agent as a subprocess against
 * the scratch repo and parse usage metrics from its output. A MockAdapter makes
 * the whole harness runnable and unit-testable offline (it does NOT make real
 * claims — it is a deterministic stand-in for exercising the runner/stats/report
 * paths without a live model).
 *
 * Adapters never throw on agent failure: they capture it in `error` so a single
 * crashed run degrades to an incorrect result rather than aborting the suite.
 */

import { spawn, spawnSync } from 'child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

import { applyScaffolding, scaffoldEnv } from './scaffold.js';
import { sanitizedEnv } from './suite.js';
import { AgentAdapter, AgentRunContext, AgentRunResult, isBaseline } from './types.js';

// ---------------------------------------------------------------------------
// Subprocess adapter (real agents)
// ---------------------------------------------------------------------------

export type UsageParser = (stdout: string, stderr: string) => Partial<AgentRunResult>;

export interface SubprocessAdapterConfig {
  id: string;
  /** Executable, e.g. 'opencode' or 'claude'. */
  bin: string;
  /**
   * Argument template. The literal tokens '{instruction}' and '{workdir}' are
   * replaced per run. Everything else is passed through verbatim.
   */
  args: string[];
  /** Parse tokens/turns/toolCalls from agent output. */
  parseUsage: UsageParser;
  /** Pass the instruction on stdin instead of substituting into args. */
  instructionOnStdin?: boolean;
}

/** Cap on captured output per stream (bytes) to bound memory on runaway agents. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Grace period after the soft timeout before the hard backstop kill. */
const HARD_KILL_GRACE_MS = 10_000;

export class SubprocessAdapter implements AgentAdapter {
  readonly id: string;
  constructor(private readonly cfg: SubprocessAdapterConfig) {
    this.id = cfg.id;
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    // Inject the UAP treatment surface (no-op for the baseline arm).
    let injected: string[] = [];
    if (!isBaseline(ctx.condition)) {
      injected = applyScaffolding(ctx.workdir, ctx.condition).injectedFiles;
    }

    const args = this.cfg.args.map((a) =>
      a.replace('{instruction}', ctx.task.instruction).replace('{workdir}', ctx.workdir)
    );

    const env: NodeJS.ProcessEnv = {
      ...sanitizedEnv(),
      ...scaffoldEnv(ctx.condition),
      UAP_BENCH_MODEL: ctx.model,
    };

    const sec = ctx.task.agentTimeoutSec;
    const { stdout, stderr, timedOut, status, spawnError } = await spawnGroup(
      this.cfg.bin,
      args,
      {
        cwd: ctx.workdir,
        env,
        timeoutMs: sec * 1000,
        input: this.cfg.instructionOnStdin ? ctx.task.instruction : undefined,
      }
    );

    let error: string | null = null;
    if (timedOut) error = `agent timed out after ${sec}s`;
    else if (spawnError) error = spawnError;
    else if (status !== 0) error = `agent exited ${status}`;

    const parsed = timedOut ? {} : this.cfg.parseUsage(stdout, stderr);

    return {
      tokens: parsed.tokens ?? null,
      costUsd: parsed.costUsd ?? null,
      turns: parsed.turns ?? null,
      toolCalls: parsed.toolCalls ?? null,
      wellFormed: parsed.wellFormed ?? null,
      error,
      rawLog: `# injected: ${injected.join(', ') || '(none)'}\n${stdout}\n---STDERR---\n${stderr}`,
    };
  }
}

interface SpawnGroupOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string;
}

interface SpawnGroupResult {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
  spawnError: string | null;
}

/**
 * Spawn a command in its OWN process group (detached) and enforce a timeout by
 * SIGKILLing the whole group. Subprocess agents (opencode/claude) fork detached
 * child trees — LSP servers, model-stream readers — that inherit our stdout pipe
 * and keep it open. Node's spawnSync `timeout` only SIGTERMs the immediate
 * child, so it hangs forever on those orphans (observed: 50-min wedged runs).
 * Killing the negative pid reaps the entire tree; a hard backstop covers a
 * child that escaped into its own session.
 */
function spawnGroup(
  bin: string,
  args: string[],
  opts: SpawnGroupOptions
): Promise<SpawnGroupResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: process.platform !== 'win32', // new process group on POSIX
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        stdout: '',
        stderr: '',
        status: null,
        timedOut: false,
        spawnError: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const append = (buf: string, chunk: Buffer): string =>
      buf.length >= MAX_OUTPUT_BYTES ? buf : buf + chunk.toString('utf-8');
    child.stdout?.on('data', (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = append(stderr, c)));

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid != null && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const softTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
    }, opts.timeoutMs);
    // Hard backstop: if SIGTERM didn't reap the tree, SIGKILL the group and,
    // if 'close' still never fires, force-settle so the runner can't wedge.
    const hardTimer = setTimeout(() => {
      killGroup('SIGKILL');
      finish(null);
    }, opts.timeoutMs + HARD_KILL_GRACE_MS);

    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolve({ stdout, stderr, status, timedOut, spawnError });
    };

    child.on('error', (e: Error) => {
      spawnError = e.message;
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));

    if (opts.input != null) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// Built-in usage parsers
// ---------------------------------------------------------------------------

/** Sum the last token-usage object emitted in Claude Code's `--output-format json`. */
export const parseClaudeUsage: UsageParser = (stdout) => {
  try {
    const obj = JSON.parse(stdout.trim());
    const usage = obj.usage ?? obj.message?.usage ?? {};
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    return {
      tokens: tokens > 0 ? tokens : null,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
      turns: typeof obj.num_turns === 'number' ? obj.num_turns : null,
    };
  } catch {
    return {};
  }
};

/**
 * Parser for opencode `--format json` output, which is a JSONL event stream
 * (step_start / tool_use / step_finish / text). We aggregate it:
 *  - turns      = number of step_finish events
 *  - toolCalls  = number of tool_use events
 *  - tokens     = total tokens metered = Σ over step_finish of
 *                 (input + output + cache.read)  — matches provider billing and
 *                 captures the context overhead an injected UAP surface adds.
 *  - costUsd    = Σ cost (often 0 for a local model → reported as null).
 */
export const parseOpencodeUsage: UsageParser = (stdout) => {
  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;
  let cost = 0;
  let sawTokens = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = ev.type;
    if (type === 'tool_use') toolCalls++;
    if (type === 'step_finish') {
      turns++;
      const part = (ev.part ?? {}) as Record<string, unknown>;
      const tk = (part.tokens ?? {}) as Record<string, unknown>;
      const cache = (tk.cache ?? {}) as Record<string, unknown>;
      const input = num(tk.input);
      const output = num(tk.output);
      const cacheRead = num(cache.read);
      if (tk.input != null || tk.output != null) {
        tokens += input + output + cacheRead;
        sawTokens = true;
      }
      cost += num(part.cost);
    }
  }
  return {
    tokens: sawTokens ? tokens : null,
    costUsd: cost > 0 ? cost : null,
    turns: turns > 0 ? turns : null,
    toolCalls: toolCalls > 0 ? toolCalls : null,
  };
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Claude Code headless adapter (`claude -p ... --output-format json`). */
export function claudeAdapter(model: string): SubprocessAdapter {
  return new SubprocessAdapter({
    id: 'claude',
    bin: 'claude',
    // --dangerously-skip-permissions is REQUIRED for headless operation: `-p`
    // (print) mode cannot surface interactive permission prompts, so without
    // this the agent silently fails to use Edit/Write/Bash and scores 0 on both
    // arms (uninformative). Safe here because each run executes in a disposable,
    // isolated scratch workdir (materializeWorkdir), never the real repo.
    args: [
      '-p',
      '{instruction}',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--model',
      model,
    ],
    parseUsage: parseClaudeUsage,
  });
}

/** opencode headless adapter (`opencode run ...`). */
export function opencodeAdapter(model: string): SubprocessAdapter {
  return new SubprocessAdapter({
    id: 'opencode',
    bin: 'opencode',
    // --format json => JSONL event stream parsed by parseOpencodeUsage.
    // --dir pins the working directory to the scratch repo.
    args: ['run', '--model', model, '--format', 'json', '--dir', '{workdir}', '{instruction}'],
    parseUsage: parseOpencodeUsage,
  });
}

// ---------------------------------------------------------------------------
// Mock adapter (offline harness exercise / tests only)
// ---------------------------------------------------------------------------

export interface MockBehavior {
  /** Base probability the bare agent resolves a task of this difficulty. */
  baseSuccess: Record<'easy' | 'medium' | 'hard', number>;
  /** Additive correctness lift per enabled UAP component (capped at 1.0). */
  liftPerComponent: number;
  /** Token cost of the bare run; each component adds overhead tokens. */
  baseTokens: number;
  overheadTokensPerComponent: number;
}

const DEFAULT_MOCK: MockBehavior = {
  baseSuccess: { easy: 0.85, medium: 0.5, hard: 0.2 },
  liftPerComponent: 0.06,
  baseTokens: 8000,
  overheadTokensPerComponent: 400,
};

/**
 * Deterministic simulated agent. Given a seed, it reproducibly "resolves" tasks
 * with a probability that the UAP components nudge upward — purely to exercise
 * the runner/stats/report end-to-end without a live model. Clearly NOT a source
 * of real benchmark claims; the real adapters above are.
 */
export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  constructor(private readonly behavior: MockBehavior = DEFAULT_MOCK) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    if (!isBaseline(ctx.condition)) applyScaffolding(ctx.workdir, ctx.condition);

    const n = ctx.condition.components.size;
    const overheadTokens = n * this.behavior.overheadTokensPerComponent;
    // Deterministic pseudo-success driven by a hash of (task, seed) so pairing
    // is stable: the same seed yields correlated draws across conditions.
    const draw = hash01(`${ctx.task.id}:${ctx.seed}`);
    const threshold = Math.min(
      0.99,
      this.behavior.baseSuccess[ctx.task.difficulty] + n * this.behavior.liftPerComponent
    );
    const resolved = draw < threshold;

    // Write a real resolution artifact so the runner's verify path is identical
    // for the mock and real agents (mock fixtures verify with `test -f MOCK_SOLVED`).
    if (resolved) writeFileSync(join(ctx.workdir, 'MOCK_SOLVED'), 'ok\n', 'utf-8');

    return {
      // `correct` is computed by the runner from the verify command above.
      tokens: this.behavior.baseTokens + overheadTokens + Math.floor(draw * 1000),
      costUsd: null,
      turns: 1 + n,
      toolCalls: 2 + n,
      wellFormed: true,
      error: null,
      rawLog: resolved ? 'MOCK_RESOLVED' : 'MOCK_UNRESOLVED',
    };
  }
}

/** Stable hash of a string to [0,1). */
export function hash01(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Raw single-shot completion adapter (NON-AGENTIC baseline) with an optional
// gate-enforced execute->verify->fix loop. This isolates UAP *gate value*: the
// baseline arm writes code in ONE completion (no self-verification), while the
// gate arm loops against the visible in-repo test (task.gateCmd), feeding
// failures back until it passes or a cap is hit — exactly the convergence a
// bare model won't do on its own. Toggled by the 'gates' component, so the
// paired delta attributes any lift to the gate loop.
// ---------------------------------------------------------------------------

export interface RawAdapterConfig {
  /** OpenAI-compatible chat endpoint. Default ik-llama :8080. */
  endpoint?: string;
  /** Max execute->verify->fix iterations when gating. Default 4. */
  maxGateIters?: number;
  temperature?: number;
}

const FILE_MARKER_SYSTEM =
  'You are a precise coding assistant. You will be given a task and the current ' +
  'project files. Output the COMPLETE updated content of every file you change, ' +
  'each wrapped EXACTLY like this and nothing else around it:\n' +
  '<<<FILE relative/path.ext>>>\n<full file content>\n<<<END>>>\n' +
  'Do not add commentary outside the markers. Do not use markdown code fences.';

/** Parse <<<FILE path>>> ... <<<END>>> blocks from a model response. Pure. */
export function parseFileBlocks(text: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const re = /<<<FILE\s+(.+?)>>>\r?\n([\s\S]*?)\r?\n?<<<END>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1].trim();
    if (path) out.push({ path, content: m[2] });
  }
  return out;
}

/** Read repo files to show the model (skips noise + binaries). */
function readRepoFiles(workdir: string): { path: string; content: string }[] {
  const SKIP = new Set(['node_modules', '.git', 'dist', '.uap', 'agents']);
  const EXT_OK = /\.(js|ts|py|json|md|txt|cfg|toml|yaml|yml)$|^[^.]+$/;
  const files: { path: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.size <= 64 * 1024 && EXT_OK.test(name) && name !== 'package.json') {
        try {
          files.push({ path: relative(workdir, abs), content: readFileSync(abs, 'utf-8') });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(workdir);
  return files;
}

/** Write parsed file blocks into workdir, refusing path-escape. */
function applyFileBlocks(workdir: string, blocks: { path: string; content: string }[]): number {
  let written = 0;
  for (const b of blocks) {
    const dest = resolve(workdir, b.path);
    if (dest !== workdir && !dest.startsWith(workdir + '/')) continue; // no escape
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, b.content, 'utf-8');
    written++;
  }
  return written;
}

interface ChatResult {
  content: string;
  tokens: number;
  error: string | null;
}

async function chatCompletion(
  endpoint: string,
  model: string,
  messages: { role: string; content: string }[],
  temperature: number,
  timeoutMs: number
): Promise<ChatResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, max_tokens: 4096 }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { content: '', tokens: 0, error: `http ${res.status}` };
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      tokens: data.usage?.total_tokens ?? 0,
      error: null,
    };
  } catch (e) {
    return { content: '', tokens: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export class RawCompletionAdapter implements AgentAdapter {
  readonly id = 'raw';
  private readonly endpoint: string;
  private readonly maxGateIters: number;
  private readonly temperature: number;
  constructor(cfg: RawAdapterConfig = {}) {
    this.endpoint =
      cfg.endpoint ?? process.env.UAP_RAW_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions';
    this.maxGateIters = cfg.maxGateIters ?? Number(process.env.UAP_RAW_GATE_ITERS ?? 4);
    this.temperature = cfg.temperature ?? Number(process.env.UAP_RAW_TEMPERATURE ?? 0.2);
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const useGate = ctx.condition.components.has('gates') && Boolean(ctx.task.gateCmd);
    const files = readRepoFiles(ctx.workdir);
    const fileDump = files
      .map((f) => `<<<FILE ${f.path}>>>\n${f.content}\n<<<END>>>`)
      .join('\n\n');

    const messages: { role: string; content: string }[] = [
      { role: 'system', content: FILE_MARKER_SYSTEM },
      {
        role: 'user',
        content:
          `Task: ${ctx.task.instruction}\n\nCurrent files:\n\n${fileDump}\n\n` +
          'Output the full updated content of each file you change, using the FILE markers.',
      },
    ];

    let totalTokens = 0;
    let turns = 0;
    let gateRuns = 0;
    let error: string | null = null;
    const logParts: string[] = [];
    const maxIters = useGate ? this.maxGateIters : 1;

    for (let iter = 0; iter < maxIters; iter++) {
      const chat = await chatCompletion(
        this.endpoint,
        ctx.model,
        messages,
        this.temperature,
        ctx.task.agentTimeoutSec * 1000
      );
      turns++;
      totalTokens += chat.tokens;
      if (chat.error) {
        error = chat.error;
        break;
      }
      const blocks = parseFileBlocks(chat.content);
      applyFileBlocks(ctx.workdir, blocks);
      logParts.push(`--- turn ${turns}: ${blocks.length} file(s) ---`);

      if (!useGate) break;

      const gate = spawnSync('bash', ['-lc', ctx.task.gateCmd as string], {
        cwd: ctx.workdir,
        encoding: 'utf-8',
        timeout: ctx.task.verifyTimeoutSec * 1000,
        env: sanitizedEnv(),
      });
      gateRuns++;
      if (gate.status === 0) break;
      if (iter === maxIters - 1) break; // out of budget
      const gateOut = `${gate.stdout ?? ''}\n${gate.stderr ?? ''}`.slice(-2000);
      messages.push({ role: 'assistant', content: chat.content });
      messages.push({
        role: 'user',
        content:
          `The gate command \`${ctx.task.gateCmd}\` failed:\n${gateOut}\n\n` +
          'Fix the code and re-output the full updated files using the FILE markers.',
      });
    }

    return {
      tokens: totalTokens > 0 ? totalTokens : null,
      costUsd: null,
      turns,
      toolCalls: useGate ? gateRuns : 0,
      wellFormed: null,
      error,
      rawLog: logParts.join('\n'),
    };
  }
}
