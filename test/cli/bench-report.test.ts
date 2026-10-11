/**
 * `uap bench report` (bridge P5) — the paired-report reader surface. Pins the
 * honesty rule from the reliability ladder: a delta is never printed without
 * its CI/verdict, and an unusable run is called NO MEASUREMENT, never a
 * number. Drift between two runs shows held/flipped verdicts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listPairedReportDirs,
  renderReportSummary,
  renderComparison,
  benchReportCommand,
  type LoadedReport,
} from '../../src/cli/bench-report.js';

const dirs: string[] = [];
function tmp(): string {
  const d = join(tmpdir(), `uap-bench-rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal well-formed paired report. */
function report(over: {
  usable?: boolean;
  meanDelta?: number;
  verdict?: string;
  startedAt?: string;
  label?: string;
}): LoadedReport['report'] {
  return {
    meta: { model: 'qwen35-a3b', adapter: 'mock', epochs: 5, taskCount: 6, startedAt: over.startedAt ?? '2026-10-11T10:00:00Z' },
    comparisons: [
      {
        label: over.label ?? 'uap-on vs uap-off',
        baseline: 'uap-off',
        correctness: {
          delta: { meanDelta: over.meanDelta ?? 0.1, ci: { lower: 0.02, upper: 0.18 }, pValue: 0.03 },
          verdict: over.verdict ?? 'win',
          mcnemar: { b: 3, c: 0 },
        },
        metrics: { turns: { meanDelta: -1.2, verdict: 'win' }, wallMs: { meanDelta: -9000, verdict: 'win' } },
      },
    ],
    discrimination: {
      status: over.usable === false ? 'underpowered' : 'usable',
      usable: over.usable !== false,
      reason: over.usable === false ? 'suite resolves < the smallest delta of interest' : undefined,
    },
  };
}

/** paired-<name>/ with report.json (+ optional report.md), mtime pinned. */
function runDir(root: string, name: string, rep: LoadedReport['report'], mtime: Date, withMd = true): string {
  const dir = join(root, `paired-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(rep));
  if (withMd) writeFileSync(join(dir, 'report.md'), `# paired-${name}\n\nfull analysis here\n`);
  utimesSync(join(dir, 'report.json'), mtime, mtime);
  return dir;
}

async function run(opts: Record<string, unknown>): Promise<{ out: string; err: string; code: number | undefined }> {
  const logs: string[] = [];
  const errs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m)));
  await benchReportCommand(opts as never);
  return { out: logs.join('\n'), err: errs.join('\n'), code: process.exitCode };
}

describe('listPairedReportDirs', () => {
  it('lists only dirs holding a report.json, newest-first', () => {
    const root = tmp();
    runDir(root, 'old', report({}), new Date('2026-10-10T10:00:00Z'));
    runDir(root, 'new', report({}), new Date('2026-10-11T10:00:00Z'));
    mkdirSync(join(root, 'paired-noreport'), { recursive: true }); // no report.json
    writeFileSync(join(root, 'loose-file.txt'), 'x');
    const found = listPairedReportDirs(root);
    expect(found.map((f) => f.dir.split('/').pop())).toEqual(['paired-new', 'paired-old']);
  });

  it('is empty (not a crash) when the root does not exist', () => {
    expect(listPairedReportDirs(join(tmp(), 'missing'))).toEqual([]);
  });

  it('breaks mtime ties by dir name (ISO-timestamped dirs stay dated)', () => {
    const root = tmp();
    const same = new Date('2026-10-11T10:00:00Z');
    runDir(root, '2026-06-22', report({}), same);
    runDir(root, '2026-09-02', report({}), same);
    const found = listPairedReportDirs(root);
    expect(found.map((f) => f.dir.split('/').pop())).toEqual(['paired-2026-09-02', 'paired-2026-06-22']);
  });

  it('one dangling symlink must not hide the good reports', () => {
    const root = tmp();
    runDir(root, 'good', report({}), new Date('2026-10-11T10:00:00Z'));
    symlinkSync(join(root, 'paired-missing-target'), join(root, 'paired-broken-link'));
    const found = listPairedReportDirs(root);
    expect(found.map((f) => f.dir.split('/').pop())).toEqual(['paired-good']);
  });
});

