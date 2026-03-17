#!/usr/bin/env python3
"""
UAP Tool Call Reliability Test Suite

Model-agnostic test suite for tool calling reliability across different
scenarios. Uses model profiles for model-specific tuning.

Tests:
1. Single tool call with per-tool choice
2. Two parallel tool calls
3. Three parallel tool calls
4. Five parallel tool calls (stress test)
5. Reasoning content suppression
6. Invalid format recovery via escalation

Usage:
    python3 tool_call_test.py [--verbose] [--output results.json] [--profile qwen35]
"""

import sys
import time
import os
import argparse
import logging
from pathlib import Path
from typing import List, Dict, Any, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime
import json

# Add script directory to path for imports (works regardless of cwd)
_script_dir = str(Path(__file__).resolve().parent)
if _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)

try:
    from tool_call_wrapper import ToolCallClient, ToolCallError
except ImportError as _e1:
    try:
        # Fall back to legacy name
        from qwen_tool_call_wrapper import (
            Qwen35ToolCallClient as ToolCallClient,
            Qwen35ToolCallError as ToolCallError,
        )
    except ImportError as _e2:
        print(f"Error: Failed to import tool_call_wrapper")
        print(f"  Primary import error: {_e1}")
        print(f"  Legacy import error:  {_e2}")
        print(f"  Script directory: {_script_dir}")
        print(f"  sys.path: {sys.path[:5]}")
        print()
        print("  Fix: pip install openai  (if missing dependency)")
        print("  Or:  run from tools/agents/scripts/")
        sys.exit(1)

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("uap_tool_test")


@dataclass
class TestResult:
    """Result of a single test"""

    test_name: str
    success: bool
    latency_ms: float
    attempts: int
    tool_calls_received: int = 0
    tool_calls_expected: int = 0
    error: str = ""


@dataclass
class TestSummary:
    """Summary of test results"""

    total_tests: int
    passed_tests: int
    failed_tests: int
    results: List[TestResult]

    @property
    def success_rate(self) -> float:
        if self.total_tests == 0:
            return 0.0
        return self.passed_tests / self.total_tests * 100


