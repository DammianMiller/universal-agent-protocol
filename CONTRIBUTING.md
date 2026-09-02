# Contributing to UAP

`v1.224.0`

Thanks for contributing to the Universal Agent Protocol. This guide covers the
development setup, the worktree workflow, the completion gates every change must
pass, and the PR process. The gates here are not aspirational — many are
enforced at runtime by UAP's own policy hooks, so the smoothest path is to
follow the workflow exactly.

For architecture, read [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md);
for the protocol UAP enforces, read
[docs/architecture/PROTOCOL.md](docs/architecture/PROTOCOL.md).

---

## Development setup

Requires **Node.js >= 18**.

```bash
git clone https://github.com/DammianMiller/universal-agent-protocol.git
cd universal-agent-protocol

npm install        # install dependencies
npm run build      # compile TypeScript (tsc) → dist/
npm test           # run the test suite (459 vitest test files)
```

Common scripts (from `package.json`):

| Script | What it does |
|--------|--------------|
| `npm run build` | `tsc` — compile to `dist/` |
| `npm run dev` | `tsc --watch` — incremental rebuilds |
| `npm test` | `vitest` — run all 459 vitest test files |
| `npm run test:ci` | `vitest run` — non-watch test run for CI |
| `npm run test:enforcers` | Python enforcer/proxy suite (~74 modules under `tools/agents/tests/`, ~1200 tests) |
| `npm run test:coverage` | tests with V8 coverage |
| `npm run bench` | benchmark suite (`vitest.bench.config.ts`) |
| `npm run lint` | `eslint src --ext .ts` |
| `npm run lint:fix` | ESLint with autofix |
| `npm run format` | Prettier over `src/**/*.ts` |
| `npm run install:web` | install the web dashboard (`scripts/setup/install-web.sh`) |
| `npm run install:desktop` | install the desktop app (`scripts/setup/install-desktop.sh`) |
| `npm run install:cloakbrowser` | install the cloak browser (`scripts/setup/install-cloakbrowser.ts`) |
| `npm run update-uap` | update UAP compliance artifacts (`scripts/maintenance/update-uap-compliance.sh`) |
| `npm run verify-uap` | verify UAP compliance (`scripts/maintenance/verify-compliance.sh`) |
| `npm run version:patch \| :minor \| :major` | bump version via `scripts/version-bump.sh` |

Type-checking is part of the build (`tsc`); for a check without emit use
`npx tsc --noEmit`.

---

## The worktree workflow

**All edits MUST happen inside a git worktree under `.worktrees/NNN-<slug>/`.**
Editing files in the project root is blocked by the worktree policy gate. This
applies to every file type — source, tests, docs, configs.

```bash
uap worktree ensure --strict     # exit 0 confirms you're inside a worktree
uap worktree create <slug>       # auto-numbered branch + worktree if not
# ... make your changes inside .worktrees/NNN-<slug>/ ...
uap worktree pr                  # open a PR from the worktree branch → master
uap worktree finish              # clean up after the PR merges
```

Rules:

- Branch and commit **only** inside the worktree.
- Open PRs from the worktree branch against `master`.
- Run the version bump on the **feature branch**, never on `master`.

Read-only work (analysis, diagnostics, queries) does not require a worktree.

---

## Completion gates

A change is not done until **all** of these pass. Verify before claiming
completion; CI and UAP's policy enforcers check them too.

1. **New tests** — add test cases (vitest, under `test/`) covering the changed
   behavior. Aim for at least two cases per behavioral change.
2. **Tests pass** — `npm test` with no failures.
3. **Build** — `npm run build` succeeds with zero errors.
4. **Lint & type-check** — `npm run lint` and `npx tsc --noEmit` pass cleanly.
5. **Version bump** — bump via the scripts below (no manual edits to
   `package.json`):

   ```bash
   npm run version:patch   # fix, chore, refactor, docs, test, style, ci
   npm run version:minor   # feat (new backwards-compatible functionality)
   npm run version:major   # breaking changes (feat! or BREAKING CHANGE)
   ```

6. **Self-review** — review the diff for correctness, no debug code, no secrets,
   no unresolved TODOs.

A fast way to drive a change through gates 2–4 automatically is the convergence
loop:

```bash
uap deliver "implement <change>"   # iterates a model against the real gates
```

See [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md#how-uap-deliver-orchestrates).

---

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/). The prefix
determines the version bump:

| Prefix | Meaning | Bump |
|--------|---------|------|
| `fix:` | bug fix | patch |
| `chore:`, `refactor:`, `docs:`, `test:`, `style:`, `ci:` | maintenance | patch |
| `feat:` | new backwards-compatible feature | minor |
| `feat!:` / `BREAKING CHANGE:` | breaking change | major |

Examples:

```
fix(memory): correct semantic recall dimension mismatch
feat(deliver): add --until-delivered ceiling flag
docs(architecture): rewrite protocol spec
```

---

## Pull request process

1. Work inside a worktree (`uap worktree create <slug>`).
2. Make changes; keep the build green between edits.
3. Pass all completion gates (above) and bump the version on the branch.
4. For non-trivial changes, run parallel review (correctness, security,
   architecture) before opening the PR; note any skipped review in the PR body.
5. Open the PR against `master` (`uap worktree pr`).
6. Ensure CI is green; address review feedback.
7. After merge, `uap worktree finish` to clean up.

---

## Project layout

```
src/           26 subsystems, 367 TypeScript modules (see docs/architecture/OVERVIEW.md)
test/          459 vitest test files
docs/          architecture, integrations, getting-started, reference
web/           web dashboard
tools/         agent tooling, including the Python enforcer/proxy tests
benchmarks/    benchmark suites and results
policies/      built-in policy markdown files
skills/        project skills
infra/         infrastructure-as-code
deploy/        deployment artifacts
templates/     hook scripts installed by `uap hooks install`
scripts/       setup, version-bump, maintenance
config/        model profiles and defaults
```

Questions or proposals: open an issue at
https://github.com/DammianMiller/universal-agent-protocol/issues
