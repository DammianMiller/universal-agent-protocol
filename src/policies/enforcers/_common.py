"""Shared helpers for UAP policy enforcers."""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def parse_cli() -> tuple[str, dict[str, Any]]:
    p = argparse.ArgumentParser()
    p.add_argument("--operation", required=True)
    p.add_argument("--args", default="{}")
    ns = p.parse_args()
    try:
        args = json.loads(ns.args)
    except json.JSONDecodeError:
        args = {}
    return ns.operation, args


def emit(allowed: bool, reason: str, **extra: Any) -> None:
    payload: dict[str, Any] = {"allowed": allowed, "reason": reason}
    payload.update(extra)
    json.dump(payload, sys.stdout)
    sys.exit(0 if allowed else 2)


def repo_root() -> Path:
    env = os.environ.get("UAP_REPO_ROOT")
    if env:
        return Path(env)
    cwd = Path.cwd()
    for p in [cwd, *cwd.parents]:
        if (p / ".git").exists():
            return p
    return cwd


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 5) -> tuple[int, str, str]:
    try:
        r = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
        return r.returncode, r.stdout, r.stderr
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def arg_str(args: dict[str, Any]) -> str:
    """Flatten args to a single lowercase string for substring checks."""
    try:
        return json.dumps(args, default=str).lower()
    except Exception:  # noqa: BLE001
        return str(args).lower()
