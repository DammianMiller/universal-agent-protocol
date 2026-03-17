# P31: Round-Trip Verification

**Category**: Verification
**Abbreviation**: Round-Trip

## Pattern

For encode/compress operations, verify by decoding/decompressing. Round-trip must restore original.

## Rule

```
Encode/compress → Decode/decompress → Must equal original.
```

## Implementation

1. Encode/compress the data
2. Decode/decompress the result
3. Compare with original
4. If mismatch: fix encoding

## Round-Trip Test

```python
original = "test data"
encoded = encode(original)
decoded = decode(encoded)
assert decoded == original, "Round-trip failed!"
```

## Common Round-Trip Failures

- Base64 encoding with wrong character set
- Compression with data loss
- Encryption with padding issues
- Character encoding mismatches

## Anti-Pattern

❌ Encoding without testing decode
❌ Compressing without verifying decompression
❌ Claiming encoding works without round-trip test
