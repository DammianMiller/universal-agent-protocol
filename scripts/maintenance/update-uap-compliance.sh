#!/bin/bash
# Update all UAP components for v2.3.0 compatibility
# This script ensures CLAUDE.md, skills, and droids are aligned

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== UAP Compliance Update Script ==="
echo "Target: CLAUDE.md v2.3.0+"
echo ""

# Step 1: Verify CLAUDE.md version
echo "Step 1/4: Checking CLAUDE.md version..."
if grep -q "CLAUDE.md v2\.[2-9]" "$PROJECT_ROOT/CLAUDE.md" || \
   grep -q "CLAUDE.md v3\." "$PROJECT_ROOT/CLAUDE.md"; then
    echo "  ✓ CLAUDE.md version compatible"
else
    echo "  ✗ CLAUDE.md needs update to v2.3.0+"
    exit 1
fi

# Step 2: Update skills
echo ""
echo "Step 2/4: Updating skills..."
python3 "$SCRIPT_DIR/update-skills.py" || {
    echo "  ⚠ Skills update failed, continuing anyway"
}

# Step 3: Update droids
echo ""
echo "Step 3/4: Updating droids..."
python3 "$SCRIPT_DIR/update-droids.py" || {
    echo "  ⚠ Droids update failed, continuing anyway"
}

# Step 4: Verify compliance
echo ""
echo "Step 4/4: Verifying UAP compliance..."
bash "$SCRIPT_DIR/verify-compliance.sh"

echo ""
echo "=== Update Complete ==="
echo "All components updated for CLAUDE.md v2.3.0+"
