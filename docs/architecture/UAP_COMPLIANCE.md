# UAP Deviation Fixes - Implementation Plan

## Overview
This document outlines options to fix minor deviations from strict UAP compliance identified in the qwen35-a3b-iq4xs implementation.

---

## Deviation #1: Markdown Frontmatter vs JSON Schema

### Current State (Non-Compliant)
Droids use YAML frontmatter for metadata:
```yaml
---
name: code-quality-guardian
description: Proactive code quality enforcer...
model: inherit
coordination:
  channels: ["review", "broadcast"]
  claims: ["exclusive"]
---
# Instructions here...
```

### Option A: Strict JSON Schema (Recommended) ✅
**Pros:** Machine-parsable, type-safe, validates against schema  
**Cons:** Less human-readable for quick edits  

**Implementation:**
- Convert `.factory/droids/*.md` to use embedded JSON in frontmatter
- Add schema validation during droid discovery via `discoverDroids()`
- Example:
  ```json
  ---
  {
    "name": "code-quality-guardian",
    "description": "...",
    "model": "inherit",
    "coordination": {
      "channels": ["review", "broadcast"],
      "claims": ["exclusive"]
    }
  }
  ---
  ```

**Files to modify:**
- `src/cli/droids.ts` - Add JSON validation in `addDroid()`
- `.opencode/plugin/uap-droids.ts` - Update parser with Zod schema
- Existing droids: Migrate one at a time as template for others

---

### Option B: Hybrid Format (Balanced) ⚠️
**Pros:** Retains YAML readability, adds JSON validation layer  
**Cons:** Slightly more complex parsing  

**Implementation:**
- Keep YAML frontmatter but add required `@schema` directive in body
- Example:
  ```yaml
  ---
  name: code-quality-guardian
  description: ...
  model: inherit
  coordination:
    channels: ["review", "broadcast"]
  ---

  @schema {
    "$ref": "#/definitions/DroidSchema"
  }

  # Instructions here...
  ```

**Files to modify:**
- `.opencode/plugin/uap-droids.ts` - Add schema directive parser
- `src/types/config.ts` - Define DroidSchema in TypeScript

---

## Deviation #2: Missing Decoder-First Gate

### Current State (Partial Implementation)
CLAUDE.md mentions "DECODER-FIRST GATE" but no explicit implementation exists. The system relies on implicit validation via memory checks and worktrees.

### Option A: Explicit Pre-Execution Validator ✅
**Pros:** Clear separation of concerns, easy to test  
**Cons:** Adds one extra step before task execution  

**Implementation:**
```typescript
// src/tasks/decoder-gate.ts
export async function validateDecoderFirst(
  droidName: string, 
  taskContext: TaskContext
): Promise<ValidationResult> {
  // Step 1: Verify model can parse droid instructions
  const schemaValid = await validateSchema(droidMeta);
  
  // Step 2: Check required tools are available
  const toolAvailability = checkToolAccess(droidMeta.tools);
  
  // Step 3: Validate coordination claims don't conflict
  const conflicts = await detectCoordinationConflicts(
    droidName, 
    taskContext.agentId
  );

  return { valid: schemaValid && toolAvailability && !conflicts };
}
```

**Files to modify:**
- `src/tasks/decoder-gate.ts` (new file)
- `.opencode/plugin/uap-droids.ts` - Call gate before invocation
- Add test in `tests/droids-parallel.test.ts`

---

### Option B: Implicit Gate via Memory Pre-check ⚠️
**Pros:** No new code, leverages existing memory system  
**Cons:** Less explicit, harder to trace failures  

**Implementation:**
```typescript
// Modify uap_droid_invoke in .opencode/plugin/uap-droids.ts
async execute({ droid, task }) {
  const validation = await validateMemoryContext(droid);
  if (!validation.valid) return validation.error;

  // Proceed with normal invocation...
}
```

---

## Deviation #3: Optional Worktree Creation ✅ (Already Compliant-ish)

### Current State
Worktrees are recommended but not enforced (`[ ] MANDATORY` in droid instructions).

### Option A: Enforce via Pre-Check Hook 🔧
**Pros:** Ensures consistency, prevents race conditions  
**Cons:** Slightly slower execution  

**Implementation:**
```typescript
// In .opencode/plugin/uap-droids.ts - before invoke
const worktree = await ensureWorktree(droidName);
if (!worktree) {
  throw new Error(`Droid ${droid} requires active worktree`);
}
```

---

## Recommended Implementation Path

### Phase 1: JSON Schema Enforcement (Week 1)
1. Update `discoverDroids()` with Zod schema validation
2. Convert code-quality-guardian to strict format as template
3. Add migration script for existing droids

**Files:** 
- `.opencode/plugin/uap-droids.ts`
- `src/cli/droids.ts` (add --strict flag)

### Phase 2: Decoder Gate Implementation (Week 1-2)
1. Create `src/tasks/decoder-gate.ts` with validation logic
2. Integrate into droid invocation flow
3. Add unit tests for gate scenarios

**Files:**
- New file: `src/tasks/decoder-gate.ts`
- `.opencode/plugin/uap-droids.ts` (integration)

### Phase 3: Worktree Enforcement (Week 2)
1. Modify `claim()` in coordination to require worktree
2. Add warning for optional droids without enforcement
3. Update CLI help text

**Files:**
- `src/tasks/coordination.ts` - update claim() logic
- `src/cli/droids.ts` - add --require-worktree flag

---

## Testing Strategy

### Parallel Droid Test Enhancement
```typescript
// Add to tests/droids-parallel.test.ts
it('validates decoder-first gate for all droids', async () => {
  const invalidDroid = 'non-existent-droid';
  await expect(validateDecoderFirst(invalidDroid)).rejects.toThrow();
  
  const validDroid = 'code-quality-guardian';
  await expect(validateDecoderFirst(validDroid)).resolves.toBe(true);
});

it('enforces worktree creation for strict droids', async () => {
  await expect(claimTaskWithoutWorktree()).rejects.toThrow();
});
```

---

## Compliance Score After Fixes

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Schema validation | YAML frontmatter | JSON + Zod | ✅ Fixable in Phase 1 |
| Decoder-first gate | Implicit | Explicit validator | ⚠️ Needs implementation |
| Worktree enforcement | Optional → Recommended | Mandatory (configurable) | 🔧 Easy fix |

**Overall: ~85% compliant now, will reach 95-98% after fixes.**
