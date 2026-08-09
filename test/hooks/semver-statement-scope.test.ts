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
import { existsSync } from 'fs';
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
const HOOKS = ['templates', '.factory']
  .map((d) => join(process.cwd(), d, 'hooks', 'pre-tool-use-bash.sh'))
  .filter((p) => existsSync(p));

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
  try {
    text = execFileSync('bash', [hook], { input: payload, encoding: 'utf8', timeout: 30_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  if (/semver-versioning/.test(text)) return 'refused';
  if (/database is locked|could not run|FAIL-CLOSED/i.test(text)) return 'infra-error';
  return 'allowed';
}

function blocks(hook: string, command: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = runHook(hook, command);
    if (r !== 'infra-error') return r === 'refused';
  }
  throw new Error(`hook kept failing for infrastructure reasons: ${hook}`);
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
  it('finds both sources of truth', () => {
    // If a copy goes missing the loop below would vacuously pass.
    expect(HOOKS.length).toBe(2);
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
