---
name: chess-engine
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
------
name: chess-engine
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`



> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

| name | description | argument-hint |
| --- | --- | --- |
| chess-engine | Use when tasks involve chess analysis, best-move finding, FEN/PGN parsing, or checkmate puzzles. Chess tasks require external engines -- reasoning alone cannot find optimal moves. | FEN string or chess position description |


#
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:chess-engine.md for domain-specific guidance
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
# Chess Engine Integration

## Detection
Keywords: "chess", "best move", "FEN", "PGN", "checkmate", "Stockfish"

## Protocol
1. Check for Stockfish: `which stockfish || apt-get install -y stockfish`
2. Parse board state to FEN format
3. Use Stockfish for analysis:
   ```bash
   echo -e "position fen <FEN>\ngo depth 20\nquit" | stockfish
   ```
4. Extract best move from engine output (`bestmove` line)

## Rules
- **NEVER** try to calculate chess moves through reasoning -- use the engine
- Use `python-chess` library for FEN validation and move legality checks
- For multi-move analysis, use `go depth 20` minimum
- Parse UCI output format: `bestmove e2e4 ponder d7d5`



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