class ToolCallTestSuite:
    """Test suite for tool calling reliability"""

    def __init__(self, client: ToolCallClient, verbose: bool = False):
        self.client = client
        self.verbose = verbose
        self.results: List[TestResult] = []

        # Define test tools
        self.tools = [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read file contents from specified path",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Absolute file path",
                            }
                        },
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "calculate",
                    "description": "Perform mathematical calculation",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "operation": {
                                "type": "string",
                                "enum": ["add", "subtract", "multiply", "divide"],
                            },
                            "a": {"type": "number"},
                            "b": {"type": "number"},
                        },
                        "required": ["operation", "a", "b"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_system_info",
                    "description": "Get system information",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "info_type": {
                                "type": "string",
                                "enum": ["cpu", "memory", "disk", "all"],
                            }
                        },
                        "required": ["info_type"],
                    },
                },
            },
        ]

    def run_test(
        self,
        test_name: str,
        messages: List[Dict],
        expected_tool_calls: int = 1,
        expected_tool: str = None,
        timeout: int = 60,
    ) -> TestResult:
        """Run a single test with multi-turn accumulation.

        For servers that emit one tool call per response (e.g. llama.cpp with
        GBNF grammar), this accumulates tool calls across multiple turns by
        feeding synthetic tool results back into the conversation.
        """
        start_time = time.time()
        attempts = 0
        success = False
        error = ""
        latency_ms = 0
        tool_calls_received = 0

        try:
            # Multi-turn accumulation: collect tool calls across turns
            current_messages = [m.copy() for m in messages]
            collected_tool_names: List[str] = []
            max_turns = expected_tool_calls + 2  # Allow extra turns for convergence

            for turn in range(max_turns):
                attempts += 1

                response = self.client.chat_with_tools(
                    messages=current_messages,
                    tools=self.tools,
                    timeout=timeout,
                    expected_tool=expected_tool if turn == 0 else None,
                    expected_tool_calls=expected_tool_calls,
                )

                tool_calls = response.choices[0].message.tool_calls
                turn_count = len(tool_calls) if tool_calls else 0

                if tool_calls:
                    for tc in tool_calls:
                        collected_tool_names.append(tc.function.name)

                    tool_calls_received = len(collected_tool_names)

                    # Check if we have enough
                    if tool_calls_received >= expected_tool_calls:
                        success = True
                        break

                    # Feed synthetic tool results back for next turn
                    # Add assistant message with tool calls
                    current_messages.append(
                        {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": tc.id,
                                    "type": "function",
                                    "function": {
                                        "name": tc.function.name,
                                        "arguments": tc.function.arguments,
                                    },
                                }
                                for tc in tool_calls
                            ],
                        }
                    )

                    # Add synthetic tool results
                    for tc in tool_calls:
                        current_messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc.id,
                                "content": json.dumps(
                                    {
                                        "status": "ok",
                                        "result": f"mock result for {tc.function.name}",
                                    }
                                ),
                            }
                        )
                else:
                    # No tool calls returned - model is done
                    break

                if self.verbose and not success:
                    logger.info(
                        f"Test '{test_name}' turn {turn + 1}: "
                        f"collected {tool_calls_received}/{expected_tool_calls} tool calls"
                    )

            latency_ms = (time.time() - start_time) * 1000

        except ToolCallError as e:
            error = str(e)
            latency_ms = (time.time() - start_time) * 1000
            if self.verbose:
                logger.error(f"Test '{test_name}' failed: {error}")

        result = TestResult(
            test_name=test_name,
            success=success,
            latency_ms=latency_ms,
            attempts=attempts,
            tool_calls_received=tool_calls_received,
            tool_calls_expected=expected_tool_calls,
            error=error,
        )

        self.results.append(result)

        status = "PASS" if success else "FAIL"
        tc_info = f"{tool_calls_received}/{expected_tool_calls} calls"
        logger.info(
            f"{status} - {test_name} ({latency_ms:.0f}ms, {attempts} attempt(s), {tc_info})"
        )

        return result

    def test_single_tool_call(self) -> TestResult:
        """Test 1: Single tool call with per-tool choice"""
        return self.run_test(
            "Single Tool Call (per-tool choice)",
            [{"role": "user", "content": "Read file at /etc/hostname"}],
            expected_tool_calls=1,
            expected_tool="read_file",
        )

    def test_two_consecutive_tool_calls(self) -> TestResult:
        """Test 2: Two parallel tool calls"""
        return self.run_test(
            "Two Parallel Tool Calls",
            [{"role": "user", "content": "Read /etc/hostname and calculate 5 + 3"}],
            expected_tool_calls=2,
        )

    def test_three_tool_calls(self) -> TestResult:
        """Test 3: Three parallel tool calls"""
        return self.run_test(
            "Three Parallel Tool Calls",
            [
                {
                    "role": "user",
                    "content": "Read /etc/hostname, calculate 10 * 5, and get system info for cpu",
                }
            ],
            expected_tool_calls=3,
        )

    def test_five_tool_calls(self) -> TestResult:
        """Test 4: Five parallel tool calls (stress test)"""
        return self.run_test(
            "Five Tool Calls (Stress)",
            [
                {
                    "role": "user",
                    "content": (
                        "Perform all of these operations:\n"
                        "1. Read /etc/hostname\n"
                        "2. Calculate 100 / 4\n"
                        "3. Calculate 7 * 8\n"
                        "4. Get system info for memory\n"
                        "5. Get system info for disk"
                    ),
                }
            ],
            expected_tool_calls=5,
        )

    def test_with_reasoning_content(self) -> TestResult:
        """Test 5: Thinking mode disabled, tool call still works"""
        messages = [
            {"role": "system", "content": "Think step by step before answering"},
            {"role": "user", "content": "Read /etc/hosts"},
        ]

        return self.run_test(
            "Reasoning Content Test",
            messages,
            expected_tool_calls=1,
            expected_tool="read_file",
        )

    def test_invalid_tool_format_recovery(self) -> TestResult:
        """Test 6: Recovery from invalid format via escalation"""
        return self.run_test(
            "Invalid Format Recovery (escalation)",
            [{"role": "user", "content": "Call read_file with path /test.txt"}],
            expected_tool_calls=1,
            expected_tool="read_file",
        )

    def run_all_tests(self) -> TestSummary:
        """Run all tests"""
        profile = getattr(self.client, "profile_name", "unknown")
        logger.info("=" * 70)
        logger.info("UAP Tool Call Reliability Test Suite")
        logger.info("=" * 70)
        logger.info(f"Profile: {profile}")
        logger.info(f"Model: {self.client.config['model']}")
        logger.info(f"Base URL: {self.client.config['base_url']}")
        logger.info(f"Temperature: {self.client.config['temperature']}")
        logger.info(f"Default tool_choice: {self.client.config['default_tool_choice']}")
        logger.info(f"parallel_tool_calls: {self.client.config['parallel_tool_calls']}")
        logger.info(
            f"Escalation: {self.client.config.get('escalate_tool_choice', False)}"
        )
        logger.info(
            f"Per-tool choice: {self.client.config.get('use_per_tool_choice', False)}"
        )
        logger.info("=" * 70)
        logger.info("")

        # Run tests
        tests = [
            self.test_single_tool_call,
            self.test_two_consecutive_tool_calls,
            self.test_three_tool_calls,
            self.test_five_tool_calls,
            self.test_with_reasoning_content,
            self.test_invalid_tool_format_recovery,
        ]

        for test in tests:
            test()
            if self.verbose:
                time.sleep(1)  # Small delay between tests

        # Calculate summary
        passed = sum(1 for r in self.results if r.success)
        failed = len(self.results) - passed

        summary = TestSummary(
            total_tests=len(self.results),
            passed_tests=passed,
            failed_tests=failed,
            results=self.results,
        )

        return summary

    def print_summary(self, summary: TestSummary):
        """Print test summary"""
        print("\n" + "=" * 70)
        print("TEST SUMMARY")
        print("=" * 70)
        print(f"Total Tests: {summary.total_tests}")
        print(f"Passed: {summary.passed_tests}")
        print(f"Failed: {summary.failed_tests}")
        print(f"Success Rate: {summary.success_rate:.1f}%")
        print("=" * 70)

        print("\nDetailed Results:")
        print("-" * 70)

        for result in summary.results:
            status = "PASS" if result.success else "FAIL"
            print(f"{status} {result.test_name}")
            print(
                f"       Latency: {result.latency_ms:.0f}ms | "
                f"Attempts: {result.attempts} | "
                f"Tool calls: {result.tool_calls_received}/{result.tool_calls_expected}"
            )
            if result.error:
                print(f"       Error: {result.error[:100]}...")
            print()

        print("-" * 70)

        # Performance analysis
        if summary.success_rate >= 90:
            print("EXCELLENT: Tool calling is highly reliable")
        elif summary.success_rate >= 70:
            print("GOOD: Tool calling is reliable with minor issues")
        elif summary.success_rate >= 50:
            print("NEEDS IMPROVEMENT: Apply template fixes and retry logic")
        else:
            print("CRITICAL: Tool calling is unreliable, review configuration")

        print("=" * 70)

        # Client metrics
        metrics = self.client.get_metrics()
        print("\nClient Metrics:")
        print(f"  Total Attempts: {metrics.total_attempts}")
        print(f"  Successful Calls: {metrics.successful_calls}")
        print(f"  Failed Calls: {metrics.failed_calls}")
        print(f"  Retries: {metrics.retries}")
        print(f"  Escalations: {metrics.tool_choice_escalations}")
        print(f"  Parallel Requested: {metrics.parallel_calls_requested}")
        print(f"  Parallel Received: {metrics.parallel_calls_received}")
        print(f"  Avg Latency: {metrics.avg_latency_ms:.0f}ms")
        print("=" * 70)

        return summary.success_rate >= 90

    def save_results(self, filename: str = None):
        """Save test results to JSON file"""
        if not filename:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"tool_call_test_results_{timestamp}.json"

        profile = getattr(self.client, "profile_name", "unknown")
        data = {
            "timestamp": datetime.now().isoformat(),
            "profile": profile,
            "model": self.client.config["model"],
            "strategies": {
                "tool_choice": self.client.config.get("default_tool_choice"),
                "parallel_tool_calls": self.client.config.get("parallel_tool_calls"),
                "escalation": self.client.config.get("escalate_tool_choice"),
                "per_tool_choice": self.client.config.get("use_per_tool_choice"),
                "batch_tool_calls": self.client.config.get("batch_tool_calls"),
                "dynamic_temperature": self.client.config.get("dynamic_temperature"),
                "suppress_thinking": self.client.config.get("suppress_thinking"),
            },
            "config": self.client.get_status(),
            "summary": {
                "total_tests": len(self.results),
                "passed_tests": sum(1 for r in self.results if r.success),
                "failed_tests": sum(1 for r in self.results if not r.success),
                "success_rate": sum(1 for r in self.results if r.success)
                / len(self.results)
                * 100
                if self.results
                else 0,
            },
            "results": [asdict(r) for r in self.results],
            "metrics": self.client.get_metrics().to_dict(),
        }

        with open(filename, "w") as f:
            json.dump(data, f, indent=2)

        logger.info(f"Results saved to: {filename}")


