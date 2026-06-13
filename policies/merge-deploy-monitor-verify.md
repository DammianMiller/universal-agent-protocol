# Merge, Deploy, Monitor, Verify

A change is NOT DONE until it has been merged, deployed, monitored in the target environment, and verified to behave correctly with observed evidence. Local "build green + tests pass" is necessary but not sufficient.

Claiming DONE, COMPLETE, or CLOSED is prohibited until ALL four gates below pass in order. No exceptions, no deferrals, no "I'll check after marking done."

## Rules

1. **Merge gate.** The change MUST be merged into the integration branch (`master`/`main`) via a reviewed pull request. Required:
   - PR opened from a feature/worktree branch (never direct commits to `master`)
   - At least one approving review (or self-review with documented justification for trivial changes)
   - All CI required checks passing on the merge commit (build, tests, lint, type-check)
   - Merge commit SHA recorded for traceability

2. **Deploy gate.** The merged change MUST be rolled out to the target environment(s) through the designated automated pipeline. Required:
   - Deployment pipeline executed without error end-to-end (no manual intervention to "make it work")
   - For infrastructure: IaC pipeline succeeded (see `definition-of-done-iac.md`)
   - For applications: build artifact published and rollout completed in staging *and* production (or the highest target environment in scope)
   - Deployment run URL recorded for traceability
   - Local deploys, ad-hoc cluster mutations, manual file pushes, or hand-edited resources are FORBIDDEN as the deploy path

3. **Monitor gate.** Post-deploy observation window MUST elapse with the change demonstrably healthy. Required:
   - Minimum monitoring window: 15 minutes for low-risk changes, 1 hour for service/infra changes, 24 hours for high-blast-radius changes (auth, payments, data migration, schema, traffic routing)
   - Health signals reviewed during the window:
     - Error rate (no new error classes, no rate increase above baseline)
     - Latency (p50/p95/p99 within SLO)
     - Saturation (CPU/memory/connections within healthy bounds)
     - Logs (no new ERROR/FATAL log lines tied to the change)
     - Alerts (no new alerts firing related to the change)
   - Dashboard/log links recorded in the task or PR
   - If any signal degrades, rollback or roll-forward fix must occur — DONE remains blocked until signals are clean

4. **Verify gate.** Behavioral verification MUST confirm the change works correctly in the deployed environment, not just in CI. Required:
   - The specific behavior the change introduced/fixed is exercised end-to-end against the deployed environment
   - Verification method matches change type:
     - API/backend: live request against deployed endpoint with expected response asserted
     - UI/frontend: interactive walkthrough of the golden path AND the specific edge case the change addresses
     - Infrastructure: cluster/cloud CLI query confirming the resource exists and behaves as designed
     - Data/schema: query confirming migrated data is shaped correctly and reads/writes succeed
   - At least one explicit negative case checked (the failure mode the change was supposed to prevent does not occur)
   - Evidence captured (response body, screenshot, command output, log excerpt) and attached to the task or PR
   - "It built and unit tests passed" is NOT verification — verification requires evidence from the deployed system

## Gate Sequence

Gates run sequentially. If any gate fails, fix the underlying issue and re-run from the failed gate forward. Do not advance with a failed prior gate "noted for follow-up."

```
merge   -> PR reviewed, CI green, merged into master
deploy  -> automated pipeline rolled out to target env(s) without error
monitor -> minimum observation window elapsed, all health signals clean
verify  -> deployed behavior exercised end-to-end with captured evidence
DONE    -> all four gates passed, evidence recorded
```

## When Triggered

This policy is enforced whenever:

- A task status is being changed to DONE / COMPLETE / CLOSED / RESOLVED
- A pull request is being declared "shipped"
- An incident or change request is being closed
- Work is being declared finished in any form

## Required Evidence on Task Closure

Before closing the task, attach (as comments, links, or task fields):

- [ ] Merge commit SHA and PR URL
- [ ] Deployment pipeline run URL (or equivalent automation evidence)
- [ ] Target environment(s) reached (e.g. staging, production)
- [ ] Monitoring window start/end timestamps
- [ ] Dashboard/log links reviewed during the window
- [ ] Verification evidence (command output, response, screenshot)
- [ ] Negative case checked (what failure mode was confirmed absent)

If any of the above cannot be provided, the task is not done.

## Anti-Patterns

DO NOT:

- Mark a task DONE because the PR was merged ("merged != deployed")
- Mark a task DONE because deployment succeeded ("deployed != working")
- Mark a task DONE based on CI green ("CI != production")
- Skip the monitoring window because "it's a small change"
- Skip verification because "the tests cover it" — tests cover code paths, not deployed behavior
- Verify only the happy path and ignore the negative case
- Accept "no alerts fired" as proof of health when no alerts exist for the changed surface area
- Roll forward without explicit verification just to clear the queue
- Defer the deploy/monitor/verify gates to "next sprint" or "ops can check later"
- Use this policy as a checkbox exercise — the evidence must be real and reviewed

## Relationship to Other Policies

This policy SUPERSEDES generic "build + test = done" interpretations. It composes with:

- `completion-gate.md` — local gates (tests, build, lint, version bump, worktree)
- `definition-of-done-iac.md` — IaC-specific deploy + cluster verify requirements
- `iac-pipeline-enforcement.md` — pipeline-only deploy path for infrastructure
- `mandatory-testing-deployment.md` — test creation and quality requirements

The local completion-gate gets a change ready to ship. This policy ensures the change actually shipped, stayed healthy, and demonstrably works.

## Enforcement Level

[REQUIRED]

## Related Tools

- github-actions / gitlab-ci: Merge and deploy automation
- prometheus / grafana / datadog: Monitoring signals during the observation window
- cluster / cloud CLI: Deployed-state verification queries
- curl / httpie / playwright: End-to-end behavioral verification
