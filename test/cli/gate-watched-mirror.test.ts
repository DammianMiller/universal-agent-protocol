/**
 * GATE_WATCHED_RE in src/cli/schema-diff.ts duplicates WATCHED_RE in
 * src/policies/enforcers/schema_diff_gate.py, and the two MUST stay identical.
 *
 * The gate demands that every watched path be covered by the pass marker, and
 * only paths the CLI examines get into the marker. When the gate watched a
 * superset, the difference was a permanent, unclearable block on the policy's
 * headline file class: `infra/helm_charts/pgdog/values.yaml` could never be
 * recorded, so the refusal told the operator to re-run a command that produced
 * the identical marker. Verified before the fix.
 *
 * The source comment claimed a test pinned this mirroring. It did not exist —
 * a reviewer found the claim false. This is that test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { GATE_WATCHED_RE } from '../../src/cli/schema-diff.js';

const enforcer = join(
  __dirname,
  '..',
  '..',
  'src',
  'policies',
  'enforcers',
  'schema_diff_gate.py'
);

/** One representative path per alternation branch of the enforcer's pattern. */
const WATCHED_SAMPLES = [
  'migrations/001_add_table.sql',
  'infra/postgres-spock/cluster.yaml',
  'infra/helm_charts/pgdog/values.yaml',
  'infra/helm_charts/cnpg-cluster/values.yaml',
  'infra/helm_charts/redis-sentinel/values.yaml',
  'infra/helm_charts/envoy-proxy/values.yaml',
  'infra/helm_charts/sentinel/values.yaml',
];

describe('gate/CLI watched-pattern mirroring', () => {
  it('every path the gate watches is one the CLI would examine', () => {
    for (const p of WATCHED_SAMPLES) {
      expect(GATE_WATCHED_RE.test(p), `${p} must be examinable, or it can never be covered`).toBe(
        true
      );
    }
  });

  it('both patterns span a newline, because a path may contain one', () => {
    // `.` stops at a newline unless dotAll is set, so `migrations/a\nb.sql`
    // matched neither pattern — the gate did not treat it as watched at all
    // and never examined the column drop inside it. Git hides this by
    // C-quoting such names in its default output; the gate's -z enumeration
    // hands over the real bytes, which is where the gap surfaced.
    const py = readFileSync(enforcer, 'utf-8');
    expect(py, 'the enforcer pattern must be DOTALL').toMatch(
      /WATCHED_RE = re\.compile\([\s\S]*?re\.(I|IGNORECASE)\s*\|\s*re\.(S|DOTALL)/
    );
    expect(GATE_WATCHED_RE.dotAll, 'the CLI mirror must be DOTALL too').toBe(true);
    expect(GATE_WATCHED_RE.test('migrations/a\nb.sql')).toBe(true);
  });

  it('the two patterns are literally the same alternation', () => {
    // Extract the Python source pattern and compare the alternation branches.
    // Comparing branch sets rather than raw strings tolerates the r"" line
    // wrapping while still failing if either side gains or loses a branch.
    const py = readFileSync(enforcer, 'utf-8');
    const m = py.match(/WATCHED_RE = re\.compile\(\s*([\s\S]*?),\s*re\.[^)]*\)/);
    expect(m, 'could not locate WATCHED_RE in the enforcer').toBeTruthy();
    const pySrc = (m as RegExpMatchArray)[1]
      .replace(/r?"([^"]*)"/g, '$1')
      .replace(/[\s,]/g, '');
    const branches = (s: string) =>
      new Set(
        s
          .replace(/^\(|\)$/g, '')
          .split('|')
          .map((b) => b.replace(/\\/g, ''))
          .filter(Boolean)
      );
    expect(branches(pySrc)).toEqual(branches(GATE_WATCHED_RE.source));
  });

  it('a path outside the watched set is not forced into examination', () => {
    expect(GATE_WATCHED_RE.test('src/cli/unrelated.ts')).toBe(false);
    expect(GATE_WATCHED_RE.test('infra/helm_charts/grafana/values.yaml')).toBe(false);
  });
});
