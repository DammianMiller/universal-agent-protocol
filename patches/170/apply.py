#!/usr/bin/env python3
"""Stop the router using the name it deprecates. OPERATOR-RUN.

  python3 patches/170/apply.py --check | (bare = apply)

self-protect guards all of src/policies/, so the agent that wrote this cannot
apply it. Anchors are exact; it refuses rather than half-applying.

`ToolDefinition` is marked `@deprecated Use PolicyToolDefinition instead` — and
then the file kept using the deprecated name for its own tool map and its own
registerTool signature. This moves those two internal uses onto
PolicyToolDefinition.

The alias and both public re-exports (src/policies/index.ts, src/index.ts) are
DELIBERATELY KEPT. It is exported from the package root, so deleting it would
stop `import type { ToolDefinition } from '@miller-tech/uap'` compiling for
downstream TypeScript consumers. Under this project's recorded stance —
compat=preserve, maturity=production — a published type export is migrated, not
dropped. Nothing here changes runtime behaviour: the alias is type-only and is
erased at build.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROUTER = "src/policies/enforced-tool-router.ts"

EDITS = [
    # Keep the alias, but say why it survives so the next reader does not
    # "clean it up" and break the package's public type surface.
    ("""/** @deprecated Use PolicyToolDefinition instead */
export type ToolDefinition = PolicyToolDefinition;""",
     """/**
 * @deprecated Use PolicyToolDefinition instead.
 *
 * Retained because it is re-exported from the package root, so removing it
 * would break `import type { ToolDefinition } from '@miller-tech/uap'` for
 * downstream TypeScript consumers. Project stance is compat=preserve /
 * maturity=production: published surface gets migrated, not deleted. Internal
 * code uses PolicyToolDefinition directly.
 */
export type ToolDefinition = PolicyToolDefinition;"""),
    ("  private tools: Map<string, ToolDefinition> = new Map();",
     "  private tools: Map<string, PolicyToolDefinition> = new Map();"),
    ("  registerTool(tool: ToolDefinition): void {",
     "  registerTool(tool: PolicyToolDefinition): void {"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--root", type=Path, default=Path.cwd())
    a = ap.parse_args()

    p = a.root / ROUTER
    if not p.is_file():
        print(f"MISSING  {ROUTER}")
        return 1

    text = original = p.read_text()
    for old, new in EDITS:
        if new in text:
            continue
        if old not in text:
            print(f"ANCHOR-DRIFT  {ROUTER}: {old.splitlines()[0][:60]}")
            return 1
        text = text.replace(old, new, 1)

    if text == original:
        print("already")
        return 0
    if a.check:
        print(f"would-patch  {ROUTER}")
        return 0
    p.write_text(text)
    print(f"patched  {ROUTER}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
