# Pre-Edit Build Gate

Before editing any TypeScript source file, the build MUST be verified as passing. After each edit (or batch of edits to a single file), the build MUST be re-verified before proceeding to the next file. If the build fails after an edit, the error MUST be fixed before any further edits are made.

## Rules

1. **Verify build before editing.** Before making the first edit to any `.ts` file in a session, run `bash scripts/validate-build.sh` (or `npm run build`) to confirm the project compiles cleanly. If it fails, fix the existing errors first before introducing new changes.

2. **Re-verify after each file edit.** After completing edits to a `.ts` file, run `npm run build` before moving to the next file. This catches errors immediately at the source rather than letting them accumulate across multiple files.

3. **Fix before proceeding.** If the build fails after an edit, the agent MUST fix the error in that file before editing any other file. Never leave the project in a broken build state while making changes elsewhere.

4. **Prefer atomic writes for complex changes.** When adding a new function AND wiring it into a dispatcher/switch statement in the same file, prefer writing the complete file content rather than multiple incremental edits. This prevents partial-edit corruption where an edit matches the wrong location in the file.

5. **Read before writing.** Always read the full relevant section of a file before editing it. For files over 200 lines, read the specific region being modified plus 20 lines of surrounding context to ensure edit anchors are unique.

6. **No orphaned code.** After any edit, verify there are no duplicate function definitions, orphaned code blocks outside functions, or unclosed braces. These are symptoms of a partial edit that matched incorrectly.

## Validation Script

```bash
# Quick check (type-check only, no emit)
bash scripts/validate-build.sh

# Full build
bash scripts/validate-build.sh --full

# Or directly
npm run build
```

## Enforcement Level

[REQUIRED]

## Category

automation

## Tags

build, typescript, quality, edit-safety, pre-edit

## Related Tools

- tsc: TypeScript compiler
- npm: Package manager (npm run build)
