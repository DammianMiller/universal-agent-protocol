| name | description |
| --- | --- |
| near-miss-iteration | Iteration protocol for when >50% of tests pass. Focus on specific failures without breaking passing tests. Reserve 30% of time budget. |

# Near-Miss Iteration

## When to Use
Test results show partial success: 8/9, 6/7, 5/6, or any >50% pass rate.

## Protocol
1. Run tests with verbose output
2. Extract ONLY failing test names
3. Read failing test source to understand exact requirement
4. Fix specific issue without touching passing code
5. Re-run failing test first, then full suite
6. Repeat until 100% or time exhausted

## Rules
- Reserve 30% of time for iteration
- Fix ONE test at a time
- Never refactor passing code during this phase
- Read assertion messages -- they contain expected values
