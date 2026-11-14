import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * O-E — the delivery-gate corpus aggregator (scripts/aggregate_gate_corpus.py).
 * Exercised against a synthetic fixture root so the test does not depend on
 * the machine's live benchmark-results/ or memory DBs: a paired report.json,
 * a bridge-mirror CLAUDE.md, and a corrupt report that must be skipped.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'aggregate_gate_corpus.py');

const python = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
const havePython = python.status === 0;

function makeFixtureRoot(): string {
  const root = join(tmpdir(), `gate-corpus-fixture-${process.pid}-${Date.now()}`);
  // A paired benchmark report with two arms.
  mkdirSync(join(root, 'benchmark-results', 'fixture-run'), { recursive: true });
  writeFileSync(
    join(root, 'benchmark-results', 'fixture-run', 'report.json'),
    JSON.stringify({
      report: {
        meta: { model: 'fixture-model' },
        discrimination: { status: 'underpowered' },
        perCondition: [
          { label: 'baseline', n: 10, successRate: 0.4, meanTokens: 100, meanTurns: 1 },
          { label: 'uap-full', n: 10, successRate: 0.7, meanTokens: 300, meanTurns: 2 },
        ],
      },
    })
  );
  // A corrupt report that must be skipped, not fatal.
  mkdirSync(join(root, 'benchmark-results', 'corrupt-run'), { recursive: true });
  writeFileSync(join(root, 'benchmark-results', 'corrupt-run', 'report.json'), '{not json');
  // A bridge mirror with one lesson of each verdict shape.
  writeFileSync(
    join(root, 'CLAUDE.md'),
    [
      '<!-- UAP-MEMORY-BRIDGE:START -->',
      '  - (lesson, i7) [deliver] NOT delivered after 3 turn(s), best 40% of gates — model fixture-model — task: alpha',
      '  - (lesson, i7) [deliver] STOPPED (interrupted, resumable — not a gate failure) after 2 turn(s), best 80% of gates — model fixture-model — task: beta',
      '  - (decision, i6) [deliver] delivered in 1 turn(s) — model fixture-model — task: gamma',
      '<!-- UAP-MEMORY-BRIDGE:END -->',
    ].join('\n')
  );
  return root;
}

function run(root: string, args: string[] = []): string {
  const r = spawnSync('python3', [SCRIPT, '--root', root, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return `${r.stdout}${r.stderr}`;
}

describe('aggregate_gate_corpus (O-E)', () => {
  it.skipIf(!havePython)(
    'pools paired arms into markdown rows with model, technique, tier, gate rate and token cost',
    () => {
      const root = makeFixtureRoot();
      try {
        const out = run(root);
        expect(out).toContain('`fixture-model`');
        expect(out).toContain('| baseline | local | 10 | 40.0% | 100 | 1.0 | underpowered |');
        expect(out).toContain('| uap-full | local | 10 | 70.0% | 300 | 2.0 | underpowered |');
        // The corrupt run is skipped, not fatal — no row, clean exit.
        expect(out).not.toContain('corrupt-run');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!havePython)(
    'collects bridge-mirror deliver lessons: all three verdict shapes, delivered counted as a passed gate',
    () => {
      const root = makeFixtureRoot();
      try {
        const out = run(root, ['--json']);
        const rows = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
        const lessons = rows.filter(
          (r: { kind: string }) => r.kind === 'deliver-lesson'
        ) as Array<{
          verdict: string;
          gateRate: number;
          meanTurns: number;
          technique: string;
        }>;
        expect(lessons).toHaveLength(3);
        const byVerdict = new Map(lessons.map((l) => [l.verdict, l]));
        expect(byVerdict.get('not-delivered')?.gateRate).toBe(0.4);
        expect(byVerdict.get('stopped-interrupted')?.gateRate).toBe(0.8);
        // A delivered run passed its gates: counted as 1.0, no best-clause needed.
        expect(byVerdict.get('delivered')?.gateRate).toBe(1.0);
        expect(lessons.every((l) => l.technique === 'full-uap-stack')).toBe(true);
        // The paired rows survived alongside the lessons in the same run.
        expect(
          rows.some((r: { kind: string; technique: string }) => r.kind === 'paired-benchmark')
        ).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
