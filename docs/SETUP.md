# UAP Setup Guide

Complete setup instructions for Universal Agent Memory.

## Quick Setup

```bash
# Install UAP CLI
npm install -g universal-agent-protocol

# Run comprehensive setup
npm run setup

# Initialize in your project
uap init
```

## Dependencies

### Required

- **Node.js >= 18.0.0** - Runtime environment
- **npm** - Package manager
- **git** - Version control (required for git hooks)
- **npx** - Runs CLI tools (included with npm)

### Optional but Recommended

- **Docker** - Enables local Qdrant for semantic search
- **Python 3** - Enables Pattern RAG indexing
- **pre-commit** - Provides advanced git hooks

## Installation by Platform

### macOS

```bash
# Install all dependencies
brew install node@18 git python docker

# Install UAP
npm install -g universal-agent-protocol

# Run setup
npm run setup
```

### Ubuntu/Debian

```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install other dependencies
sudo apt-get install -y git python3 docker.io

# Install UAP
npm install -g universal-agent-protocol

# Run setup
npm run setup
```

### Windows

```powershell
# Install all dependencies using winget
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Python.Python.3.12
winget install Docker.DockerDesktop

# Install UAP
npm install -g universal-agent-protocol

# Run setup
npm run setup
```

## Git Hooks

The setup script automatically configures the following git hooks:

### Pre-commit Hook

- Checks for secrets in committed files
- Runs linter with zero warnings allowed
- Prevents accidental commits of sensitive data

### Commit-msg Hook

- Validates conventional commits format
- Suggests proper format if invalid
- Allows override with confirmation

### Pre-push Hook

- Runs all tests before pushing
- Prevents pushing broken code

## Environment Setup

### Required Environment Variables

None required for basic functionality.

### Optional Environment Variables

```bash
# GitHub token for GitHub memory backend
export GITHUB_TOKEN=your_token_here

# Qdrant Cloud credentials for semantic search
export QDRANT_API_KEY=your_key_here
export QDRANT_URL=your_url_here

# Local Qdrant (if running Docker)
export QDRANT_URL=http://localhost:6333
```

## Verification

After setup, verify everything is working:

```bash
# Check UAP CLI
uap --version

# Check memory status
uap memory status

# Run tests
npm test

# Check git hooks
ls -la .git/hooks/
```

## Troubleshooting

### Git hooks not running

```bash
# Make hooks executable
chmod +x .git/hooks/*

# Verify hooks are active
ls -la .git/hooks/ | grep -v sample
```

### TypeScript build fails

```bash
# Clear cache and rebuild
rm -rf dist node_modules/.cache
npm run build
```

### npm install fails

```bash
# Clear npm cache
npm cache clean --force

# Reinstall
rm -rf node_modules package-lock.json
npm install
```

### Docker not available

No problem! UAP will use cloud backends. You can add Docker later:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Start Qdrant
uap memory start
```

## Next Steps

1. **Review the generated CLAUDE.md** - Customize as needed
2. **Set up cloud backends** - Add your API keys
3. **Start working** - Your AI assistant will follow the workflows automatically

## Uninstallation

```bash
# Remove global package
npm uninstall -g universal-agent-protocol

# Remove from your project
rm -rf .uap.json CLAUDE.md agents/ .worktrees/
```

## Support

- **Documentation**: [GitHub README](https://github.com/DammianMiller/universal-agent-protocol)
- **Issues**: [GitHub Issues](https://github.com/DammianMiller/universal-agent-protocol/issues)
- **Discussions**: [GitHub Discussions](https://github.com/DammianMiller/universal-agent-protocol/discussions)
