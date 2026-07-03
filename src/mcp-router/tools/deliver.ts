/**
 * deliver - Meta-tool that routes a delivery/coding task into the Fable-parity
 * convergence loop (`uap deliver`).
 *
 * This is the auto-routing entry point: the agent hands a non-trivial coding
 * task here and the loop classifies its complexity, enables the matching
 * convergence aids (best-of-N exploration, critic, practices, escalation,
 * ideation, HALO, coordination), and drives an underlying model through
 * execute → apply → verify against the project's REAL gates (build, type-check,
 * tests) until delivery is achieved or the turn budget is spent.
 *
 * Rather than re-implement deliver's wiring, this shells out to the real
 * `uap deliver --json` so the complexity auto-optimization and every aid run
 * exactly as the CLI does — single source of truth.
 *
 * Design choices (vs. routing through execute_tool like expert tools):
 *  - First-class always-listed tool so agents can auto-route delivery work to
 *    it without a discovery round-trip. The marginal token cost is ~rounding
 *    error against the router's hidden-tool baseline.
 *  - deliver runs the target project's gate scripts (= arbitrary code), so the
 *    target dir is confined to a sandbox root (UAP_DELIVER_SANDBOX, else the
 *    router cwd); the child gets a curated env, not the router's full one; and
 *    the instruction is passed after `--` so it cannot smuggle CLI flags.
 *  - deliver enforces its own gate/test-protection internally and emits its own
 *    HALO spans (auto-enabled for complex tasks), so it is not double-wrapped
 *    in the router's PolicyGate.
 */

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, sep } from 'path';
import { existsSync, realpathSync, statSync } from 'fs';
import { isValidRunId } from '../../delivery/run-state.js';

export interface DeliverArgs {
  /** The delivery/coding task instruction */
  instruction: string;
  /** Project whose gates define delivery (default: cwd) */
  projectRoot?: string;
  /** Maximum execute→verify iterations (1-20) */
  maxTurns?: number;
  /** Model preset id (default: $UAP_DELIVER_MODEL) */
  model?: string;
  /** Only classify complexity + show the plan; do not call the model */
  dryRun?: boolean;
  /** Hard wall-clock cap in seconds (default 1800) */
  timeoutSec?: number;
  /** Judge spec behavioral completeness (LLM) after objective gates pass */
  acceptance?: boolean;
  /** Separate evaluator model preset (generator never grades its own work) */
  evaluatorModel?: string;
  /** Escalation ladder on stagnation (widen → critic → reseed → stronger model) */
  escalate?: boolean;
  /** Register/announce/heartbeat via the coordination layer */
  coordinate?: boolean;
  /** Loop past maxTurns to a ceiling until every gate passes (CLI default: on) */
  untilDelivered?: boolean;
  /** Hard turn ceiling for untilDelivered (1-50) */
  ceiling?: number;
  /** Resume an interrupted durable run: a run id or 'latest' */
  resume?: string;
  /** Decompose the mission into sequential phases (auto for long complex tasks) */
  decompose?: boolean;
}

