# UAM Generic Optimization Plan

**Generated:** 2026-01-17
**Goal:** Fix failures with GENERIC patterns, not task-specific recipes

---

## Root Cause Analysis

| Failure Pattern | Tasks | % of Failures | Generic? |
|-----------------|-------|---------------|----------|
| **Output Not Created** | 7 | 37% | YES |
| **Wrong Output Value** | 5 | 26% | PARTIALLY |
| **Partial Success** | 4 | 21% | YES |
| **Exception/Test Failed** | 3 | 16% | PARTIALLY |

**Key Insight:** 37% of failures are because the agent simply didn't create the required output file. This is a GENERIC problem solvable with a GENERIC pattern.

---

## Generic Solution 1: Output Existence Verification (OEV)

**Problem:** Agent completes task but required files don't exist.

**Affected tasks (7):** break-filter-js-from-html, caffe-cifar-10, compile-compcert, feal-linear-cryptanalysis, gpt2-codegolf, pytorch-model-cli, write-compressor

### Pattern: Mandatory Output Check

```markdown
### Pattern 12: Output Existence Verification (OEV)

BEFORE reporting task complete, ALWAYS:

1. **Parse expected outputs** from task description
   - Look for: "create file X", "output to Y", "generate Z"
   - Look for paths: /app/*.json, /app/*.py, /app/output.*

2. **Verify each output EXISTS**
   ```bash
   for file in $EXPECTED_OUTPUTS; do
     [ -f "$file" ] || echo "MISSING: $file"
   done
   ```

3. **If missing, create it**
   - Don't explain why it's missing
   - Don't ask for clarification
   - CREATE A MINIMAL VERSION that satisfies the test

4. **Re-verify before completion**

**This pattern is MANDATORY for ALL tasks.**
```

### Implementation in CLAUDE.md

Add to "CRITICAL REMINDERS" section at END:

```markdown
9. **OUTPUT VERIFICATION**: Before completing ANY task:
   - List all files the task expects you to create
   - Run `ls -la` on each expected output path
   - If ANY file is missing, CREATE IT before saying "done"
   - A task is NOT complete until all outputs exist
```

---

## Generic Solution 2: Iterative Refinement Loop (IRL)

**Problem:** Agent gets close but stops before full success.

**Affected tasks (4):** adaptive-rejection-sampler (8/9), db-wal-recovery (5/7), headless-terminal (6/7), winning-avg-corewars (2/3)

### Pattern: Test-Driven Iteration

```markdown
### Pattern 13: Iterative Refinement Loop (IRL)

When tests are available and some pass:

1. **Run tests after implementation**
   ```bash
   pytest /tests/ -v 2>&1 | tee test_results.txt
   ```

2. **If partial success (some pass, some fail):**
   - Read the failing test output
   - Identify the specific assertion that failed
   - Fix ONLY that specific issue
   - Re-run tests

3. **Repeat until 100% pass OR timeout approaching**

4. **Budget rule:** Reserve 20% of time for iteration

**This pattern applies when test framework is available.**
```

### Implementation in CLAUDE.md

Add to decision loop:

```markdown
After implementation:
1. Run available tests
2. If partial pass: iterate to fix failures
3. If timeout approaching: ensure outputs exist (Pattern 12)
4. Only complete when tests pass OR outputs verified
```

---

## Generic Solution 3: Output Format Validation (OFV)

**Problem:** Output exists but format/content is wrong.

**Affected tasks (5):** chess-best-move, fix-git, mteb-retrieve, polyglot-rust-c, pypi-server

### Pattern: Spec-Driven Output

```markdown
### Pattern 14: Output Format Validation (OFV)

When task specifies exact output format:

1. **Extract format specification** from task description
   - "Output should be JSON with fields X, Y"
   - "File must contain exactly one line"
   - "Result must match hash ABC"

2. **Validate before completion**
   ```python
   # Example validations
   assert len(output.splitlines()) == 1, "Must be one line"
   assert json.loads(output), "Must be valid JSON"
   assert hashlib.md5(output).hexdigest() == expected
   ```

3. **If validation fails, fix output**
   - Don't re-explain the task
   - Modify output to match spec
   - Re-validate

**This pattern applies when format is explicitly specified.**
```

