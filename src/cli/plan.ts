/**
 * `uap plan` — validate + record plan validation for the validate-plan-on-change
 * gate. `uap plan validate` is the recorded counterpart of the `validate the
 * plan` prompt: it now performs a REAL pre-execution review (the ATG
 * thought-experiment applied to a plan artifact) before stamping
 * `.uap/plan_state.json`, instead of stamping unconditionally:
 *
 *   uap plan validate [file]  # review the plan artifact, then record validation
 *   uap plan status           # show last validation + whether it's still fresh
 *
 * Review flow: resolve the plan artifact (explicit file, else the most
 * recently modified plan-like .md), run an evaluator-model review over its
 * text (`reviewPlanText`), and REFUSE the stamp on a FAIL verdict (exit 1)
 * with the concrete findings — so "validate the plan" means an independent
 * judge actually validated it, not that a timestamp was written.
 *
 * Knobs (CLI: `--no-review`, `--force`; env equivalents for hook/CI use):
 *   UAP_PLAN_REVIEW=0        skip the model review (stamp-only legacy behavior)
 *   UAP_PLAN_REVIEW_FORCE=1  stamp even on a failed verdict (justify in the PR)
 *   UAP_PLAN_REVIEW_MODEL    reviewer model preset (default: $UAP_DELIVER_MODEL
 *                            or qwen35-a3b)
 *
 * Availability is FAIL-OPEN: no plan artifact, unknown preset, or unreachable
 * endpoint stamps with a note — the plan gate must never deadlock offline.
 * A completed review that returns "fail" is the only thing that blocks.
 */
import { createHash } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import type { LoopExecutor } from '../delivery/convergence-loop.js';
import { reviewPlanText, type PlanReviewVerdict } from '../delivery/plan-check.js';

export interface PlanOptions {
  json?: boolean;
  /** Explicit plan artifact to review (positional arg after `validate`). */
  file?: string;
  /** Set false to skip the model review (env UAP_PLAN_REVIEW=0 does the same). */
  review?: boolean;
  /** Stamp even when the review verdict is fail (env UAP_PLAN_REVIEW_FORCE=1). */
  force?: boolean;
}

/** Injectable seams so tests exercise the flow without a model or argv. */
export interface PlanDeps {
  reviewExecutor?: LoopExecutor;
  argv?: string[];
}

export interface PlanReviewOutcome {
  status: 'pass' | 'fail' | 'skipped';
  file?: string;
  findings: string[];
  reason?: string;
}

function stateDir(cwd: string): string {
  return join(cwd, process.env.UAP_STATE_DIR || '.uap');
}
function statePath(cwd: string): string {
  return join(stateDir(cwd), 'plan_state.json');
}
function windowSec(): number {
  const w = parseInt(process.env.UAP_PLAN_VALIDATE_WINDOW || '300', 10);
  return Number.isFinite(w) ? w : 300;
}

/**
 * Shared state with the enforcer (validate_plan_on_change.py). The contract:
 *
 *   pending   { <repo-relative plan path>: <epoch seen> }  written by the
 *             enforcer when a plan artifact is created or modified; cleared
 *             here once that plan has actually been validated.
 *   validated { <repo-relative plan path>: <sha256 of the reviewed bytes> }
 *
 * Keying on CONTENT is the point. The old gate keyed on a 300s timestamp and
 * fired on the plan WRITE, which meant the agent was told to validate a plan
 * before it existed: `uap plan validate` found no artifact (or an older one),
 * stamped anyway, and every write for the next five minutes sailed through
 * unread — with nothing gating the build at all. A hash says "these exact bytes
 * were reviewed", so editing the plan afterwards re-arms the gate.
 */
export interface PlanState {
  validated_at?: number;
  review?: PlanReviewOutcome;
  pending?: Record<string, number>;
  validated?: Record<string, string>;
}

/** Path key shared with the enforcer: repo-relative, forward slashes. */
export function planKey(cwd: string, file: string): string {
  return relative(resolve(cwd), resolve(cwd, file)).split(sep).join('/');
}

export function planHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function readState(cwd: string): PlanState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(cwd), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as PlanState) : {};
  } catch {
    return {};
  }
}

/**
 * Plans the enforcer recorded as touched but which have not been validated
 * since, plus plans that were validated and have since DRIFTED on disk.
 * Anything listed here is what the build gate is waiting on.
 */
export function outstandingPlans(cwd: string): { pending: string[]; drifted: string[] } {
  const st = readState(cwd);
  const pending = Object.keys(st.pending ?? {}).sort();
  const drifted: string[] = [];
  for (const [key, hash] of Object.entries(st.validated ?? {})) {
    let text: string;
    try {
      text = readFileSync(join(cwd, key), 'utf-8');
    } catch {
      continue; // deleted or unreadable — nothing left to gate on
    }
    if (planHash(text) !== hash) drifted.push(key);
  }
  return { pending, drifted: drifted.sort() };
}