describe('renderReportSummary — deltas always carry their status', () => {
  it('prints the delta WITH CI, p-value, verdict, and discordant pair count', () => {
    const loaded: LoadedReport = {
      dir: '/x/paired-demo',
      mtimeMs: 0,
      report: report({ meanDelta: 0.1, verdict: 'win' }),
    };
    const out = renderReportSummary(loaded);
    expect(out).toContain('Paired bench report — paired-demo');
    expect(out).toContain('correctness +10.0pp CI [2.0pp, 18.0pp] p=0.030 → win');
    expect(out).toContain('McNemar discordant 3');
    expect(out).toContain('turns: -120.0pp (win)'); // metrics deltas carry their verdicts too
    expect(out).toContain('usable');
  });

  it('calls an unusable run NO MEASUREMENT, never a bare number', () => {
    const loaded: LoadedReport = {
      dir: '/x/paired-demo',
      mtimeMs: 0,
      report: report({ usable: false, meanDelta: 0.4, verdict: 'unclear' }),
    };
    const out = renderReportSummary(loaded);
    expect(out).toContain('NOT usable');
    expect(out).toContain('underpowered');
    expect(out).toContain('an unusable run is NO MEASUREMENT');
  });

  it('renders honest placeholders when fields are missing', () => {
    const loaded: LoadedReport = { dir: '/x/paired-bare', mtimeMs: 0, report: {} };
    const out = renderReportSummary(loaded);
    expect(out).toContain('model=?');
    expect(out).toContain('NOT usable');
  });
});

describe('renderComparison — run-to-run drift', () => {
  const L = (dir: string, rep: LoadedReport['report']): LoadedReport => ({ dir, mtimeMs: 0, report: rep });

  it('shows drift with verdicts held or FLIPPED', () => {
    const out = renderComparison(
      L('/x/paired-prev', report({ meanDelta: 0.1, verdict: 'win', startedAt: '2026-10-10T10:00:00Z' })),
      L('/x/paired-now', report({ meanDelta: 0.08, verdict: 'win', startedAt: '2026-10-11T10:00:00Z' }))
    );
    expect(out).toContain('delta drift');
    expect(out).toContain('correctness +10.0pp (win) → +8.0pp (win)');
    expect(out).toContain('drift -2.0pp');
    expect(out).not.toContain('VERDICT FLIPPED');
  });

  it('flags verdict flips loudly', () => {
    const out = renderComparison(
      L('/x/paired-prev', report({ meanDelta: 0.1, verdict: 'win' })),
      L('/x/paired-now', report({ meanDelta: -0.05, verdict: 'loss' }))
    );
    expect(out).toContain('VERDICT FLIPPED');
  });

  it('warns when either run could not measure', () => {
    const out = renderComparison(
      L('/x/paired-prev', report({ usable: false })),
      L('/x/paired-now', report({}))
    );
    expect(out).toContain('usable/NOT usable'); // now/prev, in that order
    expect(out).toContain('at least one run could not measure');
  });

  it('says so when a comparison has no previous counterpart', () => {
    const out = renderComparison(
      L('/x/paired-prev', report({ label: 'different label' })),
      L('/x/paired-now', report({ label: 'uap-on vs uap-off' }))
    );
    expect(out).toContain('no previous comparison to drift against');
  });
});

