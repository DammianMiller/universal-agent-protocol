#!/usr/bin/env python3
"""Validate all skills include required v2.3.0 markers."""

import os
import sys
from pathlib import Path

SKILLS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".factory",
    "skills",
)

required_markers = [
    "compatibility: CLAUDE.md v2.3.0+",
    "@hooks-session-start.md",
    "DECISION LOOP",
    "MANDATORY",
]

print("=== Validating Skills for UAM v2.3.0 Compliance ===\n")

errors = []
warnings = []

for skill_dir in os.listdir(SKILLS_DIR):
    skill_path = os.path.join(SKILLS_DIR, skill_dir)

    if not os.path.isdir(skill_path):
        continue

    skill_file = os.path.join(skill_path, "SKILL.md")

    if not os.path.exists(skill_file):
        errors.append(f"{skill_dir}/SKILL.md: File not found")
        continue

    with open(skill_file, "r", encoding="utf-8") as f:
        content = f.read()

    skill_name = skill_dir

    # Check required markers
    for marker in required_markers:
        if marker not in content:
            errors.append(f"{skill_name}: Missing '{marker}'")

    # Warn about optional but recommended markers
    optional_markers = [
        "Completion Gates Checklist",
        "Verifier-First",
        "Memory Integration",
    ]

    for marker in optional_markers:
        if marker not in content:
            warnings.append(f"{skill_name}: Missing optional '{marker}' (recommended)")

# Report results
if errors:
    print("❌ ERRORS - Skills missing required markers:")
    for error in errors:
        print(f"  ✗ {error}")
    print()

if warnings:
    print("⚠️  WARNINGS - Skills missing optional markers:")
    for warning in warnings[:5]:  # Show first 5 warnings
        print(f"  ⚠ {warning}")
    if len(warnings) > 5:
        print(f"  ... and {len(warnings) - 5} more")
    print()

if not errors and not warnings:
    print("✓ All skills are compliant with UAM v2.3.0!")
    sys.exit(0)
elif not errors:
    print("✓ Skills pass all required checks (warnings shown above)")
    sys.exit(0)
else:
    print("\n❌ Validation FAILED")
    print("Run 'npm run update-skills' to fix issues")
    sys.exit(1)
