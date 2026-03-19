#!/usr/bin/env python3
"""Update all droids with v2.3.0 compatibility headers."""

import os

DROIDS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".factory",
    "droids",
)

droids = [
    "code-quality-guardian",
    "debug-expert",
    "documentation-expert",
    "ml-training-expert",
    "performance-optimizer",
    "security-auditor",
    "sysadmin-expert",
    "terminal-bench-optimizer",
]


def update_droid_file(droid_name):
    droid_file = os.path.join(DROIDS_DIR, f"{droid_name}.md")

    if not os.path.exists(droid_file):
        print(f"  ✗ {droid_name}: File not found")
        return False

    with open(droid_file, "r", encoding="utf-8") as f:
        content = f.read()

    if "CLAUDE.md v2.3.0" in content and "@Skill:" in content:
        print(f"  - {droid_name}: Already current")
        return True

    lines = content.split("\n")

    title_idx = None
    for i, line in enumerate(lines):
        if line.startswith("# ") or line.startswith("## "):
            title_idx = i
            break

    if title_idx is None:
        print(f"  ⚠ {droid_name}: No heading found")
        return False

    compat_note = f"""> **Compatibility**: CLAUDE.md v2.3.0+  
> **Integration**: Invoked via `Task(subagent_type: "{droid_name}", prompt: "...")` in PARALLEL REVIEW PROTOCOL  
> **Skill Loading**: This droid can load domain-specific guidance via `@Skill:<skill-name>.md` when applicable
"""

    lines.insert(title_idx + 1, compat_note)

    if "MANDATORY" not in content:
        for i, line in enumerate(lines):
            if line.startswith("## ") and i > title_idx + 3:
                before_section = lines[:i]
                after_section = lines[i:]

                mandatory_check = """
### MANDATORY Pre-Checks

Before applying this droid's guidance:

- [ ] **MANDATORY**: Worktree created (`uam worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures
- [ ] Parallel review protocol followed

"""
                lines = before_section + [mandatory_check] + after_section
                break

    with open(droid_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"  ✓ {droid_name}: Updated")
    return True


print("=== Updating Droids for CLAUDE.md v2.3.0 ===\n")

updated = 0
for droid in droids:
    if update_droid_file(droid):
        updated += 1

print(f"\n=== Summary ===")
print(f"Updated: {updated}/{len(droids)} droids")
