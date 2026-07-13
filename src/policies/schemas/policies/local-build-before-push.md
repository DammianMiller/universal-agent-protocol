# local-build-before-push

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: build, push, ci, docker, compile-gate

## Rule

`git push` / `gh pr create` / `gh pr merge` are **blocked** while the local
branch contains compiled-source changes (default scope: the project's C++ API
tree) that have not passed a local Docker builder-stage compile. The pass
marker (`.uap/local-build-pass.txt`, written by the project's local-build
script) must record the current HEAD SHA.

## Why

The CI compile gate can take 10-50 minutes; the identical local Docker build
takes 2-5 minutes cached. Pushing unverified compiled-source changes burns CI
cycles on errors a local build catches immediately. The marker-ties-to-HEAD
design means "built something earlier" never satisfies the gate — only the
exact tree being pushed.

## Enforcement

Python enforcer `local_build_before_push.py` intercepts push/PR Bash commands,
diffs the branch against the base, and blocks when watched paths (default
`apps/api/` sources/CMake/Dockerfiles — adjust per project) changed without a
matching pass marker. Bypass: `UAP_SKIP_LOCAL_BUILD=1` (session env — justify
in the commit message). NOTE: the enforcer diffs against the LOCAL base ref;
keep local main fast-forwarded or already-merged changes read as phantom
diffs.

```rules
- title: "Compiled-source changes must pass a local Docker build before push/PR"
  keywords: [git push, gh pr create, gh pr merge, docker, build, compile]
  antiPatterns: ["push without local build verification"]
```
