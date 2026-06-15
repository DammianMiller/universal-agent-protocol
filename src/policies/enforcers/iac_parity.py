#!/usr/bin/env python3
"""iac-parity enforcer: live-state changes must have matching IaC diff."""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, run, worktree_root  # noqa: E402

MUTATING_RE = re.compile(
    r"\b(kubectl|helm|doctl|aws|gcloud)\b[^\n;&|]{0,48}?\b(apply|patch|create|edit|delete|install|upgrade|rollout|scale|set)\b",
    re.I,
)
IAC_PATHS = (
    "infra/terraform/",
    "infra/helm_charts/",
    "infra/kubernetes/",
    "infra/k8s/",
    "infra/policies/",
)


def main() -> None:
    op, args = parse_cli()
    # iac-parity governs live-state MUTATING shell COMMANDS (kubectl apply,
    # helm install, ...). File edits -- including editing IaC manifests, or any
    # content that merely names infra tools -- are never live-state mutations,
    # so only Bash commands are in scope.
    if op.lower() != "bash":
        emit(True, "not a bash command")
    cmd = args.get("command") or args.get("cmd") or ""

    if not MUTATING_RE.search(cmd):
        emit(True, "not a mutating IaC-scope command")

    root = worktree_root()  # git status must run against the working tree, not MAIN_ROOT
    rc, out, _ = run(["git", "status", "--porcelain"], cwd=root)
    if rc != 0:
        emit(True, "git status unavailable; deferring to post-commit check")

    has_iac = any(
        line[3:].startswith(IAC_PATHS) or line[3:].lstrip().startswith(IAC_PATHS)
        for line in out.splitlines()
    )

    if not has_iac:
        emit(
            False,
            "iac-parity: live-state mutation without matching IaC diff under "
            + ", ".join(IAC_PATHS)
            + ". Update Terraform/Helm/K8s manifests in the same worktree.",
        )

    emit(True, "IaC diff present in worktree")


if __name__ == "__main__":
    main()
