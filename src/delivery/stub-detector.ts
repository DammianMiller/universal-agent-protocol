/**
 * Refuse a write whose content is a STUB rather than an implementation.
 *
 * The existing P3 anti-gutting guard (agentic-executor) compares BYTE SIZES and
 * only fires when the target already exists. That leaves the failure actually
 * observed wide open: a weak model writing brand-new files as stubs. From a real
 * run (octopus_invaders_v3, 2026-07-30) — SEVEN modules written straight to disk
 * as skeletons, then re-read by the model and used as the house style for more of
 * them. A first write has nothing to shrink from, and a stub→stub rewrite is no
 * shrink, so neither tripped the size guard. Nor do the run gates catch it: a
 * stub LOADS cleanly, which is exactly why execution-gate.ts documents the
 * "frozen game" class it could not detect.
 *
 * WHY EMPTY BODIES, NOT THE WORD "STUB"
 * The header said "— Stub" in every one of those files, which is trivially
 * greppable — and equally trivially omitted by the next model. The durable
 * signal is semantic: a module that declares a full API surface and implements
 * none of it.
 *
 * WHAT COUNTS AS A CALLABLE (and why this is not one regex)
 * The ratio is only meaningful if the denominator is right, and the first cut of
 * this file got it wrong in three ways that review caught, each of which biased
 * toward refusing REAL code:
 *
 *  - `if (…) {`, `while (…) {`, `catch (e) {` all match "identifier, parens,
 *    brace", so control flow was counted as API surface. A defensive module of
 *    three real functions wrapped in three ignore-catches scored 50% empty.
 *  - a `}` inside a comment or string terminated the brace scan early, so real
 *    bodies were measured as empty ("// clamp to } of the arena" emptied its
 *    function).
 *  - `export const init = () => {}` matched NOTHING, because every alternative
 *    required a word character or `)` before the paren. The dominant modern stub
 *    idiom scored zero callables and sailed through — and it is the first shape
 *    a model reaches for after one refusal.
 *
 * So: strip comments and string literals first (length-preserving, to keep
 * indices valid), then find bodies by scanning BACKWARD from each `{` to decide
 * whether it opens a callable. That handles return-type annotations, generics,
 * and nested parens in parameter lists, none of which a `[^()]*` regex can.
 *
 * MEASURED POPULATIONS (all figures produced BY this implementation, not recalled
 * from an earlier one — the first draft of this header cited numbers from a
 * scanner that counted `if` blocks as callables, and they no longer reproduced)
 *
 *   the 7 live stubs   4–10 callables, 75–90% empty, ~300–390 bytes each
 *   config.js (real, same directory, same run)   10 callables, 0% empty, 7.0 KB
 *   this repo, every .ts under src/   324 files, 0 flagged
 *   worst real file anywhere here   execution-gate.ts, 50% empty / 72 callables
 *
 * The gap between "worst real file" and the unlabelled bar is what the thresholds
 * actually rest on, so a negative-control test re-derives it on every run instead
 * of trusting this comment.
 */

/** Files whose shape legitimately has empty or absent bodies. */
const EXEMPT_EXTENSIONS = new Set([
  '.d.ts', // ambient declarations are ALL signature and no body by definition
  '.d.mts',
  '.d.cts',
  '.json',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.lock',
  '.css',
  '.scss',
  '.svg',
  // NOT exempt: .html. A single-file page with all the logic in an inline
  // <script> is the dominant artifact shape in the runs this guard exists for,
  // and exempting the extension let that whole shape through. An ordinary HTML
  // file has no callables at all, so it never reaches the thresholds anyway.
]);

/**
 * Keywords that take `(...)` and a block but are NOT callables. Counting these
 * as API surface is what let a real module of three functions plus three
 * ignore-catches read as 50% empty.
 */
const CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'catch',
  'with',
  'return',
  'typeof',
  'instanceof',
  'delete',
  'void',
  'in',
  'of',
  'new',
  'await',
  'yield',
]);

/**
 * Explicit self-labelling. Weak on its own — a model can drop the word — but a
 * strong confirmation when present, so it lowers BOTH bars: the callable count
 * and the empty-ratio required (6→3 and 0.60→0.45).
 * Anchored near the top of the file: "stub" inside a deep code comment is
 * usually discussing the concept, not announcing one.
 */
