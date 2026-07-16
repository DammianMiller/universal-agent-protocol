/**
 * Budget wire-protocol gate (meta-test): the context-budget module owns BOTH
 * ends of the marker protocol — formatBudgetStop produces, decodeBudgetStop
 * decodes, and everything downstream consumes only the structured
 * budgetStopped field. This test turns that docstring contract into a gate:
 * no src/ file outside context-budget.ts may sniff the marker out of text
 * (.includes / regex match on CONTEXT_BUDGET_MARKER). Importing the marker
 * for human-facing summary COMPOSITION (epic-mission's settle) stays legal.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('budget-stop protocol ownership', () => {
  it('no src/ file outside context-budget.ts sniffs CONTEXT_BUDGET_MARKER out of text', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      if (file.endsWith(`${join('delivery', 'context-budget')}.ts`)) continue;
      const text = readFileSync(file, 'utf-8');
      // Sniffing = substring/regex matching against the marker. Composition
      // (template-embedding the marker into a summary) does not match these.
      if (
        /\.includes\(\s*CONTEXT_BUDGET_MARKER/.test(text) ||
        /\.indexOf\(\s*CONTEXT_BUDGET_MARKER/.test(text) ||
        /CONTEXT_BUDGET_MARKER\s*\)\s*(!==|===|>=?|<=?)/.test(text)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
