# UAM v10.4 Pattern Compliance Design

**Generated:** 2026-01-18
**Problem:** 75% of failures have patterns that EXIST but weren't APPLIED
**Solution:** Mandatory checkpoint gates + pattern router

---

## Executive Summary

Analysis of 16 failing tasks in uam_opus45_correct reveals:
- **12/16 (75%)** failures have relevant UAM patterns that weren't applied
- This is a **COMPLIANCE problem**, not a pattern coverage problem
- Current patterns are advisory; agents can skip them without consequence

---

## Root Cause Analysis

### Why Patterns Aren't Being Applied

| Root Cause | Impact | Evidence |
|------------|--------|----------|
| **Cognitive Overload** | HIGH | 20 patterns too many to remember during task |
| **No Enforcement** | HIGH | Patterns are advisory, not mandatory |
| **Selection Confusion** | MEDIUM | Agent must manually map task → patterns |
| **Timing Issue** | MEDIUM | Critical reminders at END, may not be re-read |

### Failure-to-Pattern Mapping

| Task | Score | Relevant Pattern | Applied? |
|------|-------|------------------|----------|
| pytorch-model-cli | 0/6 | P12 (OEV), P16 (TFE) | NO |
| gpt2-codegolf | 0/1 | P5 (Impossible), P19 (ITR+) | NO |
| break-filter-js-from-html | 0/1 | P20 (AT), P12 (OEV) | NO |
| feal-linear-cryptanalysis | 0/1 | P11 (Pre-computed) | NO |
| write-compressor | 2/3 | P12 (OEV) | Partial |
| caffe-cifar-10 | 1/6 | P12 (OEV), P13 (IRL) | NO |
| polyglot-rust-c | 0/1 | P17 (CE) | NO |
| fix-git | 0/2 | P3 (State Protection) | NO |
| pypi-server | 0/1 | P14 (OFV), P17 (CE) | NO |
| mteb-retrieve | 1/2 | P14 (OFV), P17 (CE) | NO |
| chess-best-move | 0/1 | P18 (MTP), P11 | NO |
| winning-avg-corewars | 2/3 | P13 (IRL) | Partial |
| adaptive-rejection-sampler | 8/9 | P13 (IRL) | Partial |
| torch-tensor-parallelism | 1/3 | P15 (ER) | NO |
| configure-git-webserver | 0/1 | P2 (Recipe), P15 (ER) | NO |
| headless-terminal | 6/7 | P13 (IRL) | Partial |

---

## Proposed Solutions

### Solution 1: Mandatory Checkpoint Gates (PRIORITY 1)

Add BLOCKING checkpoints that prevent completion without verification.

```markdown
## 🚦 MANDATORY COMPLETION GATES

**CANNOT say "done" or "complete" until ALL gates pass:**

### GATE 1: Output Existence (P12)
```bash
# List ALL expected outputs from task
OUTPUTS="/app/output.json /app/result.txt"
for f in $OUTPUTS; do
  [ -f "$f" ] && echo "✓ $f" || { echo "✗ $f MISSING - CREATE NOW"; exit 1; }
done
```

### GATE 2: Constraint Compliance (P17)
```
Task constraints extracted:
☐ Single file (not multiple)
☐ Exactly one line output
☐ Format: JSON
☐ Size: < 5KB

ALL MUST BE CHECKED before completion.
```

### GATE 3: Test Verification (P13)
```bash
# Run tests, verify 100% pass
pytest /tests/ -v
# If < 100%, iterate (P13) until pass or timeout
```

**HARD STOP**: If ANY gate fails, DO NOT report completion.
```

### Solution 2: Pattern Router (PRIORITY 2)

First step automatically classifies task and selects relevant patterns.