const MARKER_RE =
  /(?:^|\n)\s*(?:\/\/|\/\*|\*|#)?\s*.{0,60}\b(?:stub|placeholder|not\s+implemented|unimplemented|to\s*-?\s*do\s*:?\s*implement)\b/i;

const MARKER_SCAN_LINES = 12;
/** Also cap the marker scan by characters: MARKER_RE has two `\s*` around an
 *  optional group, which backtracks quadratically on one very long line. */
const MARKER_SCAN_CHARS = 2000;

/** Above this many characters, skip detection entirely (bundled output). */
const MAX_SCAN_CHARS = 200_000;
/** Cap on retained bodies — bounds the O(input × depth) slice allocation. */
const MAX_BODIES = 2000;

export interface StubVerdict {
  isStub: boolean;
  /** Human-facing explanation, used verbatim in the refusal. */
  reason: string;
  callables: number;
  emptyRatio: number;
  marker: boolean;
}

/**
 * Blank out comments and string/template literals, replacing their contents with
 * spaces so every index in the result still lines up with the input.
 *
 * Needed because the brace scan and the signature scan both count raw
 * punctuation, and a `}` or `(` inside a comment or a string is not code. The
 * length-preserving choice matters: bodies are sliced by index afterwards.
 */
export function stripNonCode(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, src.length));
      i = j + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        // An unterminated single/double quote must not eat the rest of the file.
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Walk back over whitespace from `i` (exclusive), returning the new index. */
function skipWsBack(s: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1])) j--;
  return j;
}

/**
 * Map every `)` to its matching `(` (and every `{` to its `}`), in ONE pass.
 *
 * Both directions were previously resolved by rescanning per candidate, which is
 * quadratic on unbalanced input: an unclosed brace made each candidate scan to
 * EOF, and an unmatched paren made each `){` scan back to index 0. At the 200 KB
 * scan cap that is still ~10^10 character steps — a synchronous stall inside a
 * write handler, which is indistinguishable from a wedge and stops the deliver
 * heartbeat advancing, so the lock's wedge-reclaim can reclaim a run that is
 * merely spinning in this function.
 */
function bracketMaps(s: string): { closeOf: Map<number, number>; openOf: Map<number, number> } {
  const closeOf = new Map<number, number>();
  const openOf = new Map<number, number>();
  const braces: number[] = [];
  const parens: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') braces.push(i);
    else if (c === '}') {
      const open = braces.pop();
      if (open !== undefined) closeOf.set(open, i);
    } else if (c === '(') parens.push(i);
    else if (c === ')') {
      const open = parens.pop();
      if (open !== undefined) openOf.set(i, open);
    }
  }
  return { closeOf, openOf };
}

/**
 * Does the `{` at `open` begin a function body?
 *
 * Decided by walking backward, which is the only way to accept a return-type
 * annotation, a generic parameter list, or nested parens in the parameters
 * without hand-rolling a full parser:
 *
 *   `=> {`                     → arrow body
 *   `) {`                      → declaration/method, unless the name before the
 *                                paren is control flow
 *   `): SomeType<A, B> {`      → same, after skipping the annotation
 */
