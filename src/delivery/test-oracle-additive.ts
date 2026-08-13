/**
 * Additive test-edit sanctioning — the content rule that lets a mission ADD
 * tests to a protected test file without opening the oracle to weakening.
 *
 * Why this exists: protect-tests treats every pre-existing test file as an
 * immutable oracle, but real missions legitimately say "add test cases to
 * test/foo.test.js". Measured live (statlib runs 2–3, 2026-08-13): the
 * executor's flat refusal put the run in an internal deadlock — the
 * write-nudge escalation forced write rounds while the guard refused the only
 * write the mission required, and the refusal text ("change the
 * implementation, not the test") was actively misleading. The model burned
 * rounds re-attempting the same sanctioned edit and finally shipped without
 * the required tests.
 *
 * The rule is CONTAINMENT, not counting (review 2026-08-13: a titles-survive
 * + assertion-count heuristic sanctioned assertion swap-to-tautology, comment
 * burial, and import redefinition — a tripwire, not a boundary):
 *   1. the existing content must survive VERBATIM as a prefix — the edit may
 *      only APPEND after it (so nothing already in the oracle can be edited,
 *      deleted, commented out, or re-pointed), and
 *   2. the appended delta must not contain suppression modifiers (.only/.skip
 *      silence existing tests while their titles remain), process.exit, or
 *      reassignment of assertion machinery.
 * Anything the rule cannot POSITIVELY verify (no recognizable test cases in
 * the old content) stays refused. Non-test oracle material (fixtures,
 * helpers, data, gate scripts, manifests) is not this module's concern —
 * callers gate on isTestFilePath first and keep those fully locked.
 *
 * Bounded honestly: appended MODULE-SCOPE code still executes before test
 * callbacks run, so a deliberately adversarial append that patches the SUT's
 * module cache can weaken old tests without tripping the denylist. The
 * durable control for that residual is behavioral: compare the runner's
 * per-test results against baseline (the ladder already captures per-test
 * names) — tracked as follow-up. This rule closes the convergence-drift
 * paths a model reaches by gradient, in every write layer, with ONE
 * definition — a divergence between layers is how "two write paths, one
 * guard" incidents happen.
 */

/** Test-case titles: JS/TS (test/it/describe, incl. .each/.skip forms) and python (def test_*). */
const JS_TITLE_RE = /\b(?:test|it|describe)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
const PY_TITLE_RE = /\bdef\s+(test_\w+)\s*\(/g;

/**
 * Suppression modifiers that make a textually-additive edit behaviorally
 * SUBTRACTIVE: in vitest/jest, one `it.only` silences every other test in the
 * file; `.skip`/`x*`/`f*`, options objects (`{ skip: true }`/`{ only: true }`),
 * runtime skips and the python decorators disable tests while their titles
 * remain present. Checked over the appended DELTA only — a pre-existing
 * `.skip` in the frozen prefix is not the edit's doing.
 */
const SUPPRESSOR_RE =
  // Any member-call spelling of a suppression modifier — deliberately NOT
  // anchored to test/it/describe, so chained forms (`test.each(t).only(...)`,
  // `it.concurrent.only(...)`) and computed access are caught too. A stray
  // `.skip(` on a non-test object in appended code is a false refusal, which
  // is the safe direction.
  /[.\s]\s*(?:only|skip|todo|skipIf|runIf)\s*\(|\[\s*['"`](?:only|skip|todo)['"`]\s*\]|\b(?:xit|xdescribe|xtest|fit|fdescribe|ftest)\s*\(|\bonly\s*:\s*true|\bskip\s*:\s*true|\bpytest\.(?:mark\.)?skip|@unittest\.skip/g;

/** Module-scope escapes that end or neutralize the run before old tests execute. */
const EXIT_RE = /\bprocess\s*\.\s*exit\s*\(/g;

/** Reassignment of assertion machinery (assert.equal = noop, expect = ...). */
const ASSERT_PATCH_RE = /\b(?:assert|expect)(?:\s*\.\s*\w+)?\s*=(?![=>])/g;

/**
 * Appended FILE-SCOPE lifecycle hooks and module mocking apply to the frozen
 * tests too — an appended `beforeEach` that stubs the SUT weakens every
 * existing test without touching a byte of them. New tests that need hooks or
 * mocks belong in a NEW file, which is always allowed.
 */
const HOOK_OR_MOCK_RE =
  /\b(?:beforeEach|beforeAll|afterEach|afterAll)\s*\(|\b(?:vi|jest)\s*\.\s*(?:mock|doMock|unmock|stubGlobal|stubEnv|spyOn)\s*\(|\brequire\s*\.\s*cache\b|\bmock\s*\.\s*method\s*\(/g;

export function extractTestTitles(source: string): string[] {
  const titles: string[] = [];
  for (const m of source.matchAll(JS_TITLE_RE)) titles.push(m[2]);
  for (const m of source.matchAll(PY_TITLE_RE)) titles.push(m[1]);
  return titles;
}

/**
 * Null when replacing `oldContent` with `newContent` is a sanctioned ADDITIVE
 * test edit; otherwise a short human-readable refusal reason.
 */
export function additiveTestEditRefusal(oldContent: string, newContent: string): string | null {
  if (extractTestTitles(oldContent).length === 0) {
    // Nothing recognizable to preserve means nothing verifiable to allow —
    // and it keeps code-shaped fixtures from gaining the carve-out.
    return 'the existing file has no recognizable test cases to verify preservation against';
  }
  // Containment: existing content must survive verbatim, as a prefix.
  const frozen = oldContent.replace(/\s+$/, '');
  if (!newContent.startsWith(frozen)) {
    return 'it rewrites existing content — only APPENDING new tests after the existing content is allowed';
  }
  const delta = newContent.slice(frozen.length);
  // Token-boundary guard: the append must start on fresh whitespace, not glue
  // characters onto the last existing token.
  if (delta.length > 0 && !/^\s/.test(delta)) {
    return 'the appended content must start on a new line after the existing content';
  }
  if ([...delta.matchAll(SUPPRESSOR_RE)].length > 0) {
    return 'it adds test-suppression modifiers (.only/.skip/.todo/x*/f*/skip options), which silence existing tests while their titles remain';
  }
  if ([...delta.matchAll(EXIT_RE)].length > 0) {
    return 'it adds process.exit, which can end the run before existing tests execute';
  }
  if ([...delta.matchAll(ASSERT_PATCH_RE)].length > 0) {
    return 'it reassigns assertion machinery (assert/expect), which can neutralize existing tests';
  }
  if ([...delta.matchAll(HOOK_OR_MOCK_RE)].length > 0) {
    return (
      'it appends file-scope lifecycle hooks or module mocking (beforeEach/vi.mock/mock.method/…), ' +
      'which affect the existing tests — put tests that need hooks or mocks in a NEW test file'
    );
  }
  return null;
}

/**
 * The refusal message shown when a protected test file edit is NOT additive.
 * Names the sanctioned move — the old flat text steered models away from the
 * one edit their mission required.
 */
export function protectedTestRefusal(path: string, reason: string): string {
  return (
    `ERROR: ${path} is a protected pre-existing test file and this edit is not additive — ${reason}. ` +
    'You MAY append new test cases at the END of this file (everything already in it must remain byte-identical), ' +
    'or create a NEW test file alongside it. Never remove, rename, or weaken existing tests.'
  );
}
