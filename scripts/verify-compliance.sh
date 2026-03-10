#!/bin/bash
# Verify UAP compliance for CLAUDE.md v2.3.0+

echo "=== UAP Compliance Verification ==="
echo ""

score=0
total=12

# 1. CLAUDE.md version check
if grep -q "CLAUDE.md v2\.[2-9]\|CLAUDE.md v3\." CLAUDE.md; then
    ((score++))
    echo "✓ CLAUDE.md version (v2.x+/v3.x)"
else
    echo "✗ CLAUDE.md version not found"
fi

# 2. SESSION START block
if grep -q "## SESSION START" CLAUDE.md && grep -q "uap task ready" CLAUDE.md; then
    ((score++))
    echo "✓ SESSION START block with uap task ready"
else
    echo "✗ SESSION START block MISSING"
fi

# 3. DECISION LOOP with skills reference
if grep -q "@Skill:name.md" CLAUDE.md; then
    ((score++))
    echo "✓ DECISION LOOP with @Skill:name.md reference"
else
    echo "✗ DECISION LOOP skills reference MISSING"
fi

# 4. MANDATORY worktree enforcement
if grep -q "WORKTREE WORKFLOW — MANDATORY\|## WORKTREE WORKFLOW.*MANDATORY" CLAUDE.md; then
    ((score++))
    echo "✓ MANDATORY worktree enforcement present"
else
    echo "✗ MANDATORY worktree enforcement MISSING"
fi

# 5. PARALLEL REVIEW PROTOCOL
if grep -q "## PARALLEL REVIEW PROTOCOL" CLAUDE.md; then
    ((score++))
    echo "✓ PARALLEL REVIEW PROTOCOL present"
else
    echo "✗ PARALLEL REVIEW PROTOCOL MISSING"
fi

# 6. Schema diff gate ordering
if grep -q "BLOCKING PREREQUISITES.*Schema Diff Gate\|1\. \*\*Schema Diff Gate" CLAUDE.md; then
    ((score++))
    echo "✓ Schema diff gate in BLOCKING PREREQUISITES"
else
    echo "✗ Schema diff gate NOT in blocking prerequisites"
fi

# 7. VERIFIER-FIRST section
if grep -q "## VERIFIER-FIRST" CLAUDE.md; then
    ((score++))
    echo "✓ VERIFIER-FIRST section present"
else
    echo "✗ VERIFIER-FIRST MISSING"
fi

# 8. COMPLETION GATES - MANDATORY
if grep -q "COMPLETION GATES.*-.*MANDATORY\|## COMPLETION GATES - MANDATORY" CLAUDE.md; then
    ((score++))
    echo "✓ COMPLETION GATES - MANDATORY present"
else
    echo "✗ COMPLETION GATES - MANDATORY MISSING"
fi

# 9. Pattern Router requirement
if grep -q "Pattern.*Router\|pattern router" CLAUDE.md; then
    ((score++))
    echo "✓ Pattern Router documented"
else
    echo "✗ Pattern Router MISSING"
fi

# 10. RTK includes
if grep -q "@hooks-session-start.md\|@PreCompact.md" CLAUDE.md; then
    ((score++))
    echo "✓ RTK includes (@hooks-session-start, @PreCompact)"
else
    echo "✗ RTK includes MISSING"
fi

# 11. Verifier loop enforcement (min 3 runs)
if grep -q "MANDATORY.*minimum 3 times\|MANDATORY.*3 times" CLAUDE.md; then
    ((score++))
    echo "✓ Verifier loop enforced (min 3 runs)"
else
    echo "✗ Verifier loop enforcement MISSING"
fi

# 12. Skills directory structure
if [ -d ".factory/skills" ] && [ "$(ls -A .factory/skills 2>/dev/null)" ]; then
    ((score++))
    echo "✓ Skills directory populated"
else
    echo "✗ Skills directory MISSING or empty"
fi

echo ""
echo "=== UAP COMPLIANCE SCORE: $score/$total ($(( score * 100 / total ))%) ==="
echo ""

if [ "$score" -eq "$total" ]; then
    echo "✓ All compliance checks passed!"
    exit 0
else
    echo "✗ Compliance check failed! Score: $score/$total"
    echo "Run 'npm run update-uap' to fix issues"
    exit 1
fi
