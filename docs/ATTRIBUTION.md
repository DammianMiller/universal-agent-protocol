# Attribution & Inspirations

UAP stands on published research, community engineering write-ups, and open-source
software. This page credits the sources whose ideas are implemented in this codebase,
and what each one inspired. (Dependency licenses ship with the packages themselves;
this page is about *ideas and provenance*, not license compliance.)

## Research & techniques

| Source | What it inspired in UAP |
|---|---|
| **Atomic Task Graph: A Unified Framework for Agentic Planning and Execution**, [arXiv 2607.01942](https://arxiv.org/abs/2607.01942) | The v1.149 delivery uplifts: pre-execution plan validation (`src/delivery/plan-check.ts`, structural DAG checks + the evaluator "thought experiment" with one re-plan), ATG-style minimal node repair in the blackboard orchestrator (bounded retry with failure feedback + interface-preserving `repairTask` chains credited under the original task id), and dependency-aware parallel dispatch of independent ready tasks. The paper's ablations, validation and localized repair carry the gains, not the graph representation itself, directly shaped what we adopted and what we skipped (tool-call-granularity nodes, full-upfront planning). Surfaced to us via [Carlos E. Perez (@IntuitMachine)'s thread](https://x.com/IntuitMachine/status/2076465883938009457). |
| **vLLM Semantic Router**, collaboration as a serving-layer primitive ([vLLM project](https://github.com/vllm-project)) | The proxy's serving-layer recipes (`Confidence` / `Fusion` / `Ratings` / `ReMoM` in `src/types/config.ts` and the inference proxy): multi-sample selection, judge-fused answers, and signal-selected escalation behind a single model API, plus the gate-as-confidence escalation idea (local model → stronger model when gates disagree). |
| **Anthropic's loop-engineering practices**, as summarized publicly by Miles Deutscher | The v1.81 generator≠evaluator separation (the model implementing never grades its own work, acceptance gates are authored and judged by a different model) and the barbell routing strategy (cheap generator, sharp evaluator) used across deliver, the acceptance judge, and now the plan thought experiment. |
| **Google Labs DESIGN.md**, the [`@google/design.md`](https://www.npmjs.com/package/@google/design.md) format and OSS CLI | The project design system integration (`uap design` interrogate/lint/diff, `src/design/tokens.ts` token parsing, the reactor's design-context injection, and the hard design-token gate for UI files). |
| **Public AI-PR-review write-ups**: [Intercom's Fin team](https://ideas.fin.ai/p/ai-is-approving-our-pull-requests), [Rootly](https://rootly.com/blog/why-we-got-rid-of-our-small-pr-rule), [Rewind's Diff Vader](https://rewind.com/blog/ai-approve-pull-requests-safely/), and [Reddit Engineering's r/RedditEng post](https://www.reddit.com/r/RedditEng/comments/1y3wbkw/we_let_ai_approve_prs_at_reddit_heres_what/) (November 2026) | The framing documented in the [PR Review](guides/PR_REVIEW.md) guide: review as an allocation problem, a council of specialists over one generalist prompt, a deterministic verdict separate from the model's judgment, and risk graded by the surfaces a diff touches rather than its size. UAP implements the pattern its own way (deterministic pre-pass, reviewer droids, the review artifact, the `expert-review-required` enforcer); the write-ups shaped the guide's framing and terminology. The enforcer's 0.4 uplift adopts three of their mechanisms outright: Reddit's machine-readable merge dispositions with reason codes (the gate-parsed `verdict` + `reason`), Rewind's verifier mode (the bounded `carry_forward` that re-checks a push's delta instead of re-litigating the diff), and the findings-feedback loops Reddit and Intercom publish (the artifact's findings array with per-finding dispositions, the council's own hit-rate signal). |

## Benchmarks

| Source | How UAP uses it |
|---|---|
| **Terminal-Bench** ([tbench.ai](https://www.tbench.ai/)) | Terminal-agent evaluation; drove the token-optimization and success-rate validation results, and the confound-hunting methodology lessons in the TBench Investigation. |
| **SWE-bench Pro** | Basis of the `benchmarks/suites/swe-bench-pro-gen` paired uplift A/B suite for local-model delivery. |

## Notable open source in the stack

The full dependency graph lives in `package.json`; these deserve explicit mention
because UAP embeds, vendors, or builds core workflows around them:

- **[llama.cpp](https://github.com/ggml-org/llama.cpp) / ik_llama.cpp**, the local inference backend the whole local-model path (deliver, recipes, slot budgeting) is built against.
- **[bubblewrap](https://github.com/containers/bubblewrap)** (GNOME), the unprivileged kernel sandbox (`uap sandbox`) behind the sandboxed delivery path: read-only root mounts, per-session writable holes, and the `--unshare-net` egress cut are all bwrap primitives.
- **Qwen** (Alibaba), the local models UAP's local-first delivery pipeline is tuned for and benchmarked with.
- **[Qdrant](https://qdrant.tech/)** + **nomic-embed-text**, the semantic long-term memory store and its embeddings.
- **[uPlot](https://github.com/leeoniya/uPlot)** (MIT), vendored (with license) in `web/vendor/` for the dashboard's charts.
- **commander**, **@clack/prompts**, **vitest**, **better-sqlite3**, **zod**, the CLI, wizard, test, storage, and schema backbones.

## Conventions

When a feature is adopted from a paper or external write-up, credit it in three
places: the module docstring of the implementing file, the PR description, and a
row on this page. If you spot an uncredited inspiration, please open a PR.
