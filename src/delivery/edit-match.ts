/**
 * Edit-tool matching (harness plan area A, 2026-07-31).
 *
 * WHY this file exists: the harness-disclosure literature reports that changing
 * ONLY the edit-tool format moved a fixed model from 6.7% to 68.3% on SWE-bench
 * (Pi Research / Grok Code Fast, cited in arXiv 2605.23950). The same paper
 * measures harness variance at 7.8x model variance. The edit tool is the single
 * highest-leverage surface in the tool layer, and ours was strict-exact-match:
 * one whitespace character off and the turn was dead, with an error message that
 * told the model to "match exactly" — which is precisely the thing it had just
 * failed to do.
 *
 * The strategy ladder implemented here:
 *
 *   1. EXACT      — byte-identical substring. Unchanged, always tried first, so
 *                   a model that gets it right sees identical behaviour.
 *   2. TOLERANT   — line-aligned match after per-line whitespace normalisation
 *                   (leading/trailing trimmed, internal runs collapsed). Catches
 *                   the dominant real miss: right code, wrong indentation.
 *   3. NEAREST    — no match at all, so instead of "not found" we return the
 *                   closest region of the file with line numbers, turning a dead
 *                   turn into a corrective one.
 *
 * Everything here is PURE (string in, decision out) so the ladder is unit
 * testable without a model, a file system, or a delivery run.
 */

/** How a needle was located in the haystack. */
export type EditMatchKind =
  /** Byte-identical substring found (possibly several — see `count`). */
  | 'exact'
  /** Found only after per-line whitespace normalisation. */
  | 'tolerant'
  /** Found more than once and the caller gave no disambiguator. */
  | 'ambiguous'
  /** Not found by any strategy. */
  | 'miss';

export interface EditMatch {
  kind: EditMatchKind;
  /** Character offset of the matched span. -1 when `kind` is 'miss'/'ambiguous'. */
  index: number;
  /** Length of the matched span in characters. 0 when there is no span. */
  length: number;
  /** How many candidate matches the winning strategy found. */
  count: number;
  /**
   * Operator/model-facing explanation. For 'tolerant' this names the whitespace
   * drift so the model learns; for 'miss' it carries the nearest-match report.
   */
  note?: string;
  /**
   * Leading whitespace of the FILE line the tolerant span starts on, and of the
   * needle's first line. `applyEditMatch` re-indents the replacement by their
   * delta: without it a tolerant match splices the model's (wrong) indentation
   * in at the target site, which is cosmetic in C-like languages and a syntax
   * error in Python.
   */
  targetIndent?: string;
  needleIndent?: string;
  /**
   * True when the matched span excludes the trailing newline (the tolerant rung
   * is line-aligned). `applyEditMatch` strips one trailing newline from the
   * replacement so the exact and tolerant rungs cannot produce different line
   * counts for the same (old, new) pair.
   */
  lineAligned?: boolean;
}

export interface EditMatchOptions {
  /** 1-based occurrence selector, as the `edit_file` tool exposes it. */
  occurrence?: number | null;
  /**
   * Allow the whitespace-tolerant rung. Defaults to true. This is a harness
   * KNOB, deliberately: `ToolMod` in the self-harness search space flips it so
   * the paired bench can measure whether tolerance helps or hurts, rather than
   * us asserting that it helps.
   */
  tolerant?: boolean;
  /** Include the nearest-match report on a miss. Defaults to true. */
  diagnostics?: boolean;
  /**
   * Treat leading whitespace as significant (Python/YAML/Make/...). Callers pass
   * `isIndentSensitive(path)`. Defaults to false.
   */
  indentSensitive?: boolean;
}

