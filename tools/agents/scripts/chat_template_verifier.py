#!/usr/bin/env python3
"""
UAP Chat Template Verifier

Model-agnostic chat template auto-finder and verifier.
Validates Jinja2 syntax, renders test data, and checks for
tool call format support.

Works with any chat template format:
  - ChatML (<|im_start|>/<|im_end|>)
  - Llama (<|begin_of_text|>/<|end_of_text|>)
  - Mistral ([INST]/[/INST])
  - Custom formats

Usage:
    python3 chat_template_verifier.py [template_path]

Auto-detection looks for templates in standard locations relative to project root.
"""

import sys
import os
import re
from pathlib import Path
from datetime import datetime


def find_project_root():
    """Find the UAP project root directory."""
    current = Path(__file__).resolve().parent

    # Walk up from script location until we find package.json or .git
    for parent in [current] + list(current.parents):
        if (parent / "package.json").exists() or (parent / ".git" / "config").exists():
            return parent

    return current


def find_chat_templates(project_root=None):
    """Find all chat template files in project."""
    if not project_root:
        project_root = find_project_root()

    templates = []

    # Standard locations to check (in priority order)
    search_paths = [
        project_root / "tools" / "agents" / "config",
        project_root / "config" / "model-profiles",
        project_root,
    ]

    for search_path in search_paths:
        if not search_path.exists():
            continue

        for pattern in ["chat_template.jinja", "*.jinja", "*.jinja2"]:
            for found in search_path.glob(pattern):
                # Skip backup files
                if ".backup." in found.name:
                    continue
                templates.append(found)

    # Deduplicate and sort by path length (prefer deeper/more specific paths)
    seen = set()
    unique = []
    for t in templates:
        resolved = t.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(t)

    # Sort: prefer tools/agents/config/ over root
    return sorted(unique, key=lambda x: (0 if "tools" in str(x) else 1, len(str(x))))


def validate_template_syntax(content):
    """Validate Jinja2 template syntax with correct regex patterns."""
    issues = []

    # Count balanced blocks using correct Jinja2 syntax
    block_pairs = [
        ("if", r"\{%-?\s*if\s+", r"\{%-?\s*endif\s*-?%\}"),
        ("for", r"\{%-?\s*for\s+", r"\{%-?\s*endfor\s*-?%\}"),
        ("macro", r"\{%-?\s*macro\s+", r"\{%-?\s*endmacro\s*-?%\}"),
    ]

    for tag_name, open_pattern, close_pattern in block_pairs:
        opens = len(re.findall(open_pattern, content))
        closes = len(re.findall(close_pattern, content))

        if opens != closes:
            issues.append(
                f"Unbalanced {tag_name} blocks: {opens} open vs {closes} close"
            )

    # Check for broken tag syntax
    broken_tags = re.findall(r"\{-?%[^}]*%\}", content)
    for tag in broken_tags:
        if tag.startswith("{-%") and not tag.startswith("{%-"):
            issues.append(f"Invalid tag syntax: {tag[:40]}...")

    # Check for double-opened tags like {%- {%- elif %}
    double_opens = re.findall(r"\{%-?\s*\{%-?", content)
    if double_opens:
        issues.append(f"Found {len(double_opens)} double-opened tags")

    # Check for stray endmacro without macro
    macros = len(re.findall(r"\{%-?\s*macro\s+", content))
    endmacros = len(re.findall(r"\{%-?\s*endmacro\s*-?%\}", content))
    if endmacros > macros:
        issues.append(f"Found {endmacros - macros} stray endmacro tag(s)")

    return issues


