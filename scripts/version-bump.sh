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
#   4. Prepends dated entry to CHANGELOG.md
#   5. Commits package.json + CHANGELOG.md
#   6. Creates git tag vX.Y.Z

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

# 2. Run tests and build to confirm project is healthy
echo ""
echo "Running tests..."
npm test -- --run 2>&1 || {
  echo "Error: tests failed. Fix tests before bumping version."
  exit 1
}

echo ""
echo "Running build..."
npm run build 2>&1 || {
  echo "Error: build failed. Fix build before bumping version."
  exit 1
}

# 2b. Restore clean tree (tests may create temp files like test droids)
git checkout -- . 2>/dev/null || true
git clean -fd .factory/droids/test-droid-* 2>/dev/null || true

# 3. Bump version in package.json (no git tag yet — we do it after changelog)
npm version "$LEVEL" --no-git-tag-version > /dev/null 2>&1

NEW_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "Version bump: $OLD_VERSION -> $NEW_VERSION ($LEVEL)"

# 4. Prepend dated entry to CHANGELOG.md
DATE=$(date +%Y-%m-%d)
CHANGELOG_ENTRY="## v${NEW_VERSION} (${DATE})"

# Get commit messages since last tag for the changelog body
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
  COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"- %s" --no-merges 2>/dev/null || echo "")
else
  COMMITS=$(git log --pretty=format:"- %s" --no-merges -10 2>/dev/null || echo "")
fi

if [[ -z "$COMMITS" ]]; then
  COMMITS="- Version bump"
fi

# Build the new changelog section
CHANGELOG_SECTION="${CHANGELOG_ENTRY}

${COMMITS}
"

# Prepend to CHANGELOG.md (after the # Changelog header)
if [[ -f "CHANGELOG.md" ]]; then
  # Insert after the first line (# Changelog header)
  HEADER=$(head -1 CHANGELOG.md)
  BODY=$(tail -n +2 CHANGELOG.md)
  cat > CHANGELOG.md <<EOF
${HEADER}

${CHANGELOG_SECTION}
${BODY}
EOF
else
  cat > CHANGELOG.md <<EOF
# Changelog

${CHANGELOG_SECTION}
EOF
fi

echo "Updated CHANGELOG.md with v${NEW_VERSION} entry"

# 5. Stage and commit
git add package.json package-lock.json CHANGELOG.md 2>/dev/null || git add package.json CHANGELOG.md
git commit -m "chore: bump version to ${NEW_VERSION}"

# 6. Create git tag
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

echo ""
echo "Done: v${NEW_VERSION}"
echo "  - package.json updated"
echo "  - CHANGELOG.md updated"
echo "  - Committed: chore: bump version to ${NEW_VERSION}"
echo "  - Tagged: v${NEW_VERSION}"
echo ""
echo "To push: git push && git push --tags"
