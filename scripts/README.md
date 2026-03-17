# Setup Scripts

This directory contains automated setup and installation scripts for UAP.

## Scripts

### `setup.sh` - Complete Setup

```bash
npm run setup
```

Performs a comprehensive setup including:

- ✅ Dependency checking (Node.js, npm, git, npx)
- ✅ Optional dependency recommendations (Docker, Python, pre-commit)
- ✅ npm install (if node_modules missing)
- ✅ TypeScript build
- ✅ Git hooks configuration:
  - `pre-commit` - Secrets detection, linting
  - `commit-msg` - Conventional commits validation
  - `pre-push` - Test execution before push
- ✅ GitHub PR template (if gh CLI available)

### `install-web.sh` - Web Platform Setup

```bash
npm run install:web
```

Installs UAP for web platform usage (claude.ai, Factory.AI):

- Installs CLI globally or from GitHub
- Initializes web platform configuration
- Sets up for web-based AI assistants

### `install-desktop.sh` - Desktop Setup

```bash
npm run install:desktop
```

Installs UAP for desktop usage:

- Installs CLI globally or from GitHub
- Detects Docker for local Qdrant
- Initializes desktop platform configuration
- Provides setup guidance

## Usage

### Quick Setup

```bash
# Install UAP globally
npm install -g universal-agent-protocol

# Run comprehensive setup
npm run setup

# Initialize in your project
uap init
```

### Platform-Specific Setup

```bash
# For web platforms (claude.ai, Factory.AI)
npm run install:web

# For desktop (Claude Code, opencode)
npm run install:desktop
```

## Git Hooks

The `setup.sh` script configures three git hooks:

### Pre-commit Hook

- **Purpose**: Prevent secrets from being committed
- **Checks**:
  - Scans for API keys, passwords, tokens in code
  - Runs linter with zero warnings allowed
- **Bypass**: `git commit --no-verify`

### Commit-msg Hook

- **Purpose**: Enforce conventional commits format
- **Validates**: `type(scope): description` format
- **Types**: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert
- **Bypass**: Confirm with 'y' when prompted

### Pre-push Hook

- **Purpose**: Ensure tests pass before pushing
- **Runs**: `npm test`
- **Bypass**: None (tests must pass)

## Troubleshooting

### Hooks not executing

```bash
# Make hooks executable
chmod +x .git/hooks/*

# Verify hooks exist
ls -la .git/hooks/ | grep -v sample
```

### Setup script fails

```bash
# Check Node.js version
node --version  # Should be >= 18.0.0

# Check npm
npm --version

# Clear and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Manual hook installation

If automatic setup fails, manually create hooks:

```bash
# Pre-commit
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
npm run lint -- --max-warnings=0
exit $?
EOF
chmod +x .git/hooks/pre-commit

# Commit-msg
cat > .git/hooks/commit-msg << 'EOF'
#!/bin/bash
# Conventional commits validation
exit 0
EOF
chmod +x .git/hooks/commit-msg
```

## Best Practices

1. **Always run `npm run setup`** after cloning or updating UAP
2. **Review generated hooks** before committing
3. **Keep hooks in sync** with project requirements
4. **Document custom hooks** in project README
5. **Test hooks** with `git commit --no-verify` first

## Security Notes

- Git hooks run locally and cannot access remote repositories
- Pre-commit hook only scans TypeScript/JavaScript/JSON files
- Secrets detection is best-effort (not exhaustive)
- Always use environment variables for sensitive data
