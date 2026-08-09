/**
 * The manual-version-edit guard must scope to a single shell STATEMENT.
 *
 * The rule blocks `sed`/`awk`/`jq` edits to package.json's version field, and it
 * is correct about every real spelling of that. But it matched across the WHOLE
 * command line, so a sed in one statement plus `package.json` … `version` in an
 * unrelated one tripped it — and that shape is a READ:
 *
 *   curl ... | sed 's/^/x/'; node -p "require('./package.json').version"
 *
 * Measured live on 2026-08-09: reading the published version alongside ordinary
 * output munging was refused as a "manual package.json version edit". Splitting
 * on `;`, `|`, `&` and newline keeps every real edit — each has its verb and
 * package.json inside one statement — and drops the coincidence.
 *
 * Every installed copy is covered, plus templates/: without the template the
 * next `uap worktree create` reinstalls the unscoped version.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Only the SOURCES OF TRUTH: the template every install is generated from, and
 * the one tracked copy (.claude/ symlinks to it).
 *
 * `.codex/`, `.cursor/`, `.forge/` and `.opencode/` are generated, untracked
 * artifacts — any test that installs or refreshes hooks rewrites them mid-run,
 * which made an earlier version of this file pass in isolation and fail in the
 * full suite. Asserting on a derived artifact tests whatever last wrote it.
 */
const TEMPLATE = join(process.cwd(), 'templates', 'hooks', 'pre-tool-use-bash.sh');
const TRACKED = join(process.cwd(), '.factory', 'hooks', 'pre-tool-use-bash.sh');

/**
 * Behaviour is exercised against ONE hook, not both.
 *
 * The hook extracts its command with `jq` and fails OPEN when that yields
 * nothing:
 *
 *     CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' ...)
 *     if [ -z "$CMD" ]; then exit 0; fi
 *
 * Under the full parallel suite hundreds of concurrent `jq` spawns make that
 * reachable, and a silent fail-open is indistinguishable from a genuine allow.
 * Every extra execution doubles the exposure, so the two copies are compared as
 * FILES (no process at all) and only the template is executed.
 */
const HOOKS = [TEMPLATE].filter((p) => existsSync(p));

/**
 * Run a hook the way the harness does: tool JSON on stdin.
 *
 * Three outcomes, not two. These hooks consult the policies DB, which under a
 * full parallel suite occasionally returns `database is locked` — the hook then
 * exits non-zero WITHOUT the semver message. Treating that as "allowed" made
 * this test flaky in the suite while passing in isolation, so an infrastructure
 * error is retried rather than scored.
 */
