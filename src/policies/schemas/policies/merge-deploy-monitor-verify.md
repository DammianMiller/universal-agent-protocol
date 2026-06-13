# Policy: Merge, Deploy, Monitor, Verify

**ID**: `policy-merge-deploy-monitor-verify`
**Name**: Merge, Deploy, Monitor, Verify Before Done
**Category**: completion
**Level**: REQUIRED
**Enforcement Stage**: review
**Version**: 1.0

## Purpose

This policy enforces that a change is NOT DONE until it has been merged, rolled out via the designated pipeline, observed healthy in the target environment for a defined monitoring window, and verified with captured evidence to behave correctly end-to-end. Local "build green + tests pass" is necessary but not sufficient — DONE requires evidence from the deployed system, not just CI.

## Rules

```rules
- title: "Merge Gate"
  keywords: ["done", "complete", "finish", "close", "resolve", "shipped"]
  antiPatterns: ["direct push to master", "no pr", "skip review", "force merge", "ci failing", "merged with red ci"]

- title: "Deploy Gate"
  keywords: ["done", "complete", "deploy", "release", "ship", "rollout"]
  antiPatterns: ["manual deploy", "ad-hoc cluster command", "hand-edited resource", "deploy skipped", "deployment failed", "pipeline bypassed", "out-of-band rollout"]

- title: "Monitor Gate"
  keywords: ["done", "complete", "monitor", "observe", "verify health"]
  antiPatterns: ["no monitoring window", "skip observation", "no dashboard checked", "alerts not reviewed", "ignored error rate", "skipped post-deploy check"]

- title: "Verify Gate"
  keywords: ["done", "complete", "verify", "confirm", "validate behavior"]
  antiPatterns: ["unverified", "tests passed so done", "ci is enough", "no end-to-end check", "no evidence captured", "happy path only", "negative case skipped"]

- title: "Evidence Capture"
  keywords: ["close task", "mark done", "complete task", "resolve task"]
  antiPatterns: ["no merge sha", "no deploy url", "no monitoring evidence", "no verification output", "missing screenshot", "missing log excerpt"]
```

## Enforcement Behavior

### When Triggered

This policy is enforced during the **review stage** when:

- Task status is being changed to DONE, COMPLETE, CLOSED, or RESOLVED
- A pull request is being declared "shipped"
- An incident or change request is being closed
- Work is being declared finished in any form

### Required Actions Before Completion

1. **Merge Gate**
   - Change merged via reviewed PR from a feature/worktree branch into the integration branch
   - All CI required checks green on the merge commit (build, tests, lint, type-check)
   - At least one approving review (or self-review with explicit documented justification for trivial changes)
   - Merge commit SHA recorded

2. **Deploy Gate**
   - Designated automated deployment pipeline executed end-to-end without error
   - Application changes: artifact published and rollout completed in target environment(s) (staging through production, as scoped)
   - Infrastructure changes: IaC pipeline succeeded (composes with `definition-of-done-iac`)
   - Pipeline run URL recorded
   - Manual deploys, ad-hoc cluster commands, and hand-edited cloud resources are FORBIDDEN as the deploy path

3. **Monitor Gate**
   - Minimum post-deploy observation window elapsed:
     - 15 minutes for low-risk changes
     - 1 hour for service/infrastructure changes
     - 24 hours for high-blast-radius changes (auth, payments, data migrations, schema changes, traffic routing)
   - Health signals reviewed and clean during the window:
     - Error rate (no new error classes, no rate increase above baseline)
     - Latency (p50/p95/p99 within SLO)
     - Saturation (CPU/memory/connections within healthy bounds)
     - Logs (no new ERROR/FATAL lines tied to the change)
     - Alerts (no new alerts firing related to the change)
   - Dashboard/log links recorded
   - Any degraded signal blocks DONE until rolled back or rolled forward with a fix

4. **Verify Gate**
   - The specific behavior introduced/fixed is exercised end-to-end against the deployed environment
   - Verification method matches change type:
     - API/backend: live request against deployed endpoint with expected response asserted
     - UI/frontend: interactive walkthrough of golden path AND the specific edge case
     - Infrastructure: cluster/cloud CLI query confirming the resource exists and behaves as designed
     - Data/schema: query confirming migrated data is shaped correctly and reads/writes succeed
   - At least one negative case explicitly checked (the failure mode the change prevents does not occur)
   - Evidence captured: response body, screenshot, command output, or log excerpt
   - CI green is NOT verification — verification requires evidence from the deployed system

### Verification Checklist

Before marking work as DONE, verify and attach:

- [ ] Merge commit SHA and PR URL recorded
- [ ] Deployment pipeline run URL recorded
- [ ] Target environment(s) reached and recorded (e.g. staging, production)
- [ ] Monitoring window start/end timestamps recorded
- [ ] Dashboard/log links reviewed during the window and attached
- [ ] Health signals (error rate, latency, saturation, logs, alerts) all clean
- [ ] Verification evidence captured (command output, response body, screenshot)
- [ ] Negative case checked and the prevented failure mode confirmed absent
- [ ] No new alerts fired during or after the observation window

### Anti-Patterns to Avoid

DO NOT mark tasks as DONE when:

- The PR has been merged but the rollout hasn't run yet ("merged != deployed")
- The rollout succeeded but no one observed the system afterwards ("deployed != working")
- CI is green but the deployed environment was never exercised ("CI != production")
- The monitoring window was skipped because "it's a small change"
- Verification consisted of "the tests cover it" — tests cover code paths, not deployed behavior
- Only the happy path was verified and the negative case was skipped
- "No alerts fired" was used as proof of health when no alerts exist for the changed surface area
- The deploy/monitor/verify gates were deferred to "next sprint" or "ops can check later"
- Evidence was claimed but not actually captured or attached

## Implementation Notes

This policy should be enforced by:

1. **Task management gate** — block status transitions to DONE/CLOSED until evidence fields are populated
2. **PR merge bots** — require deployment status checks before allowing merge to be marked "shipped"
3. **CI/CD pipelines** — emit deployment and verification webhooks that the policy gate consumes
4. **Policy gate system (`uap-policy check`)** — validate before allowing completion commands

## Default Status

**Default: ON**
**Level: REQUIRED**

This policy is on by default for all UAP-managed projects. Disable only with explicit project-level override and documented justification (e.g. local-only experiments, scratch projects).

## Related Policies

- `policy-completion-gate` — Local completion gates (tests, build, lint, version bump, worktree)
- `policy-mandatory-testing-deployment` — Test creation and quality requirements
- `policy-definition-of-done-iac` — IaC-specific deploy + cluster verify requirements
- `policy-iac-pipeline-enforcement` — Pipeline-only deploy path for infrastructure

The local completion gate gets a change ready to ship. This policy ensures the change actually shipped, stayed healthy, and demonstrably works in the environment that matters.

---

_Last Updated: 2026-05-04_
_Author: Miller Tech UAP System_
