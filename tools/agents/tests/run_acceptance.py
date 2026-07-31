#!/usr/bin/env python3
"""Run all acceptance journeys for the plan gate."""
import os
import sys
import subprocess

# Journey 1: test_off_env
print("=== Journey 1: test_off_env ===")
r = subprocess.run(
    [sys.executable, "-c",
     "import os; os.environ['UAP_PLAN_VALIDATE_OFF']='1'; "
     "from tools.agents.tests.test_validate_plan_gate import TestValidatePlanGate; "
     "t=TestValidatePlanGate(); t.setUp(); t.test_plan_write_allow_pending_state()"],
    capture_output=True, text=True, cwd="/home/user",
)
print(f"stdout: {r.stdout}")
print(f"stderr: {r.stderr}")
print(f"exit code: {r.returncode}")
print()

# Journey 2: test_plan_write_records_pending
print("=== Journey 2: test_plan_write_records_pending ===")
r = subprocess.run(
    [sys.executable, "-c",
     "from tools.agents.tests.test_validate_plan_gate import TestValidatePlanGate; "
     "t=TestValidatePlanGate(); t.setUp(); t.test_plan_write_records_pending_state()"],
    capture_output=True, text=True, cwd="/home/user",
)
print(f"stdout: {r.stdout}")
print(f"stderr: {r.stderr}")
print(f"exit code: {r.returncode}")
print()

# Journey 3: test_build_blocked_pending
print("=== Journey 3: test_build_blocked_pending ===")
r = subprocess.run(
    [sys.executable, "-c",
     "from tools.agents.tests.test_validate_plan_gate import TestValidatePlanGate; "
     "t=TestValidatePlanGate(); t.setUp(); t.test_build_blocked_when_plan_pending()"],
    capture_output=True, text=True, cwd="/home/user",
)
print(f"stdout: {r.stdout}")
print(f"stderr: {r.stderr}")
print(f"exit code: {r.returncode}")
print()

# Journey 4: test_build_allowed_clean
print("=== Journey 4: test_build_allowed_clean ===")
r = subprocess.run(
    [sys.executable, "-c",
     "from tools.agents.tests.test_validate_plan_gate import TestValidatePlanGate; "
     "t=TestValidatePlanGate(); t.setUp(); t.test_build_allowed_when_clean()"],
    capture_output=True, text=True, cwd="/home/user",
)
print(f"stdout: {r.stdout}")
print(f"stderr: {r.stderr}")
print(f"exit code: {r.returncode}")
print()

# Journey 5: test_drift_detection
print("=== Journey 5: test_drift_detection ===")
r = subprocess.run(
    [sys.executable, "-c",
     "from tools.agents.tests.test_validate_plan_gate import TestValidatePlanGate; "
     "t=TestValidatePlanGate(); t.setUp(); t.test_build_blocked_on_drift()"],
    capture_output=True, text=True, cwd="/home/user",
)
print(f"stdout: {r.stdout}")
print(f"stderr: {r.stderr}")
print(f"exit code: {r.returncode}")
print()

# Journey 6: test_non_build_allowed
print("=== Journey 6: test_non_build_allowed ===")
r = subprocess.run(
    [sys.executable, "-c",
     "from tools.agents.tests.test_validate_plan_gate import TestValidatePlanGate; "
     "t=TestValidatePlanGate(); t.setUp(); t.test_non_build_commands_allowed()"],
    capture_output=True, text=True, cwd="/home/user",
)
print(f"stdout: {r.stdout}")
print(f"stderr: {r.stderr}")
print(f"exit code: {r.returncode}")