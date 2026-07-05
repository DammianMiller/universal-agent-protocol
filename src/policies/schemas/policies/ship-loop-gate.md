# ship-loop-gate

**Category**: process
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: ship-loop, task, completion, evidence, merge-deploy-monitor-verify

## Rule

A task MUST NOT be marked `completed` without evidence for all four ship-loop
phases under `metadata.shipped`: `merged` (PR URL / merge SHA on main),
`deployed` (deploy run URL), `monitored` (log/metric window + result), and
`verified` (behavioural assertion against the deployed change). `TaskUpdate`
setting `status=completed` — or `TaskCreate` landing directly in `completed` —
without all four non-empty keys is **blocked**.

## Why

"Merged" is not "done": deploys regress silently and features ship dark.
Requiring written evidence per phase turns the merge -> deploy -> monitor ->
verify loop from a convention into a contract, and the recorded values become
the audit trail. Companion to the `merge-deploy-monitor-verify` policy — this
is its enforcement point at task-completion time.

## Enforcement

Python enforcer `ship_loop_gate.py` inspects TaskUpdate/TaskCreate arguments
and rejects completion without the four evidence keys, echoing an example of
the expected `metadata.shipped` shape in the denial message.

```rules
- title: "Task completion requires merged/deployed/monitored/verified evidence"
  keywords: [taskupdate, taskcreate, completed, shipped, evidence]
  antiPatterns: ["marking a task completed with no ship evidence"]
```
