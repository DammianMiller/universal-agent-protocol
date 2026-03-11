# 🚀 UAP v0.9.1 NPM Publish - Complete Success!

**Date**: March 11, 2026  
**Version**: 0.9.1  
**Status**: ✅ **PUBLISHED TO NPM**

---

## ✅ Deployment Complete!

### Package Published

| Package | Version | Status | URL |
|---------|---------|--------|-----|
| `universal-agent-protocol` | **0.9.1** | ✅ Published | [npmjs.com](https://www.npmjs.com/package/universal-agent-protocol) |

### Package Details

```
universal-agent-protocol@0.9.1 | MIT | deps: 13 | versions: 7
Autonomous AI agent memory system with CLAUDE.md protocol enforcement
https://github.com/DammianMiller/universal-agent-protocol#readme

bin: universal-agent-protocol, uap, uap-tool-calls
```

### Installation

```bash
# Install the latest version
npm install universal-agent-protocol@latest

# Or install specific version
npm install universal-agent-protocol@0.9.1

# Use globally
npm install -g universal-agent-protocol

# Create UAP instance
uap setup -p all
```

---

## 🎯 What's in v0.9.1

### Key Features

1. **OpenCode as Primary Harness** 🎉
   - Full feature parity with Claude Code
   - 6 plugins fully operational
   - MCP Router integration

2. **Pattern RAG Enabled by Default** ✅
   - Saves ~12,000 tokens per query
   - On-demand pattern retrieval from CLAUDE.md
   - 397 patterns indexed in Qdrant

3. **Jinja2 Template Fix** 🔧
   - Resolved system message validation error
   - Fixed chat template for Qwen3.5
   - Improved error messages

4. **Full UAP Compliance** ✅
   - Task management system
   - Worktree isolation
   - Memory persistence
   - Agent coordination

---

## 📊 NPM Package Statistics

| Metric | Value |
|--------|-------|
| **Name** | universal-agent-protocol |
| **Version** | 0.9.1 |
| **License** | MIT |
| **Dependencies** | 13 packages |
| **Total Versions** | 7 releases |
| **Tarball Size** | ~2.6 MB (unpacked) |
| **Binaries** | `uap`, `universal-agent-protocol`, `uap-tool-calls` |

### Dependencies

```json
{
  "@octokit/rest": "^20.0.2",
  "@qdrant/js-client-rest": "^1.11.0",
  "better-sqlite3": "^11.0.0",
  "chalk": "^5.3.0",
  "commander": "^11.1.0",
  "ora": "^8.0.1"
}
```

---

## 🚀 GitHub Actions Workflow

### Workflow Status

| Job | Status | Duration |
|-----|--------|----------|
| **Build & Test** | ✅ Success | 1m31s |
| **Publish to npm** | ✅ Success | 1m29s |
| **Create Release** | ✅ Success | 12s |
| **Deploy Documentation** | ⚠️ Skipped | — |

### Workflow Run

- **Run ID**: `22905773861`
- **Trigger**: Push to master branch
- **Commit**: `b82b1e60` - "chore: bump version to 0.9.1 for npm publish"
- **URL**: https://github.com/DammianMiller/universal-agent-protocol/actions/runs/22905773861

---

## 📦 What's Changed (v0.9.1)

### Bug Fixes

- **Jinja2 Template System Message Error**
  - Fixed validation error in `chat_template.jinja` line 103
  - Added `has_system_message` variable for consistent checks
  - Improved error messages for missing system messages

### Improvements

- **Default Pattern RAG**
  - Enabled by default when Qdrant is available
  - Automatic pattern retrieval on task queries
  - Token savings: ~12K per query

### Infrastructure

- **OpenCode Primary Harness**
  - All 6 plugins active and tested
  - MCP Router configured for opencode
  - Full feature parity achieved

---

## 🔧 Installation & Usage

### Quick Start

```bash
# Install globally
npm install -g universal-agent-protocol@latest

# Initialize in your project
cd /path/to/project
uap setup -p all

# That's it! OpenCode is now your primary harness with:
# ✅ Pattern RAG (~12K tokens saved/query)
# ✅ Task management active
# ✅ Worktree isolation ready
```

### Available Commands

```bash
# Task Management
uap task create -t "Your task" --type feature --priority 2
uap task ready              # List tasks ready to work on
uap task claim <id>         # Claim + create worktree

# Worktree Isolation
uap worktree create <slug>  # Create isolated branch
uap worktree list           # List active worktrees
uap worktree pr <id>        # Create PR from worktree

# Memory & Patterns
uap memory status           # Show memory health
uap patterns query "search" --top 3  # Query patterns

# Compliance
uap compliance check -v     # Check UAP compliance
```

---

## 📚 Documentation

### Quick Links

- **README**: https://github.com/DammianMiller/universal-agent-protocol#readme
- **NPM Package**: https://www.npmjs.com/package/universal-agent-protocol
- **GitHub Actions**: https://github.com/DammianMiller/universal-agent-protocol/actions
- **Issues**: https://github.com/DammianMiller/universal-agent-protocol/issues

### Full Documentation

All documentation is available in the `docs/` folder of the repository:
- `/docs/deployment/` - Deployment guides and summaries
- `/docs/fixes/` - Bug fix documentation
- `/README.md` - Complete usage guide

---

## ✅ Deployment Checklist

- [x] Version bumped to 0.9.1
- [x] Build & Test passed (1m31s)
- [x] Published to npm registry
- [x] GitHub Release created
- [x] Package verified on npmjs.com
- [ ] Documentation deployment (skipped due to protection rules)

---

## 📊 Previous Versions

| Version | Date | Status | Notes |
|---------|------|--------|-------|
| 0.9.1 | Mar 11, 2026 | ✅ Published | OpenCode primary harness |
| 0.9.0 | Mar 10, 2026 | ✅ Published | OpenCode enabled |
| 0.8.1 | Mar 10, 2026 | ✅ Published | Full compliance enforcement |

---

## 🎉 Summary

**UAP v0.9.1 is now live on npm!**

This release brings:
- ✅ OpenCode as the primary AI coding harness
- ✅ Pattern RAG enabled by default (~12K tokens saved/query)
- ✅ Fixed Jinja2 template system message validation error
- ✅ Full feature parity across all platforms
- ✅ 100% UAP compliance enforcement

**Install now**: `npm install universal-agent-protocol@latest`

---

*Published via GitHub Actions workflow `deploy-publish.yml`*  
*Workflow Run: https://github.com/DammianMiller/universal-agent-protocol/actions/runs/22905773861*