/**
 * Interface/Contract Extractor (P4) — the dependency handoff.
 *
 * When a task finishes, extract the PUBLIC surface of the files it produced
 * (exported functions/classes/consts for JS/TS; top-level def/class for Python)
 * and VERIFY every extracted name actually exists in the source. A dependent
 * task then loads this contract (a few hundred chars) instead of re-reading the
 * dependency's full implementation — which is what lets a small-context model
 * compose modules it never has to hold in context at once.
 *
 * Verification matters: a contract that lies (records a signature the code
 * doesn't expose) makes dependents build against a phantom — exactly the
 * "gate-green but spec-wrong" class measured on the brutal suite. So the
 * extractor only reports names it can prove are present in the emitted source.
 */

import { isEmptyBody, stripNonCode } from './stub-detector.js';

export interface ContractResult {
  /** Compact, injectable contract text (public signatures), or '' if none. */
  contract: string;
  /** The public names proven present (for auditing / verification). */
  names: string[];
  /**
   * Names that are present but have an EMPTY body — declared, not implemented.
   *
   * Presence-verification alone cannot see this, and it is the loophole the
   * stub-write class travels through: `export function init() {}` verifies
   * perfectly, so a stub epic used to hand a fully "verified" contract to its
   * dependents, which then built against functions that do nothing. This
   * file's own rationale is that a contract must not make dependents "build
   * against a phantom"; an empty body IS a phantom that passed.
   *
   * Names are still reported in `names`/`contract` (removing them would break
   * dependents that legitimately reference the symbol) but are annotated in the
   * contract text, so a false positive costs a misleading annotation rather
   * than a missing API.
   */
  unimplemented: string[];
}

const MAX_CONTRACT_CHARS = 600;

function isJsLike(path: string): boolean {
  return /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(path);
}
function isPy(path: string): boolean {
  return /\.py$/.test(path);
}

/** Extract exported/public JS signatures from one file's source. */
function extractJs(content: string): string[] {
  const sigs: string[] = [];
  const seen = new Set<string>();
  const push = (name: string, sig: string) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      sigs.push(sig.trim());
    }
  };
  // export function foo(a, b) / export async function
  for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g)) {
    push(m[1], `function ${m[1]}(${m[2].trim()})`);
  }
  // export class Foo
  for (const m of content.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) {
    push(m[1], `class ${m[1]}`);
  }
  // export const foo = / export const foo: Type =
  for (const m of content.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)/g)) {
    push(m[1], `const ${m[1]}`);
  }
  // module.exports = { a, b } and module.exports.foo =
  for (const m of content.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const name of m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean)) {
      push(name, name);
    }
  }
  for (const m of content.matchAll(/module\.exports\.([A-Za-z0-9_$]+)\s*=/g)) {
    push(m[1], m[1]);
  }
  return sigs;
}

/** Extract top-level public def/class signatures from Python source. */
function extractPy(content: string): string[] {
  const sigs: string[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm)) {
    if (!m[1].startsWith('_') && !seen.has(m[1])) {
      seen.add(m[1]);
      sigs.push(`def ${m[1]}(${m[2].trim()})`);
    }
  }
  for (const m of content.matchAll(/^class\s+([A-Za-z0-9_]+)/gm)) {
    if (!m[1].startsWith('_') && !seen.has(m[1])) {
      seen.add(m[1]);
      sigs.push(`class ${m[1]}`);
    }
  }
  return sigs;
}

/**
 * Is `name`'s definition in `content` an empty-bodied one?
 *
 * Scans EVERY definition site for the name and evaluates the first one that
 * actually has a body. Taking the first textual match instead mis-attributed TS
 * overloads: for
 *
 *   export function draw(): void;
 *   export function draw(x: number): void {}
 *
 * the declaration matched first, and the brace search then ran on past it into
 * the *implementation's* body. Skipping bodiless declarations (`;`) is what makes
 * the overload case land on the real definition.
 *
 * Runs over comment- and string-stripped source, so a name mentioned in a
 * comment above its definition cannot win, and a brace inside a string cannot
 * close a body early. Conservative: anything it cannot locate or balance returns
 * false, so an unrecognised shape is treated as implemented — under-reporting
 * leaves the pre-existing behaviour intact, whereas over-reporting would
 * annotate a real API as phantom in the text handed to dependent epics.
 */
