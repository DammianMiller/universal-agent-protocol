/**
 * Trivial-mission guard — deliver refuses to be a tax on small direct edits.
 *
 * Observed live (cognition-engine, 2026-08-21): the mission "fix: remove
 * duplicate `mod build_serialized_batch_tests` block at line 640 in
 * src/rust-pg-ext/src/pgwire/mod.rs" — a one-line deletion — ran through the
 * convergence loop twice: 196 agent rounds, turns scoring 40%→20%, 50 minutes,
 * and the duplicate was still there. A weak local executor spends its budget
 * re-reading the file; the agent that launched it could have made the edit
 * in one tool call. Under the `escalate` delivery posture direct edits are
 * ALLOWED, so handing deliver a task like this is the wrong tool, not a
 * sanctioned route.
 *
 * The guard is deliberately narrow: it only fires when the project declares
 * `escalate`, the mission text reads as a small single-file edit (short, a
 * trivial verb, no complexity words, at most one file named), and there is no
 * escalation evidence (two consecutive red gates) saying direct edits are not
 * working. `--force` / `force:true` always overrides. Anything ambiguous runs.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface TrivialVerdict {
  trivial: boolean;
  reason: string;
  files: string[];
}

export interface TrivialGuardDecision {
  refuse: boolean;
  message: string;
  verdict: TrivialVerdict;
  posture: 'escalate' | 'gated';
  failures: number;
}

const TRIVIAL_RE =
  /\b(remove|delete|drop|rename|typo|duplicated?|unused (?:import|variable|var)|missing (?:semicolon|comma|import|bracket|brace|paren(?:thesis)?)|one-?liner?|single-?line|line \d+|comment out|uncomment|off-by-one|bump (?:the )?version)\b/i;
// Any breadth signal ("every call site", "throughout", "and then ...", "tests")
// disqualifies: a weak model that honours a refusal would otherwise attempt a
// crate-wide rename by hand.
const COMPLEX_RE =
  /\b(implement|feature|refactor|rewrite|module|endpoint|migration|across|multiple|architecture|integrat(?:e|ion)|wire up|design|new (?:file|module|crate|package|component|service|command)|tests?|end-to-end|pipeline|algorithm|schema|api|parser|engine|system|all|every|everywhere|each|codebase|call ?sites?|callers|usages?|throughout|then|ci|readme|release)\b/i;
const FILE_RE = /[\w./-]+\.(?:rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sql|sh|toml|yaml|yml|json|md)\b/g;
const MAX_TRIVIAL_CHARS = 240;

/** Pure text classification — no filesystem. */
export function classifyTrivialMission(instruction: string): TrivialVerdict {
  const text = (instruction ?? '').trim();
  const files = [...new Set(text.match(FILE_RE) ?? [])];
  if (!text) return { trivial: false, reason: 'empty instruction', files };
  if (text.length > MAX_TRIVIAL_CHARS) return { trivial: false, reason: `long brief (${text.length} chars)`, files };
  if (files.length > 1) return { trivial: false, reason: `names ${files.length} files`, files };
  const complex = text.match(COMPLEX_RE);
  if (complex) return { trivial: false, reason: `mentions "${complex[0]}"`, files };
  const trivial = text.match(TRIVIAL_RE);
  if (!trivial) return { trivial: false, reason: 'no small-edit signal', files };
  return { trivial: true, reason: `short single-file edit ("${trivial[0]}")`, files };
}

/**
 * The MAIN checkout for a project root that may be a worktree. Every writer of
 * the escalation evidence (tracker, enforcer, deliver's own reset) anchors on
 * the main checkout, and the policy gate reads `.uap.json` there too.
 */
export function mainRootOf(projectRoot: string): string {
  return projectRoot.split('/.worktrees/')[0];
}

/** The project's declared delivery posture (config-authoritative, like the gate).
 *  A local-model session can also reach escalate via UAP_DELIVER_LOCAL_MODE; that
 *  only makes the guard under-fire, which is the safe direction. */
export function deliveryPostureOf(projectRoot: string): 'escalate' | 'gated' {
  try {
    const cfg = JSON.parse(readFileSync(join(mainRootOf(projectRoot), '.uap.json'), 'utf8')) as {
      delivery?: { enforcement?: string; localMode?: string; escalateAfterFailures?: number };
    };
    const d = cfg.delivery ?? {};
    const enforcement = String(d.enforcement ?? process.env.UAP_ENFORCE_DELIVERY ?? 'block').toLowerCase();
    if (enforcement === 'escalate' || String(d.localMode ?? '').toLowerCase() === 'escalate') return 'escalate';
  } catch {
    /* no config: gated default */
  }
  return 'gated';
}

function failureBudget(projectRoot: string): number {
  try {
    const cfg = JSON.parse(readFileSync(join(mainRootOf(projectRoot), '.uap.json'), 'utf8')) as {
      delivery?: { escalateAfterFailures?: number };
    };
    const v = cfg.delivery?.escalateAfterFailures;
    if (typeof v === 'number' && v >= 0) return v;
  } catch {
    /* default */
  }
  return 2;
}

/** Consecutive red gates recorded by the escalation tracker (0 when absent/stale). */
export function readEscalationFailures(projectRoot: string): number {
  const p = join(mainRootOf(projectRoot), '.uap', 'escalation-state.json');
  if (!existsSync(p)) return 0;
  try {
    const st = JSON.parse(readFileSync(p, 'utf8')) as { failures?: number; last_failure?: { ts?: number } | null };
    const ts = st.last_failure?.ts ?? 0;
    const ttl = Number(process.env.UAP_DELIVER_ESCALATION_TTL_SEC ?? 21600);
    if (ttl > 0 && ts && Math.floor(Date.now() / 1000) - ts > ttl) return 0;
    return Number(st.failures ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function shouldRefuseTrivialMission(
  projectRoot: string,
  instruction: string,
  opts: { force?: boolean } = {}
): TrivialGuardDecision {
  const verdict = classifyTrivialMission(instruction);
  const posture = deliveryPostureOf(projectRoot);
  const failures = readEscalationFailures(projectRoot);
  const budget = failureBudget(projectRoot);
  const evidence = budget > 0 && failures >= budget;
  const envOff = /^(0|off|false|no)$/i.test(String(process.env.UAP_DELIVER_TRIVIAL_GUARD ?? ''));
  const refuse = posture === 'escalate' && verdict.trivial && !opts.force && !evidence && !envOff;
  const target = verdict.files[0] ? `'${verdict.files[0]}'` : 'the file';
  const message = refuse
    ? `NOT RUN (by design): deliver is the ESCALATION point in this project (delivery posture: escalate), ` +
      `and this mission reads as a small direct edit — ${verdict.reason}. Make the change yourself: ` +
      `open ${target} with your edit tool, apply it, then run the project's own build/test command. ` +
      `Do NOT call deliver again for this; it becomes the right tool only after two consecutive red gates ` +
      `on your direct edits, or pass force:true / --force if this genuinely needs the convergence loop.`
    : '';
  return { refuse, message, verdict, posture, failures };
}