/**
 * Normalise ONE line for tolerant comparison: collapse internal whitespace runs
 * and drop trailing whitespace. Leading whitespace is dropped only when the file
 * is not indentation-sensitive.
 *
 * `preserveIndent` exists because INDENTATION IS SEMANTIC in Python, YAML,
 * Makefiles and Nim. Without it,
 *
 *     if x:          if x:
 *         a()            a()
 *     b()                b()
 *
 * normalise identically, and a tolerant match binds an anchor in one block to
 * the other — a silent wrong-block edit on a default-on path. For those files we
 * keep the indent exact and only forgive internal/trailing spacing.
 *
 * Deliberately NOT normalising anything else. Case, punctuation and quote style
 * are all semantic in code — a match that ignored them would apply an edit the
 * model did not ask for, which is far worse than a failed edit.
 */
function normalizeLine(line: string, preserveIndent = false): string {
  // Split indent from body FIRST. Collapsing the whole line would squash the
  // leading run to a single space too, so 4-space and 8-space indents would
  // normalise identically and `preserveIndent` would preserve nothing.
  const indent = indentOf(line);
  const body = line.slice(indent.length).replace(/\s+/g, ' ').trimEnd();
  return preserveIndent ? indent + body : body;
}

/** Leading-whitespace prefix of a line. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * Extensions whose semantics depend on leading whitespace. A tolerant match in
 * one of these must not forgive indentation.
 */
const INDENT_SENSITIVE = /\.(py|pyi|yaml|yml|nim|coffee|haml|slim|sass|pug|jade)$|(^|\/)Makefile$/i;

export function isIndentSensitive(path: string): boolean {
  return INDENT_SENSITIVE.test(path);
}

/** Character offset at which each line starts, plus a terminating sentinel. */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/**
 * Token-overlap similarity in [0,1] between two normalised lines. Used only to
 * RANK candidates for the nearest-match report — never to decide an edit.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const at = a.split(' ').filter(Boolean);
  const bt = b.split(' ').filter(Boolean);
  if (at.length === 0 || bt.length === 0) return 0;
  const bCounts = new Map<string, number>();
  for (const t of bt) bCounts.set(t, (bCounts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of at) {
    const n = bCounts.get(t) ?? 0;
    if (n > 0) {
      shared++;
      bCounts.set(t, n - 1);
    }
  }
  return (2 * shared) / (at.length + bt.length);
}

/**
 * Find every line-window in `haystack` whose whitespace-normalised form equals
 * the normalised `needle`. Returns character spans.
 *
 * Line-aligned by construction: a needle that starts or ends mid-line simply
 * finds nothing here and falls through to the miss rung. That is the safe
 * direction — a mid-line tolerant match would have to guess where the span ends.
 */
