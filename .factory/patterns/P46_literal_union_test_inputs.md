# P46: Literal-Union Test Inputs from Source of Truth

**Category**: Testing
**Abbreviation**: LU-Inputs

## Pattern

When code under test exposes strict literal-union types (e.g. `'0 | 3 | 2 | 1 | 6'`
from generated tables/enums) and tests pass plain numbers, TypeScript fails with
TS2345 and burns convergence turns on a non-defect. Build test inputs FROM the
source of truth, not from hand-written copies of it.

## Rule

```
Never hand-write a literal union in a test. Derive inputs from the exported
constant/union, or cast at the single boundary where a widened number is
legitimately accepted.
```

## Implementation

```typescript
// BAD — drifts when the source of truth changes:
expect(placeProp('stone', 3)).toBe(...);        // TS2345: 3 not in '0|1|2|3'?
// GOOD — import the union and derive:
import { PROP_IDS } from './props';
const firstId = PROP_IDS[0];                      // typed by the source of truth
expect(placeProp('stone', firstId)).toBe(...);
// GOOD — explicit single-boundary cast where the API takes a widened value:
expect(placeProp('stone', 3 as (typeof PROP_IDS)[number])).toBe(...);
```

If a test needs EVERY member, iterate the union array — do not enumerate
literals in the test body.

## Examples

- Generated voxel/world tables expose literal ids; tests iterate the table
- API surface typed `Kind: 'a' | 'b' | 'c'`; test uses `kinds[k]` not `'a'`
- A gate failure shows `TS2345 ... not assignable to 'X | Y'` in a test file →
  replace the literal with a source-of-truth reference, do not widen the API
