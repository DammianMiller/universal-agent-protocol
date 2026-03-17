#!/bin/bash
# UAP 100% Compliance Verification Script
# Run this script to verify all compliance requirements are met

set -e

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"
WORKTREES_DIR="${PROJECT_DIR}/.worktrees"

echo "=========================================="
echo "UAP 100% Compliance Verification"
echo "=========================================="
echo ""

# Check 1: CLAUDE.md exists and is current
if [ -f "${PROJECT_DIR}/CLAUDE.md" ]; then
    VERSION=$(grep "TEMPLATE_VERSION:" "${PROJECT_DIR}/CLAUDE.md" | head -n 1)
    VALIDATED=$(grep "LAST_VALIDATED:" "${PROJECT_DIR}/CLAUDE.md" | head -n 1)
    echo "✅ CLAUDE.md exists"
    echo "   $VERSION"
    echo "   $VALIDATED"
else
    echo "❌ CLAUDE.md not found"
    exit 1
fi

echo ""

# Check 2: Memory database
if [ -f "$DB_PATH" ]; then
    MEM_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM memories;")
    SESSION_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM session_memories WHERE session_id = 'current';")
    echo "✅ Memory database initialized"
    echo "   Total memories: $MEM_COUNT"
    echo "   Current session entries: $SESSION_COUNT"
else
    echo "❌ Memory database not found"
    exit 1
fi

echo ""

# Check 3: UAP CLI tool
if [ -f "${PROJECT_DIR}/tools/agents/UAP/cli.py" ]; then
    VERSION=$(python3 "${PROJECT_DIR}/tools/agents/UAP/version.py" 2>/dev/null | grep "version" | cut -d'"' -f2 || echo "unknown")
    echo "✅ UAP CLI tool exists"
    echo "   Version: $VERSION"
else
    echo "❌ UAP CLI tool not found"
    exit 1
fi

echo ""

# Check 4: Session hooks
if [ -f "${PROJECT_DIR}/.claude/hooks/session-start.sh" ] && \
   [ -f "${PROJECT_DIR}/.claude/hooks/pre-compact.sh" ]; then
    echo "✅ Session hooks exist"
    
    # Check for UAP naming (no UAM references)
    UAM_COUNT=$(grep -c "UAM" "${PROJECT_DIR}/.claude/hooks/session-start.sh" 2>/dev/null || echo "0")
    if [ "$UAM_COUNT" = "0" ]; then
        echo "   ✅ No UAM references (all using UAP)"
    else
        echo "   ⚠️  Found $UAM_COUNT UAM references (should be 0)"
    fi
else
    echo "❌ Session hooks not found"
    exit 1
fi

echo ""

# Check 5: Coordination database
if [ -f "$COORD_DB" ]; then
    AGENTS=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM agent_registry;")
    echo "✅ Coordination database initialized"
    echo "   Active agents: $AGENTS"
else
    echo "⚠️  Coordination DB not initialized (single-agent mode)"
fi

echo ""

# Check 6: Worktrees
if [ -d "$WORKTREES_DIR" ]; then
    WT_COUNT=$(find "$WORKTREES_DIR" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)
    echo "✅ Worktrees directory exists"
    echo "   Total worktrees: $WT_COUNT"
else
    echo "⚠️  No worktrees directory (single-agent mode)"
fi

echo ""
echo "=========================================="
echo "Compliance Verification Complete"
echo "=========================================="

# Final status
if [ "$MEM_COUNT" -gt 0 ] && [ "$SESSION_COUNT" -gt 0 ]; then
    echo "✅ ALL COMPLIANCE CHECKS PASSED (100%)"
    exit 0
else
    echo "⚠️  Some checks need attention"
    exit 1
fi
