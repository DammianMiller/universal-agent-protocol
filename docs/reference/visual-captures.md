# Visual Captures (Review Binding)

Uplift 0.3 of the [System-1 uplift plan](../plans/system1-uplift-2026-09-18.md):
any diff touching UI files requires before/after captures bound to the
review, and completion gate 7 (self-review) refuses DONE without them.

`uap design check` remains the design-token enforcer; `uap verify` /
`visual_verification.py` remain the runtime render gate. This layer closes
the gap between them: deterministic proof that a human-or-vision reviewer
*looked at rendered before/after evidence* for the exact diff being shipped.

## Surface definition

A file is UI when its extension is `.css .scss .sass .less .tsx .jsx .vue
.svelte .html .astro`, or it lives under `web/`, `src/dashboard/`, or
`public/`. The same definition is mirrored in
`src/review/visual-captures.ts` (`UI_EXT`/`UI_DIR_PREFIXES`),
`src/policies/enforcers/expert_review_required.py`, and
`visual_verification.py` — keep all three in sync.

## CLI

```bash
uap review captures add --before <img> --after <img> [--tool tuistory] [--note "..."]
uap review captures check [--json]   # also: bare `uap review captures`
```

- `add` registers one before/after pair for the current branch. Capture files
  must exist inside the project (absolute paths under the project are
  relativized; paths escaping the project are refused). Pairs accumulate.
- `check` validates the current diff and exits 1 when UI files lack a
  complete, fresh pair — on the `--json` path too, so CI can gate on it.

Captures are produced by the agent with a capture tool: `agent-browser` for
web surfaces, `tuistory`/`pty-capture` for terminal ones. The tool only
proves pairing and freshness; judgment about what the captures show stays
with the (vision-capable) reviewer.

## Artifact

`.uap/reviews/<branch-slug>.captures.json` — a **sibling** of the review
artifact, never `<branch-slug>.json` itself, because the expert-review
enforcer treats that file's existence as "a review happened" (the same
decision as the [review pre-pass](review-prepass.md)). Writes are atomic
(tmp + rename), and review consolidation embeds the capture paths into the
real artifact.

```json
{
  "branch": "feature/x",
  "head": "…",
  "ui_files": ["src/app.tsx"],
  "captures": [
    { "tool": "tuistory", "before": ".uap/visual/before.png",
      "after": ".uap/visual/after.png", "at": "2026-09-18T…" }
  ],
  "at": "2026-09-18T…"
}
```

## Ship-time enforcement

`expert_review_required.py` runs the captures check **before** its low-risk
early-allow: UI-only diffs are exactly what the gate exists for, and they
would otherwise wave through unobserved. The check blocks the ship when:

1. the diff vs the upstream base touches UI files and no captures artifact
   exists;
2. the artifact has no complete before/after pair;
3. a referenced capture file is missing on disk;
4. any UI file's mtime postdates the captures (stale — re-capture), with the
   same 1-second grace the commit-time visual enforcer uses.

Fail-open posture matches the rest of the enforcer: when no upstream base
resolves, or a PR is shipped by reference (`gh pr merge <N>`) so the local
diff is not the PR's contents, the check is skipped. In the PR-ship case the
captures reach the trail through the review artifact's embedded capture paths
(the consolidation contract), not through a mechanical check.

The gate fires on every ship verb, so on a branch that already contains UI
commits, each later commit needs captures fresher than the newest UI mtime —
per-commit freshness, deliberately heavier than per-review.

**Bypass surface (all three routes, deliberately):**

1. `UAP_VISUAL_GATE_OFF=1` — environment-only, set by whoever launches the
   session; never parsed from the command line (an inline form would be
   self-grantable), and inline/persisted assignments are refused by
   `enforcement_self_protect.py`.
2. `UAP_NO_REVIEW=1` — the operator's global ship-gate override, same shape.
3. An expert-review waiver file (`policies/waivers/*expert-review*.md` or
   `.uap/reviews/WAIVER`) — a deliberate, committable act; waiving review
   waives captures too (the waiver check precedes the captures check).

Artifact fields `branch`, `head`, and `ui_files` are informational context
for reviewers, not verified claims: the gate checks pairing, existence, and
freshness only — an agent can self-author an artifact, which is accepted
scope ("deterministic pairing, not judgment"; mtime freshness is gameable
with `touch` and is an honesty scaffold, not a tamper-proof log).

## Decisions

- **Why a separate layer when `uap verify` already renders?** The render gate
  proves the UI *runs* (not blank/static/erroring) on entry pages it can
  find headlessly. Captures prove a reviewer *looked at the change* —
  including surfaces the render gate cannot reach (TUI flows, states behind
  interaction) — and bind that evidence to the review trail.
- **Why the enforcer and not just the skill?** The skill is prose; the
  enforcer makes "gate 7 refuses DONE on UI diffs without captures" a
  deterministic fact at ship time, including UI-only diffs that skip the
  parallel review.
- **Freshness by mtime, like `visual_verification.py`:** cheap, deterministic,
  and matches the existing commit-time backstop's semantics (1s grace).
