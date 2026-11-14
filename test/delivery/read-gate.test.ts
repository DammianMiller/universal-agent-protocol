import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTool, type ReadGate } from '../../src/delivery/agentic-executor';
import { classifyToolResult } from '../../src/telemetry/tool-failure';

let roots: string[] = [];

function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'read-gate-'));
  roots.push(r);
  return r;
}

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const SUBSTANTIAL = `export function one() { return 1; }\n`.repeat(200); // ~9.6 KB

function gate(opts: { readSeq?: (rel: string) => number } = {}): ReadGate {
  return {
    refusals: new Map(),
    readSeq: opts.readSeq ?? (() => 0),
    nextSeq: (() => 1) as () => number,
  };
}

function write(root: string, path: string, content: string, g?: ReadGate): string {
  return runTool(
    root, 'write_file', { path, content }, 1_000, new Set<string>(), true, false,
    new Set<string>(), undefined, false, undefined, undefined, undefined, g,
  );
}

describe('forced-read gate after a substance refusal (O-C.3)', () => {
  it('refuses the re-send until the file has been read since the refusal', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), SUBSTANTIAL);
    const g = gate();
    const first = write(r, 'big.ts', 'export const x = 1;\n', g);
    expect(first).toContain('GUTTING'); // the substance refusal, stamped
    expect(g.refusals.get('big.ts')).toBe(1);
    // A DIFFERENT blind re-send — the corpus's 1,097-strong failure class —
    // is refused by the gate, not re-judged as new content.
    const second = write(r, 'big.ts', 'export const y = 2;\n', g);
    expect(second).toContain('read_file big.ts');
    // The gate speaks, not the substance guard: the guard's phrasing is absent.
    expect(second).not.toContain('it would shrink');
    expect(second.startsWith('ERROR:')).toBe(true);
  });

  it('classifies the gate refusal as a stub-refusal (the same family as the guard)', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), SUBSTANTIAL);
    const g = gate();
    write(r, 'big.ts', 'export const x = 1;\n', g);
    const second = write(r, 'big.ts', 'export const y = 2;\n', g);
    expect(classifyToolResult('write_file', second)).toBe('stub-refusal');
  });

  it('releases and clears after a read, on a legitimate full replacement', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), SUBSTANTIAL);
    // The read has happened AFTER the refusal (seq 5 > stamp 1).
    const g = gate({ readSeq: () => 5 });
    const first = write(r, 'big.ts', 'export const x = 1;\n', g);
    expect(first).toContain('GUTTING');
    const replacement = Array.from(
      { length: 200 },
      (_, i) => `export function fn${i}() { return ${i}; }\n`,
    ).join(''); // full-size, varied — neither a gut nor a duplicate-definition write
    const second = write(r, 'big.ts', replacement, g);
    expect(second.startsWith('OK: wrote')).toBe(true);
    expect(g.refusals.has('big.ts')).toBe(false); // cleared on success
  });

  it('leaves the ungated behaviour byte-identical when no gate is passed', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), SUBSTANTIAL);
    const first = write(r, 'big.ts', 'export const x = 1;\n');
    expect(first).toContain('GUTTING');
    // No gate: the different re-send is judged on its own content again —
    // a small file is a gut again, but via the GUARD, with the gutting text.
    const second = write(r, 'big.ts', 'export const y = 2;\n');
    expect(second).toContain('GUTTING');
    expect(second).not.toContain('read_file big.ts');
  });

  it('UAP_DELIVER_ALLOW_GUTTING=1 never stamps, so the gate never engages', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), SUBSTANTIAL);
    const g = gate();
    process.env.UAP_DELIVER_ALLOW_GUTTING = '1';
    try {
      const ok = write(r, 'big.ts', 'export const x = 1;\n', g);
      expect(ok.startsWith('OK: wrote')).toBe(true);
      expect(g.refusals.size).toBe(0);
    } finally {
      delete process.env.UAP_DELIVER_ALLOW_GUTTING;
    }
  });
});
