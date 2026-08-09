/**
 * Tool-call outcome taxonomy (harness plan area D2, 2026-07-31).
 *
 * The Agentic-Harness-Engineering result (arXiv 2604.25850) turns on a single
 * capability we did not have: every tool call is attributed to a harness
 * COMPONENT and a stable FAILURE CLASS, so the evolve stage can rank "which part
 * of the harness is bleeding turns" instead of guessing. Their measured gains
 * concentrate in tools (+3.3pp), middleware (+2.2pp) and memory (+5.6pp) — and
 * system-prompt-only edits scored NEGATIVE (-2.3pp), which is exactly the search
 * direction a system without attribution drifts into.
 *
 * The executor's tool results are strings by design (they go straight back to the
 * model), so classification is textual. That is deliberate: the classifier reads
 * the same bytes the model reads, so a class can never claim a failure mode the
 * model was not actually shown.
 */

/**
 * Stable outcome classes. Stable is the point — these strings are GROUP BY keys
 * in the evidence corpus, so renaming one silently splits its history.
 */
export type ToolOutcomeClass =
  /** Call succeeded with no caveat. */
  | 'ok'
  /**
   * The call was accepted but changed NOTHING — a write or edit whose result
   * already matched the file. Neither a success nor a failure: the tool did
   * exactly what it was told, and the turn made no progress. It gets its own
   * class because folding it into `ok` is what the no-op guards exist to stop —
   * the corpus would report edit tooling as healthy precisely while a run is
   * spinning on repeated no-op edits.
   */
  | 'no-op'
  /** Succeeded, but only via the whitespace-tolerant edit rung (anchor drift). */
  | 'ok-tolerant'
  /** `old_string` matched nothing. The dominant edit-tool failure. */
  | 'edit-miss'
  /** Matched several places, or an out-of-range occurrence selector. */
  | 'edit-ambiguous'
  /** A line range that does not exist in the file. */
  | 'range-invalid'
  /** Target file/dir does not exist. */
  | 'path-not-found'
  /** Path escaped the project root. */
  | 'path-escape'
  /** Refused: protected test/contract/gate-config/agent-internal path. */
  | 'protected-path'
  /** Refused by the stub-substance guard (would hollow the file out). */
  | 'stub-refusal'
  /** Write rejected as truncated mid-file. */
  | 'truncated-write'
  /** `run_bash` returned a non-zero exit code. */
  | 'command-failed'
  /** Call exceeded its time budget. */
  | 'timeout'
  /** Model asked for a tool that does not exist. */
  | 'unknown-tool'
  /** The tool refused to run at all (e.g. run_bash disabled outside a sandbox). */
  | 'refused'
  /** A command mutated protected files and the harness restored them. */
  | 'tamper-restored'
  /** An error we have not given a name to yet. */
  | 'other-error';

/** The harness component a tool call exercises. Mirrors the AHE ablation axes. */
export type HarnessComponent = 'tools' | 'middleware' | 'memory' | 'prompt' | 'execution';

/** Outcome classes that represent a wasted or degraded turn. */
const FAILURE_CLASSES: ReadonlySet<ToolOutcomeClass> = new Set<ToolOutcomeClass>([
  'refused',
  'tamper-restored',
  'edit-miss',
  'edit-ambiguous',
  'range-invalid',
  'path-not-found',
  'path-escape',
  'protected-path',
  'stub-refusal',
  'truncated-write',
  'command-failed',
  'timeout',
  'unknown-tool',
  'other-error',
]);

export function isFailureClass(c: ToolOutcomeClass): boolean {
  return FAILURE_CLASSES.has(c);
}

/**
 * Classify one tool result string.
 *
 * Ordering matters: the specific edit classes are tested before the generic
 * "not found", because an `old_string not found` message also contains the word
 * "not found" and would otherwise be miscounted as a missing FILE — which would
 * point the evolve stage at path handling instead of at the edit tool.
 */
export function classifyToolResult(tool: string, result: string): ToolOutcomeClass {
  const text = String(result ?? '');
  const lower = text.toLowerCase();

  if (lower.includes('unknown tool')) return 'unknown-tool';

  // run_bash NEVER starts with 'error:' — it returns `exit=<code> ...`, or a
  // refusal when the shell is disabled. Classifying it by prefix filed every
  // failed command as a success, left 'command-failed' unreachable, and made the
  // execution component look permanently healthy to the evolve stage.
  if (tool === 'run_bash') {
    if (lower.startsWith('run_bash is disabled') || lower.includes('is disabled')) return 'refused';
    // A command that mutated protected files and was rolled back is a tamper
    // event, and matters more than its exit code.
    if (lower.includes('restored') && lower.includes('protected')) return 'tamper-restored';
    if (lower.includes('timed out')) return 'timeout';
    const exit = /(?:^|\s)exit=(-?\d+)/.exec(text);
    if (exit) return exit[1] === '0' ? 'ok' : 'command-failed';
    return lower.startsWith('error:') ? 'other-error' : 'ok';
  }

  if (!lower.startsWith('error:')) {
    // Checked BEFORE the tolerant note: a no-op reached through the tolerant
    // rung still changed nothing, and "no progress" is the more important fact.
    if (lower.startsWith('no-op:')) return 'no-op';
    // Success paths. The tolerant-match note is a success WITH a signal: the
    // model's anchors are drifting, which predicts future misses.
    if (lower.includes('did not match byte-for-byte')) return 'ok-tolerant';
    return 'ok';
  }

  // The agent-internal refusal is a protection, not a generic error.
  if (lower.includes('agent') && lower.includes('internal')) return 'protected-path';
  if (lower.includes('deliverable and tells you nothing')) return 'protected-path';

  if (lower.includes('old_string not found')) return 'edit-miss';
  if (lower.includes('old_string matches') || lower.includes('occurrence')) return 'edit-ambiguous';
  if (lower.includes('start_line') || lower.includes('end_line')) return 'range-invalid';
  if (lower.includes('escapes project root')) return 'path-escape';
  if (
    lower.includes('protected test') ||
    lower.includes('locked contract') ||
    lower.includes('refusing to modify') ||
    lower.includes('change the implementation, not the gate')
  ) {
    return 'protected-path';
  }
  if (lower.includes('stub') || lower.includes('skeleton')) return 'stub-refusal';
  if (lower.includes('truncated')) return 'truncated-write';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
  if (lower.includes('not found') || lower.includes('does not exist')) return 'path-not-found';
  return 'other-error';
}

/**
 * Map a tool name to the harness component it exercises, so failures roll up to
 * the same axes the AHE ablation measured.
 */
export function componentForTool(tool: string): HarnessComponent {
  switch (tool) {
    case 'edit_file':
    case 'edit_range':
    case 'write_file':
    case 'read_file':
    case 'list_dir':
    case 'finish':
      return 'tools';
    case 'run_bash':
      return 'execution';
    default:
      return tool.startsWith('memory') ? 'memory' : 'tools';
  }
}
