#!/usr/bin/env python3
"""
Qwen3.5 Chat Template Patch Script

Fixes the broken Jinja2 template that causes tool calling failures
after the first 1-2 tool calls.

Issue: Unclosed conditional blocks in tool call argument rendering
Source: Hugging Face Discussion #4

Usage:
    python3 fix_qwen_chat_template.py [template_file]

    If no template file specified, looks for:
    - chat_template.jinja
    - .opencode/agent/chat_template.jinja
    - llama.cpp templates
"""

import sys
import os
import re
from pathlib import Path
from datetime import datetime

# Template fix patterns
FIXES = [
    {
        "name": "Add conditional wrapper for tool call arguments",
        "pattern": r"{%- for args_name, args_value in tool_call\.arguments \| items %}",
        "replacement": "{%- if tool_call.arguments is mapping %}\n    {%- for args_name in tool_call.arguments %}",
        "description": "Wraps tool call iteration in conditional to prevent errors",
    },
    {
        "name": "Add missing endif after tool call loop",
        "pattern": r"(\{%- endfor %\}\s*)(?!\{%- endif %\})",
        "replacement": r"\1{%- endif %}",
        "description": "Closes the conditional block for tool call arguments",
    },
    {
        "name": "Fix unclosed thinking tags",
        "pattern": r"(<thinking>.*?)(?!</thinking>)\s*(?=<function|</function>)",
        "replacement": r"\1</thinking>",
        "description": "Ensures thinking tags are properly closed",
        "flags": re.DOTALL,
    },
    {
        "name": "Fix system message validation for tool mode",
        "pattern": r"\{%- if tools and tools is iterable and tools is not mapping %\}\s*{{- 'system\\n' }}",
        "replacement": "{%- set has_system_message = messages[0].role == 'system' if messages else false %}\n{%- if tools and tools is iterable and tools is not mapping %}\n    {{- 'system\\n' }}",
        "description": "Adds has_system_message check before tools block",
    },
    {
        "name": "Add system message validation in else branch",
        "pattern": r"\{%- else %\}\s*\{%- if messages\[0\]\.role == 'system' %\}",
        "replacement": "{%- else %}\n    {%- if has_system_message %}",
        "description": "Uses has_system_message variable instead of checking messages[0]",
    },
]


def find_template_files():
    """Search for Qwen3.5 chat template files"""
    search_paths = [
        Path("."),
        Path(".opencode/agent"),
        Path("llama.cpp"),
        Path("tools/agents"),
        Path("infra/k8s"),
        Path("templates"),
    ]

    template_files = []

    for search_path in search_paths:
        if not search_path.exists():
            continue

        # Look for template files
        patterns = ["chat_template.jinja", "chat_template.txt", "qwen*.jinja"]

        for pattern in patterns:
            found = list(search_path.glob(pattern))
            template_files.extend(found)

        # Also check for files with Qwen in name
        if (search_path / "tokenizer_config.json").exists():
            template_files.append(search_path / "tokenizer_config.json")

    # Remove duplicates and sort by path length (prefer more specific paths)
    unique_files = list(set(template_files))
    unique_files.sort(key=lambda x: len(str(x)))

    return unique_files


def read_template(filepath):
    """Read template file content"""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        print(f"❌ Error reading {filepath}: {e}")
        return None


def write_template(filepath, content):
    """Write content to template file"""
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return True
    except Exception as e:
        print(f"❌ Error writing {filepath}: {e}")
        return False


def backup_template(filepath):
    """Create backup of template file"""
    backup_path = f"{filepath}.backup.{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    try:
        with open(filepath, "r", encoding="utf-8") as src:
            with open(backup_path, "w", encoding="utf-8") as dst:
                dst.write(src.read())
        print(f"✅ Backup created: {backup_path}")
        return backup_path
    except Exception as e:
        print(f"❌ Error creating backup: {e}")
        return None


def apply_fix(template_content, fix):
    """Apply a single fix to template content"""
    name = fix["name"]
    pattern = fix["pattern"]
    replacement = fix["replacement"]
    flags = fix.get("flags", 0)

    try:
        # Check if pattern exists in template
        if re.search(pattern, template_content, flags):
            # Apply fix
            new_content = re.sub(pattern, replacement, template_content, flags=flags)

            # Check if fix was actually applied
            if new_content != template_content:
                print(f"  ✓ Applied: {name}")
                return new_content, True
            else:
                print(f"  - Skipped: {name} (pattern not found)")
                return template_content, False
        else:
            print(f"  - Skipped: {name} (pattern not found)")
            return template_content, False

    except Exception as e:
        print(f"  ✗ Error applying {name}: {e}")
        return template_content, False


