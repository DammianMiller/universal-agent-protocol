# P38: Prior Art First

**Category**: Planning
**Abbreviation**: PriorArt

## Pattern

Study how established products already solve the problem before designing a
solution. Adopt their proven patterns and conventions instead of inventing an
approach from scratch.

## Rule

```
BEFORE designing: name how 1-2 established products/libraries solve this,
and say which convention you are adopting — or why you are not.
```

## Implementation

Cheapest sources first; stop as soon as one answers the question.

```bash
# 1. This project already — the strongest prior art there is
grep -rn "<the concept>" src/ --include="*.ts" | head
ls node_modules | grep -i "<the concept>"

# 2. The dependency you already have (check its docs and TYPES before
#    concluding it cannot do this — assuming it can't is how duplicates start)
cat node_modules/<pkg>/README.md
find node_modules/<pkg> -name "*.d.ts" | head

# 3. Only then: how do well-known products in this space do it?
```

## Why

Inventing an approach costs more than adopting one, and it costs again at every
future maintenance step, because nobody else's knowledge transfers to it. A
convention that is already proven brings its edge cases already discovered.

The second command matters most: "the library doesn't support this" is usually
an assumption, not a finding. Check the types.

## Anti-pattern

Writing a util that a dependency already exports. Designing a bespoke
configuration format. Re-deriving a state machine that a well-known library
documents. All three look like progress and are rework.

## Related

- Engineering principles rules 5, 6 and 8 (`uap principles show`)
- P17 Constraint Extraction — prior art is a constraint source
