/**
 * Structural contract lint (P1 gate, production wiring).
 *
 * Per-epic node --check + per-epic acceptance can all pass while the ASSEMBLED
 * whole still crashes at boot, because a cross-module STRUCTURAL contract
 * diverged: one module exposes a symbol as a singleton object, another `new`s it
 * as a class. Observed live twice on the octopus build:
 *   audio.js:      `var Audio = (function(){ ... return {…}; })();`   // singleton
 *   game.js:       `audio = new Audio();`                             // TypeError: not a constructor
 *   background.js: `const Background = (() => { ... })();`            // singleton
 *   game.js:       `background = new Background(cvs);`                // TypeError: not a constructor
 *
 * This lint scans the delivered source and flags a `new X()` where X is defined
 * (anywhere in the set) as an IIFE singleton and NOT as a class/function — the
 * exact, high-confidence signature of that failure. It deliberately stays narrow
 * (PascalCase symbols, IIFE singletons, real `new` usage) to avoid false
 * positives that would wrongly fail a healthy epic. PURE — unit-tested.
 *
 * KNOWN BOUNDARIES (deliberately conservative — a missed bug is far cheaper here
 * than a false positive that wedges a healthy epic in a retry loop):
 *   - Only the IIFE singleton form is detected; a plain object-literal singleton
 *     (`const Audio = { play(){} }` then `new Audio()`) crashes the same way but
 *     is NOT flagged.
 *   - An IIFE that RETURNS a constructor (`const Ship = (() => class {…})()`) is
 *     new-able; those files are skipped from singleton classification.
 *   - Regexes scan raw text, so a `new X()` inside a comment/string is included;
 *     acceptable given the low rate and the changed-files scoping below.
 *
 * When `changedFiles` is provided, only `new`-sites in THOSE files are flagged
 * (singletons are still classified from the whole set) — so a violation is
 * attributed to the epic that actually wrote the `new`, never re-blamed onto an
 * innocent downstream epic (which may be unable to fix a locked-contract file).
 */

export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Return a list of structural contract violations across the given source files.
 * Empty when the code is structurally consistent.
 */
export function lintSourceContracts(files: SourceFile[], changedFiles?: Set<string>): string[] {
  const constructors = new Set<string>(); // `class X` or `function X(` — new-able
  const singletons = new Map<string, string>(); // IIFE singleton name -> defining file
  // An IIFE that returns a constructor is new-able — never a singleton.
  const returnsCtor = /return\s+(?:class\b|function\b)|=>\s*(?:class\b|function\b)/;

  // An IIFE singleton: `const/let/var Name = ( () => {…} )()` or
  // `= ( function (…) {…} )()`. We only need to recognize the OPENING of the
  // IIFE assignment (the immediately-invoked wrapper), which is the reliable,
  // low-false-positive signal. Names are PascalCase (the class-like convention).
  const iifeRe = /\b(?:const|let|var)\s+([A-Z]\w*)\s*=\s*\(\s*(?:function\b|async\s+function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  const classRe = /\bclass\s+([A-Z]\w*)/g;
  const funcRe = /\bfunction\s+([A-Z]\w*)\s*\(/g;

  for (const f of files) {
    let m: RegExpExecArray | null;
    classRe.lastIndex = 0; while ((m = classRe.exec(f.content))) constructors.add(m[1]);
    funcRe.lastIndex = 0; while ((m = funcRe.exec(f.content))) constructors.add(m[1]);
    // Skip singleton classification for a file whose IIFE plausibly returns a
    // constructor (anonymous/renamed class or function) — that symbol is new-able.
    if (returnsCtor.test(f.content)) continue;
    iifeRe.lastIndex = 0; while ((m = iifeRe.exec(f.content))) singletons.set(m[1], f.path);
  }

  const violations: string[] = [];
  const seen = new Set<string>();
  const newRe = /\bnew\s+([A-Z]\w*)\s*\(/g;
  for (const f of files) {
    // Only attribute a violation to a `new`-site the CURRENT epic actually wrote
    // (when the caller scopes it), so a locked/earlier file's mismatch never
    // fails an innocent downstream epic.
    if (changedFiles && !changedFiles.has(f.path)) continue;
    let m: RegExpExecArray | null;
    newRe.lastIndex = 0;
    while ((m = newRe.exec(f.content))) {
      const name = m[1];
      // Constructor wins if the symbol is ALSO a class/function anywhere —
      // ambiguous, so don't flag (avoids false positives on dual definitions).
      if (singletons.has(name) && !constructors.has(name)) {
        const key = `${name}@${f.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push(
          `${f.path}: \`new ${name}()\` but ${name} is a singleton object ` +
            `(an IIFE in ${singletons.get(name)}), not a constructor — call ${name} directly, ` +
            `or make ${name} a \`class\`. (structural contract mismatch — would crash at boot)`
        );
      }
    }
  }
  return violations;
}
