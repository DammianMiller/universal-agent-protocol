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
import { FOLLOW_CLIENT_POLL_SEC } from '../../delivery/await-run.js';
import { isValidRunId } from '../../delivery/run-state.js';

export interface DeliverArgs {
  /** The delivery/coding task. Required to LAUNCH; omit for follow/resume. */
  instruction?: string;
  /** Project whose gates define delivery (default: cwd) */
  projectRoot?: string;
  /** Maximum execute→verify iterations (1-20). ADVISORY unless hardCap is true. */
  maxTurns?: number;
  /**
   * Only when true are maxTurns/ceiling forwarded to the CLI, where an
   * explicit --max-turns is a HARD cap (v1.124.0). LLM clients dutifully copy
   * the schema's example numbers, and a 20-turn hard cap on a platform-scale
   * mission guarantees a premature stop (observed live 2026-07-09) — so by
   * default the CLI runs flagless: epics + until-delivered self-manage turns.
   */
  hardCap?: boolean;
  /** Model preset id (default: $UAP_DELIVER_MODEL) */
  model?: string;
  /** Only classify complexity + show the plan; do not call the model */
  dryRun?: boolean;
  /** Hard wall-clock cap in seconds (default 1800) */
  timeoutSec?: number;
  /**
   * Follow the run already in flight for this project instead of starting one.
   * Use this after a timed-out deliver call, or whenever a launch reports
   * alreadyRunning. Read-only: it starts nothing and takes no lock.
   */
  follow?: boolean;
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

Long missions: runs are DURABLE and DETACHED — the mission outlives this tool call. If the call times out mid-mission the run is still going: call again with follow:true to wait for it and get its result. Do NOT use resume for that — resume CONTINUES a run and, on one that is still live, starts a second copy of it. Use resume only to pick up a run that has actually stopped. Leave maxTurns/ceiling unset (epics + until-delivered self-manage turns); pass a larger timeoutSec for platform-scale work.

Best for: implement a feature, fix a bug across files, refactor with tests. Not for: trivial one-line edits, pure questions, or non-code docs.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      instruction: {
        type: 'string',
        // Stated on the property because this is where a model looks before
        // filling one in; repeating a long brief on every poll is the cost.

        description: 'The delivery/coding task, e.g. "implement a token-bucket rate limiter and wire it into the auth middleware with tests"',
      },
      projectRoot: {
        type: 'string',
        description: 'Project directory whose gates define delivery (default: current working directory)',
      },
      maxTurns: {
        type: 'number',
        description:
          'LEAVE UNSET for real missions — deliver self-manages turns until delivered (epics + until-delivered). Ignored unless hardCap is true, in which case it becomes a HARD stop, 1-20.',
      },
      hardCap: {
        type: 'boolean',
        description:
          'Set true ONLY to force a hard turn budget (maxTurns/ceiling become hard stops). Default false: turn limits are self-managed and maxTurns/ceiling are ignored.',
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
      follow: {
        type: 'boolean',
        description:
          'Wait for the deliver run already in flight and return its result, instead of starting a new one. ' +
          'This is the correct response to a timed-out deliver call or an alreadyRunning result — it starts ' +
          'nothing, and needs NO instruction — omit it, do not restate the mission. ' +
          'It returns within about a minute either way and SUCCEEDS (ok:true) whatever it finds: if the ' +
          'mission is still going you get "STILL RUNNING" in `note`, which is NOT a failure — call follow ' +
          'again. Do not take that on trust: `result.progress.health` reports "starting", "active" or ' +
          '"wedged", DERIVED from how recently the run stamped its heartbeat, and ' +
          '`result.progress.heartbeatAgeSec` / `.phase` are the numbers behind it — compare them across ' +
          'polls to watch the run move. (This used to assert the run was HEALTHY unconditionally, which ' +
          'nothing had checked; three identical replies then read as a hung process and the run got ' +
          'killed.) It does not mean the tool is stuck: ' +
          'do not kill the deliver ' +
          'process, do not change any enforcement setting, do not start a second run. Prefer this over ' +
          'sleeping in a shell. Do not use resume for this: resume CONTINUES a run and would start a second ' +
          'copy of a live one.',
      },
      timeoutSec: {
        // Documented here because the parameter is overloaded and a model that
        // raises it expecting a longer FOLLOW gets a longer launch instead.

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
        description:
          'Hard turn ceiling for untilDelivered, 1-50. Ignored unless hardCap is true — leave unset for real missions.',
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
    // `required` is OMITTED, not empty. follow and resume are valid calls without
    // an instruction, and a client that enforces `required` would reject them
    // before the handler could apply the real rule (see handleDeliver). An empty
    // array says the same thing but is rejected outright by OpenAPI 3.0 schema
    // converters and draft-04 validators, which would drop the whole tool.
  },
};

const MAX_TURNS_LIMIT = 20;
const DEFAULT_TIMEOUT_SEC = 1800;
// Platform-scale epic missions legitimately run for hours; runs are durable
// (resume:'latest' picks up where a timeout cut off), so the cap is a
// watchdog against a hung child, not a mission budget.
const MAX_TIMEOUT_SEC = 14400;
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
  /**
   * Informational message for a call that SUCCEEDED but has something to say —
   * "the mission is still running", "nothing was in flight".
   *
   * Deliberately not `error`: ok:false plus an error string reads as a broken
   * tool, and a caller told its tool is broken starts killing processes and
   * reaching for override switches rather than simply waiting.
   */
  note?: string;
}

