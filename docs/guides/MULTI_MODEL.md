# Multi-Model Routing

> Applies to UAP **v1.93.1**

> **🏭 Where this fits:** PREP/ROUTING — this is the station where a normal
> agentic workflow sends *everything* to one model: paying premium-model rates
> for routine edits, or trusting a cheap model with reasoning it can't handle.
> **What it delivers:** the right job goes to the right station — a strong
> planner for hard reasoning, a cheap/local executor for the bulk of the work —
> so you pay for expensive thinking only when the work actually needs it.

UAP runs agentic work across multiple LLMs instead of one. A high-capability
model plans, a cheaper or local model executes, and a reviewer model checks the
result. Routing decisions are made per task (and per subtask) so you pay for
expensive reasoning only when the work actually needs it — one of the early
stations on your [delivery pipeline](./DELIVERY_PIPELINE.md), before a single
line of code is written.

## Why multi-model

A single frontier model is the simplest setup, but most of the tokens an agent
spends are on routine execution — applying an edit, running a tool, writing a
test — not on hard reasoning. Sending all of that to a premium model is
expensive and slow. Sending the *hard* reasoning to a cheap model is the
opposite failure. Routing fixes both.

Multi-model routing lets you:

- Use a strong **planner** (e.g. Claude Opus) for decomposition and review.
- Use a cheap or **local executor** (e.g. Qwen 3.5 on llama.cpp) for the bulk
  of the work, at near-zero marginal cost.
- Fall back to another model automatically when the executor struggles.
- Pick a routing strategy that trades cost against quality on your terms.

## The 3-tier plan → route → execute flow

UAP separates planning, routing, and execution into three components:

1. **TaskPlanner** (`src/models/planner.ts`) — decomposes a task into subtasks.
   It classifies the task's complexity, and for non-trivial work it breaks the
   task into ordered subtasks with inputs, outputs, and constraints. Every plan
   is auto-validated by a plan validator (`src/models/plan-validator.ts`) at all
   complexity levels before it is returned.

2. **ModelRouter** (`src/models/router.ts`) — assigns a model to the overall
   task and to each subtask. It classifies the task by complexity and type,
   applies the routing rules, and selects a model for the matched role
   (planner / executor / reviewer / fallback). Classification results are cached
   to avoid repeated work on near-identical task descriptions.

3. **TaskExecutor** (`src/models/executor.ts`) — executes the plan. Subtasks run
   with a bounded level of parallelism, each call has retry-with-backoff logic
   (`retryDelayMs`, default 1000 ms), and failed attempts feed retry context
   into subsequent tries. The executor produces per-subtask results and a
   run summary.

The router and planner are wired together by the CLI and the programmatic API
(`createRouter`, `createPlanner`, `createExecutor` from `src/models/index.js`).

## The model presets

The router ships with built-in presets (`ModelPresets` in
`src/models/types.ts`). These are the ids you reference in role assignments and
in `uap model` output:

| Preset id      | Name                      | Provider  | Context  | $/1M in | $/1M out | Capabilities                                                    |
| -------------- | ------------------------- | --------- | -------- | ------- | -------- | -------------------------------------------------------------- |
| `opus-4.6`     | Claude Opus 4.6           | anthropic | 200,000  | 7.5     | 37.5     | planning, complex-reasoning, code-generation, review, advanced-planning |
| `sonnet-4.6`   | Claude Sonnet 4.6         | anthropic | 200,000  | 3.0     | 15.0     | code-generation, execution, review, agentic                    |
| `haiku`        | Claude Haiku (Latest)     | anthropic | 200,000  | 0.8     | 4.0      | code-generation, execution, simple-tasks                       |
| `qwen35-a3b`   | Qwen 3.5 35B A3B (llama.cpp) | custom | 262,144  | 0       | 0        | code-generation, execution, planning, simple-tasks             |
| `gpt-5.4`      | GPT 5.4                   | openai    | 128,000  | 2.5     | 10.0     | planning, code-generation, complex-reasoning                   |
| `gpt-5.3-codex`| GPT 5.3 Codex             | openai    | 192,000  | 3.0     | 12.0     | code-generation, execution, complex-reasoning, agentic         |

Run `uap model presets` to print the live list.

### Runtime profiles

In addition to the presets above, UAP ships seven detailed JSON **profiles** in
[`config/model-profiles/`](../../config/model-profiles/). These carry richer
runtime settings the presets lack — pricing tiers, rate limits, tool-calling
options, extended-thinking budgets, server-optimization flags, and ready-to-run
launch commands:

| Profile (`_profile`) | `model` id                 | Provider  | Context  |
| -------------------- | -------------------------- | --------- | -------- |
| `claude-opus-4.6`    | `claude-opus-4-6-20250616` | anthropic | 200,000  |
| `claude-sonnet-4.6`  | `claude-sonnet-4-6-20250514` | anthropic | 200,000 |
| `claude-haiku-3.5`   | `claude-3-5-haiku-20241022` | anthropic | 200,000 |
| `gpt-5.4`            | `gpt-5.4`                  | openai    | 128,000  |
| `gpt-5.3-codex`      | `gpt-5.3-codex`            | openai    | 192,000  |
| `qwen35`             | `qwen3.5-a3b-iq4xs`        | custom (llama.cpp) | 262,144 |
| `generic`            | `default`                  | any OpenAI-compatible | 32,768 |

