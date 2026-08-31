# Deliver/enforcement hardening plan — 2026-07-13

Motivating incident (pay2u, 2026-07-13): the `delivery-enforcement` policy blocked
direct source edits and routed a pre-reviewed 6-file C++ change into `uap deliver`.
The run declared **"Delivered — all required gates pass" after writing ZERO files**:
the only detected project gates were npm build/test for `apps/web`, which were
already green, so the loop had nothing that could fail. Meanwhile every blocked
edit auto-spawned a **blind** background deliver run whose mission was the literal
string "implement the intended change to <file>" — no content, no spec.
Related, earlier incident (same repo, board finding): `expert-review-required`
policy demanded artifacts under paths that Enforcement-Self-Protect locks agents
out of, while the skill it named did not exist — a compliance catch-22.

Defect sites (all paths relative to this repo):

| # | Defect | Where |
|---|--------|-------|
| 1 | "Delivered" = required gates green; when gates are green at (or near) baseline the loop succeeds without a diff. Two paths: the `baselineCheck` short-circuit (`alreadyDelivered`) and the normal ladder pass — the incident run went green via the latter in 2 turns with zero writes | `src/delivery/convergence-loop.ts` ~742 (`baselineCheck`) and ladder success path |
| 2 | Gate relevance to the MISSION is never established — npm web gates "verified" a C++ handler change | `src/cli/deliver.ts` gate selection, `src/delivery/execution-gate.ts` |
| 3 | Self-gate (anti-vacuous floor) only engages when NO project gates are detected | `src/cli/deliver.ts` ~43 (`needsSelfGate = … noRealGates \|\| forceSelfGate`) |
| 4 | `--no-auto` silently disables the acceptance judge (a verification rail) along with exploration aids | `src/cli/deliver.ts` auto-plan wiring |
| 5 | Acceptance judge can accept with an empty diff (diff-blind) | `src/delivery/acceptance-judge.ts` |
| 6 | Gate detection is npm-centric; polyglot repos (C++/docker, SQL migrations) get irrelevant gates | `src/delivery/execution-gate.ts` (`detectArtifactType`, package.json only) |
| 7 | Autoroute spawns deliver with a vacuous hint; the blocked edit's actual content (old/new strings) is discarded | `src/policies/enforcers/delivery_enforcement.py` ~158 (`deliverHint=f'implement the intended change to {rel}'`), `templates/hooks/deliver_autoroute.py` |
| 8 | Agentic executor has whole-file `write_file` only — no anchored edit tool; weak models re-read in loops and whole-file rewrites of 1,200-line files are high-risk | `src/delivery/agentic-executor.ts` |
| 9 | keep-best / protect-tests snapshots cover the whole tree — a deliver run in a SHARED worktree reverts other agents' concurrent (legitimate) edits, including their newly written tests (observed: frontend agent's new test file reverted) | `src/delivery/…` snapshot/rollback + protect-tests paths |
| 10 | Policy liveness: a policy can demand a compliant path that does not work (missing skill, agent-locked artifact dir, deliver that no-ops) with no detection | `src/policies/*` (no liveness concept) |
| 11 | Inverted self-protect: compliance artifact paths locked, but the policies DB the gate reads is not protected | pay2u operator patch `uap-policy-fix-APPLY.sh` exists; not upstreamed |
| 12 | Operator escape hatches are env-var-only (`UAP_DELIVER_BYPASS`, `UAP_WORKDIR_ALLOW`); env does not reliably reach hook processes in every harness, so the sanctioned override paths are effectively unreachable mid-session | `templates/hooks/uap-policy-gate.sh`, enforcers |
| 13 | Default executor model `qwen35-a3b` regardless of repo criticality | `src/cli/deliver.ts` defaults |
| 14 | Hook resolves the governing repo from the shell CWD / `cd` target, not from the operation's TARGET path — cross-repo writes are gated by one repo's policy but read the other repo's compliance state (observed: `uap plan validate` recorded in this repo was invisible to the gate anchored in pay2u) | `templates/hooks/uap-policy-gate.sh` MAIN_ROOT resolution; enforcers using relative `.uap/` state |

---

## Options per area

