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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
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
  /** Audit trail of pending entries dropped as unreachable (most recent last). */
  cleared?: Array<{ key: string; reason: string; at: number }>;
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

/**
 * Why a pending entry can never be cleared by `uap plan validate`, or null when
 * it is perfectly clearable.
 *
 * These two cases are wedges, not gates. `validate` refuses any file outside the
 * project (see `explicitFileProblem`) and cannot review a file that is not
 * there, so an entry in either state blocks every build with a remedy that
 * declines to run. Observed live: a memory note at
 * `~/.claude/projects/<slug>/memory/plan_gate_before_build.md` — matched only
 * because its name contains "plan" — blocked the repo until the state file was
 * edited by hand.
 */
export function unclearableReason(cwd: string, key: string): string | null {
  if (!isInsideProject(cwd, key)) {
    return 'outside the project directory — `uap plan validate` refuses it';
  }
  const abs = resolve(cwd, key);
  if (!existsSync(abs)) return 'file no longer exists — nothing left to review';
  // "Exists" is not the same as "reviewable". `validate` reads the file and
  // leaves the entry pending when that throws, so a directory named `*-plan.md`
  // or a file the user cannot read is the same permanent wedge with a different
  // cause — and would otherwise be listed as merely "awaiting validation",
  // sending the operator back into the loop this command exists to break.
  try {
    if (!statSync(abs).isFile()) return 'not a regular file — validation cannot read it';
    readFileSync(abs, 'utf-8');
  } catch {
    return 'unreadable — validation cannot review it';
  }
  return null;
}

/**
 * Containment test that resolves symlinks.
 *
 * `path.resolve` is purely lexical, so `docs/plans/x.md -> ~/.ssh/id_rsa` reads
 * as "inside the project" and the reviewer would ship that file's contents to a
 * model endpoint. The enforcer's own check uses `os.path.realpath`; matching it
 * here also keeps the two sides of the contract from disagreeing about the same
 * key. Falls back to the lexical answer for paths that do not exist yet.
 */
export function isInsideProject(cwd: string, key: string): boolean {
  const root = realpathIfPossible(resolve(cwd));
  const abs = realpathIfPossible(resolve(cwd, key));
  return abs === root || abs.startsWith(root + sep);
}

