#!/usr/bin/env python3
"""Pin GVS5H published LCB-100-hardest v6 anchors from run artifacts.

Reads a GVS5H repo checkout and extracts the corrected-grader (".patched.json")
pass@1 values published for the LCB release_v6 100-hardest benchmark:

- Qwen3.8 Flash Next, single-call and orchestrated (5 passes each),
  from runs/q38-fn-5pass/results/*.patched.json
- Claude Fable 5, single-call (5 passes), from
  runs/fable5-128k-reasoning-on-5pass/results/*.patched.json
- Qwen3.8-27B single and orchestrated, from paper/tab-regrade.tex
  (the paper's corrected-grader 5-pass means; raw 27B run dirs are not
  committed to the repo)

Also extracts the per-problem corrected verdicts for the first N problem ids
(the smoke subset) so the report can show what the published arms did on the
exact problems this smoke run covers.

Usage:
    extract_anchors.py <gvs5h_checkout> [--out anchors.json] [--ids-first 10]

Stdlib only. Output is a small JSON file intended to be committed.
"""

import argparse
import json
import re
import subprocess
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

FN_DIR = "runs/q38-fn-5pass/results"
FABLE_DIR = "runs/fable5-128k-reasoning-on-5pass/results"
PASSES = (1, 2, 3, 4, 5)


def load_patched(root: Path, run_dir: str, prefix: str):
    """Return {pass_number: loaded_json} for the .patched.json files of a run."""
    out = {}
    for p in PASSES:
        f = root / run_dir / f"{prefix}_p{p}.patched.json"
        if not f.exists():
            continue
        out[p] = json.loads(f.read_text())
    return out


def pass_at_1(doc) -> float:
    return float(doc["lcb"]["pass@1"])


def verdicts(doc, wanted: set):
    """Map question_id -> passed bool for the wanted ids in one results doc."""
    out = {}
    for rec in doc["lcb"]["records"]:
        if rec["question_id"] in wanted:
            out[rec["question_id"]] = bool(rec.get("passed"))
    return out


def ids_file(root: Path) -> Path:
    for cand in (
        root / "codebase/v2-current/escalation/lcb100_hardest_v6.json",
        root / "escalation/lcb100_hardest_v6.json",
    ):
        if cand.exists():
            return cand
    raise FileNotFoundError("lcb100_hardest_v6.json not found in checkout")


def pinned_commit(root: Path) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return "unknown"


