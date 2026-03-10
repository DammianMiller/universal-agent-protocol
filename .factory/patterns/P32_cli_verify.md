# P32: CLI Execution Verification

**Category**: Verification
**Abbreviation**: CLI-Verify

## Pattern

For CLI/executable tasks, run the binary and verify output. Do not just read source code.

## Rule

```
CLI created → Execute binary → Verify output.
```

## Implementation

1. Build/compile the CLI
2. Execute with test arguments
3. Verify output matches expected
4. Test edge cases

## CLI Test Commands

```bash
# Build
go build -o mycli main.go
# or
gcc -o mycli main.c

# Execute
./mycli --help
./mycli arg1 arg2

# Verify
./mycli test-input > output.txt
diff output.txt expected.txt
```

## CLI Verification Checklist

- [ ] Compiles without errors
- [ ] --help shows usage
- [ ] Valid arguments produce expected output
- [ ] Invalid arguments show error message
- [ ] Exit codes are correct

## Anti-Pattern

❌ Reading CLI source and assuming it works
❌ Not testing with actual arguments
❌ Ignoring error handling paths
