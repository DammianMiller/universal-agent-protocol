#!/usr/bin/env python3
"""Score the LCB-Droid smoke solutions with the vendored scorer (Phase 2).

For every collected solution.py: run the same hidden-test evaluation path as
run_bench.py (load_code_generation_dataset(release_v6) -> codegen_metrics,
k_list=[1]). As a per-problem scorer control, the published fn_multiagent
pass-1 reference is scored alongside each attempt — if both fail, that flags
a scorer/environment problem rather than a model miss.

Outputs:
  - smoke-scored.jsonl (one line per problem, official verdict + controls)
  - a per-problem table vs the published fn_multiagent / fn_single verdicts
  - smoke pass@1 (mean over the 10)

Run with the scoring venv:
    <venv-lcb>/bin/python score_smoke.py
"""

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ART = HERE.parent.parent / "benchmark-results" / "lcb-droid-smoke-20261025-175708"
PROBLEMS = ART / "problems"
RECORDS = ART / "records.jsonl"
OUT = ART / "smoke-scored.jsonl"
ANCHORS = HERE / "anchors.json"
FN_P1 = "runs/q38-fn-5pass/results/q38_fn_multiagent_p1.patched.json"
GVS5H_CHECKOUT = Path("/tmp/gvs5h-clone")


def load_problem(problem_id, release="release_v6"):
    from lcb_runner.benchmarks.code_generation import load_code_generation_dataset
    dataset = load_code_generation_dataset(release_version=release)
    by_id = {p.question_id: p for p in dataset}
    if problem_id not in by_id:
        sys.exit(f"problem id {problem_id!r} not in {release}")
    return by_id[problem_id]


def score(problem, codes):
    """Mirror scorer_sanity.py / run_bench.py exactly (positional alignment)."""
    import numpy as np
    from lcb_runner.evaluation.compute_code_generation_metrics import codegen_metrics

    samples = [problem.get_evaluation_sample()] * len(codes)
    generations = [[c] for c in codes]
    _, results, _ = codegen_metrics(
        samples, generations, k_list=[1], num_process_evaluate=8
    )

    def passed(res0):
        if isinstance(res0, (list, tuple)):
            return bool(len(res0) > 0 and np.all(np.array(res0) > 0))
        return bool(res0)

    return [passed(results[i][0]) for i in range(len(codes))]


def references():
    doc = json.loads((GVS5H_CHECKOUT / FN_P1).read_text())
    return {
        r["question_id"]: r["code"]
        for r in doc["lcb"]["records"]
        if r.get("passed")
    }


def published_verdicts():
    a = json.loads(ANCHORS.read_text())
    ppv = a["published_per_problem_verdicts"]
    return ppv["fn_multiagent"], ppv["fn_single"]


def main():
    if not RECORDS.exists():
        sys.exit("no records.jsonl — run run_smoke.py first")
    manifest = {m["question_id"]: m for m in
                json.loads((PROBLEMS / "manifest.json").read_text())}
    refs = references()
    fn_multi, fn_single = published_verdicts()

    rows = []
    for line in RECORDS.read_text().splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not rec.get("final") or rec["question_id"] in {r["question_id"] for r in rows}:
            continue
        qid = rec["question_id"]
        sol_path = Path(rec["log"]).parent.parent / "problems" / qid / "solution.py"
        code = sol_path.read_text() if sol_path.exists() else None
        problem = load_problem(qid)
        codes = ([code] if code is not None else []) + [refs[qid]]
        labels = (["solution"] if code is not None else []) + ["reference"]
        verdicts = score(problem, codes)
        by_label = dict(zip(labels, verdicts))
        rows.append({
            "question_id": qid,
            "style": rec["style"],
            "stop_reason": rec["stop_reason"],
            "wall_s": rec["wall_s"],
            "public_gate_passed": rec.get("public_gate", {}).get("passed"),
            "hidden_passed": by_label.get("solution", False),
            "has_solution": code is not None,
            "reference_passed": by_label.get("reference", False),
            "published_fn_multiagent_p1": fn_multi.get(qid),
            "published_fn_single_p1": fn_single.get(qid),
            "scored_utc": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        })
        r = rows[-1]
        print(
            f"{qid:10s} {r['style']:8s} stop={r['stop_reason']:11s} "
            f"pub_gate={'PASS' if r['public_gate_passed'] else 'fail'} "
            f"HIDDEN={'PASS' if r['hidden_passed'] else 'FAIL'} "
            f"(ref {'PASS' if r['reference_passed'] else 'FAIL'}; "
            f"published orchestrated p1 {r['published_fn_multiagent_p1']})",
            flush=True,
        )

    with OUT.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    n = len(rows)
    passed = sum(r["hidden_passed"] for r in rows)
    print(f"\nsmoke pass@1: {passed}/{n} = {100.0 * passed / max(n, 1):.1f}%")
    if any(not r["reference_passed"] for r in rows):
        print("WARNING: a reference failed scoring — scorer/env control tripped")
    print(f"scored records: {OUT}")


if __name__ == "__main__":
    main()
