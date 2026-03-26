---
name: llama-cpp-worker
description: C++ development worker for llama.cpp speculative decoding fixes, CUDA builds, and server validation
---

# llama.cpp C++ Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features that involve:
- C++ code changes in llama.cpp (speculative decoding, memory management, server)
- CUDA builds and binary testing
- Server restart and direct query validation
- Speculative decoding parameter tuning

## Required Skills

None (all validation is via curl and log inspection).

## Work Procedure

### 1. Understand the Feature
- Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully
- Read AGENTS.md for bug details, key paths, and validation test prompts
- Read the specific source files mentioned in the feature description

### 2. Read Current Code State
- Read the FULL files being modified (not just diffs) to understand context
- The main files are in `/home/cogtek/llama.cpp/.worktrees/003-faststate-029/`:
  - `src/llama-memory-hybrid.cpp` (checkpoint save/restore)
  - `src/llama-memory-hybrid.h` (data structures)
  - `common/speculative.cpp` (compat check, draft management)
  - `tools/server/server-common.cpp` (server tool handling)
- Also read upstream versions in worktree 002 for reference

### 3. Make Code Changes
- Edit files in worktree 003-faststate-029
- Follow existing code style (4-space indent, snake_case)
- Use LLAMA_LOG_DEBUG/LLAMA_LOG_WARN/LLAMA_LOG_ERROR for logging
- Always check return values of memory operations
- Keep changes minimal and focused

### 4. Build
```bash
cd /home/cogtek/llama.cpp/.worktrees/003-faststate-029
cmake --build build-cuda --config Release -j 32
```
- If build fails, fix errors and rebuild
- Build MUST succeed before proceeding

### 5. Restart Server and Test
```bash
# Check if server is idle
curl -s http://localhost:8080/slots | python3 -c "import sys,json; d=json.load(sys.stdin); print('idle' if all(s.get('state','')!='started' for s in d) else 'BUSY')"

# Kill current server
kill $(ps aux | grep 'llama-server.*8080' | grep -v grep | awk '{print $2}') 2>/dev/null
sleep 3

# Start with spec enabled
nohup /home/cogtek/llama.cpp/.worktrees/003-faststate-029/build-cuda/bin/llama-server \
  --model /home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf \
  --host 0.0.0.0 --port 8080 --threads 32 --ctx-size 65536 \
  --cache-type-k q4_0 --cache-type-v q4_0 --gpu-layers 99 \
  --flash-attn on --batch-size 512 --ubatch-size 512 --parallel 1 \
  --n-predict 32768 --repeat-penalty 1.0 --defrag-thold 0.1 \
  --spec-type ngram-cache --draft-max 12 --draft-min 2 --draft-p-min 0.80 \
  --jinja --chat-template-file /home/cogtek/dev/miller-tech/universal-agent-protocol/tools/agents/config/chat_template.jinja \
  --log-file /home/cogtek/llama.cpp/llama-server.log --metrics \
  > /tmp/llama-test-startup.log 2>&1 &

# Wait for model load
sleep 35
curl -s http://localhost:8080/health
```

NOTE: Use ctx-size 65536 for testing (faster startup). Production uses 262144.

### 6. Run Validation Tests
Run ALL 4 test prompts from AGENTS.md. For each:
- Check response content for degenerate repetition
- Check server log for draft acceptance rate
- Check for non-consecutive token position warnings

### 7. Iterate
If tests fail:
- Analyze the failure mode (what kind of corruption, which test)
- Check server logs for clues
- Make targeted code changes
- Rebuild and re-test
- Do NOT give up after one iteration - keep iterating until tests pass or return with detailed failure analysis

### 8. Final Validation
Once all 4 tests pass:
- Run 5 consecutive queries to verify stability (VAL-SPEC-006)
- Run a multi-turn conversation (VAL-SPEC-007)
- Verify draft acceptance rate > 0% in logs

### 9. Commit
```bash
cd /home/cogtek/llama.cpp/.worktrees/003-faststate-029
git add -A
git commit -m "fix: correct 4 bugs in hybrid speculative checkpoint system"
```

## Example Handoff

```json
{
  "salientSummary": "Fixed all 4 checkpoint bugs in llama-memory-hybrid.cpp: moved save to seq_rm callsite, added full cell metadata restore, synchronized attn/recurrent positions, and fixed compat check to test intermediate rollback. Built CUDA binary, restarted server with ngram-cache spec. All 4 test prompts produce clean output. Draft acceptance rate: 8.5% on JSON schema, 12.3% on multi-turn. Zero repetition artifacts across 5 consecutive queries.",
  "whatWasImplemented": "Fixed save timing (checkpoint now saved in seq_rm before clear, not in init_batch before decode). Fixed cell metadata restore (now reinitializes src, src0, head, tail, occupied status). Added attention cache sync after recurrent restore (mem_attn->seq_rm matching recurrent rollback position). Fixed compat check to test pos 3->1 rollback not just end->start.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "cmake --build build-cuda --config Release -j 32", "exitCode": 0, "observation": "Build succeeded, no warnings in modified files"},
      {"command": "curl JSON schema test", "exitCode": 0, "observation": "600 tokens, clean structured JSON, no repetition"},
      {"command": "curl User schema test (temp=0)", "exitCode": 0, "observation": "102 tokens, clean JSON object, no 'User:User:User' pattern"},
      {"command": "curl Fibonacci test", "exitCode": 0, "observation": "300 tokens, valid Python function, no 'val=val=val' pattern"},
      {"command": "curl proxy tool_use test", "exitCode": 0, "observation": "Valid tool_use block returned"},
      {"command": "grep 'draft acceptance rate' server.log", "exitCode": 0, "observation": "Rates: 8.5%, 12.3%, 5.1%, 14.8% across 4 tests"},
      {"command": "5 consecutive queries", "exitCode": 0, "observation": "All 5 produced clean output, no degradation"}
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": []
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Build fails due to missing dependencies or CMake configuration issues
- GPU out of memory when loading model
- Server crashes during inference (not just bad output - actual crash)
- After 3+ iterations without improvement in output quality
- Need to modify files outside worktree 003
