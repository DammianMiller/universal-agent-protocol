---
name: stack-runtime-worker
description: Optimize the local Droid/opencode + proxy stack through code, config, and runtime verification
---

# Stack Runtime Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that modify or validate:
- `tools/agents/scripts/anthropic_proxy.py`
- `opencode.json` and `.opencode/config.json`
- real-client bootstrap behavior under `~/.opencode/plugin/*.ts` when the mission explicitly scopes those files in
- local continuity/startup scripts for the proxy or client-facing stack behavior
- end-to-end benchmark harnesses and runtime ownership cleanup inside the UAP worktree

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, mission `AGENTS.md`, `.factory/services.yaml`, and `.factory/library/runtime-tuning.md` before changing anything.
2. Baseline the active stack for the feature scope:
   - check `:4000` and `:8080` health
   - capture process ownership for both ports
   - inspect the latest proxy and llama logs relevant to the feature
   - when the real client path is part of the feature, inspect `opencode run --print-logs` output for bootstrap failures from `~/.opencode/plugin/*.ts`
3. If changing proxy logic, add or update regression coverage before implementation. Prefer existing proxy regression surfaces (`test/proxy-guardrail-fallbacks.test.ts`, `tools/agents/tests/test_anthropic_proxy_streaming.py`) when relevant.
4. Implement the smallest focused change needed for the feature in the approved worktree only.
5. Run validation after every meaningful change:
   - `python3 -m py_compile tools/agents/scripts/anthropic_proxy.py` when the proxy file changes
   - targeted proxy tests relevant to the feature (for Python proxy coverage, prefer `python3 -m unittest tools/agents/tests/test_anthropic_proxy_streaming.py` or an equivalently targeted command, not bare `python3 -m unittest`)
   - `npm run build`
   - the manifest `commands.test` baseline when it is healthy; if that baseline command is broken before running tests, capture the failure evidence, run the narrowest validators that still prove your feature, and report the manifest breakage to the orchestrator in the handoff
   - additional `npm test -- <file-or-filter>` when TypeScript or regression tests are affected
6. Restart only the services needed for the feature, then verify:
   - single proxy owner on `:4000`
   - correct `/health` payload
   - if applicable, a real benchmark run or targeted CLI run
