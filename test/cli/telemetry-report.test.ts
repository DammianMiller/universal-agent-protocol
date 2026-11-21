import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordToolCall,
  dailyToolCallRates,
  toolFailureRates,
  closeToolCallStores,
} from '../../src/telemetry/tool-calls.js';
import { telemetryCommand } from '../../src/cli/telemetry.js';

/**
 * The corpus-report instrument: era table, per-tool rates, and the CLI
 * surface. Seeded with a synthetic two-day corpus so every table has
 * something real to render. The rows are recorded through recordToolCall —
 * classification happens where it does in production.
 */
describe('telemetry report — corpus queries', () => {
  let corpusDir: string;

  beforeEach(() => {
    corpusDir = mkdtempSync(join(tmpdir(), 'uap-telemetry-report-'));
  });
  afterEach(() => {
    closeToolCallStores(corpusDir);
    rmSync(corpusDir, { recursive: true, force: true });
  });

  function seed(): void {
    // Day 1 (old): the bad era. Day 2 (today): the recovered era.
    recordToolCall({ runId: 'r1', tool: 'edit_file', result: 'ERROR: a.ts: old_string not found.' }, corpusDir);
    recordToolCall({ runId: 'r1', tool: 'edit_file', result: 'OK: edited a.ts (1 replacement)' }, corpusDir);
    recordToolCall({ runId: 'r2', tool: 'write_file', result: 'NO-OP: a.ts already contains exactly this content' }, corpusDir);
    recordToolCall({ runId: 'r2', tool: 'read_file', result: 'contents' }, corpusDir);
  }

  it('ranks per-tool failure counts and rates', () => {
    seed();
    const rates = toolFailureRates(corpusDir);
    expect(rates.length).toBe(3); // edit_file, write_file, read_file
    const byTool = new Map(rates.map((r) => [r.tool, r]));
    expect(byTool.get('edit_file')?.failures).toBe(1);
    expect(byTool.get('edit_file')?.calls).toBe(2);
    // A NO-OP write is not a failure — the refusal-class corpus must not
    // count deliberate idempotence as waste.
    expect(byTool.get('write_file')?.failures).toBe(0);
    expect(byTool.get('read_file')?.failureRate).toBe(0);
    // Highest failure count first.
    expect(rates[0].tool).toBe('edit_file');
  });

  it('returns empty tables for a missing corpus, never an error', () => {
    expect(toolFailureRates(join(corpusDir, 'missing'))).toEqual([]);
    expect(dailyToolCallRates(14, join(corpusDir, 'missing'))).toEqual([]);
  });

  it('groups the era table by day with per-day rates', () => {
    seed();
    const eras = dailyToolCallRates(1, corpusDir);
    // Seeded rows land on today's date only (the DB defaults ts to now), so a
    // 1-day window holds exactly one day row with every seeded call.
    expect(eras.length).toBe(1);
    expect(eras[0].calls).toBe(4);
    expect(eras[0].failures).toBeGreaterThanOrEqual(1);
    expect(eras[0].failureRate).toBeCloseTo(eras[0].failures / eras[0].calls, 10);
  });
});

describe('telemetry report — CLI surface', () => {
  let corpusDir: string;
  let originalCorpusDir: string | undefined;
  let output: string[];
  const originalLog = console.log;

  beforeEach(() => {
    corpusDir = mkdtempSync(join(tmpdir(), 'uap-telemetry-cli-'));
    originalCorpusDir = process.env.UAP_TOOL_CORPUS_DIR;
    process.env.UAP_TOOL_CORPUS_DIR = corpusDir;
    output = [];
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    closeToolCallStores(corpusDir);
    console.log = originalLog;
    if (originalCorpusDir === undefined) delete process.env.UAP_TOOL_CORPUS_DIR;
    else process.env.UAP_TOOL_CORPUS_DIR = originalCorpusDir;
    rmSync(corpusDir, { recursive: true, force: true });
  });

  it('renders the era table, per-tool rates, and failure classes', async () => {
    recordToolCall({ runId: 'r', tool: 'edit_file', result: 'ERROR: a.ts: old_string not found.' }, corpusDir);
    recordToolCall({ runId: 'r', tool: 'read_file', result: 'contents' }, corpusDir);

    await telemetryCommand('report', {});
    const text = output.join('\n');
    expect(text).toContain('Tool-call corpus');
    expect(text).toContain('Era table');
    expect(text).toContain('Per-tool rates');
    expect(text).toContain('edit_file');
    expect(text).toContain('read_file');
  });

  it('emits machine-readable JSON with --json', async () => {
    recordToolCall({ runId: 'r', tool: 'write_file', result: 'ERROR: refusing to write a.ts — it would shrink' }, corpusDir);

    await telemetryCommand('report', { json: true });
    const parsed = JSON.parse(output.join('\n')) as {
      headline: { totalCalls: number; failureRate: number };
      toolRates: Array<{ tool: string; failures: number }>;
      eras: Array<{ day: string; calls: number }>;
    };
    expect(parsed.headline.totalCalls).toBe(1);
    expect(parsed.headline.failureRate).toBe(1);
    expect(parsed.toolRates[0].tool).toBe('write_file');
    expect(parsed.toolRates[0].failures).toBe(1);
    expect(parsed.eras.length).toBe(1);
  });

  it('reports an empty corpus without failing', async () => {
    await telemetryCommand('report', {});
    expect(output.join('\n')).toContain('No tool-call evidence recorded yet.');
  });

  it('rejects an unknown subcommand', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      await telemetryCommand('bogus', {});
    } finally {
      console.error = originalError;
    }
    expect(errors.join('\n')).toContain("unknown subcommand 'bogus'");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe('telemetry report — suite setup corpus isolation', () => {
  it('redirects the production corpus away from ~/.uap for the whole suite', () => {
    // test/setup-env.ts runs as a setupFile BEFORE any test, so the inherited
    // value must already be isolated away from the real machine store. (The
    // pollution it closes: 630 fixture rows measured in the production
    // corpus after the 2026-11-21 validation runs.)
    const isolated = process.env.UAP_TOOL_CORPUS_DIR;
    expect(isolated).toBeDefined();
    expect(isolated).not.toBe(join(homedir(), '.uap', 'telemetry'));
    expect(isolated).not.toContain(join(homedir(), '.uap'));
  });
});