/**
 * Run `uap deliver <instruction> --json [flags]` and return the parsed result.
 * Validation mirrors the CLI; everything else (complexity auto-optimization,
 * aids, gates, test protection) is handled by deliver itself.
 */
/**
 * Build the argv for the deliver CLI. Extracted so the flag decisions are
 * testable directly.
 *
 * They were not: `follow`'s budget is the difference between a wait that returns
 * an answer and one the client kills, and the only test that touched it passed an
 * explicit timeoutSec — so it exercised the branch that was NOT the default and
 * asserted nothing about the flag either way.
 */
export function buildDeliverCliArgs(
  cli: string,
  root: string,
  a: DeliverArgs
): string[] {
  const cliArgs = [cli, 'deliver', '--json'];
  if (a.dryRun) cliArgs.push('--dry-run');
  cliArgs.push('--project-root', root); // always explicit (confined above)
  // Turn caps are forwarded ONLY under an explicit hardCap: the CLI treats
  // --max-turns/--ceiling as hard stops, and LLM clients copy small example
  // numbers into every call — which killed platform-scale missions at turn 20.
  // Flagless, deliver's epics + until-delivered machinery self-manages turns.
  if (a.hardCap === true && a.maxTurns !== undefined) cliArgs.push('--max-turns', String(a.maxTurns));
  if (a.model) cliArgs.push('--model', a.model);
  if (a.acceptance) cliArgs.push('--acceptance');
  if (a.evaluatorModel) cliArgs.push('--evaluator-model', a.evaluatorModel);
  if (a.escalate) cliArgs.push('--escalate');
  if (a.coordinate) cliArgs.push('--coordinate');
  if (a.untilDelivered === false) cliArgs.push('--no-until-delivered');
  if (a.hardCap === true && a.ceiling !== undefined) cliArgs.push('--ceiling', String(a.ceiling));
  if (a.follow) {
    cliArgs.push('--await-run');
    // ALWAYS explicit, and always short. This is the only layer that knows the
    // caller is a client with a request timeout (~60s), so it is the layer that
    // must size the wait — leaving it to the CLI default capped every terminal
    // and CI caller instead, which is the wrong trade.
    //
    // Clamped even when the caller names a bigger a.timeoutSec. That parameter is
    // overloaded: it is the LAUNCH kill-timeout, whose description advertises
    // 1800 and whose sibling text invites "a larger timeoutSec for platform-scale
    // work". A model following that advice with follow:true would ask for a
    // 1620s wait and re-create the original incident verbatim — no answer, and an
    // orphaned process. Blocking longer than the client will wait is never what
    // the caller wants; calling a.follow again is.
    const followSec = Math.min(
      FOLLOW_CLIENT_POLL_SEC,
      a.timeoutSec !== undefined ? Math.max(1, Math.floor(a.timeoutSec) - 1) : FOLLOW_CLIENT_POLL_SEC
    );
    cliArgs.push('--await-timeout', String(Math.max(1, followSec)));
  }
  if (a.resume) cliArgs.push('--resume', a.resume);
  if (a.decompose === true) cliArgs.push('--decompose');
  if (a.decompose === false) cliArgs.push('--no-decompose');
  cliArgs.push('--', a.instruction ?? '');
  return cliArgs;
}