function opensCallable(s: string, open: number, openOf: Map<number, number>): boolean {
  let i = skipWsBack(s, open);
  if (i >= 2 && s[i - 1] === '>' && s[i - 2] === '=') return true; // => {
  // Skip a return-type annotation: `: Foo<Bar> | null` back to its `:`.
  if (i > 0 && s[i - 1] !== ')') {
    let j = i;
    while (j > 0 && /[\w$.<>[\]|&,\s'"]/.test(s[j - 1])) j--;
    if (j > 0 && s[j - 1] === ':') {
      i = skipWsBack(s, j - 1);
    } else {
      return false;
    }
  }
  if (i === 0 || s[i - 1] !== ')') return false;
  const openParen = openOf.get(i - 1);
  if (openParen === undefined) return false;
  let k = skipWsBack(s, openParen);
  // Skip a generic parameter list: `foo<T extends X>(…)`.
  if (k > 0 && s[k - 1] === '>') {
    let depth = 0;
    let j = k - 1;
    for (; j >= 0; j--) {
      if (s[j] === '>') depth++;
      else if (s[j] === '<') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j < 0) return false;
    k = skipWsBack(s, j);
  }
  // The identifier immediately before the parameter list.
  let n = k;
  while (n > 0 && /[\w$]/.test(s[n - 1])) n--;
  const name = s.slice(n, k);
  if (name === '') {
    // `(…) {` with no name: an IIFE header or a bare block. Only treat it as a
    // callable when `function` precedes it (`function (a) {`).
    const before = s.slice(Math.max(0, skipWsBack(s, n) - 8), skipWsBack(s, n));
    return /\bfunction$/.test(before);
  }
  if (CONTROL_KEYWORDS.has(name)) return false;
  return true;
}

/**
 * Bodies of function-like constructs, brace-matched over stripped source.
 *
 * A regex cannot do this: `\{[^{}]*\}` only ever matches innermost braces, so a
 * real file full of nested logic reports a handful of callables and the ratio
 * becomes meaningless (measured during design — the naive version found 1–2
 * callables in 1000-line modules).
 */
export function extractFunctionBodies(src: string): string[] {
  const s = stripNonCode(src);
  const { closeOf, openOf } = bracketMaps(s);
  const bodies: string[] = [];
  for (let open = 0; open < s.length; open++) {
    if (s[open] !== '{') continue;
    const end = closeOf.get(open);
    if (end === undefined) continue; // never closed — skip rather than guess
    if (!opensCallable(s, open, openOf)) continue;
    bodies.push(s.slice(open + 1, end));
    // Nested bodies mean the retained text is O(input × nesting depth), so a
    // pathological file of `f(){` repeated can allocate orders of magnitude more
    // than it contains. Past this many callables the ratio has long since told us
    // whatever it is going to.
    if (bodies.length >= MAX_BODIES) break;
  }
  return bodies;
}

/**
 * Is a body empty of executable content? Comments do not count as substance.
 *
 * `return true` / `return 0` were originally counted as empty too. They are not:
 * `canShoot() { return true; }` is an ordinary predicate, and treating it as a
 * stub put a real module three points from a false refusal — and, because
 * contract-extractor reuses this predicate, annotated real exports as "declared
 * but NOT implemented" in the text handed to dependent epics. Only genuinely
 * vacuous returns count.
 */
export function isEmptyBody(body: string): boolean {
  const stripped = stripNonCode(body)
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (stripped === '') return true;
  return /^return(\s*(?:null|undefined|\{\s*\}|\[\s*\]))?\s*;?$/.test(stripped);
}

function pctOf(ratio: number): number {
  return Math.round(ratio * 100);
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const lower = base.toLowerCase();
  for (const ext of ['.d.ts', '.d.mts', '.d.cts']) {
    if (lower.endsWith(ext)) return ext;
  }
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot) : '';
}

/**
 * Decide whether `content` is a stub for `path`.
 *
 * Thresholds are set from the measured populations, biased toward letting things
 * through: a false refusal blocks legitimate work and trains the operator to set
 * the override, which costs more than an occasional miss.
 *
 *  - ≥6 callables and ≥60% empty  → stub, no label needed.
 *  - ≥3 callables and ≥45% empty AND a self-label → stub.
 *
 * The two bars differ because a self-label is strong evidence and should lower
 * the ratio required, not merely the surface size. Replaying the real corpus
 * caught this: background.js is unambiguously a stub ("Background Module —
 * Stub") but sits at 50% empty, so a single 60% bar let it through — 6 of 7
 * blocked, a miss on a file the guard exists for.
 *
 * A file with one or two empty bodies is never flagged, on either bar: no-op
 * defaults and intentional no-op handlers are ordinary, and there is no evidence
 * to separate them from a stub at that size. That promise is what the labelled
 * bar's `empties >= 3` floor keeps — with only `ratio >= 0.45`, a 3-body file
 * with 2 empties and a "TODO: implement" header would have been refused.
 *
 * NOT flagged, by design: `throw new Error("TODO")` / `todo!()` /
 * `raise NotImplementedError` bodies. Those are what a SCAFFOLD epic is
 * explicitly instructed to produce (epic-mission.ts), and they are honest —
 * they announce themselves at runtime instead of silently succeeding, which is
 * the whole problem with `{}`.
 */
export function detectStub(path: string, content: string, prior?: string): StubVerdict {
  const none: StubVerdict = { isStub: false, reason: '', callables: 0, emptyRatio: 0, marker: false };
  if (EXEMPT_EXTENSIONS.has(extensionOf(path))) return none;
  // Above this, skip rather than scan. Minified/vendored bundles are the case —
  // and the harness actively steers models into writing them, because the visual
  // gate's advice for a failed CDN request is "vendor the dependency locally".
  // The shape argument does not apply to generated output anyway.
  if (content.length > MAX_SCAN_CHARS) return none;

  const head = content.split('\n').slice(0, MARKER_SCAN_LINES).join('\n').slice(0, MARKER_SCAN_CHARS);
  const marker = MARKER_RE.test(head);

  const bodies = extractFunctionBodies(content);
  if (bodies.length === 0) return { ...none, marker };

  const empties = bodies.filter(isEmptyBody).length;
  const ratio = empties / bodies.length;
  const base = { callables: bodies.length, emptyRatio: ratio, marker };

  const bigSurface = bodies.length >= 6 && ratio >= 0.6;
  // The labelled bar also needs an ABSOLUTE floor of empty bodies. Without it a
  // 3-callable file at 45% (two empties) could be refused on the strength of the
  // word "stub" appearing in its header — and MARKER_RE matches prose that merely
  // discusses stubs ("this module used to be a stub"), including this very file's
  // own header. Three empty bodies is real evidence; two is a coincidence.
  // The labelled bar is also bounded ABOVE. Measured: the worst genuinely-real
  // file in this repo (src/delivery/execution-gate.ts) sits at 50% empty across
  // 72 callables — under the 60% bar with room, but over the labelled 45% one. It
  // is unflagged today only because its header happens not to say "stub"; adding
  // that word to a comment would have refused it. A self-label is evidence about
  // a small module that declares an API and implements none of it, which is what
  // background.js (4 callables) is. It says nothing useful about a 72-callable
  // implementation file, so the lowered bar does not apply there.
  const labelled =
    bodies.length >= 3 && bodies.length <= 12 && empties >= 3 && ratio >= 0.45 && marker;

  if (!bigSurface && !labelled) return { ...base, isStub: false, reason: '' };

  // MONOTONE PROGRESS. A FILL epic reads an 8-function skeleton and re-emits it
  // with three functions implemented: still 62% empty, so the snapshot test
  // refuses it — and refuses every subsequent partial improvement, ratcheting the
  // file permanently shut. That is the same unsatisfiable-gate class this guard's
  // own epic exemption exists to avoid, reached from the other direction. If the
  // file on disk is already a stub and the new content implements strictly more
  // of it, the write is progress and is allowed.
  if (prior !== undefined && prior !== '') {
    const before = detectStub(path, prior);
    if (before.isStub) {
      const beforeEmpties = Math.round(before.emptyRatio * before.callables);
      if (empties < beforeEmpties || ratio < before.emptyRatio) {
        return {
          ...base,
          isStub: false,
          reason: `still ${pctOf(ratio)}% empty, but fewer empty bodies than before — progress`,
        };
      }
    }
  }

  const pct = pctOf(ratio);
  return {
    ...base,
    isStub: true,
    reason:
      `${bodies.length} function bodies declared and ${empties} of them (${pct}%) are empty` +
      (marker ? ', and the file labels itself a stub/placeholder' : '') +
      '. This declares an API surface without implementing it',
  };
}

/**
 * The refusal text handed back to the model.
 *
 * Says what to do instead, because a bare refusal on the agentic path produces a
 * retry of the identical content — the same reason the P3 guard spells out
 * edit_file. Names the override so a human reading the transcript can unblock a
 * legitimate case without reading this source.
 */
export function stubRefusal(path: string, verdict: StubVerdict): string {
  return (
    `ERROR: refusing to write ${path} — ${verdict.reason}. ` +
    `Write the REAL implementation: each function must contain the logic that makes it work. ` +
    `Re-sending this same skeleton will be refused again. ` +
    `If this file is deliberately a skeleton (a scaffold phase), give each body an explicit ` +
    `throw new Error('TODO: <what>') instead of an empty block — that is honest at runtime, ` +
    `and it is accepted. ` +
    `If a genuinely empty-bodied file is intended (an interface, an abstract base), ` +
    `set UAP_DELIVER_ALLOW_STUBS=1.`
  );
}

/**
 * Operator opt-out, matching UAP_DELIVER_ALLOW_GUTTING's shape. ENV ONLY.
 *
 * There was briefly a second disjunct here, `UAP_EPIC_STUBS_OK`, set by the epic
 * controller for CONTRACTS and SCAFFOLD epics — the two phases whose prompts say
 * stub bodies are the DELIVERABLE. It is gone, because it was SELF-GRANTABLE:
 * `epic.scaffold` and `epic.contracts` come out of the PLANNER MODEL's JSON
 * (decompose.ts), and the planner and the executor are the same model. Labelling
 * a phase `"scaffold": true` would have switched the guard off for it. An
 * override the constrained party can set is not an override, it is an off switch
 * — the same reasoning that made expert-review's inline waiver indefensible.
 *
 * Nothing is lost by removing it. A COMPLIANT scaffold already passes: the prompt
 * asks for `throw new Error("TODO")` / `todo!()` / `raise NotImplementedError`
 * bodies, and those are not empty. The exemption would only ever have permitted
 * the one shape the prompt does not ask for, bare `{}` — which is also the only
 * shape that fails silently at runtime instead of announcing itself. So the
 * refusal names the compliant form instead of waiving the check, which keeps the
 * phase satisfiable without handing the model a switch.
 */
export function stubGuardDisabled(): boolean {
  return process.env.UAP_DELIVER_ALLOW_STUBS === '1';
}
