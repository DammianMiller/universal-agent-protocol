#!/usr/bin/env python3
"""EVERY code type routes through deliver.

The rule: if it is interpreted, transpiled, or compiled, it is code — it must be
gated (and therefore tested). A partial SOURCE_EXTS list let whole ecosystems
escape: `.html` was missing, so a 34KB single-file web app shipped completely
ungated. Pure data/config (.json/.yaml/.md) is deliberately NOT gated — it has no
"correct function" to execute.
"""
import json, os, subprocess, sys, unittest
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "delivery_enforcement.py"

# One representative file per language family — compiled, transpiled, interpreted.
GATED = [
    # C / C++ / CUDA / ObjC
    "src/main.c", "src/main.cpp", "src/main.cxx", "src/engine.hpp", "src/k.cu", "src/v.mm",
    # Rust / Go / Zig / Nim
    "src/main.rs", "src/main.go", "src/main.zig", "src/main.nim",
    # .NET
    "src/Program.cs", "src/Lib.fs", "src/Old.vb", "src/Page.razor",
    # JVM
    "src/Main.java", "src/Main.kt", "src/Main.scala", "src/build.gradle",
    # Scripting / interpreted
    "src/app.py", "src/app.rb", "src/app.php", "src/app.lua", "src/app.pl",
    # NOTE: `scripts/` is an EXEMPT_PREFIXES tooling dir (pre-existing carve-out),
    # so shell code is exercised from a non-exempt path here.
    "bin/deploy.sh", "bin/deploy.ps1",
    # Functional / BEAM
    "src/app.ex", "src/app.erl", "src/app.hs", "src/app.ml",
    # Mobile / other
    "src/App.swift", "src/main.dart",
    # Web (renders/executes)
    "index.html", "src/app.css", "src/App.vue", "src/App.svelte",
    # Contracts / query / schema / IaC
    "contracts/Token.sol", "db/schema.sql", "api/user.proto", "infra/main.tf",
    # Assembly
    "boot/start.asm",
]

# Data / prose: no executable "correct function" — must stay ungated.
NOT_GATED = ["package.json", "config.yaml", "data.xml", "README.md", "notes.txt", "Cargo.lock"]


def run(path, content="x" * 2000):
    e = {**os.environ, "UAP_ENFORCE_DELIVERY": "block", "UAP_INFERENCE_ENDPOINT": "http://172.17.0.1:8080/v1"}
    # ANTHROPIC_BASE_URL / OPENAI_BASE_URL must be stripped too: the enforcer
    # downgrades block -> advisory for a local-model session, so a developer
    # with a loopback base URL exported (the normal shape of a local session)
    # sees every block-expecting test here allow instead. CI has them unset, so
    # this is green in CI and red on the developer's machine.
    for k in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS", "UAP_DELIVER_LOCAL_MODE",
              "UAP_DELIVER_LOCAL_ADVISORY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"):
        e.pop(k, None)
    p = subprocess.run(
        [sys.executable, str(ENF), "--operation", "Write", "--args", json.dumps({"file_path": path, "content": content})],
        capture_output=True, text=True, env=e, cwd=str(ENF.parents[3]),
    )
    return p.returncode, p.stdout


class AllLanguagesGatedTest(unittest.TestCase):
    def test_every_code_type_routes_to_deliver(self):
        for path in GATED:
            code, out = run(path)
            self.assertEqual(code, 2, f"{path} must be GATED as source — got {out}")
            self.assertIn("route", out, path)

    def test_data_and_prose_stay_ungated(self):
        for path in NOT_GATED:
            code, out = run(path)
            self.assertEqual(code, 0, f"{path} must NOT be gated (data/config, not code) — got {out}")


if __name__ == "__main__":
    unittest.main()