def run_setup_check(profile: str) -> bool:
    """Validate setup without requiring a running inference server."""
    print("=" * 70)
    print("UAP Tool Call Setup Check")
    print("=" * 70)
    print(f"\nProfile: {profile}")

    all_ok = True

    # Check 1: openai package
    try:
        import openai

        print(f"  [OK] openai package: {openai.__version__}")
    except ImportError:
        print("  [FAIL] openai package not installed")
        print("         Fix: pip install openai")
        all_ok = False

    # Check 2: tool_call_wrapper import
    try:
        from tool_call_wrapper import ToolCallClient as _TC

        print("  [OK] tool_call_wrapper: importable")
    except ImportError as e:
        print(f"  [FAIL] tool_call_wrapper: {e}")
        all_ok = False

    # Check 3: Profile config
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent.parent.parent
    profile_path = project_root / "config" / "model-profiles" / f"{profile}.json"
    if profile_path.exists():
        print(f"  [OK] Profile config: {profile_path.name}")
        try:
            with open(profile_path) as f:
                cfg = json.load(f)
            print(f"       Model: {cfg.get('model', '?')}")
            print(f"       Context: {cfg.get('context_window', '?')}")
        except Exception:
            pass
    else:
        legacy_path = project_root / "config" / f"{profile}-settings.json"
        if legacy_path.exists():
            print(f"  [OK] Profile config: {legacy_path.name} (legacy)")
        else:
            print(f"  [INFO] No profile config for '{profile}' (using defaults)")

    # Check 4: Inference server connectivity
    base_url = os.environ.get("TARGET_URL", "http://127.0.0.1:8080")
    try:
        import urllib.request

        req = urllib.request.Request(f"{base_url}/v1/models", method="GET")
        req.add_header("Connection", "close")
        with urllib.request.urlopen(req, timeout=3) as resp:
            print(f"  [OK] Inference server: {base_url} (status {resp.status})")
    except Exception as e:
        print(
            f"  [WARN] Inference server: {base_url} not reachable ({type(e).__name__})"
        )
        print("         Tests require a running inference server.")
        print(f"         Set TARGET_URL env var if server is on a different address.")

    # Check 5: Python scripts
    for script in [
        "tool_call_wrapper.py",
        "tool_call_test.py",
        "chat_template_verifier.py",
    ]:
        path = script_dir / script
        if path.exists():
            print(f"  [OK] Script: {script}")
        else:
            # Check legacy name
            legacy = {
                "tool_call_wrapper.py": "qwen_tool_call_wrapper.py",
                "tool_call_test.py": "qwen_tool_call_test.py",
                "chat_template_verifier.py": "fix_qwen_chat_template.py",
            }.get(script)
            if legacy and (script_dir / legacy).exists():
                print(f"  [OK] Script: {legacy} (legacy)")
            else:
                print(f"  [MISS] Script: {script}")

    print("\n" + "=" * 70)
    if all_ok:
        print("Setup check PASSED. Run without --check to execute tests.")
    else:
        print("Setup check FAILED. Fix the issues above before running tests.")
    print("=" * 70)
    return all_ok


