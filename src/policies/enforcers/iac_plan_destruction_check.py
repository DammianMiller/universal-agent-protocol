#!/usr/bin/env python3
"""iac-plan-destruction-check enforcer.

Before an IaC apply/merge, REQUIRE that the terraform plan was reviewed for
`Destruction`/`must be replaced` events. A lagging pinned version slug against
an auto-upgraded cluster is a destroy-on-next-apply landmine (2026-05-31: a
routine dashboard PR's push-to-main apply destroyed an OpenObserve cluster).

Gate fires on IaC apply/merge Bash commands:
  - terraform apply
  - gh workflow run <iac-terraform...> with action=apply
  - gh pr merge / gh api ...PUT|PATCH .../merge   (only if the PR being merged
    touches infra/terraform/**)
  - git push origin main                          (only if infra/terraform/** changed)

Satisfy by reviewing the plan, then writing
  .uap/iac_plan_reviewed.json  -> {"reviewed_at": <epoch>, "no_unexpected_destruction": true}
(or set env UAP_IAC_PLAN_REVIEWED=1). Ack is valid for 2h.
"""
from __future__ import annotations
import json
import os
import re
import time
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, arg_str, repo_root, run  # noqa: E402

ACK = Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "iac_plan_reviewed.json"
ACK_TTL = 2 * 60 * 60  # 2 hours

# Commands that apply/merge infrastructure.
APPLY_MARKERS = ("terraform apply",)
WORKFLOW_APPLY = ("gh workflow run",)
MERGE_MARKERS = ("gh pr merge", "/merge")  # gh api .../pulls/<n>/merge
PUSH_MAIN = ("git push",)


def branch_touches_iac() -> bool:
    """True if the current branch diff vs origin/main touches infra/terraform."""
    root = repo_root()
    for ref in ("origin/main...HEAD", "HEAD"):
        rc, out, _ = run(["git", "-C", str(root), "diff", "--name-only", ref], timeout=8)
        if rc == 0 and "infra/terraform/" in out:
            return True
    # staged/working changes too
    rc, out, _ = run(["git", "-C", str(root), "status", "--porcelain"], timeout=8)
    return rc == 0 and "infra/terraform/" in out


def merge_touches_iac(cmd: str) -> bool:
    """Decide whether a `gh pr merge`/`gh api .../merge` command touches IaC by
    inspecting the FILES OF THE PR BEING MERGED — not the local working tree.

    The naive approach falls back to branch_touches_iac(), which reads the
    current checkout. That blocks EVERY `gh pr merge <N>` whenever the local
    tree happens to carry unrelated infra/terraform changes (e.g. untracked
    *.tf files), regardless of what PR <N> actually contains. We pull the PR's
    own file list instead, and only fall back to the local check when no PR
    number can be parsed or the lookup fails.
    """
    m = re.search(r"gh\s+pr\s+merge\s+(\d+)", cmd) or re.search(r"/pulls/(\d+)/merge", cmd)
    if not m:
        # e.g. `gh pr merge` on the current branch with no number — use local diff.
        return branch_touches_iac()
    pr = m.group(1)
    rc, out, _ = run(
        ["gh", "pr", "view", pr, "--json", "files", "-q", ".files[].path"], timeout=20
    )
    if rc != 0:
        # Lookup failed (offline / auth) — fail safe by keeping the gate on.
        return branch_touches_iac()
    return "infra/terraform/" in out


def ack_fresh() -> bool:
    if os.environ.get("UAP_IAC_PLAN_REVIEWED") == "1":
        return True
    if not ACK.exists():
        return False
    try:
        s = json.loads(ACK.read_text())
    except json.JSONDecodeError:
        return False
    return bool(s.get("no_unexpected_destruction")) and (time.time() - float(s.get("reviewed_at", 0))) < ACK_TTL


def main() -> None:
    op, args = parse_cli()
    if op not in ("Bash", "bash"):
        emit(True, "not a bash op")
    cmd = (args.get("command") or "").lower()

    is_tf_apply = any(m in cmd for m in APPLY_MARKERS)
    is_wf_apply = any(m in cmd for m in WORKFLOW_APPLY) and "iac-terraform" in cmd and "apply" in cmd
    is_merge = any(m in cmd for m in MERGE_MARKERS)
    is_push_main = any(m in cmd for m in PUSH_MAIN) and ("origin main" in cmd or "origin head" in cmd or " main" in cmd)

    if not (is_tf_apply or is_wf_apply or is_merge or is_push_main):
        emit(True, "not an IaC apply/merge command")

    # Merges/pushes only gated when IaC is actually touched. For `gh pr merge`
    # inspect the PR's own files; for local pushes use the working-tree diff.
    if (is_merge or is_push_main) and not (is_tf_apply or is_wf_apply):
        touches = merge_touches_iac(cmd) if is_merge else branch_touches_iac()
        if not touches:
            emit(True, "merge/push does not touch infra/terraform")

    if ack_fresh():
        emit(True, "IaC plan-destruction review acknowledged")

    emit(
        False,
        "iac-plan-destruction-check: review the terraform plan for "
        "'Destruction'/'must be replaced'/'forces replacement' BEFORE this "
        "apply/merge. A lagging pinned version slug against an auto-upgraded "
        "cluster is a destroy-on-next-apply landmine (it destroyed an "
        "OpenObserve cluster on 2026-05-31). After confirming no unexpected "
        "destruction, write .uap/iac_plan_reviewed.json "
        '{"reviewed_at": <epoch>, "no_unexpected_destruction": true} '
        "(valid 2h) or set UAP_IAC_PLAN_REVIEWED=1, then retry.",
    )


if __name__ == "__main__":
    main()