The active profile is selected by the `UAP_MODEL_PROFILE` environment variable
(defaults to `generic`). The loader lives in `src/models/profile-loader.ts`.

## How routing decides

The router first classifies the task, then applies rules.

**Complexity** is inferred from keywords. Examples (from
`COMPLEXITY_KEYWORDS` in `src/models/router.ts`):

- `critical` — security, authentication, authorization, deployment, migration,
  production, database, encryption, credentials, secrets
- `high` — architecture, design, refactor, performance, optimization,
  algorithm, distributed, concurrent, multi-step, complex
- `medium` — feature, implement, add, create, update, integrate, api, endpoint
- `low` — fix, typo, comment, rename, format, style, simple, minor, quick,
  documentation

**Task type** is inferred similarly: `planning`, `coding`, `refactoring`,
`bug-fix`, `review`, `documentation`.

**Routing rules** (`DEFAULT_ROUTING_RULES`) map complexity/type to a role by
priority (higher wins):

| Match                                                       | Role       | Priority |
| ---------------------------------------------------------- | ---------- | -------- |
| complexity `critical`                                      | planner    | 100      |
| keywords: security, authentication, deployment, migration | planner    | 90       |
| complexity `high`                                          | planner    | 80       |
| keywords: architecture, design, refactor                  | planner    | 70       |
| task type `planning`                                       | planner    | 70       |
| task type `review`                                         | reviewer   | 60       |
| complexity `medium`                                        | executor   | 50       |
| task type `coding`                                         | executor   | 50       |
| task type `bug-fix`                                        | executor   | 50       |
| complexity `low`                                           | executor   | 30       |
| task type `documentation`                                  | executor   | 30       |

The matched role is resolved to a concrete model via your role assignments.

**Routing strategy** further shapes selection. Four strategies are supported
(`routingStrategy`, default `balanced`):

- `cost-optimized` — minimize cost, use the cheapest capable model
- `performance-first` — maximize quality, use the best model
- `balanced` — balance cost and performance (default)
- `adaptive` — learn from task results over time

> **One nuance worth internalizing:** when an executor stalls and the work
> escalates, escalate to a **stronger, distinct** model — not the same model in
> a different seat. A same-model judge (a local model grading its own output)
> was measured to add no lift. The value of routing comes from the *difference*
> in capability between the station that got stuck and the one you hand off to.

## The `uap model` CLI

All subcommands are defined in `src/cli/model.ts`.

```bash
uap model status              # show configured models, role assignments, strategy
uap model route <task>        # analyze how a task would be routed
uap model route <task> -v     # + matched rules and cost comparison
uap model plan <task>         # build an execution plan (decomposition + assignments)
uap model plan <task> -v      # + per-subtask detail
uap model plan <task> -e      # execute the plan (mock client unless API keys set)
uap model compare             # compare cost/performance across sample configs
uap model presets             # list all built-in model presets
uap model select              # interactively assign models to each role
uap model select --save       # persist the selection to .uap.json
uap model export              # print current config as JSON
uap model export -f yaml      # ... or YAML
uap model health              # validate that assigned models exist and resolve
```

Example — see how a task routes:

```bash
uap model route "add OAuth2 login with JWT sessions" --verbose
```

This prints the inferred complexity, task type, the selected and fallback
models, the matched rules, and an estimated cost comparison.

## Configuring profiles

### Role assignments

Configure the multi-model setup under `multiModel` in your `.uap.json`. The
default configuration is:

```json
{
  "multiModel": {
    "enabled": true,
    "models": ["opus-4.6", "qwen35-a3b"],
    "roles": {
      "planner": "opus-4.6",
      "executor": "qwen35-a3b",
      "fallback": "qwen35-a3b"
    },
    "routingStrategy": "balanced"
  }
}
```

A `reviewer` role is also supported; if unset it falls back to the planner.
You can add `costOptimization` (with `targetReduction`,
`maxPerformanceDegradation`, and `fallbackThreshold`) when using a
cost-oriented strategy.

The fastest way to edit this is interactively:

```bash
uap model select --save
```

### Runtime profile + endpoints

Pick a runtime profile and provide credentials/endpoints via environment
variables (see each file's `running_config` in
[`config/model-profiles/`](../../config/model-profiles/)):

```bash
# Anthropic-hosted models
export ANTHROPIC_API_KEY=<your-key>
export UAP_MODEL_PROFILE=claude-opus-4.6

# OpenAI-hosted models
export OPENAI_API_KEY=<your-key>
export UAP_MODEL_PROFILE=gpt-5.4

# Local / any OpenAI-compatible server
export TARGET_URL=http://127.0.0.1:8080
export UAP_MODEL_PROFILE=generic
```

To customize a model's runtime behavior — temperature, tool-call batching,
extended-thinking budget, rate limits, or server-optimization flags — edit the
corresponding JSON file in `config/model-profiles/`. Each file is documented
inline with `_comment` fields.

## See also

- [Droids and Skills](./DROIDS_AND_SKILLS.md) — specialist agents and reusable
  workflows that run on top of the routed models.
