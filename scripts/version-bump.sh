#!/bin/bash
set -euo pipefail

# version-bump.sh — Automated semver version bump with validation
#
# Usage:
#   ./scripts/version-bump.sh patch   # fix, chore, refactor, etc.
#   ./scripts/version-bump.sh minor   # feat (new functionality)
#   ./scripts/version-bump.sh major   # breaking changes
#
# What it does:
#   1. Validates working tree is clean
#   2. Runs tests and build
#   3. Bumps version in package.json
#   4. Commits package.json + package-lock.json
#   5. Creates git tag vX.Y.Z

LEVEL="${1:-}"

if [[ -z "$LEVEL" ]]; then
  echo "Usage: $0 <patch|minor|major>"
  echo ""
  echo "  patch  — bug fixes, chores, refactors (X.Y.Z+1)"
  echo "  minor  — new features (X.Y+1.0)"
  echo "  major  — breaking changes (X+1.0.0)"
  exit 1
fi

if [[ "$LEVEL" != "patch" && "$LEVEL" != "minor" && "$LEVEL" != "major" ]]; then
  echo "Error: level must be 'patch', 'minor', or 'major' (got '$LEVEL')"
  exit 1
fi

# 1. Validate working tree is clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  echo ""
  git status --short
  exit 1
fi

# Get current version before bump
OLD_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $OLD_VERSION"

# 2. Run build and tests to confirm project is healthy
echo ""
echo "Running build..."
npm run build 2>&1 || {
  echo "Error: build failed. Fix build before bumping version."
  exit 1
}

echo ""
echo "Running tests..."
npm test -- --run 2>&1 || {
  echo "Error: tests failed. Fix tests before bumping version."
  exit 1
}

# 2b. Restore clean tree (tests may create temp files like test droids)
git checkout -- . 2>/dev/null || true
find .factory/droids -maxdepth 1 -type f -name 'test-droid-*' -delete 2>/dev/null || true

# 3. Bump version in package.json (no git tag yet — we do it after the commit)
npm version "$LEVEL" --no-git-tag-version > /dev/null 2>&1

NEW_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "Version bump: $OLD_VERSION -> $NEW_VERSION ($LEVEL)"

# 4. Stage and commit
git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "chore: bump version to ${NEW_VERSION}"

# 5. Create git tag
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

echo ""
echo "Done: v${NEW_VERSION}"
echo "  - package.json updated"
echo "  - Committed: chore: bump version to ${NEW_VERSION}"
echo "  - Tagged: v${NEW_VERSION}"
echo ""
echo "To push: git push && git push --tags"
