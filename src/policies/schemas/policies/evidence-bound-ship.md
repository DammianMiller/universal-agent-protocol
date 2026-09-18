# evidence-bound-ship

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: review
**Tags**: uap, delivery, evidence, gates, enforcement, ship

## Rule

A ship action MUST present machine-recorded gate evidence bound to the exact
commit being shipped. When no valid evidence artifact exists for the current
HEAD, the enforcer blocks the ship actions:

- `git commit`, `git push`, `git merge`
- `gh pr create`, `gh pr merge`, `gh pr ready`
- merge / pr-ready / signoff / ready-for-review operations

Evidence artifact: `.uap/evidence/<candidate-sha>.json`, written by the
**deliver CLI** (`src/delivery/gate-evidence.ts`) when a mission completes with
its gates green. Recognised shape (version 1):

```json
{
  "version": 1,
  "candidateSha": "<full HEAD sha the gates prove>",
  "recordedAt": "<ISO-8601>",
  "runId": "<deliver run id, optional>",
  "hatches": ["<gate-affecting env vars set at deliver time, audit only>"],
  "gates": [
    { "name": "test", "command": "npm test", "exitCode": 0,
      "outputTail": "<last ≤2000 chars>", "at": "<ISO-8601>" }
  ]
}
```

The writer **refuses to record against a dirty working tree** (`git status
--porcelain` must be empty): evidence claims the gates passed for `<sha>`, and
with uncommitted changes they provably ran against HEAD-plus-delta. The
supported flow is therefore commit → `uap deliver` (a green tree short-circuits
as `alreadyDelivered`, and the baseline ladder's rung results become the
evidence) → ship.

Per-gate `at` is **reconstructed**, not measured: rungs carry durations but no
wall-clock finish time, so a gate's stamp is the recording time minus the
durations of the gates that ran after it. Honest ordering, approximate clock.

`hatches` lists which known gate-affecting env vars (the
enforcement-self-protect BYPASS_PATTERNS set plus `UAP_VISUAL_GATE_OFF` /
`UAP_DESIGN_GATE_OFF`) were set when the evidence was recorded. Audit value
only; the enforcer does not act on it.

The enforcer rejects (BLOCKS) an artifact that is:

- **missing** — no `.uap/evidence/<head>.json` for the current HEAD;
- **oversized** — larger than 512KB (read capped before parsing);
- **malformed** — not parseable JSON;
- **wrong version** — anything but `version: 1`;
- **SHA-mismatched** — `candidateSha` differs from HEAD (evidence for a
  different commit proves nothing about this one; this is also the forgery
  case, since `.uap/evidence/` is agent-write-protected by
  enforcement-self-protect, including interpreter-mediated writes);
- **backdated** — `recordedAt` earlier than the commit's own committer time
  (and an UNRESOLVABLE commit time blocks too: the sha resolving while
  `git show` fails is anomalous, not a skip);
- **future-dated** — `recordedAt` more than 5 minutes ahead of now;
- **stale** — `recordedAt` older than the staleness window (default **24h**,
  operator-tunable via `UAP_EVIDENCE_MAX_AGE_HOURS` in the launch environment;
  the agent cannot set it — enforcement-self-protect refuses any assignment);
- **empty** — no gate entry with `exitCode: 0`, a non-empty `command`, and a
  parseable `at` timestamp.

## Why

Deliver missions claim "all gates pass", but until this policy nothing bound
that claim to the commit a ship action actually publishes. An agent could run
the gates on one tree, amend or swap the commit, and ship code the gates never
saw — the ship gates trusted the run, not the artifact. Evidence binding makes
the merge candidate carry its proof: the ship enforcer reads the artifact for
`HEAD` and fails closed on anything missing, stale, or mismatched.

This is the machine-recorded analogue of `expert-review-required`: review
evidence is a human verdict (fail-open on unresolvable HEAD); gate evidence is
written by the CLI at deliver time, so the posture is fail-closed — the only
fail-open is a tree that is not a git repo at all.

## Enforcement

Python enforcer `evidence_bound_ship.py` resolves the candidate HEAD via local
git (`git rev-parse --verify HEAD^{commit}` — no network, no `gh`), then checks
`.uap/evidence/<sha>.json` as above. Ship-action detection is **shared** with
`expert-review-required` (imported `is_ship_action`), so the two gates can
never disagree on what a ship action is.

Fail-closed on every ambiguity; fail-open only when git itself is absent or
the working tree is not a repository (non-UAP trees unaffected).

Bypass (operator-only, environment-only — the inline form is refused by
enforcement-self-protect because the agent composes its own command strings):

- `UAP_EVIDENCE_GATE_OFF=1` — set in the launch environment.

```rules
- title: "A ship action must present gate evidence bound to the shipped commit"
  keywords: [git commit, git push, gh pr create, merge, pr-ready, signoff, gate evidence]
  antiPatterns: [no-evidence, stale-evidence, forged-evidence, evidence-sha-mismatch]
```
