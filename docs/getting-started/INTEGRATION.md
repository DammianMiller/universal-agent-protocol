# UAP Integration Guide

**Version:** 1.0.0  
**Last Updated:** 2026-03-13  
**Status:** ✅ Production Ready

---

## Executive Summary

This guide provides integration instructions for all supported platforms, including opencode, ForgeCode, Claude Code, and VSCode.

---

## 1. opencode Integration

### 1.1 Overview

**opencode** is the recommended platform for UAP, providing:

- Persistent sessions across restarts
- Plugin architecture for Pattern RAG
- Local LLM support (llama.cpp)
- Built-in tooling (file operations, bash, search)

### 1.2 Setup

```bash
# Install opencode
npm install -g opencode

# Configure local LLM (optional)
cat > ~/.opencode/config.json << 'EOF'
{
  "provider": {
    "llama.cpp": {
      "name": "llama-server (local)",
      "options": {
        "baseURL": "http://localhost:8080/v1",
        "apiKey": "sk-qwen35b"
      },
      "models": {
        "qwen35-a3b-iq4xs": {
          "name": "Qwen3.5 35B A3B (IQ4_XS)",
          "limit": {
            "context": 262144,
            "output": 16384
          }
        }
      }
    }
  },
  "model": "llama.cpp/qwen35-a3b-iq4xs"
}
EOF

# Initialize UAP in your project
cd your-project
uap init
```

### 1.3 Plugin Configuration

UAP plugins automatically load in opencode for:

- **Pattern RAG** - Context-aware pattern injection (~12K tokens saved)
- **Session hooks** - Pre-execution setup, memory preservation
- **Agent coordination** - Multi-agent workflows without conflicts

### 1.4 Usage

```bash
# Start opencode with UAP
opencode

# UAP features available:
# - Pattern RAG auto-injection
# - Memory persistence
# - Worktree isolation
# - Compliance enforcement
```

---

## 2. ForgeCode Integration

### 2.1 Overview

**ForgeCode** is the world's #1 coding agent (TermBench 2.0, 78.4% accuracy), providing:

- ZSH-native invocation (type `:` to invoke)
- Multi-agent modes (FORGE, MUSE, SAGE)
- Model flexibility (mix models mid-session)
- Context engine with RAG-powered memory

### 2.2 Setup

```bash
# Install UAP in your project
cd your-project
uap init

# Install hooks for ForgeCode integration
uap hooks install forgecode
```

This creates:

- `.forge/hooks/session-start.sh` - Injects recent memory before `:` command
- `.forge/forgecode.plugin.sh` - ZSH plugin with environment injection
- `.forge/settings.local.json` - UAP integration configuration
- Updates `~/.zshrc` to source the plugin automatically

### 2.3 Usage

```bash
# In your ZSH session, type : to invoke ForgeCode
cd ~/projects/my-app && :
: fix login bug in auth middleware
```

UAP will:

1. Load recent memory context from `agents/data/memory/short_term.db`
2. Check for stale worktrees and open loops
3. Inject as environment variables (`UAP_CONTEXT`, `UAP_OPEN_LOOPS`)
4. ForgeCode reads these for enhanced context-aware responses
5. On completion, saves lessons back to UAP memory

### 2.4 Verification

```bash
# Check hook status for all platforms including forgecode
uap hooks status -t forgecode
```

---

## 3. Claude Code Integration

### 3.1 Overview

**Claude Code** is Anthropic's desktop app with full UAP support:

- Full UAP integration
- CLAUDE.md for context
- Persistent memory across sessions
- Built-in tooling

### 3.2 Setup

```bash
# Install UAP in your project
cd your-project
uap init

# CLAUDE.md automatically generated with:
# - Project structure
# - UAP commands
# - Pattern references
# - Memory system docs
```

### 3.3 Usage

```bash
# Open project in Claude Code
claude-code

# UAP features available:
# - CLAUDE.md context injection
# - Pattern Router auto-selection
# - Memory persistence
# - Worktree isolation
```