### A. Kill the false-green (defects 1–3) — pick one, A2 recommended

- **A1 — No-op guard (minimum).** For coding missions, `success` requires a
  non-empty applied-files set across the run (`filesApplied` union), unless the
  caller passes `--allow-noop`. The `alreadyDelivered` baseline short-circuit is
  only taken when the acceptance judge affirmatively confirms the mission is
  already satisfied, with cited evidence. Small, surgical; does not fix gate
  relevance (a run that writes one irrelevant file still "delivers").
- **A2 — Universal anti-vacuous floor (recommended).** Generalize the self-gate
  rule that already exists for gate AUTHORING to the whole run: every deliver run
  must have ≥1 required gate that FAILS at baseline. If all detected project
  gates are green at turn 0, auto-engage self-gate authoring (today that happens
  only when `noRealGates`). Change is essentially
  `needsSelfGate = selfGateAllowed && (noRealGates || allRequiredGatesGreenAtBaseline || forceSelfGate)`
  plus threading the baseline result into gate selection. HARD-FAIL rule: if the
  required self-gate is still vacuous after its authoring retries (passes on the
  unsolved repo), the RUN fails — today a vacuous gate is only a warning, which
  re-opens the false-green door. This is the smallest change that makes
  "delivered" always mean "something that was red is now green".
- **A3 — Mission-scoped gate relevance (deep).** Classify the mission → affected
  paths → require gates whose declared scope covers those paths (needs B1's gate
  manifests with `scope:` globs). Most correct; biggest lift; do after A2.

### B. Polyglot gates (defect 6) — B1 recommended, B2 additive

- **B1 — Project-declared gates.** `.uap.json → delivery.gates[]`:
  `{id, name, cmd, cwd, scope: [globs], required, tier, timeoutSec}`. Declared
  gates merge with (and outrank) detected ones. pay2u would declare:
  docker-buildx `--target builder` for `apps/api/**`, `gen_openapi.py --check`
  for handler files, vitest workspace for `apps/web/**`. Also gives A3 its
  scope metadata later.
- **B2 — Broader detection.** Recognize Dockerfile targets, CMakeLists, cargo,
  pyproject, migrations dirs. Heuristic; useful defaults, never as trustworthy
  as B1.

### C. Verification rails (defects 4–5) — do both, small

- **C1 — Diff-aware acceptance.** The judge prompt always includes
  `git diff --stat` + changed-file list since run start; hard rule before the
  LLM call: empty diff ⇒ acceptance FAIL (for coding missions). An LLM judge
  must never be the only thing standing between a no-op and success — make the
  empty-diff case deterministic.
- **C2 — Decouple rails from `--no-auto`.** `--no-auto` disables exploration
  aids only (candidates, ideation, practices, escalation). Acceptance judging
  and the anti-vacuous floor are verification rails and stay on unless
  explicitly disabled (`--no-acceptance`).

### D. Autoroute with content (defects 7–8) — D1+D3 recommended, D2 policy choice

- **D1 — Capture the blocked edit as an intent.** The PreToolUse payload already
  contains the exact `old_string`/`new_string`/`content`. The enforcer writes the
  FULL intent into `.uap/pending-deliver.jsonl` (file, op, old, new, ts, agent).
  The spawned deliver mission becomes "apply the recorded edit intents for
  <file>" and the executor gets a deterministic `apply_pending_edits` fast path
  (anchored exact-match application, no model improvisation; model only engages
  when an anchor no longer matches). This converts "block and hope" into a
  queue of exact diffs applied through the sanctioned pipeline with gates —
  today's entire incident would have been a non-event.