function tolerantSpans(
  haystack: string,
  needle: string,
  preserveIndent: boolean,
): Array<{ index: number; length: number; indent: string }> {
  const needleLines = needle.split('\n');
  // A needle with a trailing newline yields an empty final element; dropping it
  // lets "block plus newline" match the same lines as "block".
  if (needleLines.length > 1 && needleLines[needleLines.length - 1] === '') needleLines.pop();
  const wanted = needleLines.map((l) => normalizeLine(l, preserveIndent));
  if (wanted.length === 0 || wanted.every((l) => l === '')) return [];

  const hayLines = haystack.split('\n');
  const offsets = lineOffsets(haystack);
  const spans: Array<{ index: number; length: number; indent: string }> = [];

  for (let start = 0; start + wanted.length <= hayLines.length; start++) {
    let ok = true;
    for (let k = 0; k < wanted.length; k++) {
      if (normalizeLine(hayLines[start + k], preserveIndent) !== wanted[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const index = offsets[start];
    const lastLine = start + wanted.length - 1;
    // End of the span = end of the last matched line, newline NOT included, so
    // the replacement cannot swallow the line break that follows it.
    const end = offsets[lastLine] + hayLines[lastLine].length;
    spans.push({ index, length: end - index, indent: indentOf(hayLines[start]) });
  }
  return spans;
}

/**
 * Build the nearest-match report shown when nothing matched.
 *
 * The model's failure is almost always "my memory of the file is stale", so the
 * single most useful thing we can hand back is the CURRENT text of the region it
 * was aiming at, with line numbers it can feed straight into `edit_range`.
 */
export function nearestMatchReport(haystack: string, needle: string, maxLines = 8): string {
  const needleLines = needle
    .split('\n')
    .map((l) => normalizeLine(l))
    .filter((l) => l !== '');
  if (needleLines.length === 0) return '';
  const hayLines = haystack.split('\n');
  const anchor = needleLines[0];

  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < hayLines.length; i++) {
    const score = similarity(anchor, normalizeLine(hayLines[i]));
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  // Below this the "nearest" line is noise and quoting it would mislead.
  if (bestLine < 0 || bestScore < 0.34) return '';

  const from = Math.max(0, bestLine - 2);
  // Bounded by maxLines, NOT by the needle length: this text goes straight back
  // into the model's context, and a 200-line old_string must not echo 200 lines.
  const to = Math.min(hayLines.length - 1, bestLine + Math.max(1, maxLines - 2));
  const excerpt = hayLines
    .slice(from, to + 1)
    .map((l, i) => `${String(from + i + 1).padStart(5)}| ${l}`)
    .join('\n');
  return (
    `Nearest region in the CURRENT file (lines ${from + 1}-${to + 1}, ` +
    `best anchor line ${bestLine + 1}):\n${excerpt}\n` +
    `Copy the exact text above, or use edit_range with start_line/end_line.`
  );
}

/**
 * Locate `oldStr` in `current` using the exact -> tolerant -> miss ladder.
 *
 * Contract: a returned 'exact' or 'tolerant' match is safe to apply verbatim by
 * slicing at [index, index+length). 'ambiguous' and 'miss' carry a `note` that
 * is already model-facing prose.
 */
export function resolveEditMatch(
  current: string,
  oldStr: string,
  options: EditMatchOptions = {},
): EditMatch {
  const {
    occurrence = null,
    tolerant = true,
    diagnostics = true,
    indentSensitive = false,
  } = options;

  // --- Rung 1: exact -------------------------------------------------------
  const exactCount = oldStr.length === 0 ? 0 : current.split(oldStr).length - 1;
  if (exactCount > 0) {
    if (exactCount > 1 && occurrence == null) {
      return {
        kind: 'ambiguous',
        index: -1,
        length: 0,
        count: exactCount,
        note: `old_string matches ${exactCount} times — add surrounding context or pass occurrence (1-based).`,
      };
    }
    const which = occurrence ?? 1;
    if (!Number.isInteger(which) || which < 1 || which > exactCount) {
      return {
        kind: 'ambiguous',
        index: -1,
        length: 0,
        count: exactCount,
        note: `occurrence ${String(occurrence)} out of range (1..${exactCount}).`,
      };
    }
    let idx = -1;
    for (let i = 0; i < which; i++) idx = current.indexOf(oldStr, idx + 1);
    return { kind: 'exact', index: idx, length: oldStr.length, count: exactCount };
  }

  // --- Rung 2: whitespace-tolerant ----------------------------------------
  if (tolerant) {
    const spans = tolerantSpans(current, oldStr, indentSensitive);
    if (spans.length > 0) {
      // UNIQUENESS IS REQUIRED here, and `occurrence` is deliberately NOT used to
      // disambiguate. The model chose its occurrence index against what it
      // believed the EXACT matches were; the normalised candidate list has
      // different membership and ordering, so honouring it would silently land
      // the edit at an unrelated site and still report success.
      if (spans.length > 1) {
        return {
          kind: 'ambiguous',
          index: -1,
          length: 0,
          count: spans.length,
          note:
            `old_string did not match exactly, and matches ${spans.length} places once whitespace ` +
            `is normalised — that is too ambiguous to guess at. Re-read the file and copy the exact ` +
            `text, or use edit_range with explicit line numbers.`,
        };
      }
      const span = spans[0];
      const needleFirst = oldStr.split('\n')[0] ?? '';
      return {
        kind: 'tolerant',
        index: span.index,
        length: span.length,
        count: 1,
        targetIndent: span.indent,
        needleIndent: indentOf(needleFirst),
        lineAligned: true,
        note:
          'old_string did not match byte-for-byte; matched after normalising whitespace. ' +
          'The edit was applied — re-read the file before the next edit so your anchors are current.',
      };
    }
  }

  // --- Rung 3: miss, with diagnostics -------------------------------------
  const report = diagnostics ? nearestMatchReport(current, oldStr) : '';
  return {
    kind: 'miss',
    index: -1,
    length: 0,
    count: 0,
    note: report
      ? `old_string not found.\n${report}`
      : 'old_string not found — re-read the file and match the CURRENT content.',
  };
}

/**
 * Apply a resolved match. Caller must have checked `kind` is exact/tolerant.
 *
 * Two corrections happen only on the line-aligned (tolerant) path, because only
 * there does the matched span differ in shape from what the model sent:
 *
 *  - RE-INDENT. The span starts at column 0 of the matched line while the needle
 *    may have been unindented, so splicing verbatim would move the code to
 *    column 0. We rebase the replacement onto the target's indentation.
 *  - TRAILING NEWLINE. The span excludes the line break that follows it, so a
 *    `new_string` ending in "\n" would add a blank line — making the same
 *    (old, new) pair produce different files depending on which rung fired.
 */
export function applyEditMatch(current: string, match: EditMatch, newStr: string): string {
  let replacement = newStr;
  if (match.lineAligned) {
    if (replacement.endsWith('\n')) replacement = replacement.slice(0, -1);
    const target = match.targetIndent ?? '';
    const needle = match.needleIndent ?? '';
    if (target !== needle) {
      replacement = replacement
        .split('\n')
        .map((line, i) => {
          // Blank lines stay blank — indenting them just adds trailing whitespace.
          if (line.trim() === '') return line;
          const stripped = needle && line.startsWith(needle) ? line.slice(needle.length) : line;
          // The first line is always rebased; later lines keep their relative
          // indentation, which stripping the common needle prefix preserves.
          return i === 0 ? target + stripped.trimStart() : target + stripped;
        })
        .join('\n');
    }
  }
  return current.slice(0, match.index) + replacement + current.slice(match.index + match.length);
}

export interface RangeEditResult {
  ok: boolean;
  /** Updated text when ok. */
  text?: string;
  /** Model-facing reason when not ok. */
  error?: string;
  /** Number of lines the range covered, for the success note. */
  replacedLines?: number;
}

/**
 * Replace an inclusive 1-based LINE RANGE.
 *
 * Why this exists alongside `edit_file`: a model that cannot reproduce exact
 * whitespace can still count lines, and `read_file` hands it numbered context.
 * This gives the ladder a rung that does not depend on reproducing file bytes at
 * all — the failure mode the tolerant rung only softens.
 */
export function applyRangeEdit(
  current: string,
  startLine: number,
  endLine: number,
  newText: string,
): RangeEditResult {
  const lines = current.split('\n');
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return { ok: false, error: 'start_line and end_line must be integers (1-based, inclusive).' };
  }
  if (startLine < 1 || endLine < startLine) {
    return { ok: false, error: `invalid range ${startLine}..${endLine} (need 1 <= start_line <= end_line).` };
  }
  if (endLine > lines.length) {
    return {
      ok: false,
      error: `end_line ${endLine} is past the end of the file (${lines.length} lines) — re-read it.`,
    };
  }
  // A trailing newline on new_text would inject a blank line, because the join
  // below re-adds the separator. Strip exactly one.
  const replacement = newText.endsWith('\n') ? newText.slice(0, -1) : newText;
  const updated = [
    ...lines.slice(0, startLine - 1),
    ...replacement.split('\n'),
    ...lines.slice(endLine),
  ].join('\n');
  return { ok: true, text: updated, replacedLines: endLine - startLine + 1 };
}
