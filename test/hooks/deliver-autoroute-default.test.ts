/**
 * P0 (2026-07-13): deliver_autoroute must default OFF. The auto-spawned run
 * carries only a vacuous "implement the intended change to <file>" hint (the
 * blocked edit's content is not plumbed through until plan D1), so a blind
 * background model per blocked file is fan-out risk, not help. The block
 * message must instead point the agent at the recorded intent.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const REPO = process.cwd();
const HELPER = join(REPO, 'templates', 'hooks', 'deliver_autoroute.py');

function runPy(code: string, envVal?: string): string {
  const env = { ...process.env } as Record<string, string>;
  delete env.UAP_DELIVER_AUTOROUTE;
  if (envVal !== undefined) env.UAP_DELIVER_AUTOROUTE = envVal;
  const r = spawnSync('python3', ['-c', code], { env, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return r.stdout.trim();
}

const LOAD = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(HELPER)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

function autorouteEnabled(envVal?: string): boolean {
  return JSON.parse(runPy(`${LOAD}\nprint(json.dumps(m._autoroute_enabled()))`, envVal));
}

describe('deliver_autoroute default posture', () => {
  it('defaults OFF — blind background spawns are opt-in', () => {
    expect(autorouteEnabled()).toBe(false);
  });

  it('opts in with UAP_DELIVER_AUTOROUTE=1/on/true/yes', () => {
    for (const v of ['1', 'on', 'true', 'yes']) expect(autorouteEnabled(v)).toBe(true);
  });

  it('stays off for the legacy disable spellings', () => {
    for (const v of ['0', 'off', 'false', 'no']) expect(autorouteEnabled(v)).toBe(false);
  });

  it('block message points at the recorded intent when not spawning', () => {
    const out = runPy(`${LOAD}
d = m.decide(
    {"reason": "BLOCKED: route through deliver", "route": "deliver", "deliverHint": "implement x"},
    "Edit", {"file_path": "/tmp/proj/src/a.ts"}, False, set())
print(json.dumps(d))
`);
    const d = JSON.parse(out);
    expect(d.spawn).toBe(false);
    expect(d.message).toContain('pending-deliver.jsonl');
    expect(d.message).toContain('uap deliver');
  });
});

describe('deliver_autoroute records replayable edit intents (P1, plan D1)', () => {
  it('the intent carries the blocked edit\'s old/new content', () => {
    const out = runPy(`${LOAD}
d = m.decide(
    {"reason": "BLOCKED", "route": "deliver", "deliverHint": "implement x"},
    "Edit",
    {"file_path": "/tmp/proj/src/a.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"},
    False, set())
print(json.dumps(d["intent"]))
`);
    const intent = JSON.parse(out);
    expect(intent.edit).toEqual({ old_string: 'const x = 1;', new_string: 'const x = 2;' });
  });

  it('prefers the enforcer-provided editIntent payload', () => {
    const out = runPy(`${LOAD}
d = m.decide(
    {"reason": "BLOCKED", "route": "deliver", "deliverHint": "implement x",
     "editIntent": {"content": "whole file"}},
    "Write", {"file_path": "/tmp/proj/src/b.ts", "content": "raw"}, False, set())
print(json.dumps(d["intent"]))
`);
    expect(JSON.parse(out).edit).toEqual({ content: 'whole file' });
  });
});