describe('benchReportCommand — the CLI wrapper', () => {
  it('errors honestly when no paired reports exist', async () => {
    const r = await run({ root: tmp() });
    expect(r.code).toBe(1);
    expect(r.err).toContain('No paired reports found');
  });

  it('summarizes the NEWEST run and mentions what else is on disk', async () => {
    const root = tmp();
    runDir(root, 'old', report({ startedAt: '2026-10-10T10:00:00Z' }), new Date('2026-10-10T10:00:00Z'));
    runDir(root, 'new', report({ startedAt: '2026-10-11T10:00:00Z' }), new Date('2026-10-11T10:00:00Z'));
    const r = await run({ root });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Paired bench report — paired-new');
    expect(r.out).toContain('2 report(s) on disk');
    expect(r.out).not.toContain('paired-old');
  });

  it('--dir pins a specific run; --full prints the stored markdown', async () => {
    const root = tmp();
    const dir = runDir(root, 'pinned', report({}), new Date('2026-10-11T10:00:00Z'));
    const r = await run({ dir });
    expect(r.out).toContain('Paired bench report — paired-pinned');
    const full = await run({ dir, full: true });
    expect(full.out).toContain('# paired-pinned');
  });

  it('--compare renders the drift view of the two newest runs', async () => {
    const root = tmp();
    runDir(root, 'a', report({ meanDelta: 0.1 }), new Date('2026-10-10T10:00:00Z'));
    runDir(root, 'b', report({ meanDelta: 0.08 }), new Date('2026-10-11T10:00:00Z'));
    const r = await run({ root, compare: true });
    expect(r.out).toContain('delta drift');
    expect(r.out).toContain('drift -2.0pp');
  });

  it('--compare refuses when only one report exists', async () => {
    const root = tmp();
    runDir(root, 'only', report({}), new Date('2026-10-11T10:00:00Z'));
    const r = await run({ root, compare: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Only one paired report exists');
  });

  it('--json emits the raw report object', async () => {
    const root = tmp();
    runDir(root, 'j', report({}), new Date('2026-10-11T10:00:00Z'));
    const r = await run({ root, json: true });
    const parsed = JSON.parse(r.out);
    expect(parsed.meta.model).toBe('qwen35-a3b');
    expect(parsed.comparisons[0].correctness.verdict).toBe('win');
  });

  it('unwraps the harness `{ ablation, report }` shape real runs write', async () => {
    const root = tmp();
    const dir = join(root, 'paired-wrapped');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'report.json'),
      JSON.stringify({ ablation: null, report: report({ meanDelta: 0.375, verdict: 'win' }) })
    );
    const r = await run({ dir });
    expect(r.out).toContain('model=qwen35-a3b');
    expect(r.out).toContain('correctness +37.5pp');
    expect(r.out).toContain('usable');
  });

  it('refuses an unreadable --dir', async () => {
    const r = await run({ dir: join(tmp(), 'missing') });
    expect(r.code).toBe(1);
    expect(r.err).toContain('No readable report.json');
  });

  it('--full degrades to the summary when report.md is missing (never a stack trace)', async () => {
    const root = tmp();
    const dir = runDir(root, 'interrupted', report({}), new Date('2026-10-11T10:00:00Z'), false); // no report.md
    const r = await run({ dir, full: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('No report.md stored in paired-interrupted/');
    expect(r.out).toContain('Paired bench report — paired-interrupted'); // the summary fallback
  });

  it('survives a malformed pValue in report.json (string, not number)', async () => {
    const root = tmp();
    const rep = report({});
    (rep.comparisons![0].correctness!.delta as { pValue?: unknown }).pValue = '0.03'; // hostile/legacy shape
    const dir = runDir(root, 'badp', rep, new Date('2026-10-11T10:00:00Z'));
    const r = await run({ dir });
    expect(r.out).toContain('p=—'); // guarded, not a crash
  });

  it('notes that --compare is ignored when --dir pins a run', async () => {
    const root = tmp();
    const dir = runDir(root, 'pinned', report({}), new Date('2026-10-11T10:00:00Z'));
    const r = await run({ dir, compare: true });
    expect(r.out).toContain('--dir pins a single run; --compare is ignored');
  });

  it('strips terminal-control bytes from report fields (defense-in-depth)', () => {
    const rep = report({});
    rep.comparisons![0].label = 'evil\u001b]52;c;base64\u0007 vs uap-off';
    const out = renderReportSummary({ dir: '/x/paired-demo', mtimeMs: 0, report: rep });
    expect(out).not.toContain('\u001b'); // the ESC byte is gone — no OSC 52 clipboard write
    expect(out).not.toContain('\u0007'); // the BEL byte is gone too
    expect(out).toContain('evil]52;c;base64 vs uap-off'); // visible text survives
  });
});
