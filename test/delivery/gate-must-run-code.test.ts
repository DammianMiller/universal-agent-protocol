/**
 * A self-authored gate that never RUNS the code it is grading.
 *
 * Surveyed on this machine: 3 of 4 real acceptance gates execute nothing at
 * all. They assert on the source text instead — `grep -q "return (sr, src)"`,
 * `grep -q "SetOfIterator<'static, (i64, i64)>"` — which grades how the
 * implementation is SPELLED, not what it does. Two failures follow from that,
 * and both were seen live this session:
 *
 *   - a correct solution phrased differently can never pass, so the mission is
 *     unwinnable and the run loops until it runs out of turns;
 *   - text that matches but does not work passes, so the run reports success
 *     over code nobody executed.
 *
 * The response is deliberately mild: ONE regeneration with feedback naming the
 * problem. Some tasks genuinely have nothing to run — a docs change, a config
 * file — so after that attempt the gate is accepted as authored. The cost of
 * being wrong is one model call; the cost of hard-rejecting would be a task
 * that can never author a gate at all.
 */
import { describe, it, expect } from 'vitest';
import { neverExecutesReason } from '../../src/delivery/self-gate.js';

describe('detecting a gate that only reads source', () => {
  it('flags a pure grep gate', () => {
    const script = `#!/usr/bin/env bash
set -e
grep -q "function slugify" src/slug.js || { echo "missing"; exit 1; }
grep -q "toLowerCase" src/slug.js || exit 1
`;
    expect(neverExecutesReason(script)).toBeTruthy();
  });

  it('flags one that only checks files exist', () => {
    expect(neverExecutesReason('[ -f src/slug.js ] || exit 1\n[ -d test ] || exit 1\n')).toBeTruthy();
  });

  it('names running the code as the remedy', () => {
    const reason = neverExecutesReason('grep -q foo src/a.js || exit 1\n') ?? '';
    expect(reason).toMatch(/run|execute/i);
    expect(reason, 'and say what to assert on instead').toMatch(/output|behaviou?r/i);
  });
});

describe('what it must NOT flag', () => {
  const ok = (script: string) => expect(neverExecutesReason(script)).toBeNull();

  it('a gate that runs the test suite', () => {
    ok('#!/usr/bin/env bash\nnpm test --silent || exit 1\n');
  });

  it('a gate that runs a python module', () => {
    ok('python3 -m pytest -q || exit 1\n');
  });

  it('a gate that invokes node directly on the artifact', () => {
    ok(`node -e "import('./src/slug.js').then(m => process.exit(m.slugify('A B') === 'a-b' ? 0 : 1))"\n`);
  });

  it('a gate that builds with cargo', () => {
    ok('cargo test --workspace || exit 1\n');
  });

  it('a gate that greps the OUTPUT of a command it ran', () => {
    // Grep is fine as a supplement — the objection is to grep INSTEAD of running.
    ok('node dist/cli.js --help | grep -q "usage" || exit 1\n');
  });

  it('ignores executable-looking words inside comments', () => {
    // A comment mentioning npm must not make a grep-only gate look like it runs.
    const script = '# we could npm test here but do not\ngrep -q foo src/a.js || exit 1\n';
    expect(neverExecutesReason(script)).toBeTruthy();
  });

  it('does not fire on an empty script', () => {
    // Nothing to judge; other validators own that case.
    ok('');
  });
});