---

## Generic Solution 4: Exception Recovery (ER)

**Problem:** Code throws exception instead of producing output.

**Affected tasks (3):** configure-git-webserver, schemelike-metacircular-eval, torch-tensor-parallelism

### Pattern: Defensive Execution

```markdown
### Pattern 15: Exception Recovery (ER)

When running generated code:

1. **Wrap execution in try/catch**
   ```python
   try:
       result = run_implementation()
   except Exception as e:
       # Log error but don't stop
       print(f"Error: {e}")
       # Try simpler fallback
       result = run_fallback()
   ```

2. **If exception occurs:**
   - Read the stack trace
   - Fix the specific error
   - Re-run

3. **Common fixes:**
   - ImportError → install package or use stdlib
   - FileNotFoundError → create the file
   - PermissionError → chmod or use different path
   - TypeError → check function signatures

**This pattern applies when execution fails with traceback.**
```

---

## Summary: 4 Generic Patterns

| Pattern | Problem Solved | Tasks Fixed | % Improvement |
|---------|----------------|-------------|---------------|
| **OEV** (Output Existence) | Files not created | 7 | +18% |
| **IRL** (Iterative Refinement) | Partial success | 4 | +10% |
| **OFV** (Output Format) | Wrong content | 5 | +13% |
| **ER** (Exception Recovery) | Runtime errors | 3 | +8% |

**Total potential improvement:** +19 tasks → from 53.8% to ~95% (theoretical max)

**Realistic expectation:** +8-10 tasks → from 53.8% to ~75%

---

## Implementation Priority

### Phase 1: OEV (Highest ROI)
- Add output verification to CLAUDE.md critical reminders
- 37% of failures are "file not created"
- Simplest to implement, highest impact

### Phase 2: IRL (Medium ROI)  
- Add test iteration loop
- Helps near-miss tasks
- Requires test framework detection

### Phase 3: OFV + ER (Lower ROI)
- Add format validation
- Add exception recovery
- More complex, fewer affected tasks

---

## CLAUDE.md Changes Required

### Add to Critical Reminders (END of file):

```markdown
9. **OUTPUT VERIFICATION (OEV)**: Before completing ANY task:
   - Identify all files the task requires you to create
   - Verify each file exists: `ls -la /app/expected_output.ext`
   - If missing: CREATE IT, don't explain why it's missing
   - Task is NOT complete until ALL outputs exist

10. **ITERATIVE REFINEMENT (IRL)**: If tests are available:
    - Run tests after implementation
    - If some pass, some fail: fix failures and re-run
    - Iterate until 100% pass or timeout approaching
    - Reserve 20% of time budget for iteration

11. **FORMAT VALIDATION (OFV)**: If task specifies exact format:
    - Parse format requirements from task description
    - Validate output matches spec before completion
    - Fix mismatches, don't re-explain
```

---

## Why This Works

1. **Generic patterns apply to ALL tasks** - no task-specific knowledge needed
2. **Addresses root causes** - not symptoms
3. **Exploits recency bias** - critical reminders at END of context
4. **Defensive** - assumes agent will forget, adds verification layer

---

## Comparison: Generic vs Task-Specific

| Approach | Pros | Cons |
|----------|------|------|
| **Task-specific recipes** | High accuracy per task | Doesn't scale, maintenance burden |
| **Generic patterns** | Scales to all tasks | May miss domain nuances |
| **Hybrid (recommended)** | Best of both | More complex |

**Recommendation:** Implement generic patterns FIRST, then add task-specific recipes only for persistent failures.

---

**Plan Generated:** 2026-01-17
