<coding_guidelines>

# AGENT.md - universal-agent-protocol Development Guide

You are an AI assistant helping with the universal-agent-protocol project.

> Universal AI agent memory system - CLAUDE.md templates, memory, worktrees for Claude Code, Factory.AI, VSCode, OpenCode

---

## BROWSER USAGE

When using browser automation:

- ALWAYS save a screenshot after EVERY browser action
- Save screenshots to: `agents/data/screenshots/`
- Filename format: `{timestamp}_{action}.png`

---

---

## DECISION LOOP

1. **READ** short-term memory (recent context)
2. **QUERY** long-term memory (semantic search for relevant learnings)
3. **THINK** about what to do next
4. **ACT** - execute your decision
5. **RECORD** - write to short-term memory
6. **OPTIONALLY** - if significant learning, add to long-term memory

---

---

## Quick Reference

### URLs

- **URL**: https://raw.githubusercontent.com/DammianMiller/universal-agent-protocol/main/scripts/install-desktop.sh
- **URL**: https://raw.githubusercontent.com/DammianMiller/universal-agent-protocol/main/scripts/install-web.sh
- **URL**: https://raw.githubusercontent.com/DammianMiller/universal-agent-protocol/main/schema.json
- **URL**: https://xxxxx.aws.cloud.qdrant.io:6333&quot;,
- **URL**: https://xxxxx.aws.cloud.qdrant.io:6333

### Essential Commands

```bash
# Testing
npm test

# Linting
npm run lint

# Building
npm run build
```

---

---

## Augmented Agent Capabilities

---

## Completion Checklist

```
[ ] Tests updated and passing
[ ] Linting/type checking passed
[ ] Documentation updated
[ ] No secrets in code/commits
```

---

**Languages**: JavaScript, TypeScript
**Frameworks**: 

</coding_guidelines>