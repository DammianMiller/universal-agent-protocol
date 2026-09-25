/**
 * `uap loops` — loop-incident ledger reading, tolerant parsing, and the
 * ideate/deliver escalation handoff. The ledger is written by the proxy's
 * LOCKSTEP ESCALATION guardrail (tools/agents/scripts/anthropic_proxy.py);
 * these tests pin the cross-language contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  escalationHints,
  loopIncidentsPath,
  loopsCommand,
  readLoopIncidents,
  shQuote,
  stripControlChars,
  type LoopIncident,
} from '../src/cli/loops.js';

const INCIDENT: LoopIncident = {
  ts: '2026-09-25T13:20:09Z',
  guard: 'lockstep',
  outcome: 'hard_blocked',
  session: 'sess-abc',
  tool: 'bash',
  fingerprint: 'a1b2c3d4e5f6',
  error_signature: 'traceback (most recent call last):',
  streak: 4,
  doubling_streak: 4,
  error_signature_streak: 4,
  fires: 2,
  blocks: 1,
  detail: 'bash x4',
};

let dir: string;
let ledger: string;

function writeLedger(records: unknown[]): void {
  writeFileSync(ledger, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-loops-'));
  ledger = join(dir, 'loop-incidents.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.UAP_LOOP_INCIDENTS;
});

describe('loopIncidentsPath', () => {
  it('honors the env override the proxy also reads', () => {
    process.env.UAP_LOOP_INCIDENTS = '/tmp/custom-ledger.jsonl';
    expect(loopIncidentsPath()).toBe('/tmp/custom-ledger.jsonl');
  });

  it('falls back to the XDG uap config layout', () => {
    delete process.env.UAP_LOOP_INCIDENTS;
    expect(loopIncidentsPath()).toMatch(/\.config\/uap\/loop-incidents\.jsonl$/);
  });
});

describe('readLoopIncidents', () => {
  it('returns an empty list for a missing ledger', () => {
    expect(readLoopIncidents(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('parses records and skips torn lines', () => {
    writeFileSync(ledger, JSON.stringify(INCIDENT) + '\n{"ts": "partial' + '\n\n');
    const incidents = readLoopIncidents(ledger);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].tool).toBe('bash');
  });

  it('drops records missing the contract fields', () => {
    writeLedger([INCIDENT, { ts: 'x' }, { tool: 'bash' }]);
    expect(readLoopIncidents(ledger)).toHaveLength(1);
  });
});

describe('escalationHints', () => {
  it('seeds a deliver instruction that forbids the retried call', () => {
    const [deliver] = escalationHints(INCIDENT);
    expect(deliver).toContain('uap deliver');
    expect(deliver).toContain('Do NOT retry that same call');
    expect(deliver).toContain('bash');
    expect(deliver).toContain('traceback');
  });

  it('offers an ideate scaffold keyed by fingerprint', () => {
    const hints = escalationHints(INCIDENT);
    expect(hints[1]).toContain('uap ideate setup loop-a1b2c3d4e5f6');
  });

  it('shell-quotes the handoff against command substitution', () => {
    const evil: LoopIncident = {
      ...INCIDENT,
      error_signature: "Error: $(touch /tmp/pwned) `id` it's",
    };
    const [deliver] = escalationHints(evil);
    // single-quoted body: $(…) and backticks are inert; embedded quotes escaped
    expect(deliver).toContain("'\\''");
    expect(deliver).not.toMatch(/uap deliver "/);
    const body = deliver.replace(/^uap deliver /, '');
    expect(body.startsWith("'")).toBe(true);
    expect(body.endsWith("'")).toBe(true);
  });
});

describe('stripControlChars / shQuote', () => {
  it('removes ANSI/C0 control bytes from tool-result-derived text', () => {
    expect(stripControlChars('Error: [31mred[0m\nnext')).toBe('Error: rednext');
  });

  it('single-quotes with POSIX escaping', () => {
    expect(shQuote("don't")).toBe("'don'\\''t'");
    expect(shQuote('plain')).toBe("'plain'");
  });
});

describe('loopsCommand', () => {
  it('prints the empty state without failing', async () => {
    await expect(loopsCommand(undefined, { file: ledger })).resolves.toBeUndefined();
  });

  it('exits non-zero for an unknown incident id', async () => {
    writeLedger([INCIDENT]);
    const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(loopsCommand('zzz', { file: ledger })).rejects.toThrow('exit');
    expect(spy).toHaveBeenCalledWith(2);
    spy.mockRestore();
  });

  it('fingerprint prefix resolves to the NEWEST matching record', async () => {
    const pivot: LoopIncident = { ...INCIDENT, outcome: 'pivot', ts: '2026-09-25T13:19:22Z' };
    writeLedger([pivot, INCIDENT]); // pivot first, hard_blocked last
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    await loopsCommand('a1b2', { file: ledger });
    spy.mockRestore();
    expect(logs.join('\n')).toContain('hard_blocked');
    expect(logs.join('\n')).not.toMatch(/outcome:\s+pivot/);
  });
});
