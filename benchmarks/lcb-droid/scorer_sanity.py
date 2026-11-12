#!/usr/bin/env python3
"""Scorer sanity for the LCB-Droid smoke benchmark.

Validates the vendored LiveCodeBench fork's scoring path end to end on one
problem, per the repo's suite-validation rule:

- a known-good reference solution (a record the GVS5H paper scored as passed)
  must pass the hidden-test evaluation,
- a stub must fail it.

Runs the exact code path run_bench.py uses:
load_code_generation_dataset(release_v6) -> codegen_metrics(k_list=[1]).

Usage:
    scorer_sanity.py --problem-id arc196_b \
        [--reference-file code.py] [--gvs5h-checkout <dir>]

The reference comes either from an explicit file or from the published
q38-fn multiagent pass-1 record for the problem id in a GVS5H checkout.

Must be run with the scoring venv (datasets, numpy, lcb_runner installed).
"""

import argparse
import json
import sys
from pathlib import Path

FN_P1 = "runs/q38-fn-5pass/results/q38_fn_multiagent_p1.patched.json"


def load_problem(problem_id: str, release: str):
    from lcb_runner.benchmarks.code_generation import load_code_generation_dataset
    dataset = load_code_generation_dataset(release_version=release)
    by_id = {p.question_id: p for p in dataset}
    if problem_id not in by_id:
        sys.exit(
            f"problem id {problem_id!r} not in {release}; "
            f"dataset has {len(by_id)} problems"
        )
    return by_id[problem_id]


def score(problem, codes) -> list:
    """Score each code against the same problem's hidden tests.

    codegen_metrics aligns generations with samples positionally, so the
    sample is repeated once per code (same as run_bench.py's per-problem
    call shape: one sample, one list of generations, k=1).
    """
    from lcb_runner.evaluation.compute_code_generation_metrics import codegen_metrics
    samples = [problem.get_evaluation_sample()] * len(codes)
    generations = [[c] for c in codes]
    _, results, _ = codegen_metrics(samples, generations, k_list=[1], num_process_evaluate=8)
    import numpy as np

    def passed(res0):
        if isinstance(res0, (list, tuple)):
            return bool(np.all(np.array(res0) > 0)) and len(res0) > 0
        return bool(res0)

    return [passed(results[i][0]) for i in range(len(codes))]


def reference_from_checkout(checkout: Path, problem_id: str) -> str:
    doc = json.loads((checkout / FN_P1).read_text())
    for rec in doc["lcb"]["records"]:
        if rec["question_id"] == problem_id:
            if not rec.get("passed"):
                sys.exit(f"published record for {problem_id} did not pass; not a reference")
            return rec["code"]
    sys.exit(f"no published record for {problem_id} in {FN_P1}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--problem-id", default="arc196_b")
    ap.add_argument("--release", default="release_v6")
    ap.add_argument("--reference-file", default=None)
    ap.add_argument("--gvs5h-checkout", default=None,
                    help="GVS5H checkout to pull a known-good reference from")
    args = ap.parse_args()

    if args.reference_file:
        reference = Path(args.reference_file).read_text()
    elif args.gvs5h_checkout:
        reference = reference_from_checkout(Path(args.gvs5h_checkout), args.problem_id)
    else:
        sys.exit("need --reference-file or --gvs5h-checkout")

    stub = "print('stub')\n"

    problem = load_problem(args.problem_id, args.release)
    print(f"problem {problem.question_id}: {len(problem.public_test_cases)} public, "
          f"hidden tests in evaluation sample", flush=True)

    ref_pass, stub_pass = score(problem, [reference, stub])

    print(f"reference: {'PASS' if ref_pass else 'FAIL'}")
    print(f"stub:      {'PASS' if stub_pass else 'FAIL'}")

    if ref_pass and not stub_pass:
        print("SCORER_SANE")
        return 0
    print("SCORER_BROKEN")
    return 1


if __name__ == "__main__":
    sys.exit(main())