function realpathIfPossible(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Pending entries split into ones validation can clear and ones it cannot. */
export function classifyPending(cwd: string): {
  clearable: string[];
  unclearable: Array<{ key: string; reason: string }>;
} {
  const clearable: string[] = [];
  const unclearable: Array<{ key: string; reason: string }> = [];
  for (const key of outstandingPlans(cwd).pending) {
    const reason = unclearableReason(cwd, key);
    if (reason) unclearable.push({ key, reason });
    else clearable.push(key);
  }
  return { clearable, unclearable };
}

/**
 * Drop pending entries. With no `file`, drops only the UNCLEARABLE ones — the
 * supported recovery from a wedged gate, and deliberately not a way to skip
 * review of a plan that is sitting right there awaiting it.
 */
export function clearPending(
  cwd: string,
  file?: string
): { dropped: string[]; refused: Array<{ key: string; reason: string }> } {
  // ONE snapshot for both the decision and the write. Reading twice let a plan
  // recorded by the enforcer between the reads be erased by the write-back —
  // a freshly written plan silently ungated, reachable by racing a plan write
  // against this command.
  const st = readState(cwd);
  const pendingKeys = Object.keys(st.pending ?? {});
  const pending: Record<string, number> = Object.create(null);
  for (const k of pendingKeys) pending[k] = (st.pending ?? {})[k];

  const dropped: string[] = [];
  const refused: Array<{ key: string; reason: string }> = [];
  const reasons = new Map<string, string>();
  for (const k of pendingKeys) {
    const r = unclearableReason(cwd, k);
    if (r) reasons.set(k, r);
  }

  if (file) {
    // Match by RESOLVED PATH, not by key string. The enforcer stores an
    // out-of-project entry as the absolute path it saw, while `planKey` would
    // render the same file as `../../…` — so copy-pasting the key that `status`
    // just printed found nothing and reported "nothing to clear", contradicting
    // the line above it.
    const wanted = resolve(cwd, file);
    const key = pendingKeys.find((k) => resolve(cwd, k) === wanted);
    if (!key) return { dropped: [], refused: [] };
    const reason = reasons.get(key);
    if (!reason) {
      // A real, reviewable plan. Dropping it here would turn the recovery hatch
      // into "skip the gate", which is the one thing it must not be.
      refused.push({ key, reason: 'reviewable — run `uap plan validate` instead' });
    } else {
      delete pending[key];
      dropped.push(key);
    }
  } else {
    for (const key of pendingKeys) {
      if (!reasons.has(key)) continue;
      delete pending[key];
      dropped.push(key);
    }
  }

  if (dropped.length > 0) {
    mkdirSync(stateDir(cwd), { recursive: true });
    // Audit what was dropped and why. A gate whose blocking set can shrink
    // without a trace is not auditable, and "the plan was moved" is exactly the
    // case a reviewer needs to be able to see after the fact.
    const cleared = [
      ...(st.cleared ?? []),
      ...dropped.map((key) => ({
        key,
        reason: reasons.get(key) ?? 'unreachable',
        at: Math.floor(Date.now() / 1000),
      })),
    ].slice(-50);
    writeStateAtomic(cwd, { ...st, pending: { ...pending }, cleared });
  }
  return { dropped, refused };
}

/**
 * Write via temp file + rename. `writeFileSync` truncates first, so a crash
 * mid-write leaves a partial file — and both readers swallow a parse error into
 * `{}`, which silently disarms the entire gate.
 */
function writeStateAtomic(cwd: string, state: PlanState): void {
  const target = statePath(cwd);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
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

function argvClearFile(argv: string[]): string | undefined {
  const at = argv.indexOf('clear');
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
  // Symlink-resolving: a lexical check let `docs/plans/x.md -> ~/.ssh/id_rsa`
  // pass, and the review ships the file's contents to a model endpoint.
  if (!isInsideProject(cwd, file)) {
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
      // Name the ones validation can never satisfy, and the way out. Without
      // this the operator re-runs `validate` forever against an entry it refuses
      // by design, and the only exit is hand-editing state.
      const stuck = classifyPending(cwd).unclearable;
      if (stuck.length) {
        console.log('  Of those, these can NEVER be cleared by validation:');
        stuck.forEach((s) => console.log(`    • ${s.key} — ${s.reason}`));
        console.log('  Drop them: `uap plan clear`');
      }
    } else {
      console.log('  All touched plans are validated — builds are unblocked until a plan changes.');
    }
    return;
  }

  if (action === 'clear') {
    const file = options.file ?? (deps.argv ? argvClearFile(deps.argv) : undefined);
    const { dropped, refused } = clearPending(cwd, file);
    if (options.json) {
      console.log(JSON.stringify({ ok: refused.length === 0, dropped, refused }));
      return;
    }
    if (dropped.length === 0 && refused.length === 0) {
      console.log('Nothing to clear: no pending plan entry is unreachable.');
      console.log('  (`clear` drops only entries validation cannot satisfy — a reviewable plan');
      console.log('   still needs `uap plan validate`.)');
      return;
    }
    dropped.forEach((k) => console.log(`✓ dropped unreachable pending entry: ${k}`));
    refused.forEach((r) => console.log(`✗ refused ${r.key} — ${r.reason}`));
    if (refused.length > 0) process.exitCode = 1;
    return;
  }

  // status (default)
  const st = readState(cwd);
  const validatedAt = Number(st.validated_at) || 0;
  const ageSec = validatedAt ? Math.floor(Date.now() / 1000) - validatedAt : null;
  const { pending, drifted } = outstandingPlans(cwd);
  const { unclearable } = classifyPending(cwd);
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
        unclearable,
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
  const stuckKeys = new Set(unclearable.map((u) => u.key));
  pending
    .filter((p) => !stuckKeys.has(p))
    .forEach((p) => console.log(`  • ${p} (created/modified, never validated)`));
  drifted.forEach((p) => console.log(`  • ${p} (changed since it was validated)`));
  console.log('  Run the `validate the plan` prompt, then `uap plan validate <file>`.');
  if (unclearable.length) {
    // Separated deliberately. These are not awaiting review — validation refuses
    // them — so listing them alongside real work sends the operator into a loop
    // of re-running a command that declines the file.
    console.log('');
    console.log('  UNREACHABLE — validation can never clear these:');
    unclearable.forEach((u) => console.log(`    • ${u.key} — ${u.reason}`));
    console.log('  Drop them: `uap plan clear`');
  }
}

export { statePath as planStatePath, windowSec as planWindowSec };
