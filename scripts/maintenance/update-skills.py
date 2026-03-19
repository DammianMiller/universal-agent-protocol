#!/usr/bin/env python3
"""Update all skills with v2.3.0 compatibility headers and protocol references."""

import os
from pathlib import Path

SKILLS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".factory",
    "skills",
)

skills_to_update = {
    "chess-engine": ("Game AI", ["chess", "engine", "analysis", "game"]),
    "codebase-navigator": (
        "Navigation",
        ["navigate", "codebase", "explore", "understand"],
    ),
    "compression": ("Algorithms", ["compress", "optimize", "size", "minify"]),
    "git-forensics": ("Git", ["git", "history", "forensics", "recover", "blame"]),
    "near-miss": ("Debugging", ["near miss", "bug", "error", "debug", "fix"]),
    "polyglot": ("Localization", ["polyglot", "i18n", "l10n", "translation", "locale"]),
    "service-config": ("Configuration", ["config", "configuration", "settings", "env"]),
    "terminal-bench-strategies": (
        "Benchmarking",
        ["terminal-bench", "benchmark", "test", "evaluate"],
    ),
}


def add_rtk_header(content, skill_name):
    rtk_addition = f"""---
name: {skill_name}
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

"""
    if content.startswith("---"):
        end_frontmatter = content.find("---", 3)
        if end_frontmatter > 0:
            return (
                content[: end_frontmatter + 3]
                + rtk_addition
                + content[end_frontmatter + 3 :]
            )
    return rtk_addition + content


def add_decision_loop_ref(content, skill_name):
    decision_loop = f"""
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:{skill_name}.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
"""
    if "# " in content:
        first_heading = content.find("# ")
        return content[:first_heading] + decision_loop + content[first_heading:]
    return content


def add_uam_compliance(content):
    uam_section = """
## UAM Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uam worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```
"""
    if "## Common Pitfalls" in content:
        return content.replace(
            "## Common Pitfalls", uam_section + "\n## Common Pitfalls"
        )
    if "## References" in content:
        return content.replace("## References", uam_section + "\n## References")
    return content + "\n\n" + uam_section


def update_skill_file(skill_dir, skill_name):
    skill_file = os.path.join(skill_dir, "SKILL.md")

    if not os.path.exists(skill_file):
        print(f"  ✗ {skill_name}: SKILL.md not found")
        return False

    with open(skill_file, "r", encoding="utf-8") as f:
        content = f.read()

    original_content = content
    content = add_rtk_header(content, skill_name)
    content = add_decision_loop_ref(content, skill_name)
    content = add_uam_compliance(content)

    if content != original_content:
        with open(skill_file, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"  ✓ {skill_name}: Updated")
        return True

    print(f"  - {skill_name}: Already updated")
    return False


print("=== Updating Skills for CLAUDE.md v2.3.0 ===\n")

updated = 0
for skill_name, (category, triggers) in skills_to_update.items():
    skill_dir = os.path.join(SKILLS_DIR, skill_name)

    if not os.path.exists(skill_dir):
        print(f"  ✗ {skill_name}: Directory not found")
        continue

    if update_skill_file(skill_dir, skill_name):
        updated += 1

print(f"\n=== Summary ===")
print(f"Updated: {updated}/{len(skills_to_update)} skills")
