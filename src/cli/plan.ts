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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
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

function readState(cwd: string): { validated_at?: number; review?: PlanReviewOutcome } {
  try {
    return JSON.parse(readFileSync(statePath(cwd), 'utf-8'));
  } catch {
    return {};
  }
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
    writeFileSync(statePath(cwd), JSON.stringify({ ...prev, validated_at: now, review }, null, 2));
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
    console.log(
      `  Plan-file writes are unblocked for ${windowSec()}s — re-run \`uap plan validate\` after that or after a substantive plan change.`
    );
    return;
  }

  // status (default)
  const st = readState(cwd);
  const validatedAt = Number(st.validated_at) || 0;
  const ageSec = validatedAt ? Math.floor(Date.now() / 1000) - validatedAt : null;
  const fresh = ageSec !== null && ageSec <= windowSec();
  if (options.json) {
    console.log(
      JSON.stringify({ validated_at: validatedAt || null, ageSec, fresh, window: windowSec(), review: st.review ?? null })
    );
    return;
  }
  if (!validatedAt) {
    console.log('Plan validation: never recorded. A plan-file write will require `validate the plan` + `uap plan validate`.');
    return;
  }
  console.log(`Plan validation: ${fresh ? 'FRESH' : 'STALE'} — last validated ${ageSec}s ago (window ${windowSec()}s).`);
  if (st.review?.status) {
    console.log(`  Last review: ${st.review.status}${st.review.file ? ` (${st.review.file})` : ''}`);
  }
  if (!fresh) console.log('  Re-run the `validate the plan` prompt, then `uap plan validate`, before editing a plan.');
}

export { statePath as planStatePath, windowSec as planWindowSec };
