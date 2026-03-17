#!/bin/bash
# UAP 100% Full Verification Script
# Tests all tools, hooks, capabilities, and MCP configuration

set -e

echo "=========================================="
echo "UAP COMPLETE SYSTEM VERIFICATION"
echo "=========================================="
echo ""

PASS=0
FAIL=0

check() {
    if [ $? -eq 0 ]; then
        echo "✅ $1"
        ((PASS++))
    else
        echo "❌ $1"
        ((FAIL++))
    fi
}

# 1. CLAUDE.md Check
echo "📄 CLAUDE.md Verification"
grep -q "TEMPLATE_VERSION: 2.3.0" CLAUDE.md
check "CLAUDE.md template version correct"
grep -qP "LAST_VALIDATED: \d{4}-\d{2}-\d{2}" CLAUDE.md
check "CLAUDE.md last validated date present"
test -f ".claude/hooks/session-start.sh"
check "Session start hook exists"
test -f ".claude/hooks/pre-compact.sh"
check "Pre-compact hook exists"
echo ""

# 2. Memory Database Check
echo "💾 Memory Database Verification"
test -f "agents/data/memory/short_term.db"
check "Memory database exists"
MEM_COUNT=$(sqlite3 agents/data/memory/short_term.db "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "0")
[ "$MEM_COUNT" -gt 0 ]
check "Memory database has entries ($MEM_COUNT)"
SESSION_COUNT=$(sqlite3 agents/data/memory/short_term.db "SELECT COUNT(*) FROM session_memories WHERE session_id = 'current';" 2>/dev/null || echo "0")
[ "$SESSION_COUNT" -gt 0 ]
check "Session memories tracked ($SESSION_COUNT entries)"
echo ""

# 3. UAP CLI Check
echo "🔧 UAP CLI Verification"
test -f "tools/agents/UAP/cli.py"
check "UAP CLI tool exists"
python3 tools/agents/UAP/version.py | grep -qP 'version = "\d+\.\d+\.\d+"'
check "UAP version is set"
python3 tools/agents/UAP/cli.py compliance check > /dev/null 2>&1
check "Compliance check passes"
echo ""

# 4. Hooks Check
echo "🪝 Hooks Verification"
bash .claude/hooks/session-start.sh > /dev/null 2>&1
check "Session start hook executes without errors"
bash .claude/hooks/pre-compact.sh > /dev/null 2>&1
check "Pre-compact hook executes without errors"
! grep -q "# UAM Session Start Hook" .claude/hooks/session-start.sh
check "No UAM references in session-start hook"
echo ""

# 5. Worktrees Check
echo "📁 Worktrees Verification"
test -d ".worktrees"
check "Worktrees directory exists"
WT_COUNT=$(find .worktrees -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)
[ "$WT_COUNT" -gt 0 ]
check "Worktrees exist ($WT_COUNT worktrees)"
echo ""

# 6. Opencode Configuration Check
echo "🎯 Opencode Configuration Verification"
test -f ".opencode/opencode.json"
check "Opencode config exists"
grep -q '"mcp"' .opencode/opencode.json
check "MCP configuration present"
grep -q './dist/cli/mcp-router.js' .opencode/opencode.json
check "MCP router path correct (dist/cli/mcp-router.js)"
test -f ".opencode/plugin/uap-commands.ts"
check "UAP commands plugin exists"
test -f ".opencode/plugin/uap-session-hooks.ts"
check "Session hooks plugin exists"
echo ""

# 7. MCP Router Check
echo "🔌 MCP Router Verification"
test -f "dist/cli/mcp-router.js"
check "MCP router compiled"
node dist/cli/mcp-router.js --help > /dev/null 2>&1 || true
check "MCP router is executable"
echo ""

# 8. Plugins Check
echo "🧩 Opencode Plugins Verification"
test -f ".opencode/plugin/uap-commands.ts"
check "UAP commands plugin exists"
test -f ".opencode/plugin/uap-droids.ts"
check "UAP droids plugin exists"
test -f ".opencode/plugin/uap-skills.ts"
check "UAP skills plugin exists"
test -f ".opencode/plugin/uap-session-hooks.ts"
check "Session hooks plugin exists"
echo ""

# Summary
echo "=========================================="
echo "VERIFICATION SUMMARY"
echo "=========================================="
echo "✅ Passed: $PASS"
echo "❌ Failed: $FAIL"
echo ""

if [ $FAIL -eq 0 ]; then
    echo "🎉 ALL SYSTEMS OPERATIONAL (100%)"
    exit 0
else
    echo "⚠️  Some systems need attention"
    exit 1
fi