def main():
    """Main test execution"""
    parser = argparse.ArgumentParser(description="UAP Tool Call Reliability Test")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument("--output", "-o", type=str, help="Output results to JSON file")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate setup without running tests (no server needed)",
    )
    parser.add_argument(
        "--profile",
        "-p",
        type=str,
        default=None,
        help="Model profile (default: auto-detect from UAP_MODEL_PROFILE env var)",
    )
    args = parser.parse_args()

    # Set profile from CLI arg if provided
    if args.profile:
        os.environ["UAP_MODEL_PROFILE"] = args.profile

    profile = os.environ.get("UAP_MODEL_PROFILE", "generic")

    # Setup check mode -- validate without needing a server
    if args.check:
        ok = run_setup_check(profile)
        sys.exit(0 if ok else 1)

    try:
        # Initialize client
        logger.info(f"Initializing tool call client (profile: {profile})...")
        client = ToolCallClient()

        # Create test suite
        test_suite = ToolCallTestSuite(client, verbose=args.verbose)

        # Run tests
        summary = test_suite.run_all_tests()

        # Print summary
        passed = test_suite.print_summary(summary)

        # Save results
        if args.output:
            test_suite.save_results(args.output)

        # Exit with appropriate code
        sys.exit(0 if passed else 1)

    except KeyboardInterrupt:
        print("\nTest interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Test failed with error: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
