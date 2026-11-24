# PR Review

> **🏭 Where this fits:** SHIPPING, shared with QC. On an agentic floor the cost of writing a change collapsed while review capacity stayed flat, so review becomes the bottleneck, and the predictable response (skim faster) ships changes nobody actually read. **What it delivers:** every non-trivial diff passes a deterministic pre-pass and a parallel council of specialist reviewers before ship actions unlock, the verdict is recorded in an artifact bound to the branch and the exact HEAD, and the merge stays an operator act. The judgment is the model's. The gate is code, and you can read it.

This guide documents the full review line: what runs, in what order, what each station produces, what the gates check, and what the operator keeps. For where review sits in the delivery line as a whole, see the [Delivery Pipeline tour](./DELIVERY_PIPELINE.md) (stations 5 and 7).

## The problem review had to solve

Agents made change cheap to produce and expensive to absorb. A single operator with a fleet of agents can open a day's worth of PRs before lunch, and every one of them competes for the same scarce input: focused attention on a diff.

Bolting an AI reviewer onto that problem naively fails in three recognizable ways:

1. **One generalist prompt.** "Review this PR for bugs, security, performance, and style" produces a reviewer that does everything a little and nothing well. Findings arrive as undifferentiated nit soup, and readers learn to scroll past them.
2. **The author grades itself.** A generator that is also its own evaluator will always pass itself. The same blind spots wrote the code and reviewed it.
3. **Unverifiable review claims.** "The AI reviewed it" with no recorded verdict, no scope, and no binding to the commit is a vibe, and a gate that cannot be checked is a suggestion.

UAP's answers, in order: a **council** of specialist reviewers instead of one prompt, a hard **generator ≠ evaluator** separation, and a **recorded verdict artifact** that the ship gates can check mechanically. The pattern is not ours; several teams have now published versions of it (see [Lineage](#lineage) below). This guide documents the concrete implementation on this floor.

## The review line at a glance

| # | Station | What runs | Output | Enforced by |
|---|---|---|---|---|
| 0 | Pre-pass | Deterministic ruleset scanner (`uap review prepass`) | Line-anchored findings in `.uap/reviews/<slug>.pre-pass.json` | Advisory (exit 1 on HIGH), blocking stays with the enforcer |
| 0.5 | Visual captures | Before/after renders of UI surfaces | `.uap/reviews/<slug>.captures.json` | Ship gate refuses UI diffs without fresh, complete pairs |
| 1 | Parallel council | Specialist reviewer droids, spawned concurrently | Findings per specialty, same diff scope | The [parallel-expert-review](../../.factory/skills/parallel-expert-review/SKILL.md) skill |
| 2 | Consolidation | Severity merge, de-duplication, pre-pass merge-in | One summary: blockers / concerns / clean | Reviewer discipline (skill) |
| 3 | Verdict artifact | The consolidated verdict, written to disk | `.uap/reviews/<slug>.json` | `expert-review-required` enforcer, fails closed |
| 4 | Ship gates | Quality check, gate evidence, merge gate | `.uap/quality-report.json`, `.uap/evidence/<sha>.json` | Enforcers, fail closed |
| 5 | Merge | Operator or merge queue lands the PR | Reviewed, CI-green, versioned merge | Branch protection + merge-deploy-monitor-verify policy |

The branch slug is the branch name percent-encoded (`%`→`%25`, then `/`→`%2F`, so `feature/foo` becomes `feature%2Ffoo`). The encoding is injective: two branches that differ cannot share an artifact, which is the point.

## Step 0: the deterministic pre-pass

Before any LLM reviewer sees the diff, the ruleset scanner runs:

```bash
uap review prepass --write   # scan changed files vs upstream base, record findings
```

It owns pattern-matching, not judgment: secrets (AWS keys, private key blocks, token prefixes, JWTs), injection sinks (`eval(`, interpolated `exec`, `innerHTML`), concatenated SQL, empty catch blocks, unlocked `threading.Thread`. The bar for a rule is "almost always worth a reviewer's glance," because a scanner that cries wolf teaches reviewers to ignore it. Secrets findings are redacted in the artifact; the `file:line` anchor is enough to inspect the secret in place.

Three rules keep the pre-pass honest:

- Findings land in a **sibling** file (`<slug>.pre-pass.json`), never the review artifact itself, because the enforcer treats the artifact's existence as "a review happened." An advisory pass must not satisfy a blocking gate.
- HIGH findings make the command exit 1, so CI can gate on it, but the pre-pass never blocks a ship action itself.
- Every reviewer receives the pre-filtered findings and must say so explicitly when dismissing one. Reviewers adjudicate; the scanner does not re-derive.

