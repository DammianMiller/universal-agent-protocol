# Deliver Hardening — Parallel-Review Response (2026-07-13)

Three review angles ran concurrently against the uncommitted hardening diff
(code-quality-reviewer, security-code-reviewer, architect-reviewer). This
document records every finding and its disposition. The implementation plan
itself is `deliver-hardening-plan-2026-07-13.md`.

## Blockers — fixed

### 1. E2 scoped restore was inert on the default executor (code-quality + architect)

`runFiles` came from `history[].filesApplied`, but the agentic executor (the
DEFAULT whenever the repo has inspectable content) writes through its own
tools behind a no-op applier, so the write-set was empty by construction: a
regressed run logged "nothing to do" and disposed the only good snapshot —
worse than the blast-radius defect E2 fixed.

**Fix:**

- `AgenticExecutorOptions.writeLedger` — a caller-owned per-run `Set` of
  project-relative paths, recorded at the `write_file`/`edit_file`/`edit_range`
  `writeFileSync` sites (NOT via the bash sweep's `authorised` map, which is a
  no-op when bash is disabled — the common case).
- `SweepOutcome.changed` — the turn-end bash sweep now reports every
  stat-moved path, judged or not, so shell writes reach the same ledger.
- deliver.ts drains the ledger in the applier seam, so
  `history[].filesApplied` is truthful again. The isolated-task executor is
  deliberately NOT wired in: its paths are relative to its own tree and would
  mis-target the projectRoot-scoped restore.
- Empty write-set + warranted rollback now fails LOUD: the snapshot is
  preserved with an operator-actionable message instead of being silently
  disposed. (A whole-tree fallback restore was considered and rejected — in a
  shared worktree it reverts other agents' work, the incident E2 exists to
  fix.)
- The convergence loop's idle-breaker comment was updated: `filesApplied` is
  no longer empty-by-construction on the agentic path.

Tests: `test/delivery/agentic-write-ledger.test.ts` (8: tool writes recorded,
refusals not, end-to-end through a mocked model, shell write via the sweep),
plus a `changed`-field test in `bash-sweep.test.ts`.

### 2. operator-overrides.json was agent-mintable (security BLOCK)

Every check on the file was satisfiable by a same-uid agent (uid==euid is
vacuous when the agent IS the user), and an interpreter-mediated write
(`python3 -c 'open(...)'`) walked past the self-protect text scan — one Bash
call minted `deliverBypass` + `selfProtectOff`, neutralizing all enforcement.

**Fix:**

- The hook now requires the override file (and the liveness cache, below) to
  be **ROOT-owned** (`st_uid == 0`), regular, not group/world-writable,
  symlink-free (O_NOFOLLOW + fstat-on-fd), and unexpired. Root ownership is
  the only check with teeth under a same-uid agent: the operator plants the
  file with `sudo`, the agent cannot. (When the agent itself runs as root, no
  local check can help — enforcement is already theater there.)
- Defense-in-depth: `enforcement_self_protect.py` gained an interpreter-write
  rule — a bash command naming either trust anchor
  (`.uap/operator-overrides.json`, `.uap/policy-liveness.json`) with an
  interpreter (python/perl/ruby/node) and a write primitive
  (`open(…"w"/"a"/"x"/"+")`, `.write*/.dump/.rename/.unlink/…`) is blocked at
  any wrapper depth. Reads (`open` without a mode, `json.load`, `cat`) stay
  allowed; ordinary `.uap` runtime state stays writable.