function hasEmptyBody(src: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defRe = new RegExp(
    `(?:function\\s*\\*?\\s*${esc}|(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?(?:function\\s*\\*?)?)\\s*(?:<[^<>]*>)?\\s*\\(`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(src)) !== null) {
    // Walk from the parameter list's `(` to its matching `)`.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    // Then over an optional return-type annotation / arrow, to the body brace.
    let j = i + 1;
    while (j < src.length && /[\s:=>|&,\w$.<>[\]]/.test(src[j])) j++;
    if (src[j] !== '{') continue; // a bodiless overload declaration — try the next
    let d = 0;
    let k = j;
    for (; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') {
        d--;
        if (d === 0) break;
      }
    }
    if (d !== 0) continue;
    return isEmptyBody(src.slice(j + 1, k));
  }
  return false;
}

/**
 * Python equivalent of hasEmptyBody. Braces do not apply, so the body is the
 * run of lines indented deeper than the `def`, and "empty" means it holds only
 * `pass`, `...`, a bare `return`, or a docstring. Same conservative contract as
 * the JS probe: an unrecognised shape reports false.
 */
function hasEmptyBodyPy(content: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defRe = new RegExp(
    `^([ \\t]*)(?:async\\s+)?def\\s+${esc}\\s*\\([^()]*\\)\\s*(?:->[^:]+)?:[ \\t]*$`,
    'm'
  );
  const m = defRe.exec(content);
  if (!m) return false;
  const indent = m[1].length;
  const body: string[] = [];
  for (const line of content.slice(m.index + m[0].length).split('\n').slice(1)) {
    if (line.trim() === '') continue;
    const lead = line.length - line.trimStart().length;
    if (lead <= indent) break;
    body.push(line.trim());
  }
  if (body.length === 0) return true;
  // Drop a leading docstring: documentation is not implementation, the same
  // rule isEmptyBody applies to JS comments.
  let i = 0;
  const q = body[0].slice(0, 3);
  if (q === '"""' || q === "'''") {
    if (body[0].length > 3 && body[0].endsWith(q)) i = 1;
    else {
      i = 1;
      while (i < body.length && !body[i].endsWith(q)) i++;
      i++;
    }
  }
  const real = body.slice(i).filter((l) => !l.startsWith('#'));
  if (real.length === 0) return true;
  return real.every((l) => /^(pass|\.\.\.|return(\s+None)?|raise\s+NotImplementedError(\(.*\))?)$/.test(l));
}

/**
 * Extract + verify the public contract from a task's produced files. Pure over
 * the given {path, content} pairs — the caller reads the files. Verification is
 * intrinsic: a name only appears if it was matched in the actual source.
 */
export function extractContract(files: Array<{ path: string; content: string }>): ContractResult {
  const parts: string[] = [];
  const names: string[] = [];
  const unimplemented: string[] = [];
  for (const f of files) {
    let sigs: string[] = [];
    if (isJsLike(f.path)) sigs = extractJs(f.content);
    else if (isPy(f.path)) sigs = extractPy(f.content);
    if (sigs.length === 0) continue;
    const annotated: string[] = [];
    // Stripped ONCE per file, not once per name: stripNonCode allocates a
    // char-array copy of the whole file, and a bundled source with a hundred
    // exports meant a hundred of those.
    const stripped = isPy(f.path) ? '' : stripNonCode(f.content);
    for (const s of sigs) {
      const name = s.replace(/^(function|class|const|def)\s+/, '').split('(')[0].trim();
      if (name) names.push(name);
      // The `module.exports = { … }` branch derives names by splitting arbitrary
      // text, which then reaches `new RegExp`. The escape there is complete, but
      // the safety should not rest on that alone, and a malformed capture should
      // not compile a huge pattern.
      const usable = /^[A-Za-z0-9_$]{1,80}$/.test(name);
      const empty =
        usable && (isPy(f.path) ? hasEmptyBodyPy(f.content, name) : hasEmptyBody(stripped, name));
      if (name && empty) {
        unimplemented.push(name);
        annotated.push(`${s} [empty]`);
      } else {
        annotated.push(s);
      }
    }
    parts.push(`${f.path}: ${annotated.join('; ')}`);
  }
  // The annotation is compact and the legend appears ONCE. Inlining the long
  // form per name cost ~42 chars each against a 600-char cap that dependents see
  // only the first 240 of (task-orchestrator's maxDepSummaryChars) — so on a
  // scaffold handoff, where every name is annotated, the real signatures were
  // truncated away and dependents built against nothing. That inverts the whole
  // point of carrying a contract.
  const legend = unimplemented.length > 0 ? '[empty] = declared, NOT implemented. ' : '';
  const contract = (legend + parts.join(' | ')).slice(0, MAX_CONTRACT_CHARS);
  return { contract, names, unimplemented };
}
