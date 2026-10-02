# Plane-admin enforcer now fails closed on shell operations

Date: 2026-10-02
Deliver run: `run-20261002T030209-1af47d` (status: delivered)

## Problem

`uap-policy-gate.sh` maps an errored or missing enforcer to ALLOW for everything
except the two enforcers named in `must_fail_closed()` (`enforcement_self_protect`
on `SEC_SENSITIVE`, `schema_diff_gate` on `COMMIT_OP`). `plane_admin_protect` —
the guard over Plane admin credential resets — was not in that selector, so a
crashed or absent plane enforcer was a silent bypass of the admin controls on
exactly the surface it exists to protect.

## Change

New `SHELL_OP` arm, keyed on the tool name (the enforcer's own activation test is
tool-based — a shell tool is the only one it is ever asked about):

```bash
SHELL_OP=0
case " $TOOL " in
  *" Bash "*|*" bash "*|*" BashTool "*|*" Shell "*|*" shell "*|*" Terminal "*|*" terminal "*|*" execute_command "*|*" run_command "*|*" exec "*|*" local_shell "*|*" command "*)
    SHELL_OP=1
    ;;
esac
[[ "${UAP_SELF_PROTECT_OFF:-}" == "1" ]] && SHELL_OP=0
```

and the selector case:

```bash
must_fail_closed() {
  case "$1" in
    enforcement_self_protect) [[ "$SEC_SENSITIVE" == "1" ]] ;;
    schema_diff_gate)         [[ "$COMMIT_OP" == "1" ]] ;;
    plane_admin_protect)      [[ "$SHELL_OP" == "1" ]] ;;
    *)                        false ;;
  esac
}
```

Scoping rationale (mirrors why `schema_diff_gate` is gated on `COMMIT_OP`): the
plane-admin surface is mutable through the shell and nothing else. Arming the
fail-closed net on every edit would turn a broken plane enforcer into a blanket
block on all edits in the session. Non-shell tools keep failing open.
`UAP_SELF_PROTECT_OFF=1` clears this arm too — otherwise the override named in
the refusal is a no-op for the case that prints it.

## Files changed

- `templates/hooks/uap-policy-gate.sh` — +33 lines (SHELL_OP arm, selector case, rationale comments)
- `.claude/hooks/uap-policy-gate.sh`, `.factory/hooks/uap-policy-gate.sh`, `.omp/hooks/uap-policy-gate.sh` — identical mirrors (drift test requirement; `uap worktree create` seeds from `templates/hooks/`)
- `tools/agents/tests/test_gate_failclosed_plane_admin.py` — new, 15 tests
- `package.json` — `test:enforcers` now registers `test_gate_failclosed_plane_admin` (additive; nothing removed)

## Verification

- `UAP_PROXY_ENV_AUTOLOAD=0 python3 -m unittest tools.agents.tests.test_gate_failclosed_plane_admin` → 15 tests OK
- `tools.agents.tests.test_gate_failclosed_schema_diff` → 23 tests OK (drift sweep green)
- All four tracked hook copies byte-identical to `templates/hooks/`; `bash -n` clean on each
- No other fail-open behavior changed

## Note on the pending-intent log

The earlier recorded intent `ts=1790903849` (a `_pt_for` path-resolution change to
the gate) was **not** applied. It was archived to `.uap/pending-deliver.applied.jsonl`
with an operator note recording that it was deferred deliberately: the delivered
hardening is the `must_fail_closed` arm, not the path-resolution rewrite. 38 other
intents remain pending and visible.