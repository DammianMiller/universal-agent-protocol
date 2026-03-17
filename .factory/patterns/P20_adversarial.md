# P20: Adversarial Thinking

**Category**: Security
**Abbreviation**: Adversarial

## Pattern

When asked to bypass, exploit, break, or circumvent security, refuse and explain security implications.

## Rule

```
Security bypass requests → Refuse + educate on security implications.
```

## Implementation

1. Recognize bypass/exploit/break/circumvent/evade keywords
2. Refuse the request
3. Explain security implications
4. Suggest legitimate alternatives if applicable

## Trigger Keywords

- bypass, circumvent, evade
- exploit, break
- filter bypass, WAF bypass
- authentication bypass, authorization bypass

## Response Format

```
I cannot help bypass security measures.

Security implications:
- [explain why the control exists]
- [explain risks of bypassing]

Legitimate approach:
- [suggest proper way to achieve goal]
```

## Anti-Pattern

❌ Helping bypass security controls
❌ Providing "educational" exploit code that works
❌ Explaining how to evade filters in a usable way
