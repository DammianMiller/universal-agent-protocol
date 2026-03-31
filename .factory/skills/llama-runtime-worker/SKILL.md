---
name: llama-runtime-worker
description: Tune and validate the local llama.cpp runtime profile for Qwen3.5 35B A3B
---

# Llama Runtime Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that modify or validate:
- local llama.cpp launch flags, continuity scripts, or runtime configuration
- direct llama performance experiments and A/B comparisons
- benchmark-related runtime tuning for Qwen3.5 35B A3B

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, mission `AGENTS.md`, `.factory/services.yaml`, `.factory/library/architecture.md`, and `.factory/library/runtime-tuning.md`.
2. Baseline the current runtime before editing:
   - inspect active `llama-server` command line
   - capture direct `:8080` health/models output
   - capture relevant log timings and any current regressions
3. If changing repo-tracked runtime scripts or configs, implement those changes in the worktree first.
4. Restart the local llama runtime with the mission service command or the feature-specified A/B command.
5. Validate both direct and end-to-end impact:
   - direct llama health/models/completion probes
   - log timing review for throughput and long-context behavior
   - at least one proxy-backed benchmark run if the feature claims end-to-end impact
   - when the feature is unblocking session-stability, include the exact benchmark prompt as a direct `:8080` probe and confirm whether output remains substantive or still degrades into prompt leakage / `finish_reason:"length"`
6. If the feature asks for a runtime revert to the fastest stable baseline, treat commit `7bc58aec` as the reference profile unless the feature description says otherwise. Adapt it only for the current worktree paths and localhost binding, and explicitly record any flags you keep or drop from that baseline.
7. Use controlled before/after comparisons:
   - same prompt
   - same client path when comparing end-to-end results
   - same warm/cold state rule recorded in the handoff
8. Run repo validators for any tracked file changes:
   - `npm run build`
   - targeted tests if a script or benchmark harness changed
9. Leave the runtime in a known healthy state and record the exact winning launch profile.
10. If the direct exact-prompt probes become healthy but the full CLI benchmark still fails, return to orchestrator with the direct evidence so the remaining blocker can stay in the stack-runtime feature.

## Example Handoff

```json
{
  "salientSummary": "Tuned the local llama runtime by removing `--no-warmup` and restoring `--repeat-penalty 1.0`, then compared the benchmark prompt before and after. Direct probes stayed healthy and the tuned profile reduced total runtime without regressing tool correctness.",
  "whatWasImplemented": "Updated the tracked llama runtime launch profile and continuity command, restarted the local server on port 8080, and compared baseline vs tuned timings under matching warm-state rules. Verified that direct completions and the proxy-backed benchmark both remained healthy after the flag changes.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "curl -sS http://127.0.0.1:8080/health", "exitCode": 0, "observation": "Runtime healthy after restart"},
      {"command": "curl -sS http://127.0.0.1:8080/v1/models", "exitCode": 0, "observation": "Expected Qwen model surfaced"},
      {"command": "direct completion probe", "exitCode": 0, "observation": "Short prompt returned bounded visible output without prior smoke-test regression"},
      {"command": "npm run build", "exitCode": 0, "observation": "Tracked config/script changes compiled cleanly"}
    ],
    "interactiveChecks": [
      {"action": "Compared baseline and tuned benchmark runs under the same prompt and warm-state rule", "observed": "Tuned profile improved runtime while preserving successful proxy-backed completion"}
    ]
  },
  "tests": {
    "added": []
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The best candidate runtime change requires modifying the external llama.cpp repository rather than this mission worktree
- The runtime becomes unhealthy or irrecoverable after restart attempts
- Performance comparisons cannot be made fairly because the benchmark environment is too noisy or ownership is ambiguous
- A proxy/client bug dominates results so strongly that llama tuning is no longer the limiting factor