---

## 4. VSCode Integration

### 4.1 Overview

**VSCode** with Claude Code extension provides:

- IDE integration
- Full UAP support
- File system access
- Terminal integration

### 4.2 Setup

```bash
# Install UAP in your project
cd your-project
uap init

# Install VSCode extensions:
# - Claude Code extension
# - UAP syntax highlighting (optional)
```

### 4.3 Usage

```bash
# Open project in VSCode
code your-project

# Use Claude Code extension:
# - UAP features available
# - File operations
# - Terminal commands
# - Memory queries
```

---

## 5. claude.ai Integration

### 5.1 Overview

**claude.ai** is Anthropic's web version with limited UAP support:

- Web-based interface
- Limited tooling
- No persistent memory
- Reduced functionality

### 5.2 Setup

```bash
# Initialize UAP (for reference)
cd your-project
uap init

# Note: Web version has limited UAP support
# Consider using Claude Code or opencode for full features
```

### 5.3 Limitations

- ❌ No persistent memory
- ❌ No worktree isolation
- ❌ No hook enforcement
- ⚠️ Limited tooling
- ⚠️ No Pattern RAG

---

## 6. Integration Comparison

Every platform listed above ships as a stateless code editor. UAP closes the gap. Here is what it adds and why:

- **4-layer persistent memory** -- agents retain lessons across sessions instead of starting from zero
- **Write gate** -- 5-criteria quality filter prevents memory pollution
- **22 battle-tested patterns** -- Terminal-Bench 2.0 workflows eliminate 37% of common agent failures
- **Pattern RAG** -- on-demand retrieval saves ~12K tokens per session
- **Worktree isolation** -- parallel agents never corrupt each other's git state
- **Multi-agent coordination** -- heartbeats, overlap detection, and conflict risk let multiple agents share a repo safely
- **Deploy batching** -- squashed commits and serialized pushes prevent deploy storms
- **Policy enforcement** -- audit-trailed rules ensure agents follow project standards
- **Task DAG** -- dependency-aware tracking with cycle detection and JSONL sync
- **MCP Router** -- 98% system prompt token reduction (from ~12K to ~200)
- **RTK** -- 60-90% output token savings via Rust-based compression
- **12-gate compliance** -- automated protocol verification catches drift before it ships

> Full 15-harness matrix with per-harness integration details: **[HARNESS-MATRIX.md](../reference/HARNESS-MATRIX.md)**

### Baseline: What Platforms Provide Natively

| Feature                      |  opencode  | ForgeCode | Claude Code | VSCode  |    Cursor    | claude.ai |
| ---------------------------- | :--------: | :-------: | :---------: | :-----: | :----------: | :-------: |
| File system + terminal       |    Yes     |    Yes    |     Yes     |   Yes   |     Yes      |    --     |
| Context file                 |     --     |    --     |  CLAUDE.md  |   --    | .cursorrules |    --     |
| Native hooks                 | Plugin API | ZSH hooks |     Yes     |   --    |  hooks.json  |    --     |
| MCP support                  |   Config   |    --     |   Native    | Via ext |    Native    |    --     |
| Persistent sessions          |    Yes     |  ZSH env  |     Yes     | Limited |   Limited    |    --     |
| Local LLM support            |   Native   |    Yes    |     --      | Via ext |     Yes      |    --     |
| **Persistent memory**        |     --     |    --     |     --      |   --    |      --      |    --     |
| **Pattern library**          |     --     |    --     |     --      |   --    |      --      |    --     |
| **Multi-agent coordination** |     --     |    --     |     --      |   --    |      --      |    --     |
| **Policy enforcement**       |     --     |    --     |     --      |   --    |      --      |    --     |

The bottom four rows are empty across every column. No platform provides them. This is the gap UAP fills.

### With UAP: What Every Platform Gains