Full rule catalog and design decisions: [Review Pre-Pass](../reference/review-prepass.md).

## Step 0.5: rendered evidence for UI diffs

When the diff touches UI files, code review cannot see what the user sees. Before consolidation, capture the rendered surface before and after the change, review the pair with vision, and register it:

```bash
uap review captures add --before .uap/visual/before.png \
                        --after  .uap/visual/after.png \
                        --tool agent-browser
uap review captures check    # exit 1 until the UI diff is covered
```

The BEFORE capture comes from the base ref, not the changed tree. The gate fires at ship time and again at commit time, and a UI edit made after the captures invalidates them. Captures are recorded in a sibling artifact and embedded into the review trail at consolidation. Details: [Visual Captures](../reference/visual-captures.md).

## The council

The default fan-out for a code-change PR:

| Reviewer | What it owns |
|---|---|
| `code-quality-reviewer` | Diff-focused quality, file:line citations |
| `security-code-reviewer` | Per-diff security regressions, CWE-cited |
| `performance-reviewer` | Hot-path and allocation regressions |
| `documentation-accuracy-reviewer` | Stale docs, broken examples |
| `test-coverage-reviewer` | Behavior change without tests |

Add specialists by what the diff touches:

| Trigger | Add |
|---|---|
| `src/types/**` or schemas | `architect-reviewer` (and the architecture-review policy demands an ADR or waiver for the change) |
| API routes / OpenAPI | `api-designer` |
| Dependencies | `dependency-auditor` |
| UI components | `accessibility-tester` |
| Infrastructure as code | `cost-engineer` |

