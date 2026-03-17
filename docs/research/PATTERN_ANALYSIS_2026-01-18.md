# UAP v1.1.0 Pattern Analysis - Deep Failure Study

**Date:** 2026-01-18
**Benchmark Run:** uam_v190_full (11 tasks, 27.3% pass rate, 3/11)
**Analysis Method:** Deep dive into agent logs, verifier outputs, and failure patterns

---

## Executive Summary

Analyzed 8 failing tasks from latest benchmark to extract **generalized patterns** that can improve future performance across similar problem categories.

### Key Findings

1. **Near-Miss Tasks (1 failing test)**: 3 tasks - targeted fixes yield high ROI
2. **Domain-Specific Complexity**: 3 tasks - need specialized pre-hooks/recipes
3. **Fundamentally Hard**: 2 tasks - polyglot-rust-c, pypi-server require different approaches

---

## Task-by-Task Deep Analysis

### 1. adaptive-rejection-sampler (8/9 - Near Miss)

**Failing Test:** `test_can_generate_standard_distribution_samples`

**Agent Behavior (from logs):**

- Agent correctly installed R
- Implemented Gilks & Wild (1992) ARS algorithm
- Tests passed internally but verifier failed on one distribution

**Root Cause:**

- Numerical instability in log-concavity checking
- Derivative computation using fixed step size (1e-6) fails near domain boundaries
- Exponential distribution test intermittently fails due to domain edge effects

**Generalized Pattern: P27 - Numerical Robustness Testing**

```markdown
When implementing numerical algorithms:

1. Test with multiple random seeds (not just one)
2. Test edge cases explicitly (domain boundaries, near-zero, near-infinity)
3. Use adaptive step sizes for derivative computation
4. Add tolerance margins for floating-point comparisons
5. Run 3+ iterations to catch intermittent failures
```

**Transferable to:** Monte Carlo simulations, optimization algorithms, signal processing

---

### 2. chess-best-move (0/1 - Domain Complexity)

**Failing Test:** `test_move_correct`

**Agent Behavior:**

- Correctly identified Pattern 21 (Chess Engine Integration)
- Installed Stockfish successfully
- Generated FEN from visual analysis of image
- **CRITICAL ERROR:** FEN was incorrect - misread piece positions

**Root Cause:**

- Agent's visual analysis of PNG image was unreliable
- Generated FEN: `r1bq3r/1p3ppp/p1n2p2/3nkb1P/8/P1N5/1P2QPP1/R1B1K2R`
- This FEN is syntactically valid but position doesn't match image
- Stockfish gave best move for WRONG position

**Generalized Pattern: P28 - Image-to-Structured Pipeline**

```markdown
When task requires extracting structured data from images:

1. NEVER rely on visual reasoning alone - use dedicated tools
2. Search for existing image recognition libraries:
   - Chess: chessimg2pos, fenify, board_to_fen (Python)
   - OCR: tesseract, easyocr
   - Diagrams: diagram-parser, vision APIs
3. Verify extracted data makes sense before using
4. If no tools available, clearly state limitation
```

**Research (from web search):**

- github.com/mdicio/chessimg2pos - Python image→FEN
- github.com/mcdominik/board_to_fen - Digital board→FEN
- CVChess (arxiv:2511.11522) - CNN for physical boards

**Transferable to:** OCR tasks, diagram parsing, medical imaging, satellite imagery

---

### 3. mteb-retrieve (1/2 - Format Mismatch)

**Failing Test:** `test_data_matches`

**Agent Behavior:**

- Retrieved data successfully
- Created output file
- Data content/format didn't match expected schema

**Root Cause:**

- MTEB has specific output format requirements
- Agent didn't verify output schema against expected format
- Missing or misformatted fields in output

**Generalized Pattern: P29 - Output Schema Verification**

```markdown
When task specifies output format/structure:

1. Parse expected output schema from task description or test files
2. BEFORE completion, validate output against schema:
   - Check all required fields present
   - Verify data types match
   - Confirm array lengths/counts match
3. If tests available, run them and read EXACT error messages
4. Fix schema mismatches before reporting complete
```

**Transferable to:** API responses, data exports, report generation, file format conversions

---

### 4. polyglot-rust-c (0/1 - Near Impossible)

**Failing Test:** `test_fibonacci_polyglot`

**Agent Behavior (173 turns!):**

