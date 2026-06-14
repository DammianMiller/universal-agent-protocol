# Delivery Enforcement

Substantive coding work should be driven through the `uap deliver` convergence
loop — which iterates a model against the project's real gates (build,
type-check, tests) until delivery is verified — rather than ad-hoc hand edits.

## Rules

1. **Route coding through `uap deliver`.** For non-trivial implementation work,
   prefer `uap deliver "<task>"` (or the MCP `deliver` tool). It classifies task
   complexity and enables the matching convergence aids automatically, then
   drives the change to verified completion against the gates.

2. **Default is advisory.** With the policy installed but `UAP_ENFORCE_DELIVERY`
   unset (or `advisory`), direct source edits are allowed and simply logged with
   a nudge. Nothing breaks.

3. **Strict mode is opt-in.** Set `UAP_ENFORCE_DELIVERY=block` to make direct
   source edits outside a deliver context a hard block.

4. **Escape hatches.** A deliver-driven run sets `UAP_DELIVER_ACTIVE=1` (auto-
   exempt). For a sanctioned manual edit under strict mode, set
   `UAP_DELIVER_BYPASS=1`.

5. **Scope is source code only.** Docs, configs, scripts, policies, and test
   files are exempt (tests are protected by deliver itself).

## Nature of this gate

This is a **cooperative-agent guardrail / nudge**, not a security boundary. Its
signals (`UAP_DELIVER_ACTIVE`, `UAP_DELIVER_BYPASS`, `UAP_ENFORCE_DELIVERY`) are
read from the calling agent's environment, so an agent that sets them can
self-exempt. It is designed to keep a *cooperative* workflow routed through
`uap deliver` and to make the expectation explicit — not to constrain a
misaligned agent. Treat it accordingly; do not rely on it as an access control.

## Running deliver to completion

To drive a task to 100% verified completion autonomously, add `--until-delivered`:
the loop keeps iterating (escalating on stagnation) until every required gate
passes, a hard turn ceiling is reached, or progress stalls.

```bash
uap deliver "implement X with tests" --until-delivered
UAP_ENFORCE_DELIVERY=block   # opt in to strict enforcement
UAP_DELIVER_BYPASS=1         # sanctioned manual override
```