def paper_27b(root: Path) -> dict:
    """Parse the Qwen3.8-27B row out of paper/tab-regrade.tex.

    Row shape: 'Qwen3.8-27B & 62.4 & $+2.6$ & $+1.8$ & \\textbf{66.8} &
               84.4 & $+5.4$ & $+2.6$ & \\textbf{92.4} \\\\'
    Columns: single as-graded, delta harness, delta keys, single re-ported,
             multi as-graded, delta harness, delta keys, multi re-ported.
    """
    tex = (root / "paper/tab-regrade.tex").read_text()
    m = re.search(
        r"Qwen3\.8-27B\s*&\s*([\d.]+).*?\\textbf\{([\d.]+)\}.*?"
        r"&\s*([\d.]+).*?\\textbf\{([\d.]+)\}",
        tex, re.S,
    )
    row = None
    if m:
        row = {
            "as_graded_single": float(m.group(1)),
            "single": float(m.group(2)),
            "as_graded_multiagent": float(m.group(3)),
            "multiagent": float(m.group(4)),
        }
    return {
        "model": "Qwen3.8-27B (FP8, served locally per paper)",
        "values": row,
        "source": "paper/tab-regrade.tex, corrected grader, 5-pass means; "
                  "paper/tab-qwen-caps.tex reports single 66.8 +/- 5.2 (95% t int.)",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkout", help="path to a GVS5H repo checkout")
    ap.add_argument("--out", default=None, help="output anchors.json path")
    ap.add_argument("--ids-first", type=int, default=10,
                    help="size of the smoke subset taken from the head of the ids file")
    args = ap.parse_args()

    root = Path(args.checkout).resolve()
    if not root.exists():
        sys.exit(f"checkout not found: {root}")

    ids = json.loads(ids_file(root).read_text())
    smoke_ids = ids[: args.ids_first]
    wanted = set(smoke_ids)

    fn_single = load_patched(root, FN_DIR, "q38_fn_single")
    fn_multi = load_patched(root, FN_DIR, "q38_fn_multiagent")
    fable_single = load_patched(root, FABLE_DIR, "fable5_single")
    for name, docs in (("fn_single", fn_single), ("fn_multiagent", fn_multi),
                       ("fable5_single", fable_single)):
        if len(docs) != len(PASSES):
            sys.exit(f"expected 5 patched result files for {name}, found {len(docs)}")

    def per_pass(docs):
        return {str(p): pass_at_1(docs[p]) for p in sorted(docs)}

    def mean(docs):
        return round(statistics.mean(pass_at_1(docs[p]) for p in docs), 1)

    fn_run_config = (root / FN_DIR / "run_config.txt").read_text()
    fn_config_lines = [ln for ln in fn_run_config.splitlines() if ln.strip()]

    published_per_problem = {}
    for name, docs in (("fn_single", fn_single), ("fn_multiagent", fn_multi),
                       ("fable5_single", fable_single)):
        per_problem = {}
        for qid in smoke_ids:
            per_problem[qid] = [verdicts(docs[p], {qid}).get(qid) for p in sorted(docs)]
        published_per_problem[name] = per_problem

    anchors = {
        "schema": "lcb-droid-anchors/1",
        "provenance": {
            "source_repo": "https://github.com/slee-persis/GVS5H",
            "pinned_commit": pinned_commit(root),
            "extracted_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "benchmark": "LiveCodeBench code generation, release_v6, the 100 hardest "
                         "problems (escalation/lcb100_hardest_v6.json)",
            "metric": "pass@1 (k=1), corrected grader (.patched.json, post fix-rescore); "
                      "identical to the paper's 'Re-ported' column",
            "license_note": "GVS5H code is MIT; paper, figures and run data are CC BY 4.0 "
                            "(LICENSE + LICENSE-CC-BY-4.0 in the vendored copy)",
            "fn_run_config": fn_config_lines,
        },
        "published": {
            "fn_single": {
                "model": "Qwen3.8 Flash Next, single-call baseline",
                "per_pass": per_pass(fn_single),
                "mean": mean(fn_single),
                "n_graded": 100,
                "source": f"{FN_DIR}/q38_fn_single_p*.patched.json",
            },
            "fn_multiagent": {
                "model": "Qwen3.8 Flash Next, GVS5H ledger self-orchestration",
                "per_pass": per_pass(fn_multi),
                "mean": mean(fn_multi),
                "n_graded": 100,
                "source": f"{FN_DIR}/q38_fn_multiagent_p*.patched.json",
            },
            "fable5_single": {
                "model": "Claude Fable 5, single-call baseline",
                "per_pass": per_pass(fable_single),
                "mean": mean(fable_single),
                "n_graded": 100,
                "source": f"{FABLE_DIR}/fable5_single_p*.patched.json",
            },
            "qwen27b": paper_27b(root),
        },
        "smoke_subset": {
            "rule": f"first {len(smoke_ids)} ids of escalation/lcb100_hardest_v6.json",
            "ids": smoke_ids,
        },
        "published_per_problem_verdicts": {
            "note": "per-pass corrected verdicts on the smoke subset, "
                    "[p1, p2, p3, p4, p5]",
            **published_per_problem,
        },
    }

    out = Path(args.out) if args.out else Path(__file__).resolve().parent / "anchors.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(anchors, indent=2) + "\n")
    print(f"wrote {out}")
    print(f"  fn_single mean {anchors['published']['fn_single']['mean']}")
    print(f"  fn_multiagent mean {anchors['published']['fn_multiagent']['mean']}")
    print(f"  fable5_single mean {anchors['published']['fable5_single']['mean']}")
    print(f"  qwen27b {anchors['published']['qwen27b']['values']}")


if __name__ == "__main__":
    main()
