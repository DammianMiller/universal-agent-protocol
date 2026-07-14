/**
 * Never order the agent to do something only more writing can fix.
 *
 * A multi-file Rust crate CANNOT compile until its module tree is whole: write
 * `main.rs` with `use mycrate::types::*` and cargo rightly reports an unresolved
 * import until `types/mod.rs` lands. The per-write check used to answer EVERY
 * failure with "fix these BEFORE writing anything else" — a deadlock, because
 * writing the missing module was the only possible fix. On a live mission the
 * agent obeyed, retried, and the identical repeated message drove the proxy's
 * ERROR-LOOP guard to fire 10 times.
 */
import { describe, it, expect } from 'vitest';
import { isIncompleteScaffold } from '../../src/delivery/agentic-executor.js';

describe('isIncompleteScaffold — "not written yet" is not a defect', () => {
  it('the LIVE case: unresolved imports while the module tree is being written', () => {
    expect(isIncompleteScaffold([
      "src/main.rs:1:5: error[E0432]: unresolved import `rubiks_cube::types`",
      "src/lib.rs:3:9: error[E0583]: file not found for module `vec3`",
    ])).toBe(true);
  });

  it('treats failed-to-resolve / cannot-find-crate the same way', () => {
    expect(isIncompleteScaffold(["error[E0433]: failed to resolve: use of undeclared crate `foo`"])).toBe(true);
  });

  it('a REAL error is NOT scaffolding — the agent must actually fix it', () => {
    expect(isIncompleteScaffold([
      "src/main.rs:9:5: error[E0308]: mismatched types",
    ])).toBe(false);
  });

  it('a MIX of real + scaffold errors counts as real (do not excuse the type error)', () => {
    expect(isIncompleteScaffold([
      "error[E0432]: unresolved import `x::y`",
      "error[E0308]: mismatched types",
    ])).toBe(false);
  });

  it('no errors at all is not scaffolding', () => {
    expect(isIncompleteScaffold([])).toBe(false);
  });
});