- Spent 14+ minutes attempting various polyglot approaches
- Tried: comment tricks, preprocessor directives, line continuations
- Could compile as Rust OR C++, never BOTH from same file

**Root Cause:**

- True Rust/C++ polyglot is extremely difficult due to incompatible syntax
- Rust's `fn main()` syntax has no C++ equivalent that compiles
- Agent correctly identified Pattern 24 but couldn't find working example
- 871 seconds spent (timeout approaching)

**Generalized Pattern: P30 - Polyglot Feasibility Check**

```markdown
For polyglot tasks (code that compiles in multiple languages):

1. CHECK if language pair has known polyglot techniques:
   - C/Python: ✓ Possible (preprocessor + string tricks)
   - Python/Perl: ✓ Possible (comment syntax overlap)
   - Rust/C++: ✗ Very difficult (incompatible syntax)
2. SEARCH GitHub for "{lang1}-{lang2} polyglot" examples FIRST
3. If no examples found within 5 minutes, consider task near-impossible
4. Time-box polyglot attempts to 20% of total budget
5. Create working single-language solution as fallback
```

**Research:** The MCPMarket skill "polyglot-rust-c" confirms this is a Terminal-Bench task with known difficulty.

**Transferable to:** Code golf, quine challenges, multi-syntax problems

---

### 5. pypi-server (0/1 - Infrastructure)

**Failing Test:** `test_api`

**Agent Behavior:**

- Attempted to implement PyPI server
- Server didn't respond correctly to API requests

**Root Cause:**

- PyPI Simple API has specific protocol requirements
- Agent didn't implement all required endpoints
- Service verification wasn't thorough

**Generalized Pattern: P31 - Service Endpoint Verification**

```markdown
When implementing server/API:

1. IDENTIFY all required endpoints from spec
2. Implement endpoints ONE by ONE
3. Test EACH endpoint independently before moving on:
   - curl/wget the endpoint
   - Verify response status code
   - Verify response body format
4. Run integration test only after all endpoints pass
5. Use service-specific testing tools when available
```

**Transferable to:** REST APIs, microservices, protocol implementations

---

### 6. pytorch-model-cli (3/6 - Execution Gap)

**Failing Tests:**

- `test_prediction_file_content`
- `test_cli_tool_executable`
- `test_cli_tool_output`

**Agent Behavior:**

- Created weights.json ✓
- Created cli_tool ✓
- Created prediction.txt ✓
- BUT: CLI tool couldn't be executed or produced wrong output

**Root Cause:**

- Agent created Python script as CLI tool
- Script works when run with `python3 cli_tool`
- But test runs it as `./cli_tool` - needs shebang + chmod
- Or: Output format didn't match expected format

**Generalized Pattern: P32 - CLI Tool Verification**

```markdown
When creating CLI tools:

1. Add proper shebang: `#!/usr/bin/env python3`
2. Make executable: `chmod +x cli_tool`
3. TEST execution exactly as test will run it:
   - `./cli_tool arg1 arg2` (not `python3 cli_tool`)
4. Capture and verify output format
5. Handle edge cases: no args, invalid args, help flag
```

**Transferable to:** Script creation, automation tools, wrapper commands

---

### 7. winning-avg-corewars (2/3 - Optimization)

**Failing Test:** `test_warrior_performance`

**Agent Behavior:**

- Created CoreWars warrior
- Tested against all opponents
- Best result: 42% wins vs Stone (need 75%+)

**Root Cause:**

- CoreWars is a competitive programming challenge
- Agent tried many strategies (84 turns!)
- Stone bomber is specifically designed to be hard to beat
- Agent's best "Proven_Hydra" got 42% vs Stone, not 75%

**Generalized Pattern: P33 - Competition Optimization Loop**

```markdown
For competitive/optimization tasks with performance thresholds:

1. ESTABLISH baseline performance early
2. Track progress: wins/losses per iteration
3. Research domain-specific winning strategies:
   - CoreWars: Paper beats stone, imp-rings for ties
   - Genetic algorithms: Crossover and mutation
   - Game AI: Minimax, Monte Carlo Tree Search
