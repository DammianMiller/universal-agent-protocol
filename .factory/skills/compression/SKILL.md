---
name: compression
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
------
name: compression
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`



> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

| name | description | argument-hint |
| --- | --- | --- |
| compression | Use when tasks involve data compression, codegolf, encoder/decoder creation, or compression impossibility detection. Includes decoder-first analysis protocol. | compression target or decoder source |


#
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:compression.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
# Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:<skill-name>.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
# Compression & Codegolf

## Detection
Keywords: "compress", "codegolf", "under X bytes", "minimal size", "encoder", "decoder", "decompressor"

## Impossibility Check (DO FIRST)
These are **mathematically impossible** -- refuse immediately:
- ML model weights below ~1% of original (GPT-2 = 500MB+, cannot be <5MB with function)
- Random/encrypted data (incompressible by definition)
- Compression ratio beyond information-theoretic limits (Shannon entropy)

If impossible: create `IMPOSSIBLE.md` explaining why. Do not attempt.

## Decoder-First Protocol
When a task provides a decoder/decompressor:
1. **READ the decoder source code FIRST** before writing encoder
2. Extract the exact format it expects (headers, encoding, byte order)
3. Create minimal test case matching decoder's expected format
4. Test round-trip: `original == decode(encode(original))` BEFORE optimizing
5. If decoder crashes, your format is wrong -- do not optimize further

## Codegolf Strategy
1. Start with a correct (unoptimized) solution
2. Verify it works end-to-end
3. Then shrink iteratively: remove whitespace, use shorter names, exploit language quirks
4. Test after EVERY shrink step -- do not batch optimizations

## Round-Trip Verification
For any encode/compress task:
```bash
# Compress
./compress input.dat > compressed.dat
# Decompress
./decompress compressed.dat > output.dat
# Verify
diff input.dat output.dat && echo "MATCH" || echo "MISMATCH"
```



## UAP Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```



## UAP Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```