/** Mirror of the enforcer's plan-artifact test (validate_plan_on_change.py). */
const PLAN_STEM_RE = /(^|[-_. ])plans?([-_. ]|$)/i;
function isPlanFile(name: string): boolean {
  if (!name.toLowerCase().endsWith('.md')) return false;
  return PLAN_STEM_RE.test(name.slice(0, -3));
}

/** Most recently modified plan-like artifact: plans/ dirs first, then cwd. */
export function findPlanArtifact(cwd: string): string | null {
  const candidates: Array<{ path: string; mtime: number }> = [];
  const scan = (dir: string, requirePlanName: boolean): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        if (requirePlanName ? isPlanFile(name) : name.toLowerCase().endsWith('.md')) {
          candidates.push({ path: p, mtime: st.mtimeMs });
        }
      } catch {
        // unreadable entry — skip
      }
    }
  };
  scan(join(cwd, 'plans'), false);
  scan(join(cwd, 'docs', 'plans'), false);
  scan(cwd, true);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

/** Test seam only: pull the positional file from an injected argv (the real
 * CLI registration passes the `[file]` argument through options.file). */
function argvPlanFile(argv: string[]): string | undefined {
  const at = argv.indexOf('validate');
  if (at === -1) return undefined;
  for (const tok of argv.slice(at + 1)) {
    if (!tok.startsWith('-')) return tok;
  }
  return undefined;
}

/**
 * An EXPLICIT file must still look like a plan artifact and live under the
 * project: the review ships file content to a model endpoint, so `uap plan
 * validate <arbitrary path>` must not become a quiet read-anything channel.
 */
function explicitFileProblem(file: string, cwd: string): string | null {
  if (!file.toLowerCase().endsWith('.md')) return 'explicit plan file must be a .md artifact';
  const abs = resolve(cwd, file);
  if (abs !== resolve(cwd) && !abs.startsWith(resolve(cwd) + sep)) {
    return 'explicit plan file must live under the project directory';
  }
  return null;
}

/** Build the reviewer executor the way `uap verify --acceptance` does. */
async function buildReviewExecutor(): Promise<LoopExecutor> {
  const { OpenAICompatClient } = await import('../models/openai-compat-client.js');
  const { ModelPresets } = await import('../models/types.js');
  const presetId =
    process.env.UAP_PLAN_REVIEW_MODEL ?? process.env.UAP_DELIVER_MODEL ?? 'qwen35-a3b';
  const model = ModelPresets[presetId];
  if (!model) {
    throw new Error(`unknown model preset '${presetId}'`);
  }
  // Privacy signal (same as verify.ts): the review ships plan text to the
  // model endpoint — a NON-LOCAL target must be a conscious choice.
  const ep = model.endpoint ?? process.env.UAP_INFERENCE_ENDPOINT ?? '';
  if (ep && !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(ep)) {
    process.stderr.write(`uap plan: review will send the plan text to a NON-LOCAL endpoint (${ep}).\n`);
  }
  const client = new OpenAICompatClient();
  return async (prompt: string) => {
    const r = await client.complete(model, prompt, { temperature: 0, jsonResponse: true });
    return r.content;
  };
}