4. Time-box optimization: Stop iterating at 70% time budget
5. If not meeting threshold, document best achieved + gap
```

**Research (from web search):**

- corewar.co.uk/strategy.htm: Paper warriors defeat stone bombers
- Imps tie against stone but don't win
- Need scanner/vampire hybrid to defeat stone reliably

**Transferable to:** Code optimization, algorithm tuning, game AI

---

### 8. write-compressor (2/3 - Reversibility)

**Failing Test:** `test_decompression_produces_original`

**Agent Behavior:**

- Created compressor that met size constraint ✓
- Compressed file exists ✓
- BUT: Decompression produces segfault or wrong output

**Root Cause:**

- Agent implemented custom arithmetic coding
- Compressor/decompressor format mismatch
- Decompressor provided by task (fixed) - must match its format
- Agent's compressed output not compatible with given decompressor

**Generalized Pattern: P34 - Reversibility Verification**

```markdown
For compression/encoding tasks with provided decoder:

1. ANALYZE the decoder first to understand expected format
2. Create test case: compress simple data → decompress → verify match
3. Test round-trip BEFORE optimizing for size
4. If decoder crashes, the format is wrong - don't optimize further
5. Binary format: Match byte-by-byte, not just semantics
```

**Transferable to:** Compression, serialization, encryption, codec implementation

---

## Pattern Priority Matrix

| Pattern                    | # Tasks Fixed | Implementation Effort | ROI    |
| -------------------------- | ------------- | --------------------- | ------ |
| P32 (CLI Verification)     | 1-2           | Low                   | High   |
| P34 (Reversibility)        | 1             | Low                   | High   |
| P29 (Schema Verification)  | 1             | Low                   | High   |
| P27 (Numerical Robustness) | 1             | Medium                | Medium |
| P31 (Service Verification) | 1             | Medium                | Medium |
| P28 (Image Pipeline)       | 1             | High                  | Medium |
| P33 (Competition Loop)     | 0-1           | High                  | Low    |
| P30 (Polyglot Check)       | 0-1           | Low                   | Low    |

---

## Recommended CLAUDE.md Updates (v10.7)

### High Priority (Add Immediately)

```markdown
### Pattern 27: Numerical Robustness Testing

When implementing numerical algorithms:

- Test with multiple random seeds (3+ iterations)
- Test domain boundaries explicitly
- Use adaptive step sizes for derivatives
- Add tolerance margins (1e-6 typical)

### Pattern 29: Output Schema Verification

When task specifies output format:

1. Parse expected schema from task/tests
2. Validate output against schema BEFORE completion
3. Fix mismatches before reporting done

### Pattern 32: CLI Tool Verification

When creating executable CLI tools:

1. Add shebang: #!/usr/bin/env python3
2. chmod +x <script>
3. Test EXACTLY as verifier will run: ./tool args

### Pattern 34: Reversibility Verification

For encode/decode or compress/decompress tasks:

1. Analyze provided decoder FIRST
2. Test round-trip before optimizing
3. If decoder crashes, format is wrong
```

### Medium Priority (Add in v1.1.0)

```markdown
### Pattern 28: Image-to-Structured Pipeline

For extracting structured data from images:

1. Use dedicated tools (OCR, image classifiers)
2. Search: "{domain} image to {format} python"
3. Verify extracted data before using

### Pattern 31: Service Endpoint Verification

When implementing servers/APIs:

1. Test each endpoint independently
2. Verify status codes AND response bodies
3. Run integration tests only after unit passes
```

### Low Priority (Document but don't embed)

```markdown
### Pattern 30: Polyglot Feasibility Check

Check if language pair has known polyglot techniques.
Rust/C++ polyglot is extremely difficult - time-box to 20%.

### Pattern 33: Competition Optimization Loop

For optimization tasks with thresholds:
Track progress per iteration, research domain strategies,
stop at 70% time budget if not meeting threshold.
```

---

## Next Steps

1. **Immediate**: Add P27, P29, P32, P34 to CLAUDE.md
2. **Test**: Run targeted benchmark on near-miss tasks
3. **Iterate**: Refine patterns based on results
4. **Document**: Update benchmark comparison report

---

## Appendix: Agent Log Highlights

### Polyglot Attempt Duration

- Total turns: 173
- Duration: 871 seconds (14.5 minutes)
- Final result: Rust compiles, C++ fails

### CoreWars Best Strategies Tested

- Dwarf bomber: 0% wins
- Imp: 90% ties
- Hydra (scanner): 42% wins
- Paper: Good vs stone but loses to scissors

### Write-Compressor Format Issue

- Agent's format: Custom arithmetic coding
- Expected format: Must match provided decompressor
- Decompressor: Segfaults on agent's output
