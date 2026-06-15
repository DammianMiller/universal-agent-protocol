#!/usr/bin/env python3
"""cluster-routing enforcer: kubectl/helm context must match component domain."""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import arg_str, emit, parse_cli, run  # noqa: E402

DOMAINS = {
    "openobserve": re.compile(
        r"grafana|prometheus|openobserve|fluent-?bit|servicemonitor|alertmanager|loki|tempo|jaeger",
        re.I,
    ),
    "zitadel": re.compile(r"zitadel|oidc|keycloak|iam-crd", re.I),
}
CONTEXTS = {
    "openobserve": "do-syd1-pay2u-openobserve",
    "zitadel": "do-syd1-zitadel",
    "main": "do-syd1-pay2u",
}


def pick_domain(blob: str) -> str:
    for d, rx in DOMAINS.items():
        if rx.search(blob):
            return d
    return "main"


def main() -> None:
    op, args = parse_cli()
    blob = f"{op} {arg_str(args)}"

    if not re.search(r"\b(kubectl|helm)\b", blob):
        emit(True, "not a kubectl/helm call")

    if not re.search(
        r"\b(apply|patch|create|edit|delete|install|upgrade|uninstall|rollout)\b", blob
    ):
        emit(True, "read-only kubectl/helm call")

    rc, out, _ = run(["kubectl", "config", "current-context"])
    ctx = out.strip() if rc == 0 else ""

    wanted_domain = pick_domain(blob)
    wanted_ctx = CONTEXTS[wanted_domain]

    if ctx != wanted_ctx:
        emit(
            False,
            f"cluster-routing: context '{ctx}' does not match domain "
            f"'{wanted_domain}'. Run: kubectl config use-context {wanted_ctx}",
            wanted_context=wanted_ctx,
            current_context=ctx,
        )

    emit(True, f"context '{ctx}' matches domain '{wanted_domain}'")


if __name__ == "__main__":
    main()
