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

export interface ContractResult {
  /** Compact, injectable contract text (public signatures), or '' if none. */
  contract: string;
  /** The public names proven present (for auditing / verification). */
  names: string[];
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
 * Extract + verify the public contract from a task's produced files. Pure over
 * the given {path, content} pairs — the caller reads the files. Verification is
 * intrinsic: a name only appears if it was matched in the actual source.
 */
export function extractContract(files: Array<{ path: string; content: string }>): ContractResult {
  const parts: string[] = [];
  const names: string[] = [];
  for (const f of files) {
    let sigs: string[] = [];
    if (isJsLike(f.path)) sigs = extractJs(f.content);
    else if (isPy(f.path)) sigs = extractPy(f.content);
    if (sigs.length === 0) continue;
    for (const s of sigs) {
      const name = s.replace(/^(function|class|const|def)\s+/, '').split('(')[0].trim();
      if (name) names.push(name);
    }
    parts.push(`${f.path}: ${sigs.join('; ')}`);
  }
  const contract = parts.join(' | ').slice(0, MAX_CONTRACT_CHARS);
  return { contract, names };
}