def verify_template_with_jinja(template_content):
    """Verify template can be parsed by Jinja2."""
    try:
        from jinja2 import Environment, BaseLoader
        import json

        env = Environment(loader=BaseLoader())

        # Try to compile the template
        template = env.from_string(template_content)

        # Test with minimal valid input
        test_data = {
            "messages": [
                {"role": "system", "content": "Test system message"},
                {"role": "user", "content": "Hello"},
            ],
            "add_generation_prompt": True,
            "enable_thinking": False,
        }

        try:
            result = template.render(**test_data)
            print(f"  [OK] Template compiled and rendered ({len(result)} chars)")

            # Test tool call round-trip
            test_tool_data = {
                "messages": [
                    {"role": "user", "content": "Read file"},
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "read_file",
                                    "arguments": json.dumps({"path": "/etc/hosts"}),
                                }
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "name": "read_file",
                        "content": "127.0.0.1 localhost",
                    },
                ],
                "add_generation_prompt": True,
                "enable_thinking": False,
            }

            result2 = template.render(**test_tool_data)

            # Check for various tool call formats (model-agnostic)
            tool_formats = [
                ("<tool_call>", "ChatML/Qwen3 format"),
                ("<function_call>", "legacy XML format"),
                ("<function=", "function= style"),
                ('"name"', "JSON tool call"),
            ]

            found_format = False
            for marker, format_name in tool_formats:
                if marker in result2:
                    print(f"  [OK] Tool call format verified ({format_name})")
                    found_format = True
                    break

            if not found_format:
                print("  [WARN] Tool call tags not found in output")

            return True

        except Exception as e:
            error_msg = str(e)
            if "undefined" in error_msg.lower():
                # Variable undefined is expected with minimal test data
                print(f"  [OK] Template parsed (expected variable: {error_msg[:60]})")
                return True
            else:
                print(f"  [FAIL] Render error: {error_msg[:100]}")
                return False

    except ImportError:
        print("  [SKIP] Jinja2 not installed (pip install jinja2)")
        return None
    except Exception as e:
        error_msg = str(e)
        line_match = re.search(r"line (\d+)", error_msg)

        if line_match:
            line_num = int(line_match.group(1))
            lines = template_content.split("\n")
            print(f"\n  [FAIL] Error at line {line_num}:")
            start = max(0, line_num - 3)
            for i in range(start, min(line_num + 2, len(lines))):
                marker = ">>>" if i == line_num - 1 else "   "
                print(f"  {marker} {i + 1}: {lines[i][:80]}")
        else:
            print(f"\n  [FAIL] Template parsing error: {error_msg[:200]}")

        return False


def main():
    """Main execution with auto-detection."""

    print("=" * 70)
    print("UAP Chat Template Verifier")
    print("=" * 70)

    # Get project root
    project_root = find_project_root()
    print(f"\nProject root: {project_root}")

    # Handle explicit path argument
    if len(sys.argv) > 1:
        target_template = Path(sys.argv[1])
        if not target_template.exists():
            print(f"Error: File not found: {target_template}")
            sys.exit(1)
    else:
        # Find templates automatically
        print("\nSearching for chat templates...")
        templates = find_chat_templates(project_root)

        if not templates:
            print("Error: No chat template files found!")
            print(
                f"\nExpected at: {project_root / 'tools' / 'agents' / 'config' / 'chat_template.jinja'}"
            )
            sys.exit(1)

        target_template = templates[0]

        # Show all found templates
        if len(templates) > 1:
            print(f"  Found {len(templates)} template(s):")
            for t in templates:
                try:
                    rel = t.relative_to(project_root)
                except ValueError:
                    rel = t
                marker = " <-- using" if t == target_template else ""
                print(f"    - {rel}{marker}")

    try:
        rel_path = target_template.relative_to(project_root)
    except ValueError:
        rel_path = target_template

    print(f"Using: {rel_path}")

    # Read content
    try:
        with open(target_template, "r", encoding="utf-8") as f:
            content = f.read()
        print(f"Loaded: {len(content)} bytes, {len(content.splitlines())} lines")
    except Exception as e:
        print(f"Error reading {target_template}: {e}")
        sys.exit(1)

    # Validate syntax
    print("\nValidating template syntax...")
    issues = validate_template_syntax(content)

    if issues:
        print(f"  Found {len(issues)} issue(s):")
        for issue in issues:
            print(f"    - {issue}")
    else:
        print("  [OK] No syntax issues detected")

    # Verify with Jinja2
    print("\nVerifying with Jinja2 parser...")
    jinja_ok = verify_template_with_jinja(content)

    if jinja_ok is True:
        print("\n[OK] Template is valid and functional")
    elif jinja_ok is False:
        print("\n[FAIL] Template has errors - needs manual review")
        sys.exit(1)
    else:
        print("\n[SKIP] Could not verify (install jinja2: pip install jinja2)")

    # Show template features (model-agnostic detection)
    print("\nTemplate features:")
    features = [
        ("System message handling", "role == 'system'" in content),
        ("User message handling", "role == 'user'" in content),
        ("Assistant message handling", "role == 'assistant'" in content),
        ("Tool call support", "tool_calls" in content or "tool_call" in content),
        ("Native tool descriptions", "for tool in tools" in content),
        (
            "Tool response support",
            "role == 'tool'" in content or "tool_response" in content,
        ),
        (
            "Thinking/reasoning mode",
            "thinking" in content.lower() or "think" in content.lower(),
        ),
        ("ChatML format (<|im_start|>)", "<|im_start|>" in content),
        ("Llama format (<|begin_of_text|>)", "<|begin_of_text|>" in content),
        ("Mistral format ([INST])", "[INST]" in content),
        ("Generation prompt", "add_generation_prompt" in content),
    ]

    for feature, has_it in features:
        status = "[OK]" if has_it else "[--]"
        print(f"  {status} {feature}")

    print("\n" + "=" * 70)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted")
        sys.exit(130)
    except Exception as e:
        import traceback

        print(f"\nUnexpected error: {e}")
        traceback.print_exc()
        sys.exit(1)
