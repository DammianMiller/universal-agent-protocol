# P14: Output Format Validation

**Category**: Verification
**Abbreviation**: Format-Check

## Pattern

Verify output matches the exact format requested.

## Rule

```
If task specifies format → Output MUST match that format.
```

## Implementation

1. Extract format requirements from task
2. Validate output against requirements
3. Fix mismatches immediately

## Examples

- Task: "output as JSON" → Must be valid JSON
- Task: "CSV with headers name,email" → Must have those exact headers
- Task: "markdown table" → Must be valid markdown table syntax

## Validation Commands

```bash
# JSON validation
python3 -c "import json; json.load(open('output.json'))"

# YAML validation
python3 -c "import yaml; yaml.safe_load(open('config.yml'))"

# CSV validation
python3 -c "import csv; list(csv.DictReader(open('data.csv')))"
```

## Anti-Pattern

❌ Outputting JSON when task asks for CSV
❌ Using different header names than specified
❌ "Close enough" format matching