- **D2 — Spawn policy.** Default OFF for auto-spawn (log + surface the pending
  intent to the agent in the block message: "recorded; run `uap deliver
  --pending <file>` to apply"), batch multiple intents per file per run. Avoids
  background fan-out entirely; the agent stays in control of when to flush.
- **D3 — `edit_file` tool in the agentic executor.** Anchored `{path, old, new,
  occurrence}` replacement alongside `write_file`. Needed by D1's fallback; also
  removes the whole-file-rewrite hazard for large files generally.

### E. Shared-workspace safety (defect 9)

- **E1 — Exclusive lease.** `deliver.lock` becomes a real mutex: a second run
  against the same worktree refuses to start (override flag for operators).
  Concurrent agents queue rather than interleave.
- **E2 — Scoped snapshots (recommended with E1).** keep-best rollback and
  protect-tests restoration operate ONLY on files the run itself wrote (tracked
  per-run), never tree-wide — a concurrent agent's test files can't be reverted
  by someone else's deliver run.

### F. Policy liveness (defects 10–12, 14) — the catch-22 class

- **F1 — Compliance-path liveness check (recommended, with a sabotage guard).**
  Every enforcer declares its compliant path as machine-checkable requirements
  (`requires:` — commands that must exist, dirs that must be agent-writable,
  skills that must resolve). `uap policy enable`/install runs the liveness
  check and re-runs it on session-start; a policy whose compliant path is dead
  raises a loud operator alert and is marked "unhealthy" in `uap policy status`.
  IMPORTANT — auto-degrade to advisory is NOT the default: an agent could
  deliberately break a compliant path (delete a skill, wedge deliver) to force
  a blocking policy down to advisory. Degrade-on-dead-path is opt-in per policy
  (`degradeOnDeadPath: true`) and only when the breakage is outside
  agent-writable surfaces; otherwise the policy stays blocking and the operator
  decides. Liveness probe for deliver itself: a canary mission in a temp repo
  that must produce a 1-line diff and pass its gate.
- **F2 — Upstream the self-protect inversion fix.** Port pay2u's operator patch
  (`uap-policy-fix-APPLY.sh`): protect `agents/data/memory/policies.db` (the
  enforcement DB) while allowing agent WRITES (not edits/deletes) to compliance
  artifact paths the gates demand (`.uap/reviews/…`).
- **F3 — Operator overrides via signed file.** Honor
  `.uap/operator-overrides.json` (owner-writable only; hook verifies uid/mode)
  carrying `{deliverBypass: true, workdirAllow: [...], expiresAt}` in addition
  to env vars — env doesn't reach hook subprocesses in all harnesses, which
  today makes the documented escape hatches unreachable mid-session. Time-boxed
  by `expiresAt` so overrides can't rot open.
- **F4 — Anchor policy state to the TARGET repo (defect 14).** The gate hook
  resolves MAIN_ROOT from the operation's target path (file_path) when present,
  falling back to cwd only for path-less ops; enforcers read state via
  `UAP_STATE_DIR` derived from that root, never a bare relative `.uap/`.
  Cross-repo work then meets the target repo's policies with the target repo's
  compliance state.

### G. Model routing (defect 13)

- **G1 —** `.uap.json → delivery.model` / `delivery.routing` as the
  config-authoritative default (same authoritative-over-env pattern as
  `delivery.enforcement`); ship a `criticality: money|normal|sandbox` shorthand
  that maps to routing presets. Local qwen stays the default only for `sandbox`.

---

## Recommended phasing

- **P0 (stops the bleeding; small diffs):** A2 + C1 + C2, and D2's log-only
  default for autoroute (one-line default flip). After P0, a false-green no-op
  is structurally impossible and blind agents stop spawning.
- **P1 (makes the sanctioned path actually good):** D1 + D3 + B1 + E1 + E2.
  After P1, a blocked edit flows through deliver as an exact diff with real,
  project-declared gates — the enforcement stops costing precision.
- **P2 (kills the catch-22 class):** F1 + F2 + F3 + F4 + G1.
- **P3 (correctness ceiling):** A3 mission-scoped gate relevance on top of B1
  scopes.

Rollout: fix in this repo → version-bump (1.145.0 for P0) → reinstall global
(`npm i -g …`) → pay2u picks it up next session; add regression tests:
(1) deliver on a green-gated repo with a real mission must NOT return
`alreadyDelivered` or ladder-pass without a failing-at-baseline required gate;
(2) empty-diff acceptance must fail; (3) autoroute intent must round-trip
`old/new` verbatim; (4) policy liveness canary on the two historical
catch-22s; (5) vacuous required self-gate ⇒ run failure, not warning;
(6) cross-repo write meets the TARGET repo's policy state.