| Capability               | Why It Matters                        | opencode | ForgeCode | Claude Code | VSCode  | Cursor  | claude.ai |
| ------------------------ | ------------------------------------- | :------: | :-------: | :---------: | :-----: | :-----: | :-------: |
| 4-layer memory (L1-L4)   | Agents remember across sessions       |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| Write gate + tiering     | Only high-value knowledge stored      |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| 22 patterns + RAG        | Proven workflows, ~12K token savings  |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| Worktree isolation       | Parallel agents, zero conflicts       |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| Multi-agent coordination | Heartbeats, overlap detection, claims |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| Deploy batching          | No push races, squashed commits       |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| Policy engine            | Audit-trailed rule enforcement        |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| Task DAG                 | Dependency-aware work tracking        |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| MCP Router               | 98% system prompt token reduction     |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| RTK compression          | 60-90% output token savings           |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| 12-gate compliance       | Automated protocol verification       |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| 20+ CLI commands         | Full management + dashboard           |   Yes    |    Yes    |     Yes     |   Yes   |   Yes   |    --     |
| **Recommended**          |                                       |   Yes    |    Yes    |     Yes     | Partial | Partial |    --     |

### Integration Tiers

| Tier                   | Harnesses                                    | What You Get                                                            |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| **T1 -- First-Class**  | Claude Code, Factory.AI, OpenCode, ForgeCode | Native hooks, dedicated config dir, `uap sync`, context file generation |
| **T2 -- IDE-Based**    | Cursor, VSCode, Cline                        | Platform-specific hooks, MCP config paths                               |
| **T3 -- CLI/Terminal** | Windsurf, Codex CLI, Aider, Zed AI, Continue | Mapped to T1/T2 via CLAUDE.md or .cursorrules                           |
| **T4 -- Additional**   | GitHub Copilot, JetBrains AI, SWE-agent      | Piggybacks on T2 infrastructure                                         |

All tiers receive identical UAP features. The difference is integration depth, not capability.

---

## 7. Platform-Specific Features

### 7.1 opencode

**Unique Features:**

- Plugin architecture
- Persistent sessions
- Local LLM optimization
- Built-in tooling

**Configuration:**

```json
{
  "provider": {
    "llama.cpp": {
      "name": "llama-server (local)",
      "options": {
        "baseURL": "http://localhost:8080/v1"
      }
    }
  }
}
```

### 7.2 ForgeCode

**Unique Features:**

- ZSH-native (`:` command)
- Multi-agent modes
- Environment variable injection
- Oh My Zsh integration

**Configuration:**

```json
{
  "forge": {
    "enabled": true,
    "uamIntegration": true,
    "memoryInjection": true
  }
}
```

### 7.3 Claude Code

**Unique Features:**

- Desktop app
- CLAUDE.md context
- Full tooling
- Persistent sessions

**Configuration:**

```json
{
  "claudeCode": {
    "enabled": true,
    "claudeMd": true,
    "fullUAP": true
  }
}
```

---

## 8. Quick Start Examples

### 8.1 opencode (Recommended)

```bash
# Install and configure
npm install -g opencode
uap init
opencode

# UAP features available immediately
```

### 8.2 ForgeCode

```bash
# Install and configure
uap init
uap hooks install forgecode

# Use in ZSH
cd project && :
: fix bug
```

### 8.3 Claude Code

```bash
# Install and configure
uap init

# Open in Claude Code
claude-code
```

---

## 9. Troubleshooting

### 9.1 Common Issues

**Issue:** "Memory not persisting"  
**Solution:** Check `agents/data/memory/short_term.db` exists

**Issue:** "Pattern RAG not working"  
**Solution:** Run `python agents/scripts/index_patterns_to_qdrant.py`

**Issue:** "ForgeCode : command not found"  
**Solution:** Restart ZSH or source `~/.zshrc`

**Issue:** "opencode plugin not loading"  
**Solution:** Check `opencode.json` configuration

### 9.2 Getting Help

- Documentation: `docs/` directory
- Issues: GitHub repository issues
- Community: Join UAP Discord

---

**Last Updated:** 2026-03-13  
**Version:** 1.0.0  
**Status:** ✅ Production Ready