export function handleDeliver(args: DeliverArgs): Promise<DeliverResult> {
  // Only what the VALIDATION and the subprocess call still need — the flag
  // decisions moved into buildDeliverCliArgs.
  const {
    instruction, projectRoot, maxTurns, model, dryRun = false, timeoutSec,
    evaluatorModel, ceiling, resume, follow = false,
  } = args;

  // follow and resume both identify an EXISTING run — follow by the project's
  // lock, resume by run id — so neither needs the mission text.
  //
  // This is not a nicety. With a short poll budget a caller follows repeatedly,
  // and requiring the instruction made every poll re-send the entire mission
  // brief: observed live at ~2 KB a call, which over a long mission is tens of
  // KB of a 130 K context spent restating something the harness already has.
  if ((!instruction || !instruction.trim()) && !resume && !follow) {
    return Promise.resolve({
      ok: false,
      dryRun,
      error: 'instruction is required (or pass resume to continue a stopped run, or follow to watch a running one)',
    });
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
  const cliArgs = buildDeliverCliArgs(cli, root, args);

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
          // Reaching here means the CLI exited without honouring --json. That is
          // a bug in the CLI rather than anything the caller did, so the message
          // must not read like a mission failure the caller should retry —
          // retrying is what turned one such gap into a launch loop.
          resolvePromise({
            ok: false,
            dryRun,
            exitCode,
            error:
              'deliver produced no JSON result (its --json contract was not honoured on this exit path). ' +
              'Do NOT relaunch blindly: call deliver with follow:true to see whether a run is already in progress and wait for it.',
            result: stdout.slice(-2000),
          });
          return;
        }
        // Prefer the payload's own success signal over the exit code so a
        // future CLI exit-code change can't silently flip the semantics.
        const r = parsed as {
          success?: boolean;
          alreadyDelivered?: boolean;
          alreadyRunning?: boolean;
          holderPid?: string;
          nextStep?: string;
        };
        // A duplicate launch is NOT a failure of the mission — the mission is
        // running. Saying only `ok:false` invites the caller to retry, which is
        // what produced the observed loop: timeout -> relaunch -> duplicate ->
        // retry. Carry the reason and the one correct next move in `error`,
        // because that is the field a tool caller reads first.
        if (r.alreadyRunning === true) {
          resolvePromise({
            ok: false,
            dryRun,
            exitCode,
            error:
              `a deliver run is already in progress for this project` +
              `${r.holderPid ? ` (pid ${r.holderPid})` : ''} — this duplicate launch was skipped. ` +
              (r.nextStep ??
                'Wait for the in-flight run to finish; do not start another and do not pass resume.'),
            result: parsed,
          });
          return;
        }
        // Preflight refusals need the same treatment: without this they resolve
        // with NO `error` at all, leaving the actionable text buried in
        // `result.blockers` — in a shape whose own contract says `error` is what
        // a caller reads first.
        // Follow outcomes: timedOut / nothingInFlight / holderChanged all resolve
        // success:false, so without this they fall through with NO `error` and the
        // carefully-worded "it has NOT failed, do not relaunch" text stays buried
        // in `result` — the exact gap fixed twice above for alreadyRunning and
        // preflightFailed.
        const fo = parsed as {
          timedOut?: boolean;
          nothingInFlight?: boolean;
          holderChanged?: boolean;
          followed?: boolean;
          delivered?: boolean;
          reason?: string;
          nextStep?: string;
        };
        // A poll that ANSWERS is a successful tool call, whatever the answer.
        //
        // These three used to resolve ok:false with a populated `error`, and that
        // combination reads as a broken tool no matter how carefully the prose
        // says otherwise. Observed live (opencode, 2026-07-31): follow returned
        // "the deliver run (pid X) is STILL RUNNING — it has not failed", the
        // model saw ok:false + error and concluded "The deliver tool is stuck",
        // the proxy's ERROR-LOOP guard fired on the repeated failure signature,
        // and the model escalated to `kill -9` on its own mission and then tried
        // to switch off the self-protect enforcer.
        //
        // The mission was healthy the entire time. The guidance now travels in
        // `note`, which is read but does not mean failure; `error` is reserved for
        // "this call did not work".
        if (fo.timedOut === true || fo.nothingInFlight === true || fo.holderChanged === true) {
          resolvePromise({
            ok: true,
            dryRun,
            exitCode,
            note: `${fo.reason ?? 'follow returned'} ${fo.nextStep ?? ''}`.trim(),
            result: parsed,
          });
          return;
        }
        // The MISSION ending badly IS a real negative, and stays ok:false — the
        // caller has to know its work did not land. `followed` alone is not that
        // signal: it is true for a run that failed.
        if (fo.followed === true && fo.delivered === false) {
          resolvePromise({
            ok: false,
            dryRun,
            exitCode,
            error: `${fo.reason ?? 'the followed run did not succeed'} ${fo.nextStep ?? ''}`.trim(),
            result: parsed,
          });
          return;
        }
        const pf = parsed as { preflightFailed?: boolean; blockers?: unknown; nextStep?: string };
        if (pf.preflightFailed === true) {
          const blockers = Array.isArray(pf.blockers) ? pf.blockers.map(String) : [];
          resolvePromise({
            ok: false,
            dryRun,
            exitCode,
            error:
              'this project cannot deliver until its setup is fixed: ' +
              (blockers.join(' | ').slice(0, 600) || 'see result.blockers') +
              '. Re-running unchanged will fail the same way.',
            result: parsed,
          });
          return;
        }
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
