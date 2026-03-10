# P12: Output Existence Verification

**Category**: Verification
**Abbreviation**: OE-Verify

## Pattern

Verify output files exist before claiming task completion.

## Rule

```
CANNOT say "done" until ALL expected outputs exist.
```

## Implementation

```bash
for f in $EXPECTED_OUTPUTS; do
  [ -f "$f" ] && echo "ok $f" || echo "MISSING: $f"
done
```

If missing: CREATE IT immediately. No excuses.

## Examples

- Task says "create config.yaml" → config.yaml must exist
- Task says "generate 3 files" → all 3 files must exist
- Task says "output to stdout" → output must appear in terminal

## Anti-Pattern

❌ "I've created the file" (without checking it exists)
❌ "The file should be there" (without verification)
