#!/usr/bin/env bash
# SWE-bench Pro — paired UAP-uplift A/B.
#
# Runs `uap bench paired` with baseline (bare opencode+Qwen3.6) vs uap-full
# (same agent + full UAP surface) over a generated SWE-bench Pro suite, on the
# SAME seeds, then writes a paired report (Δ resolve-rate with CIs, McNemar 2x2).
#
# Prereqs (see suite.config.yaml): pip install swebench; Docker; opencode routing
# Qwen to the proxy :4000; `uap proxy` up; a SWE-bench Pro instances file.
#
# Usage:
#   ./run-ab.sh path/to/swe_bench_pro_public.jsonl            # full run
#   LIMIT=25 EPOCHS=3 ./run-ab.sh instances.jsonl             # quick smoke
#   ABLATION=1 ./run-ab.sh instances.jsonl                    # per-component ablation
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
instances="${1:?usage: run-ab.sh <swe-bench-pro-instances.jsonl>}"

MODEL="${UAP_BENCH_MODEL:-qwen36-a3b}"
EPOCHS="${EPOCHS:-5}"
CONCURRENCY="${CONCURRENCY:-4}"
LIMIT="${LIMIT:-0}"
ADAPTER="${ADAPTER:-opencode}"
SUITE_DIR="${SUITE_DIR:-$here/../swe-bench-pro-generated}"

# 1) Materialize the suite from SWE-bench Pro instances (idempotent).
gen_args=(--instances "$instances" --out "$SUITE_DIR" --shallow)
[ "$LIMIT" != "0" ] && gen_args+=(--limit "$LIMIT")
echo "▶ generating suite -> $SUITE_DIR"
python3 "$here/generate.py" "${gen_args[@]}"

# 2) Run the paired A/B. `uap` resolves to the repo CLI or the global install.
UAP_BIN="${UAP_BIN:-uap}"
bench_args=(bench paired
  --suite "$SUITE_DIR"
  --adapter "$ADAPTER"
  --model "$MODEL"
  --epochs "$EPOCHS"
  --concurrency "$CONCURRENCY"
  --lazy)                       # add the uap-lazy arm (bare-first, UAP on failure)
[ "${ABLATION:-0}" = "1" ] && bench_args+=(--ablation)

echo "▶ uap ${bench_args[*]}"
"$UAP_BIN" "${bench_args[@]}"

echo
echo "✓ done — report in benchmark-results/paired-<timestamp>/report.md"
echo "  Headline: paired Δ resolve-rate (uap-full − baseline) with 95% CI."
echo "  Reminder: report the split + scaffold; ≥5 seeds; verify Qwen numbers"
echo "            against the primary SWE-bench Pro leaderboard before publishing."
echo
echo "  External anchor (run separately for public comparability):"
echo "    uap bench paired --suite \"$SUITE_DIR\" --adapter mini --model \"$MODEL\" --epochs $EPOCHS"
