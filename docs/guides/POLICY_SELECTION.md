# Policy Selection & Recommendations

UAP ships ~33 executable policies (the [enforcer catalog](POLICIES.md)). You don't want all of them on for every project — you want the set that fits *your* workflow. This guide gives you a recommended core plus tailored add-ons by scenario, and the commands to apply them.

> **Live version of this guide:** `uap policy recommend` (all scenarios) or `uap policy recommend <scenario>` (a tailored set with an install command). The recommendations here and in the CLI come from the same source (`src/config/policy-recommendations.ts`).

## How policies work (the 20-second version)

A policy is enforced by a hook → the enforcer inspects the tool call → it **allows (exit 0)** or **blocks (exit 2)**. Only `REQUIRED`-level policies hard-block; `RECOMMENDED`/`OPTIONAL` are advisory. Each enforcer also has an env kill-switch (e.g. `UAP_NO_WORKTREE`, `UAP_DELIVER_BYPASS`) so a human can override a single call — they're **cooperative guardrails**, not a sandbox. For a true write boundary, pair them with the [sandbox](SANDBOX.md). Full mechanics: [Policies](POLICIES.md).

## Apply them

```bash
uap policy recommend                 # list the core set + all scenarios
uap policy recommend team            # tailored set for a scenario + an install command
uap policy install <slug>            # install one policy (attaches its enforcer)
uap policy matrix                    # see everything installed + how to adjust it
uap config wizard                    # interactive: pick a scenario, install in one step
uap setup --profile custom           # baseline setup, then the wizard (config + policies)
```

## The core set — recommended for every project

The safety floor. `uap setup` installs the delivery-enforcement + self-protect pieces automatically; the rest are one `uap policy install` away.

| Policy | Why |
|---|---|
| `worktree-required` | Edits land in an isolated worktree, never the working tree. |
| `delivery-enforcement` | Source changes route through the verified `deliver` loop. |
| `enforcement-self-protect` | Agents cannot disable the gates that constrain them. |
| `task-required` | Work is tied to a tracked task, not ad-hoc. |
| `test-gate` | Changed code must pass tests before "done". |
| `memory-before-plan` | The agent recalls prior decisions before re-deriving them. |
| `workdir-scope` | Writes are contained to the project directory. |

## Scenarios — add these on top of the core

Pick the row that matches how you work. Each adds to the core set above.

### Solo dev, local model
*One person driving a local (llama.cpp/Qwen) model that needs strong guardrails.*

`codebase-read-before-plan` · `validate-plan-before-build` · `mcp-router-first` · `local-build-before-push` · `ship-loop-gate` · `doc-live-over-report`

Weaker models benefit most from "read before you plan", a lean context window, and converging to green before shipping.

### Team / multi-agent
*Multiple people or agents working the same repo concurrently.*

`coord-overlap` · `expert-review-required` · `schema-diff-gate` · `session-memory-write` · `artifact-hygiene`

The point is to stop agents colliding, surface contract changes for review, and capture learnings so peers compound them.

### CI-gated delivery
*Changes must survive a CI pipeline and controlled deploys.*

`local-build-before-push` · `ship-loop-gate` · `merge-deploy-monitor-verify` · `schema-diff-gate`

Fail fast locally, re-converge on red CI, and treat deploys as monitored + verified rather than fire-and-forget.

### High autonomy / hands-free
*Long unattended builds where the model must not cut corners.*

`validate-plan-before-build` · `ship-loop-gate` · `artifact-hygiene` · `doc-live-over-report` · `codebase-read-before-plan`

A wrong plan wastes an entire autonomous run — validate up front, grade the real system (not the model's optimism), and only end when the work is genuinely done.

### Security-sensitive
*Handling secrets, infrastructure, or regulated code.*

`bearer-lockdown` · `schema-diff-gate` · `iac-parity` · `iac-plan-destruction-check`

Block credential leaks, forbid silent permission/API-surface changes, and flag destructive infra plans before apply.

### UI / design work
*Projects with a front-end and a design system.*

`design-token-gate` · `visual-verification`

Keep UI edits on your design tokens/spacing and verify changes visually, not just by tests. Pair with [DESIGN.md](../design/UAP_REACTOR.md) and `uap config set design.enabled true`.

## Tuning the level of any policy

A policy's *level* decides whether it hard-blocks or just warns:

```bash
uap policy level <id> RECOMMENDED   # downgrade a REQUIRED gate to advisory
uap policy level <id> REQUIRED      # promote an advisory to a hard block
uap policy disable <id>             # turn it off entirely
```

Start stricter than you think you need — it's easier to relax a gate that's too noisy than to notice a class of mistakes a missing gate let through. Run `uap config doctor` to catch settings that quietly weaken the whole set (e.g. a leaked `UAP_ENFORCE_DELIVERY=advisory`).

## See also

- [Policies](POLICIES.md) — the full enforcer catalog + CLI reference
- [Configuration Reference](../reference/CONFIGURATION_REFERENCE.md) — every setting `uap config` exposes
- [Sandbox](SANDBOX.md) — the kernel-level write boundary that backs the cooperative gates
