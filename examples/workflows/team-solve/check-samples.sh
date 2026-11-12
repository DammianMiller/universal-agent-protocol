#!/usr/bin/env bash
# Sample harness for team-solve: run solution.py against every tests/N.in and
# compare with tests/N.out.
#
#   default  : print per-sample results, ALWAYS exit 0 — this is the `test`
#              step: evidence for the reviewer, never a run-killer.
#   --strict : exit 1 when any sample fails — this is the `verify` step, the
#              run's verdict. The score is what the harness says, never what
#              a model claims.
set -u
strict=0
[ "${1:-}" = "--strict" ] && strict=1

if [ ! -f solution.py ]; then
  echo "MISSING solution.py — nothing to test"
  [ "$strict" = 1 ] && exit 1
  exit 0
fi

pass=0
fail=0
found=0
for input in tests/*.in; do
  [ -e "$input" ] || continue
  found=$((found + 1))
  n=$(basename "$input" .in)
  expected=$(cat "tests/$n.out")
  actual=$(python3 solution.py < "$input" 2>&1)
  if [ "$actual" = "$expected" ]; then
    echo "sample $n: PASS"
    pass=$((pass + 1))
  else
    echo "sample $n: FAIL"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    fail=$((fail + 1))
  fi
done

if [ "$found" = 0 ]; then
  echo "no tests found under tests/"
  [ "$strict" = 1 ] && exit 1
  exit 0
fi

echo "samples: $pass pass, $fail fail (of $found)"
if [ "$strict" = 1 ] && [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
