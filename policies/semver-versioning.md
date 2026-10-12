# Semver Versioning

All version changes MUST follow Semantic Versioning 2.0.0 and be automated through `npm run version:patch`, `npm run version:minor`, or `npm run version:major`. Manual edits to the version field in `package.json` are prohibited.

**This repository keeps no changelog file.** Git history and tags are the release record: every version bump commits `package.json` and creates a `vX.Y.Z` tag, and release notes are derived from the conventional commits between tags. Living docs carry no version stamps — `package.json` and the git tags are the only version source, so docs cannot drift stale. Do not reintroduce a `CHANGELOG.md` for this repository; the changelog-format knowledge in the droid library serves host projects, not UAP itself.

## Rules

1. **Version bumps are derived from commit type.** The conventional commit prefix determines the bump level:
   - `fix:` -> patch (X.Y.Z+1)
   - `feat:` -> minor (X.Y+1.0)
   - `feat!:` or `BREAKING CHANGE:` -> major (X+1.0.0)
   - `chore:`, `docs:`, `refactor:`, `perf:`, `test:`, `style:`, `ci:` -> patch (X.Y.Z+1)

2. **Version bump happens AFTER the changes, never before.** The version bump commit must be the final commit in a changeset. Bumping the version before writing the code it describes is a policy violation.

3. **Version bump is automated.** Use the provided npm scripts which handle package.json update, git tag, and commit in a single atomic operation:

   ```bash
   npm run version:patch   # fix, chore, refactor, etc.
   npm run version:minor   # feat (new functionality)
   npm run version:major   # breaking changes
   ```

4. **Git tags are mandatory.** Every version bump creates a `vX.Y.Z` git tag. Tags must not be created manually or moved after creation.

5. **No manual package.json version edits.** Changing the `version` field directly in `package.json` bypasses validation and tagging. Always use the npm scripts.

6. **Version must be bumped before push.** Every push to master/main that contains functional changes must include a version bump commit. Pushing code changes without a corresponding version bump is a violation.

## Automation

The `scripts/version-bump.sh` script performs:

1. Validates the working tree is clean (no uncommitted changes)
2. Runs `npm test` and `npm run build` to confirm the project is healthy
3. Bumps the version in `package.json` using `npm version <level> --no-git-tag-version`
4. Stages `package.json` and `package-lock.json`
5. Creates a commit: `chore: bump version to X.Y.Z`
6. Creates a git tag: `vX.Y.Z`

## Anti-Patterns

DO NOT:

- Edit `package.json` version field manually
- Bump version before writing the code it describes
- Push code changes without a version bump
- Create version bump commits with unrelated code changes mixed in
- Delete or move git tags after creation

## Enforcement Level

[REQUIRED]

## Related Policies

- `completion-gate` — Version bump is part of the completion sequence
- `mandatory-testing-deployment` — Tests must pass before version bump
- `pre-edit-build-gate` — Build must pass before version bump