- Newline/colon injection through `workdirAllow` values is rejected (a value
  carrying `\nUAP_SELF_PROTECT_OFF=1` would have smuggled an extra export into
  the hook's eval loop).

Tests: the override suite was restructured around the new trust model — the
user-owned-refusal case runs everywhere (it IS the security property); the
trusted-file cases are `runIf(getuid()===0)` since a non-root process cannot
mint a root-owned fixture by construction. New injection test. Six new
enforcer tests (`test_enforcement_self_protect.py`).

## High — fixed

### 3. Liveness cache trusted blindly (security)

The degrade consult now applies the same trust terms as the override file:
root-owned, regular, not group/world-writable, no symlink, and FRESH
(`checkedAt` < 24h — a fixed path silently re-tightens; staleness bound was
the architect's should-fix). The file was already added to PROTECTED_TARGETS
pre-review. Consequence, documented in the hook and tests: `uap policy
liveness` run as the user writes the cache for STATUS display; the gate never
degrades on it. No seeded policy sets `degradeOnDeadPath` today, so no live
behavior changes; when one does, the operator refreshes the cache elevated —
a deliberate act, matching the override story.

### 4. Declared-gates cwd containment (security #3, partial)

`runRung` refuses a declared `cwd` that resolves outside the project root
(one-line containment check, fail-closed with a clear message; test added).
The deeper finding — `.uap.json` is writable via interpreter-mediated bash,
and declared gates make that RCE — is PRE-EXISTING and honestly documented in
the enforcer (`HONEST SCOPE`); the same interpreter-write class now blocked
for the trust anchors could be extended to `.uap.json` in a follow-up. The
id-shadowing of detected rungs by declared ones is an intended feature
(documented outrank semantics), kept.

## Should-fix — fixed

- **Liveness worktree alignment (code-quality + architect):** `liveness.ts`
  gained `mainCheckoutRoot()` (git toplevel + `.worktrees` strip, same rule
  as the hook's `${CHECKOUT_ROOT%%/.worktrees/*}`), applied in
  `checkPolicyLiveness`/`writeLivenessCache`/`readLivenessCache`/
  `enabledPolicySlugs`. Session-start runs the refresh from `COORD_ROOT`.
  Previously a worktree session (the mandated workflow) wrote the cache and
  read the DB where the gate never looks — F1 was inert there.
- **Cache contract:** `version: 1` field added; the slug rule is documented
  as one rule in three places (TS writer, `policyNameSlug`, hook re.sub).
- **`classifySurface`** now compares separator-terminated (`/repo-evil` no
  longer classifies as inside `/repo`), and an unwritable dir INSIDE the repo
  is `agent-writable` (agent could chmod it — the hardcoded `external` was a
  sabotage hole once any policy opts into degrade).
- **Python execution gate** prefers `.venv/bin/python` over ambient
  `python3` (deps live in the venv; ambient import failed healthy repos).
  Test with a stub venv interpreter added.
- **`runNativeBin`** no longer counts a binary that failed to exec at all
  (ENOENT/bad shebang/wrong arch) as pass evidence; all-unexecutable reads as
  an honest skip-pass ("not measurable here"), not a pass.
- **Hook hot path:** the override parse is guarded by an existence early-out
  — zero python spawns on the common path. (Merging the two payload parses
  was considered and skipped: churn on a string the tests pin byte-exactly,
  for ~one spawn on path-carrying ops only.)
- **F4 anchor:** walks to the nearest EXISTING ancestor directory (a Write
  into a not-yet-created dir in another repo no longer falls back to cwd),
  and the extractor accepts the same key set as the self-protect extractor
  (`file_path`, `path`, `filePath`, `target`, `filename`, `file`).
- **deliver.ts** uses `Object.hasOwn` for the criticality lookup (prototype-
  chain values like `"constructor"` no longer pass).
- **plan.ts** `stateDir` honors an ABSOLUTE `UAP_STATE_DIR` (the hook exports
  it as `$MAIN_ROOT/.uap` since F4; `join` would have concatenated it).
- **acceptance-judge** labels the git section "UNCOMMITTED CHANGES IN THIS
  TREE" with a shared-worktree caveat instead of "CHANGES IN THIS RUN" — the
  diff is against HEAD, so in a shared worktree it lists other agents' work
  and the old label actively misled the judge.
- **acceptance-judge test fixture** sets local git identity (flakes on
  machines without global user.email).
- **`uap policy status` help** documents the cache-write side effect.

## Considered, not done

- **Whole-tree restore fallback for an empty write-set** — rejected: it is
  the shared-worktree incident E2 fixes. Loud preserve instead.
- **Signing overrides with an HMAC/keyfile instead of root ownership** —
  root ownership is simpler, needs no key management, and is auditable with
  `ls -l`. Revisit if multi-user operator workflows appear.
- **Re-deriving `degradable` in the hook from the registry** — the registry
  is TS; the hook is bash. Root-ownership + freshness + the opt-in bit in the
  cache achieves the same guard without a TS eval in the hot path.
- **ADR adoption** — the repo convention is `docs/plans/`; the plan doc plus
  this response satisfy the decision-record intent.

## Behavior changes operators should know (in the commit message)

1. **`UAP_STATE_DIR` is now exported by the gate hook as `$MAIN_ROOT/.uap`.**
   In-flight per-worktree state (`plan_state.json`, `read_log.state`, IaC
   acks) is orphaned once — a one-time fail-closed reset: sessions may be
   re-prompted for plan review. State then lives consistently in the main
   checkout instead of fragmenting per worktree.
2. **Config beats env for deliver model routing** (G1): a declared
   `delivery.model`/`routing`/`criticality` in `.uap.json` now outranks
   ambient `UAP_DELIVER_MODEL`/`UAP_DELIVER_ROUTING`.
3. **The operator-override file must be root-owned** (sudo) to be honored —
   the original uid/mode-only check was vacuous against a same-uid agent.
4. **The liveness degrade path** consults only root-owned, fresh (<24h)
   caches.

## Verification

- `tsc --noEmit` clean.
- All touched vitest suites green (ledger 8, bash-sweep 39, snapshot-scoped
  10, declared-gates 9, execution-gate-polyglot 13, acceptance-judge 26,
  policy-liveness 12, gate hook suites 22, routing 13, run-state 15).
- Python enforcer suite: 1212 tests; 3F+9E all in `test_uap_compliance`
  (live-DB schema checks), byte-identical failure set on unmodified master —
  pre-existing environmental.
- Hook mirror parity enforced by `test_gate_failclosed_indirection` +
  `test_gate_failclosed_schema_diff` (these caught an unsynced mirror during
  remediation — the parity net works).
- Full vitest suite: see PR body for the final run.
