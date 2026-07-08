# adr-guard

**Category**: safety
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: adr, architecture, invariants, write-gate

## Rule

Write/Edit tool calls MUST satisfy every machine-readable rule block declared
in the project's ADRs. An ADR under `docs/adr/` may embed a `<!-- uap-rules
... -->` HTML comment declaring `forbid` / `require` regexes scoped by path
prefix, exclusion substring, and extension. A write whose content violates a
matching rule is **blocked** with the ADR's own message.

## Why

Architectural and security invariants decided in an ADR decay unless they are
enforced where the regression would be written. Declaring the rule inside the
ADR itself keeps a single source of truth: accept the decision, and the gate
comes with it. The policy is inert in projects whose ADRs declare no rule
blocks.

## Enforcement

Python enforcer `adr_guard.py` parses `uap-rules` blocks from every ADR under
`docs/adr/` (cached per mtime) and evaluates each Write/Edit target/content
against the matching rules. Rule fields: `id`, `scope.include/exclude/ext`,
`forbid` (regex must NOT match), `require` (regex MUST match), `message`.

```rules
- title: "Writes must satisfy the machine-readable rule blocks embedded in ADRs"
  keywords: [write, edit, adr, invariant, forbid, require]
  antiPatterns: []
```
