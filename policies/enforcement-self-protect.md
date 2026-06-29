# Enforcement Self-Protect

The delivery gate exists to route coding through `uap deliver`. A weak local
model that hits the block tends to try to ESCAPE it rather than comply
(observed: "set enforcement to advisory", "use UAP_DELIVER_BYPASS=1"). This
policy makes the gate non-disableable by the agent.

## Rules

1. **The control surface is read-only to the agent.** Edits to policy
   definitions, enforcers (`src/policies/`, `.policy-tools/`), `.uap.json`,
   `.uap/`, the proxy env, and the policy-gate hook scripts are blocked.
2. **Bypass/relax flags cannot be set by the agent.** Bash commands that set or
   persist `UAP_DELIVER_BYPASS`, relax `UAP_ENFORCE_DELIVERY`, or disable the
   workdir/worktree gates are blocked. (A shell `export` alone does not persist
   across tool calls; this blocks the persistence paths.)
3. **No model-reachable bypass.** Honoring a bypass here would reopen the hole.
   Operator override is out-of-band only: `UAP_SELF_PROTECT_OFF=1` in the
   trusted launch environment.

## Rationale

Compliance must be the easy path and non-compliance the blocked one. Route
substantive coding through the `deliver` tool; do not weaken the gate.