async function runPlanReview(
  cwd: string,
  explicitFile: string | undefined,
  deps: PlanDeps
): Promise<PlanReviewOutcome> {
  if (explicitFile) {
    const problem = explicitFileProblem(explicitFile, cwd);
    if (problem) return { status: 'skipped', file: explicitFile, findings: [], reason: problem };
  }
  const file = explicitFile ?? findPlanArtifact(cwd) ?? undefined;
  if (!file) {
    return { status: 'skipped', findings: [], reason: 'no plan artifact found' };
  }
  let text = '';
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return { status: 'skipped', file, findings: [], reason: `could not read ${file}` };
  }
  if (!text.trim()) {
    return { status: 'skipped', file, findings: [], reason: 'plan artifact is empty' };
  }
  let executor: LoopExecutor;
  try {
    executor = deps.reviewExecutor ?? (await buildReviewExecutor());
  } catch (err) {
    return {
      status: 'skipped',
      file,
      findings: [],
      reason: `reviewer unavailable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  // reviewPlanText fail-softs model errors to PASS (right for the advisory
  // decompose path, wrong here: a stamp claiming "an independent judge
  // validated this" must not be fabricated by an unreachable endpoint or an
  // empty completion). Detect those and record SKIPPED instead.
  let unavailable: string | null = null;
  const observed: LoopExecutor = async (prompt) => {
    let out: string;
    try {
      out = await executor(prompt);
    } catch (err) {
      unavailable = err instanceof Error ? err.message : String(err);
      throw err;
    }
    if (!out || !out.trim()) unavailable = 'reviewer returned an empty completion';
    return out;
  };
  const verdict: PlanReviewVerdict = await reviewPlanText(text, observed);
  if (unavailable) {
    return { status: 'skipped', file, findings: [], reason: `reviewer unavailable (${unavailable})` };
  }
  return { status: verdict.verdict, file, findings: verdict.findings };
}

export async function planCommand(
  action: string | undefined,
  options: PlanOptions = {},
  cwd: string = process.cwd(),
  deps: PlanDeps = {}
): Promise<void> {
  if (action === 'validate') {
    const reviewWanted = (options.review ?? true) && process.env.UAP_PLAN_REVIEW !== '0';
    const force = options.force === true || process.env.UAP_PLAN_REVIEW_FORCE === '1';
    const explicitFile = options.file ?? (deps.argv ? argvPlanFile(deps.argv) : undefined);
    const review = reviewWanted
      ? await runPlanReview(cwd, explicitFile, deps)
      : ({ status: 'skipped', findings: [], reason: 'review disabled' } as PlanReviewOutcome);

    if (review.status === 'fail' && !force) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, review }));
      } else {
        console.log(`✗ Plan review FAILED — validation NOT recorded (${review.file}).`);
        review.findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
        console.log('  Fix the plan and re-run `uap plan validate` (or UAP_PLAN_REVIEW_FORCE=1 with justification).');
      }
      process.exitCode = 1;
      return;
    }

    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    const prev = readState(cwd);
    const now = Math.floor(Date.now() / 1000);
    const pending = { ...(prev.pending ?? {}) };
    const validated = { ...(prev.validated ?? {}) };

    // Record the hash of what was ACTUALLY reviewed, and clear that plan from
    // the pending set. Only the reviewed plan is cleared: validating one plan
    // must not silently vouch for another the agent also touched.
    // Which plan this validation vouches for. `review.file` is absent whenever
    // the review did not resolve one — most importantly when the review was
    // DISABLED (UAP_PLAN_REVIEW=0 / --no-review), which returns a bare
    // {status:'skipped'}. Keying only off review.file meant `uap plan validate
    // PLAN.md` reported success, recorded nothing, and left the build blocked
    // on the very file the operator had just named. Fall back to the explicit
    // argument, then to the artifact the review would have picked.
    const stamped = review.file ?? explicitFile ?? findPlanArtifact(cwd) ?? undefined;
    if (stamped) {
      const key = planKey(cwd, stamped);
      try {
        validated[key] = planHash(readFileSync(resolve(cwd, stamped), 'utf-8'));
        delete pending[key];
      } catch {
        // Unreadable at stamp time — leave it pending rather than record a
        // hash we cannot stand behind.
      }
    }
    writeFileSync(
      statePath(cwd),
      JSON.stringify({ ...prev, validated_at: now, review, pending, validated }, null, 2)
    );
    if (options.json) {
      console.log(JSON.stringify({ ok: true, validated_at: now, review }));
      return;
    }
    if (review.status === 'pass') {
      console.log(`✓ Plan review PASSED (${review.file}) — validation recorded.`);
    } else if (review.status === 'fail') {
      console.log(`⚠ Plan review FAILED but stamped under force (${review.file}):`);
      review.findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    } else {
      console.log(`✓ Plan validation recorded (review skipped: ${review.reason}).`);
    }
    const left = outstandingPlans(cwd);
    const remaining = [...left.pending, ...left.drifted];
    if (remaining.length) {
      console.log(`  Still awaiting validation before a build can run: ${remaining.join(', ')}`);
    } else {
      console.log('  All touched plans are validated — builds are unblocked until a plan changes.');
    }
    return;
  }

  // status (default)
  const st = readState(cwd);
  const validatedAt = Number(st.validated_at) || 0;
  const ageSec = validatedAt ? Math.floor(Date.now() / 1000) - validatedAt : null;
  const { pending, drifted } = outstandingPlans(cwd);
  // What the gate actually keys on now — not the age of the last stamp.
  const blocked = pending.length > 0 || drifted.length > 0;
  if (options.json) {
    console.log(
      JSON.stringify({
        validated_at: validatedAt || null,
        ageSec,
        blocked,
        pending,
        drifted,
        review: st.review ?? null,
      })
    );
    return;
  }
  if (!blocked) {
    console.log(
      validatedAt
        ? `Plan validation: OK — no plan is awaiting validation (last validated ${ageSec}s ago).`
        : 'Plan validation: nothing pending. Creating or editing a plan will require `validate the plan` before a build.'
    );
    if (st.review?.status) {
      console.log(`  Last review: ${st.review.status}${st.review.file ? ` (${st.review.file})` : ''}`);
    }
    return;
  }
  console.log('Plan validation: BLOCKING — a build cannot run until these are validated:');
  pending.forEach((p) => console.log(`  • ${p} (created/modified, never validated)`));
  drifted.forEach((p) => console.log(`  • ${p} (changed since it was validated)`));
  console.log('  Run the `validate the plan` prompt, then `uap plan validate <file>`.');
}

export { statePath as planStatePath, windowSec as planWindowSec };