function runHook(hook: string, command: string): 'refused' | 'allowed' | 'infra-error' {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  let text: string;
  let killed = false;
  try {
    text = execFileSync('bash', [hook], { input: payload, encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; signal?: string; code?: string };
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    // A timeout kills the child with a signal. That is an ABSENT verdict, not a
    // permission — reading it as "allowed" is what still made this flaky under
    // the full parallel suite.
    //
    // Note the asymmetry: a hook that ALLOWS exits 0 silently, so empty output
    // on a clean exit genuinely means allowed. Only a kill is inconclusive.
    killed = Boolean(err.signal) || err.code === 'ETIMEDOUT';
  }
  // Any refusal counts. Several rules live in this hook and their order is not
  // guaranteed: `jq ... > tmp && mv tmp package.json` also shell-WRITES
  // package.json, which delivery-enforcement refuses with its own message.
  // Requiring the semver message specifically scored those refusals as ALLOWED
  // and made this file intermittently fail under the parallel suite. The
  // contract here is "must be refused"; the test at the foot of this file pins
  // that semver is the rule doing the work for a case only it can claim.
  if (/BLOCKED \[/.test(text) || /semver-versioning/.test(text)) return 'refused';
  if (killed) return 'infra-error';
  if (/database is locked|could not run|FAIL-CLOSED/i.test(text)) return 'infra-error';
  return 'allowed';
}

/**
 * A command this hook ALWAYS refuses, used to prove the hook actually ran.
 *
 * The fail-open path (`jq` yields nothing -> `exit 0`) is silent and therefore
 * indistinguishable from a genuine allow. But it is indiscriminate: when it
 * fires, EVERYTHING is allowed. So when a case that should be refused comes
 * back allowed, re-ask with the canary. If the canary is allowed too, the hook
 * did not evaluate anything and the answer is inconclusive, not permission.
 */
const CANARY = 'terraform apply -auto-approve';

/** Did the hook evaluate at all? The canary is refused by a DIFFERENT rule. */
function hookIsLive(hook: string): boolean {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: CANARY } });
  try {
    execFileSync('bash', [hook], { input: payload, encoding: 'utf8', timeout: 60_000 });
    return false; // exit 0 on the canary => the hook failed open
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    // Any refusal proves it ran; the canary trips iac-pipeline-enforcement, not
    // semver, so this must not look for the semver message specifically.
    return /BLOCKED/.test(`${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

function refusedOnce(hook: string, command: string): 'refused' | 'allowed' | 'infra-error' {
  const r = runHook(hook, command);
  if (r !== 'allowed') return r;
  // Allowed — but did the hook actually evaluate anything?
  return hookIsLive(hook) ? 'allowed' : 'infra-error';
}

function blocks(hook: string, command: string): boolean {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = refusedOnce(hook, command);
    if (r !== 'infra-error') return r === 'refused';
  }
  throw new Error(`hook never produced a verdict (kept failing open): ${hook}`);
}

const REAL_EDITS = [
  `sed -i 's/"version": "1.0.0"/"version": "2.0.0"/' package.json`,
  `sed -i.bak 's/version/v/' package.json`,
  `jq '.version = "9.9.9"' package.json > tmp && mv tmp package.json`,
  `awk '{gsub(/version/,"x")}1' package.json`,
  `cat x | sed -i 's/version/y/' package.json`,
];

const READS = [
  // The two shapes that were refused live.
  `curl -s reg | sed 's/^/x/'; node -p "require('./package.json').version"`,
  `sed -n '1,5p' README.md; echo package.json version`,
  // Ordinary reads that were already fine — regression guards.
  `npm view @miller-tech/uap version | sed 's/^/npm: /'`,
  `cat package.json | grep version`,
  `node -p "require('./package.json').version"`,
  `git log --oneline | sed 's/^/  /'`,
];

describe('semver guard: real edits stay blocked', () => {
  it('the tracked copy and the template are byte-identical', () => {
    // Cheap identity check instead of a second round of hook executions: a
    // divergence still fails, without doubling the jq spawns.
    expect(existsSync(TEMPLATE)).toBe(true);
    expect(existsSync(TRACKED)).toBe(true);
    expect(readFileSync(TRACKED, 'utf8')).toBe(readFileSync(TEMPLATE, 'utf8'));
    expect(HOOKS.length).toBe(1);
  });

  for (const cmd of REAL_EDITS) {
    it(`blocks: ${cmd.slice(0, 52)}`, () => {
      for (const hook of HOOKS) expect(blocks(hook, cmd), hook).toBe(true);
    });
  }
});

describe('semver guard: reading a version is not editing it', () => {
  for (const cmd of READS) {
    it(`allows: ${cmd.slice(0, 52)}`, () => {
      for (const hook of HOOKS) expect(blocks(hook, cmd), hook).toBe(false);
    });
  }
});

describe('semver is the rule that catches a pure version edit', () => {
  it('names semver-versioning for an edit no other rule claims', () => {
    // An in-place sed is not a shell write redirect, so nothing else claims it.
    const cmd = [
      "sed -i 's/",
      '"version": "1.0.0"',
      '/',
      '"version": "2.0.0"',
      "/' package.json",
    ].join('');
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } });
    let text = '';
    try {
      execFileSync('bash', [TEMPLATE], { input: payload, encoding: 'utf8', timeout: 60_000 });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(text).toMatch(/semver-versioning/);
  });
});