def validate_template(template_content):
    """Validate template structure"""
    issues = []

    # Check for balanced braces
    if_template_count = template_content.count("{%- if ")
    endif_count = template_content.count("{%- endif %}")

    if if_template_count != endif_count:
        issues.append(
            f"Unbalanced if/endif: {if_template_count} if, {endif_count} endif"
        )

    # Check for tool call arguments pattern
    if "tool_call.arguments" in template_content:
        if "if tool_call.arguments is mapping" not in template_content:
            issues.append("Missing conditional wrapper for tool_call.arguments")

    # Check for thinking tags
    thinking_open = template_content.count("<thinking>")
    thinking_close = template_content.count("</thinking>")

    if thinking_open != thinking_close:
        issues.append(
            f"Unbalanced thinking tags: {thinking_open} open, {thinking_close} close"
        )

    return issues


def print_template_diff(old_content, new_content):
    """Print simplified diff showing key changes"""
    old_lines = old_content.split("\n")
    new_lines = new_content.split("\n")

    print("\n" + "=" * 70)
    print("KEY CHANGES:")
    print("=" * 70)

    # Find lines with tool call arguments
    for i, line in enumerate(new_lines):
        if "tool_call.arguments" in line and ("if" in line or "for" in line):
            print(f"Line {i + 1}: {line.strip()}")

    # Find endif additions
    for i, line in enumerate(new_lines):
        if "{%- endif %}" in line:
            # Check if preceded by endfor
            if i > 0 and "{%- endfor %}" in new_lines[i - 1]:
                print(f"Line {i + 1}: {line.strip()} (closing tool call conditional)")

    print("=" * 70 + "\n")


def main():
    """Main execution"""
    print("=" * 70)
    print("Qwen3.5 Chat Template Patch Script")
    print("=" * 70)

    # Get template file
    if len(sys.argv) > 1:
        template_file = Path(sys.argv[1])
        if not template_file.exists():
            print(f"❌ Template file not found: {template_file}")
            sys.exit(1)
    else:
        print("Searching for template files...")
        template_files = find_template_files()

        if not template_files:
            print("❌ No template files found")
            print("\nPlease specify template file manually:")
            print("  python3 fix_qwen_chat_template.py /path/to/chat_template.jinja")
            sys.exit(1)

        print(f"Found {len(template_files)} potential template file(s):")
        for i, tf in enumerate(template_files, 1):
            print(f"  {i}. {tf}")

        # Use the most specific one (first in list)
        template_file = template_files[0]
        print(f"\nUsing: {template_file}\n")

    # Read template
    print(f"Reading template: {template_file}")
    original_content = read_template(template_file)

    if not original_content:
        sys.exit(1)

    # Create backup
    backup_path = backup_template(template_file)
    if not backup_path:
        sys.exit(1)

    # Validate before fix
    print("\nValidating template before fix:")
    issues_before = validate_template(original_content)
    if issues_before:
        print("  Issues found:")
        for issue in issues_before:
            print(f"    - {issue}")
    else:
        print("  No obvious issues detected")

    # Apply fixes
    print("\nApplying fixes:")
    fixed_content = original_content

    for fix in FIXES:
        fixed_content, applied = apply_fix(fixed_content, fix)

    # Validate after fix
    print("\nValidating template after fix:")
    issues_after = validate_template(fixed_content)
    if issues_after:
        print("  Remaining issues:")
        for issue in issues_after:
            print(f"    - {issue}")
    else:
        print("  ✓ No obvious issues detected")

    # Write fixed template
    if fixed_content != original_content:
        print(f"\nWriting fixed template: {template_file}")
        if write_template(template_file, fixed_content):
            print("✅ Template patch applied successfully!")
        else:
            print("❌ Failed to write template")
            sys.exit(1)
    else:
        print("\n⚠️  No changes were made - template may already be fixed")

    # Print summary
    print_template_diff(original_content, fixed_content)

    # Print instructions
    print("\n" + "=" * 70)
    print("NEXT STEPS:")
    print("=" * 70)
    print("1. Verify the template was patched correctly:")
    print(f"   grep -n 'if tool_call.arguments is mapping' {template_file}")
    print("\n2. Restart llama.cpp server with the fixed template:")
    print("   ./llama.cpp/llama-server \\")
    print("     --chat-template-file chat_template.jinja \\")
    print("     --jinja \\")
    print("     --port 8080")
    print("\n3. Test tool calling:")
    print("   python3 qwen_tool_call_test.py")
    print("=" * 70)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n❌ Interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