export const DELIVER_TOOL_DEFINITION = {
  name: 'deliver',
  description: `Autonomously build-and-verify a non-trivial coding task using the convergence loop (uap deliver).

Route any substantive coding/delivery task here instead of editing by hand when you want it driven to VERIFIED completion: the loop classifies task complexity and automatically enables the right aids (best-of-N exploration, structured critic, learned practices, model escalation, divergent ideation), then iterates a model against the project's real gates (build, type-check, tests) until they pass. Pre-existing tests/specs are protected from modification.

Use dryRun:true first to see the complexity classification and plan (fast, no model calls). Then call without dryRun to actually deliver.

Best for: implement a feature, fix a bug across files, refactor with tests. Not for: trivial one-line edits, pure questions, or non-code docs.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      instruction: {
        type: 'string',
        description: 'The delivery/coding task, e.g. "implement a token-bucket rate limiter and wire it into the auth middleware with tests"',
      },
      projectRoot: {
        type: 'string',
        description: 'Project directory whose gates define delivery (default: current working directory)',
      },
      maxTurns: {
        type: 'number',
        description: 'Maximum execute→verify iterations, 1-20 (default: 5)',
      },
      model: {
        type: 'string',
        description: 'Model preset id (default: $UAP_DELIVER_MODEL or qwen35-a3b)',
      },
      dryRun: {
        type: 'boolean',
        description: 'If true, only classify complexity and show the plan (fast, no model calls). Default false.',
        default: false,
      },
      timeoutSec: {
        type: 'number',
        description: 'Hard wall-clock cap in seconds (default 1800)',
      },
      acceptance: {
        type: 'boolean',
        description: 'After objective gates pass, judge spec behavioral completeness (LLM) and iterate on unmet requirements (auto-on for moderate/complex tasks)',
      },
      evaluatorModel: {
        type: 'string',
        description: 'Model preset that AUTHORS + JUDGES acceptance, separate from the generator',
      },
      escalate: {
        type: 'boolean',
        description: 'Escalation ladder on stagnation: widen exploration → critic → reseed ideation → stronger model',
      },
      coordinate: {
        type: 'boolean',
        description: 'Register the run with the coordination layer (announce, heartbeat, overlap detection)',
      },
      untilDelivered: {
        type: 'boolean',
        description: 'Loop past maxTurns to a hard ceiling until every gate passes (default: on; false disables)',
      },
      ceiling: {
        type: 'number',
        description: 'Hard turn ceiling for untilDelivered, 1-50 (default 30)',
      },
      resume: {
        type: 'string',
        description: "Resume an interrupted durable run: a run id or 'latest'",
      },
      decompose: {
        type: 'boolean',
        description: 'Decompose the mission into sequential phases, each converged by its own loop (auto for long complex tasks; false disables)',
      },
    },
    required: ['instruction'],
  },
};

const MAX_TURNS_LIMIT = 20;
const DEFAULT_TIMEOUT_SEC = 1800;
const MAX_TIMEOUT_SEC = 3600;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * `uap deliver` runs the target project's gate scripts (npm build/test/…),
 * i.e. it executes arbitrary code in `projectRoot`. The MCP client must not be
 * able to point it at an arbitrary directory, so projectRoot is confined to a
 * sandbox root (UAP_DELIVER_SANDBOX, else the router's cwd). Returns the
 * resolved, contained real path, or an error string.
 */
function resolveSandboxedRoot(projectRoot?: string): { root: string } | { error: string } {
  let baseReal: string;
  try {
    baseReal = realpathSync(resolve(process.env.UAP_DELIVER_SANDBOX || process.cwd()));
  } catch {
    return { error: 'sandbox base directory is unavailable' };
  }
  if (!projectRoot) return { root: baseReal };
  let real: string;
  try {
    real = realpathSync(resolve(projectRoot));
  } catch {
    return { error: 'projectRoot does not exist' };
  }
  if (real !== baseReal && !real.startsWith(baseReal + sep)) {
    return { error: 'projectRoot is outside the allowed sandbox (set UAP_DELIVER_SANDBOX to widen)' };
  }
  try {
    if (!statSync(real).isDirectory()) return { error: 'projectRoot is not a directory' };
  } catch {
    return { error: 'projectRoot is not accessible' };
  }
  return { root: real };
}

/** Minimal env for the child: deliver needs model creds + PATH/HOME, not the
 * router's full environment (which the gate-running subprocess could leak). */
function buildChildEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const pass = (k: string): void => {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  };
  pass('PATH');
  pass('HOME');
  pass('NODE_OPTIONS');
  // Model/backend config deliver legitimately needs.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('UAP_') || k.startsWith('ANTHROPIC_')) out[k] = process.env[k];
  }
  return out;
}

/**
 * Extract the delivery JSON from CLI stdout. `uap deliver --json` prints the
 * pretty-printed result object LAST, but decorative progress precedes it and
 * may contain stray '{'. Scan candidate object starts (a line that is exactly
 * '{') from the end and return the first that parses to completion.
 */
export function extractLastJson(stdout: string): unknown {
  const lines = stdout.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    if (line.trim() === '{') starts.push(offset);
    offset += line.length + 1;
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(stdout.slice(starts[i]));
    } catch {
      /* try an earlier candidate */
    }
  }
  // Fallback: a single-line JSON object somewhere in the output.
  const m = stdout.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* give up */
    }
  }
  return undefined;
}

/** Resolve the compiled CLI entrypoint (dist/bin/cli.js). Works both from the
 * compiled module (dist/mcp-router/tools) and from source under vitest, by
 * also walking up to the package root and using its dist/bin/cli.js. */
function resolveCliEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', '..', 'bin', 'cli.js')];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'package.json'))) {
      candidates.push(resolve(dir, 'dist', 'bin', 'cli.js'));
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export interface DeliverResult {
  ok: boolean;
  dryRun: boolean;
  /** Parsed JSON from `uap deliver --json` (plan when dryRun, DeliveryResult otherwise) */
  result?: unknown;
  /** Non-zero CLI exit code, if delivery did not fully succeed */
  exitCode?: number;
  error?: string;
}

/**
 * Run `uap deliver <instruction> --json [flags]` and return the parsed result.
 * Validation mirrors the CLI; everything else (complexity auto-optimization,
 * aids, gates, test protection) is handled by deliver itself.
 */
export function handleDeliver(args: DeliverArgs): Promise<DeliverResult> {
  const {
    instruction, projectRoot, maxTurns, model, dryRun = false, timeoutSec,
    acceptance, evaluatorModel, escalate, coordinate, untilDelivered, ceiling,
    resume, decompose,
  } = args;

  if ((!instruction || !instruction.trim()) && !resume) {
    return Promise.resolve({ ok: false, dryRun, error: 'instruction is required (or pass resume)' });
  }
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS_LIMIT)) {
    return Promise.resolve({ ok: false, dryRun, error: `maxTurns must be an integer 1-${MAX_TURNS_LIMIT}` });
  }
  if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
    return Promise.resolve({ ok: false, dryRun, error: 'timeoutSec must be a positive finite number' });
  }
  if (model !== undefined && !/^[A-Za-z0-9._-]+$/.test(model)) {
    return Promise.resolve({ ok: false, dryRun, error: 'model must be a plain preset id' });
  }
  if (evaluatorModel !== undefined && !/^[A-Za-z0-9._-]+$/.test(evaluatorModel)) {
    return Promise.resolve({ ok: false, dryRun, error: 'evaluatorModel must be a plain preset id' });
  }
  if (ceiling !== undefined && (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 50)) {
    return Promise.resolve({ ok: false, dryRun, error: 'ceiling must be an integer 1-50' });
  }
  if (resume !== undefined && resume !== 'latest' && !isValidRunId(resume)) {
    return Promise.resolve({ ok: false, dryRun, error: 'resume must be a plain run id or latest' });
  }

  const sandbox = resolveSandboxedRoot(projectRoot);
  if ('error' in sandbox) {
    return Promise.resolve({ ok: false, dryRun, error: sandbox.error });
  }
  const root = sandbox.root;

  const cli = resolveCliEntry();
  if (!cli) {
    return Promise.resolve({ ok: false, dryRun, error: 'could not locate the uap CLI entrypoint' });
  }

  // Options FIRST, then `--`, then the (client-controlled) instruction as a
  // pure operand — so a leading-dash instruction can't smuggle flags like
  // --endpoint / --deploy / --no-protect-tests.
  const cliArgs = [cli, 'deliver', '--json'];
  if (dryRun) cliArgs.push('--dry-run');
  cliArgs.push('--project-root', root); // always explicit (confined above)
  if (maxTurns !== undefined) cliArgs.push('--max-turns', String(maxTurns));
  if (model) cliArgs.push('--model', model);
  if (acceptance) cliArgs.push('--acceptance');
  if (evaluatorModel) cliArgs.push('--evaluator-model', evaluatorModel);
  if (escalate) cliArgs.push('--escalate');
  if (coordinate) cliArgs.push('--coordinate');
  if (untilDelivered === false) cliArgs.push('--no-until-delivered');
  if (ceiling !== undefined) cliArgs.push('--ceiling', String(ceiling));
  if (resume) cliArgs.push('--resume', resume);
  if (decompose === true) cliArgs.push('--decompose');
  if (decompose === false) cliArgs.push('--no-decompose');
  cliArgs.push('--', instruction ?? '');

  const timeoutMs = Math.min(MAX_TIMEOUT_SEC, Math.max(1, timeoutSec ?? DEFAULT_TIMEOUT_SEC)) * 1000;

  return new Promise<DeliverResult>((resolvePromise) => {
    execFile(
      process.execPath,
      cliArgs,
      { cwd: root, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: buildChildEnv() },
      (err, stdout) => {
        // deliver prints the JSON result to stdout even on a non-zero exit
        // (exit 1 = "not delivered after N turns"); parse it regardless.
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        const exitCode = e && typeof e.code === 'number' ? e.code : 0;
        const parsed = extractLastJson(stdout);

        if (e && e.killed) {
          const why = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? `deliver output exceeded ${MAX_OUTPUT_BYTES} bytes`
            : `deliver timed out after ${timeoutMs / 1000}s`;
          resolvePromise({ ok: false, dryRun, error: why, result: parsed });
          return;
        }
        if (parsed === undefined) {
          resolvePromise({ ok: false, dryRun, exitCode, error: 'could not parse deliver output', result: stdout.slice(-2000) });
          return;
        }
        // Prefer the payload's own success signal over the exit code so a
        // future CLI exit-code change can't silently flip the semantics.
        const r = parsed as { success?: boolean; alreadyDelivered?: boolean };
        const ok = typeof r.success === 'boolean' ? r.success || r.alreadyDelivered === true : exitCode === 0;
        resolvePromise({ ok, dryRun, exitCode, result: parsed });
      }
    );
  });
}

/** Rough token estimate for the tool definition (router stats). */
export function estimateDeliverToolTokens(): number {
  return Math.ceil(JSON.stringify(DELIVER_TOOL_DEFINITION).length / 4);
}