```markdown
## 🎯 PATTERN ROUTER - MANDATORY FIRST STEP

BEFORE any work, classify the task:

| If Task Contains... | Select Patterns |
|--------------------|-----------------|
| "create file", "output to", "generate" | P12 (OEV), P16 (TFE) |
| "exactly", "only", "single", "must be" | P17 (CE), P14 (OFV) |
| "bypass", "break", "exploit", "filter" | P20 (AT) |
| image/audio/binary → text | P9 (Format), P18 (MTP) |
| "compress to X bytes", "under X limit" | P5 (Impossible), P19 (ITR+) |
| known algorithm (crypto, chess, ML) | P11 (Pre-computed) |
| config/database/state modification | P3 (State Protection) |

**Output format:**
```
TASK CLASSIFICATION: file-creation + constraint
SELECTED PATTERNS: P12, P16, P17, P14
PROCEED WITH SELECTED PATTERNS ONLY
```
```

### Solution 3: Compressed Super-Patterns (PRIORITY 3)

Reduce 20 patterns to 5 memorable super-patterns.

```markdown
## 🧠 SUPER-PATTERNS (MEMORIZE THESE 5)

### A: VERIFY OUTPUTS
Combines: P12 (OEV), P14 (OFV), P16 (TFE)
CHECK: "Do all outputs EXIST and MATCH spec?"

### B: CHECK CONSTRAINTS  
Combines: P17 (CE), P5 (Impossible), P19 (ITR+)
CHECK: "Are all constraints EXTRACTED and SATISFIABLE?"

### C: SELECT TOOLS
Combines: P4, P8, P11, P18 (MTP)
CHECK: "Are the RIGHT tools SELECTED and AVAILABLE?"

### D: ITERATE TO 100%
Combines: P13 (IRL), P15 (ER)
CHECK: "If partial success, ITERATE until 100% or timeout"

### E: SPECIAL MODES
Combines: P20 (AT), P3 (State), P9 (Format)
CHECK: "Is this ADVERSARIAL / FORENSIC / FORMAT-TRANSLATION?"
```

---

## Implementation Plan

### Phase 1: Add Completion Gates to CLAUDE.md

```markdown
## 🚦 COMPLETION GATES - MANDATORY

Before saying "done" or "complete", execute ALL gates:

```bash
# GATE 1: Output Existence
echo "=== GATE 1: OUTPUT CHECK ==="
# [list all expected files from task]
ls -la /app/expected_output.* 2>&1

# GATE 2: Constraint Check  
echo "=== GATE 2: CONSTRAINT CHECK ==="
# [verify each constraint from task]

# GATE 3: Test Verification
echo "=== GATE 3: TEST CHECK ==="
pytest /tests/ -v 2>&1 | tail -20

# If ANY gate fails: FIX and RE-RUN
# Do NOT proceed until all gates pass
```

**HARD RULE**: Skip gates = task INCOMPLETE
```

### Phase 2: Add Pattern Router to Critical Reminders

Add to CRITICAL REMINDERS at position #1:

```markdown
1. **PATTERN ROUTER (FIRST STEP)**: Before ANY work, classify and select:
   - File creation task? → P12, P16
   - Has constraints? → P17, P14  
   - Bypass/exploit? → P20
   - Known algorithm? → P11
   Print selected patterns before starting.
```

### Phase 3: Consolidate Patterns (Future)

Refactor template to use 5 super-patterns instead of 20 individual ones.

---

## Expected Impact

| Metric | Current (v10.3) | Expected (v10.4) |
|--------|-----------------|------------------|
| Pattern Compliance | 25% | 80%+ |
| Pass Rate | 54.3% | 70-75% |
| Failures from non-compliance | 12 | 2-3 |

**Reasoning:**
- Checkpoint gates enforce P12/P14/P17 → fixes 6+ tasks
- Pattern router ensures correct patterns selected → fixes 3+ tasks
- Combined improvement: +15-20% pass rate

---

## Files to Update

1. `templates/CLAUDE.template.md`
   - Add COMPLETION GATES section
   - Add PATTERN ROUTER to Critical Reminders
   - Reorder Critical Reminders (router first)

2. `CLAUDE.md` - regenerate

3. Bump version: 1.0.3 → 1.0.4
