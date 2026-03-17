# P24: Polyglot Code Construction

**Category**: Code-Golf
**Abbreviation**: Polyglot

## Pattern

For code that must work in multiple languages, test in each language explicitly. Do not assume compatibility.

## Rule

```
"Works in both X and Y" → Test in X, then test in Y.
```

## Implementation

1. Identify all target languages
2. Write code that satisfies syntax of all targets
3. Test in each language independently
4. Verify output in each language

## Common Polyglot Patterns

- Code that's valid in both Python and Ruby
- HTML/JS polyglots
- Shell/Python polyglots

## Testing Requirements

```bash
# For Python + Ruby polyglot
python3 polyglot.py
ruby polyglot.rb

# Both must succeed with same output
```

## Anti-Pattern

❌ Writing code and assuming it works in both languages
❌ Testing only one language
❌ Ignoring subtle syntax differences