7. For end-to-end features, run the exact benchmark prompt through the real client path and capture transcript, timing, retry behavior, and PID/log correlation. Fallback/apology output is not a successful benchmark result when the contract requires actionable final output, even if the CLI exits 0 or the proxy returns HTTP 200.
8. If the real client path shows repeated bootstrap exceptions from `~/.opencode/plugin/*.ts`, treat that as its own blocker before over-tuning proxy or llama behavior. If the assigned feature allows touching those user-level plugin files, preserve a reversible backup/rename trail and record the exact startup mode left behind.
9. If the real client path still fails after startup is clean and the plain-text proxy path is healthy, inspect proxy logs and any available opencode session/tool records for malformed `task` or other tool calls with junk placeholder/schema-fragment arguments; add equivalent rejection/recovery guardrails before rerunning the benchmark unchanged.
10. If those malformed streamed tool turns are already guarded but the real benchmark still shows upstream `too_many_requests`, treat a one-line planning/stub answer as failure, not success. The next fix should make that path recover to substantive output or fail explicitly and boundedly.
11. If the benchmark still fails after those streamed-path guardrails are live, re-check direct `:8080` exact-prompt output before continuing. If direct llama output is again malformed or length-capped, return to orchestrator so the blocker can move back to `llama-runtime-worker`.
12. If repeated `VAL-CROSS-002` retries keep degrading into malformed grounding/text dumps before any same-run executed tool evidence appears, treat that as a loop and return to orchestrator instead of taking another proxy-only pass. The next step should be a llama-runtime revert or other runtime-level reset before more grounded route work.
13. If the benchmark completes cleanly but the answer is still generic or weakly grounded, inspect the effective env/config of the live proxy process (not just source defaults) and confirm whether analysis-only routing or equivalent grounding flags are actually enabled for the running instance.
14. If analysis-only routing is already enabled but the answer still asks for logs/metrics or gives generic advice, focus on injecting concrete live runtime facts into that benchmark path rather than reopening already-fixed transport/tool guardrails.
15. If user-testing later fails `VAL-CROSS-002`, do not accept a grounded benchmark route that achieves success only by disabling tools. The next fix must preserve tool-capable behavior while keeping the answer grounded.
16. For `VAL-CROSS-002`, absence of a tool-disable marker is not sufficient evidence by itself. The successful run must show actual client tool activity with matching proxy/client records for the same benchmark session.
17. If source-level preservation guards pass in unit tests but the live benchmark still disables tools, log the real `messages[0].content` shape, normalized prompt fingerprint, and tool count before routing, then normalize the matcher against the actual `opencode run` request surface instead of guessing from the exact prompt string alone.
18. For inherited listeners on ports `4000` or `8080`, you may replace them when the assigned feature requires it, but you must record the prior PID/command in your handoff and restore a healthy intended owner before finishing.
19. If the feature target state is already present when you start, validation-only completion is acceptable: prove the assigned assertions with current runtime evidence, record that no further edits were needed, and return a thorough handoff.
20. If a mission-scoped file such as `tools/agents/scripts/anthropic_proxy.py` already contains validated uncommitted changes from earlier workers, you may take ownership of the full current diff for that file after revalidating the assigned assertions and the live benchmark path.
21. If the worktree already contains unrelated modified files, do not treat that as a blocker by itself; stage and commit only the files your feature changed.
22. If the assigned feature only repairs mission-authorized home-directory plugin files outside git (for example `~/.opencode/plugin/*.ts`), validation-only completion is acceptable; report the exact files changed and the clean runtime evidence instead of treating the lack of a git commit as a blocker.
23. Known pre-existing lint blockers documented in mission `AGENTS.md` should not derail feature completion; use the mission lint command and note any out-of-scope failures precisely.
24. Do not leave duplicate proxy owners, ambiguous endpoint routing, half-applied runtime changes, or unexplained client bootstrap state behind.

## Example Handoff

```json
{
  "salientSummary": "Normalized the proxy/client stack to localhost, reduced client token budget, and tightened proxy loop handling. The benchmark prompt now completes through the real CLI path without the prior empty-visible retry spiral.",
  "whatWasImplemented": "Updated opencode client config to use 127.0.0.1:4000 consistently, reduced oversized output budgets, and refined proxy loop-termination logic with matching regression coverage. Restarted the proxy cleanly so only one intended owner remained on port 4000.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "python3 -m py_compile tools/agents/scripts/anthropic_proxy.py", "exitCode": 0, "observation": "Proxy syntax valid"},
      {"command": "npm test -- test/proxy-guardrail-fallbacks.test.ts", "exitCode": 0, "observation": "Relevant proxy regressions passed"},
      {"command": "npm run build", "exitCode": 0, "observation": "TypeScript build passed"},
      {"command": "curl -sS http://127.0.0.1:4000/health", "exitCode": 0, "observation": "Proxy and upstream both reported healthy"}
    ],
    "interactiveChecks": [
      {"action": "Ran the exact benchmark prompt through the local CLI path", "observed": "Completed with actionable findings, no repeated tiny follow-up loop, and a single correlated proxy PID"}
    ]
  },
  "tests": {
    "added": [
      {"file": "test/proxy-guardrail-fallbacks.test.ts", "cases": [
        {"name": "terminalizes repeated empty-visible retry loop", "verifies": "proxy emits a bounded terminal classification after repeated empty-visible retries"}
      ]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires changing behavior outside the approved worktree or outside the local proxy/client stack
- A required runtime process cannot be restarted cleanly without broader infrastructure decisions
- Benchmark results are ambiguous because another process keeps reclaiming `:4000` or `:8080`
- Direct llama reproduction of the exact benchmark prompt remains malformed or prompt-injected even though startup, ownership, health, and model discovery are all clean; escalate so the blocker can be split to `llama-runtime-worker`
- The feature depends on llama.cpp runtime changes that belong in the llama-specific worker skill
