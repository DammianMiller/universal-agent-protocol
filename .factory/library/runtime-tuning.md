# Runtime Tuning

Mission-specific runtime tuning knowledge for the Qwen3.5 proxy + Droid + llama.cpp stack.

**What belongs here:** known bottlenecks, high-confidence experiments, and measurement dimensions.
**What does NOT belong here:** per-feature status tracking.

---

## Known Runtime Risks
- Proxy port ownership races on `:4000`
- Drift between `127.0.0.1` and `192.168.1.165` proxy endpoints in local configs
- Oversized client output budgets (`81920`) increasing long-tail latency
- Default thinking mode in `.opencode/config.json` adding overhead to tool-heavy flows
- Sticky forced-tool behavior causing retry pressure on Qwen tool turns
- Empty-visible stream retries and tiny follow-up loops in the proxy
- Repeated real-client bootstrap exceptions from `~/.opencode/plugin/*.ts` that can silently degrade available local tool/skill surfaces
- llama.cpp `--repeat-penalty 1.15` and `--no-warmup` likely trading correctness/stability for startup convenience

## Highest-Confidence Tuning Levers
- Client: reduce output budgets, prefer stable local proxy endpoint, avoid default thinking for tool-heavy runs
- Proxy: keep bounded guardrails, release forced-tool pressure sooner when recovery paths trigger, preserve non-tool path correctness
- llama.cpp: test `--repeat-penalty 1.0`, remove `--no-warmup`, and A/B speculative decoding settings on the real workload

## Measurement Dimensions
- wall-clock benchmark runtime
- time to first visible progress / first useful output when available
- end-to-end success rate across consecutive fresh runs
- proxy retry / terminal classification counts
- direct llama decode throughput and long-context behavior
- whether the exact benchmark prompt completes without manual interruption

## Confirmed During Mission Execution
- Lowering the local client output budget from 81920 to 16384 and disabling default thinking mode has already been validated by targeted regression coverage as a normalization step.
- The active proxy can report healthy upstream attribution on `/health` while still surfacing incorrect model identities on `/v1/models`; both surfaces must be checked.
- Historical duplicate bind/ownership races on `:4000` are a real environmental hazard and should be treated as first-class runtime normalization work.
- The empty-visible `529` loop-breaker path was replaced by a bounded fallback response, but that change alone does **not** satisfy benchmark-success requirements.
- For session-stability validation, a generic fallback such as `I couldn't produce a usable answer on that turn. Please retry the request.` must be treated as a failure for `VAL-CLI-001`, `VAL-CLI-003`, `VAL-CROSS-001`, and related exact-prompt success assertions, even if the CLI exits 0.
- Current scrutiny guidance: a bounded fallback/apology message still counts as benchmark failure whenever the contract requires actionable final output.
- The latest plugin-bootstrap repair cleared the repeated `fn3 is not a function` failures while loading user-level plugins from `~/.opencode/plugin/*.ts`; remaining real-client benchmark failures should now be traced from the later `too_many_requests` / fallback path unless plugin bootstrap regressions reappear.
- Latest session-stability evidence shows the exact benchmark prompt is also malformed when sent directly to `:8080` and can hit `finish_reason:\"length\"`; once stack ownership and startup are clean, treat that as a llama-runtime blocker rather than repeatedly retrying the CLI transcript path unchanged.
- After the llama-runtime fix and Bash placeholder guardrail, the remaining benchmark blocker shifted to malformed streamed `task` tool calls with junk/schema-fragment arguments; when plain-text proxy output is healthy, focus proxy recovery on intercepting or terminalizing those invalid streamed tool turns before they can contaminate later turns.
- After the streamed-task guardrail landed, the live blocker shifted again to upstream `too_many_requests` producing a success-shaped one-line stub. Treat that as a transport/retry-class failure: the path must either recover into substantive output or return an explicit bounded failure, not a misleading stub sentence.
- Latest follow-up evidence shows the benchmark can still regress after proxy guardrail wins: direct llama exact-prompt output may fall back to malformed, length-capped schema debris again, and the CLI loop may then degrade into repeated retry text plus erroneous skill/tool attempts. When that happens, restore direct llama output before further stack-runtime transcript work.
- Once startup, direct output, and rate-limit guardrails are healthy, the remaining blocker can shift to answer grounding: the raw benchmark prompt tends to produce generic best-practice advice unless the live proxy process actually enables analysis-only routing or equivalent grounding. Inspect the running proxy env, not just source defaults.
- Even after analysis-only routing is restored, the benchmark may still stay generic unless the route injects concrete local runtime facts. The next smallest fix at that stage is benchmark-path grounding/context injection, not more transport guardrails.
- Current orchestrator guidance after the repeated `VAL-CROSS-002` loop: stop retrying grounded tool-preservation against the current llama profile. First restore a `7bc58aec`-style fast/stable llama baseline (adapted to localhost/worktree paths), then re-evaluate the remaining first-tool/grounding interaction from that post-revert state.
