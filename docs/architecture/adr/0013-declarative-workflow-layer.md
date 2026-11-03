# ADR 0013: Declarative workflow layer — static step DAGs over the orchestrator

- Status: Accepted
- Date: 2026-11-03
- Spec: `uap workflow` (src/workflow/, src/cli/workflow.ts,
  examples/workflows/team-solve/, docs/guides/WORKFLOWS.md).
- Supersedes: none — additive layer; `orchestrate()` and every existing
  delivery surface are untouched.

## Context

UAP's task DAG machinery (ADR 0009's blackboard orchestrator) executes a
graph of fresh-context tasks with bounded repair and resume — but the DAG it
runs is model-authored at runtime (decompose.ts). Every mission re-plans
itself; nothing about the plan is a durable, reviewable, reusable asset.

The measured external counterpoint is GVS5H (Lee, 2026; reproduced by
Memdoor's team-solve): five Qwen3.8-27B roles on a STATIC graph — planner,
two parallel ideators from different algorithm families, solver, reviewer,
repairer — talking only through files, judged only by a deterministic
harness, matched the authors' own harness on LiveCodeBench Hard (9.8/10 vs
9.6; a frontier single-call at 8.0). The claim is structure, not model
class: the graph and the ledger discipline carried the result.

UAP had the engine but not the declarative layer: no way to author the graph
as data, pin models per step, run deterministic command steps as first-class
nodes, or resume a blocked run — nothing a CI or a cron could execute as a
file.

## Decision

1. **A workflow is data.** `.uap/workflows/<name>/workflow.yaml` (zod-
   validated) + role-prompt files; search roots project → home → bundled
   `examples/` (first hit wins). The loader is fail-closed: unique ids, known
   `requires:`, cycle rejection (Kahn — topoOrder's fail-soft is right for
   model-authored plans, wrong for a static file), kind/field confusion,
   parallel write collision (graph-safety FALSE INDEPENDENCE, checked at
   authoring time), run-dir path escapes, load-time model-pin validation,
   reserved-path rejection.
2. **`orchestrate()` is the engine, unchanged.** The runner maps three step
   kinds onto its existing seams: `agent` (fresh single completion; role
   prompt + direct-dependency summaries + inlined `reads:` files; the reply
   IS `writes[0]`), `command` (spawnSync exit-code verdict; `neverFails`
   evidence mode), `gate` (approval file → BLOCKED exit 2, resumable). No
   graph logic is reimplemented; dependency-triggered dispatch, skip
   cascade, bounded repair, and resume-at-the-boundary are inherited and
   already tested by the orchestrator suite.
3. **Files, not chat.** Steps communicate only through the run directory
   (`.uap/workflow-runs/<runId>/`); each agent step starts from a fresh
   context assembled from the file ledger. One deliberate divergence from
   Memdoor: one reply → one file (overwrite semantics), not append-to-notes;
   per-step files keep the ledger unambiguous.
4. **Steps name no model.** Pin ladder: step → workflow `defaultModel` →
   `--model` → the local fleet default (`qwen38-27b`, the strata arm through
   the proxy). A workflow is portable across arms and endpoints without
   edits; `--endpoint` covers non-local OpenAI-compatible servers.
5. **Exit contract for CI/cron:** 0 ok · 1 step failed · 2 gate blocked
   (resumable) · 3 invalid workflow. A real step defect never hides behind a
   blocked gate (failed > blocked precedence).
6. **Trust boundary is the npm-scripts class.** `command:` lines run a shell
   as the invoking user; `--input` bundles are dereferenced on copy (no
   symlink escapes) and cannot plant run-state.json; model replies are data
   (prompts and files, never a shell); model-written code executes only via
   authored commands, exactly like `deliver` gate scripts. Untrusted input
   composes with `uap sandbox --net off` externally — no sandbox stub inside
   the layer.
7. **Validation is a gated option, not a claim.** O7 in
   docs/plans/model-performance-proof-options.md: paired three-arm (single-
   shot / deliver gate loop / team-solve workflow) on the same local model;
   starts only on an explicit go, with the house rules (paired rates,
   bootstrap CI, McNemar, discrimination status).

## Alternatives considered

- **Extend decompose.ts with static plan files** — rejected: couples the
  declarative format to the model-planning path; a static workflow needs
  different validation (fail-closed, not fail-soft) and different authoring
  ergonomics than a runtime plan.
- **Byte-port Memdoor's mario engine** — rejected: UAP already owns a
  validated orchestrator with repair/resume semantics; a second engine would
  duplicate them. The port keeps the METHOD (roles, ledger discipline,
  deterministic verdict), not the bytes.
- **Build workflows on droids/Task** — rejected: droid delegation is runtime
  ad-hoc (the orchestrating model decides); a workflow must be executable
  headless from a file, by CI, without any model in the driver's seat.

## Consequences

- `uap workflow list|show|run|status|resume|approve` joins the command
  surface (additive; registration is one lazy-map entry + one block).
- team-solve ships as the bundled flagship example and the O7 subject; its
  published numbers belong to the authors (their harness, their host).
- Known follow-ups (tracked, deliberate): a shared preset resolver for
  deliver + workflow (the pin ladder's resolution discipline is currently
  expressed twice); dashboard integration over run-state.json's stable JSON
  seam; gate repair-attempt accounting (an unapproved gate consumes its
  step's repair budget while waiting).
