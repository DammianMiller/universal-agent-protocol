# P35: Decoder-First Analysis

**Category**: Analysis
**Abbreviation**: Decoder-First

## Pattern

For decode/deserialize tasks, analyze the decoder/parser requirements first. Understanding the target format guides encoding.

## Rule

```
Decode task → Understand decoder → Reverse-engineer format.
```

## Implementation

1. Identify target format/decoder
2. Understand decoder requirements
3. Construct valid input for decoder
4. Verify decode succeeds

## Decoder Analysis

```python
# What does the decoder expect?
json.loads()      # Expects valid JSON string
yaml.safe_load()  # Expects valid YAML
pickle.loads()    # Expects pickle bytes
struct.unpack()   # Expects specific byte format
```

## Common Decoder Requirements

- JSON: Proper quotes, escaping, structure
- Binary: Correct byte order, size
- CSV: Correct delimiter, quoting
- Custom: Parser-specific rules

## Anti-Pattern

❌ Encoding without understanding decoder
❌ Assuming format is obvious
❌ Creating data that "looks right"