The council runs concurrently (every reviewer spawned in a single batch) and every reviewer reads the same scope, so findings cross-reference. What the diff touches decides the roster; line count appears nowhere in that decision. (The skill's activation guidance uses a 50-line change only as a rough non-triviality proxy for whether to engage the council at all.) A twelve-line schema migration is more dangerous than a three-thousand-line generated-client refresh, and a gate built on diff size is wrong in both directions.

Every reviewer is pointed at the same question: if this is wrong in production, what user-facing behavior breaks? That question rules in substance and rules out bikeshedding. A reviewer that flags naming conventions gets ignored when it has something real to say.

## Consolidation and the verdict artifact

Consolidation merges the council's findings into one summary, ordered by severity (security blockers outrank quality nits), de-duplicated, with the pre-pass findings merged in. A reviewer may dismiss a pre-pass finding, but must say so explicitly in the consolidation.

Then the verdict is recorded, because consolidating in chat is not enough to open the gate:

```json
{
  "branch": "feature/027-pr-review-docs",
  "head": "<full HEAD sha>",
  "verdict": "approve",
  "reviewers": [
    "code-quality-reviewer",
    "security-code-reviewer",
    "performance-reviewer",
    "documentation-accuracy-reviewer",
    "test-coverage-reviewer"
  ],
  "findings": [
    {
      "reviewer": "test-coverage-reviewer",
      "severity": "blocker",
      "location": "src/policies/policy-gate.ts:120",
      "disposition": "resolved"
    },
    {
      "reviewer": "code-quality-reviewer",
      "severity": "concern",
      "location": "src/cli/droids.ts:88",
      "disposition": "open"
    }
  ],
  "quality": { "pass": true, "blocking": 0, "report": ".uap/quality-report.json" }
}
```

Written to `.uap/reviews/<slug>.json` from the repo/worktree root. Four properties do the real work:

- **The verdict is gate-parsed, not just recorded.** The protocol's rule is `approve` or fix and re-review; blockers remaining means fix, re-review, and re-record. The enforcer requires `verdict: "approve"` to ship: a `reject`, a `needs-human`, or an artifact that predates the field blocks with the recorded `reason` when one exists. A disposition the gate cannot read is a disposition that does not exist — the reason rides in the artifact so no downstream tool has to scrape prose to learn why a ship is refused.
- **The artifact binds to `head`.** A review whose `head` differs from the current HEAD is stale, and the gate re-blocks. The artifact also records `branch`, so it cannot be reused on a different branch. One bounded exception, the **carry-forward**: when a new HEAD lands after the review (the version-line merge commit, a generated-file regen), the re-recorded artifact declares `carry_forward: {since_head, justification}` and the gate verifies the delta itself — `since_head` must be an ancestor of the shipped HEAD, at most 3 commits may sit between, and every file in the delta must be low-risk by the same classifier the early-allow uses. Anything wider is a fresh council run. An un-declared hand-edit of `head` is exactly what this closes: after PR #960's version merge, `head` was re-pointed by hand with a prose note the gate could neither see nor bound.
- **The findings ride with dispositions.** When the consolidated findings travel in the artifact, a blocker-severity finding may not be `open` at ship time: `resolved` (fixed and verified) or `withdrawn` (the reviewer retracts it, and says so in the consolidation) clear it. The disposition record is the floor's version of the feedback loops the public write-ups run — which findings were useful becomes data the council can ratchet on.
- **The `quality` block is a number, not an opinion.** When the quality gate is active (`uap quality check`), the machine report rides in the artifact, and a failing report vetoes the approval. Reviewers interpret the numbers (gaming, waivers, trend); they cannot outvote them. When the gate is inactive the key is absent and this check fails open.

Consolidation merges into the artifact; it never overwrites it.

## What the gates check at ship time

The `expert-review-required` enforcer intercepts ship-class actions: `git commit` / `push` / `merge`, `gh pr create` / `merge` / `ready`, PR-ready and signoff phrasings. The detection is deliberately wider than the porcelain verbs:

- Git plumbing that does the same job (`send-pack`, `commit-tree`, `update-ref`, `fast-import`) and git aliases that expand to ship subcommands (resolved via your gitconfig, the authority).
- `gh api` calls that reach merge endpoints without ever saying "pr merge".
- Command-position detection, so `git -C <path> push` counts.
- Prose masking, conditionally: quoted text is treated as prose (blanked before matching) only when the command's verbs are the inert ones that print or search it (`echo 'git push'` mentions a ship verb without shipping). Under any other verb the text is scanned raw, so `git commit -m 'mentions gh pr merge'` still counts as a ship action, the commit is outside the quotes. Heredoc bodies are stripped separately.

Then it checks, in order, all fail-closed:

| Check | Rejection |
|---|---|
| Artifact exists for the branch being shipped | BLOCK, run the review and record it |
| Artifact's recorded branch matches this branch | BLOCK, re-review on this branch |
| Artifact's `head` matches the HEAD being shipped | BLOCK, the review is stale |
| `verdict` is `approve` | BLOCK, the council did not clear this change (reason on record) |
| A declared `carry_forward` is bounded: ancestor, at most 3 commits, low-risk delta only | BLOCK, re-run the council for the current HEAD |
| No blocker-severity finding is `open` in the artifact's findings | BLOCK, resolve or withdraw each, then re-record |
| `quality.pass` is not false | BLOCK, fix or deliberately re-baseline |
| UI diffs have fresh, complete capture pairs | BLOCK, capture before/after evidence |
| Low-risk early allow | Diffs touching only frontend/styles, docs, config, tests, or assets ship without a review; an unresolvable base does not skip |

`gh pr merge <N>` resolves the PR's head branch via `gh` (bounded at 5s, fail-open to the local branch), so a merge run from the main checkout validates the PR's contents, not whatever the local branch happens to be.

Two more gates carry the same posture:

- **Evidence-bound ship**, which binds at ship actions. The gates (build, test, lint) must have passed for the *exact* commit being shipped, recorded in `.uap/evidence/<head-sha>.json` by `uap deliver`. The writer refuses a dirty tree, and the artifact directory is write-protected: the agent cannot forge its own evidence. The order is commit → `uap deliver` → ship; new commits after the deliver run require a fresh run. Staleness window 24h by default. See [Evidence-Bound Ship](../reference/evidence-bound-ship.md).
- **The merge gate**, which runs where merges actually land: for mission-linked PRs at merge-queue landing (`gatePr`), and on demand as `uap merge gate <missionId>`. The diff is matched against the gate system's own paths (enforcer hooks, CI workflows, policy enforcers, the quality baseline, the version-bump script, capacity policy, the mission ledger, and the merge gate and queue themselves). Touching any of them fails the check unless the change is acknowledged in plain sight: a `gate-infra` PR label, or `--allow-gate-infra` on the CLI. A reviewer sees the label; the gate sees the diff. The gates watch themselves.

## What the operator keeps

- **The merge.** The review opens the gate; it does not press the button. CI, branch protection, and required checks still apply, and the merge is a deliberate act by the operator or the merge queue, never by the reviewing model. A reviewer that both writes and ships alone is separation-of-duties failure, not automation.
- **The overrides.** `UAP_NO_REVIEW=1` works in the launch environment only. It used to be honored inline and was removed deliberately: the agent composes its own command strings, so an inline override is self-granted, and in practice sessions waived review on every ship. The env-free routes are waiver files, `policies/waivers/*expert-review*.md` or `.uap/reviews/WAIVER`, deliberate acts visible in the tree. `enforcement-self-protect` refuses the agent setting the bypass, so an inline attempt fails loudly instead of appearing to work.
- **High-risk surfaces.** Schema and type changes add `architect-reviewer` under the protocol, and the architecture-review policy independently blocks schema-touching changes that carry no ADR or waiver. The enforcer's low-risk allow list names what can skip review; everything else, including anything it cannot resolve, gets reviewed.
- **The ratchet.** The quality gate enforces the baseline, and regenerating it (`uap quality baseline --update`, which re-freezes the current state) is a deliberate act that needs reviewer sign-off. The only-tightens property is process discipline rather than a hard-coded invariant, which is exactly why the regeneration is an operator act.

## Skips, and documenting them

The protocol is for non-trivial diffs. Single-line fixes, pure renames, and doc-only changes skip the full council (doc-only changes run `documentation-accuracy-reviewer` solo), and the low-risk allow list above is the enforcer's own version of the same judgment. Two rules keep skips honest:

1. A deliberate skip is documented in the PR body ("single-line rename, no council needed"), so the reviewer knows the omission was a choice.
2. The enforcer resolves risk from the diff itself. If it cannot prove the diff is low-risk, the review is required. Fail-closed is the default under uncertainty.

## After the merge: merged is not done

The review line ends at a merged, CI-green PR. The [merge-deploy-monitor-verify](../../policies/merge-deploy-monitor-verify.md) policy starts where it ends: the change must deploy through the pipeline (never by hand), survive a monitoring window scaled to blast radius (15 minutes low-risk, 1 hour for services, 24 hours for auth/payments/schema changes), and be verified against the deployed system with captured evidence, including one negative case. "CI was green" is not verification; verification is evidence from the running system.

## Lineage

The pattern of a specialist council, a deterministic verdict, and a human keeping the merge is not original. The pre-pass follows the open-code-review precedent (deterministic rule pipelines first, LLM judgment second), credited in [Review Pre-Pass](../reference/review-prepass.md). The framing of review-as-allocation ("risk decides the roster, not size") was sharpened by the public write-ups of teams that let AI review or approve pull requests: Intercom's Fin team, Rootly, Rewind's Diff Vader, and Reddit Engineering's r/RedditEng post (November 2026). UAP's contribution is the enforcement: the verdict is an artifact the gates check, bound to the branch and the exact commit, with the overrides owned by the operator and the evidence unfakeable by the agent. The gate-parsed disposition, the bounded carry-forward, and the findings dispositions adopt three of their mechanisms outright: Reddit's machine-readable merge dispositions and reason codes, Rewind's verifier mode (a push re-checks what changed rather than re-litigating the whole diff), and the feedback loops Reddit and Intercom run on which findings engineers acted on. Crediting convention: see [ATTRIBUTION](../ATTRIBUTION.md).

## Operating the review by hand

```bash
uap expert-route "harden the upload endpoint"   # recommended chain, review phase included
uap review prepass --write                       # step 0, deterministic findings
uap review captures add ...                      # step 0.5, UI diffs only
# spawn the council (one batch, same scope each):
#   Task(subagent_type: "code-quality-reviewer",        prompt: <diff + pre-pass>)
#   Task(subagent_type: "security-code-reviewer",       prompt: <diff + pre-pass>)
#   Task(subagent_type: "performance-reviewer",         prompt: <diff + pre-pass>)
#   Task(subagent_type: "documentation-accuracy-reviewer", prompt: <diff>)
#   Task(subagent_type: "test-coverage-reviewer",       prompt: <diff + pre-pass>)
# consolidate by severity, disposition every blocker (resolved or withdrawn,
#   said so in the consolidation), then record the verdict artifact (see above)
uap quality check                                # the numbers the artifact embeds
# a later commit (the version bump, a regen) makes the artifact stale: re-run
# the council for the new HEAD, or carry forward when the delta is
# version-line-only (see above)
uap worktree pr <id>                             # open the PR from the worktree branch (id from create, e.g. 27)
```

The exact artifact-writing snippet, including the quality-block capture, lives in the [parallel-expert-review](../../.factory/skills/parallel-expert-review/SKILL.md) skill.

## See also

- [Parallel expert review skill](../../.factory/skills/parallel-expert-review/SKILL.md), the protocol this guide documents
- [Review Pre-Pass](../reference/review-prepass.md) · [Visual Captures](../reference/visual-captures.md) · [Evidence-Bound Ship](../reference/evidence-bound-ship.md)
- [Policies](./POLICIES.md), the executable framework the enforcers live in
- [Droids & Skills](./DROIDS_AND_SKILLS.md), where the reviewer roster comes from
- [Merge, Deploy, Monitor, Verify](../../policies/merge-deploy-monitor-verify.md), the policy that owns what happens after merge
- [CONTRIBUTING](../../CONTRIBUTING.md), the contributor-facing summary
