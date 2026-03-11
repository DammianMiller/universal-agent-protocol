#!/usr/bin/env python3
"""
Qwen3.5 Tool Call Reliability Test Suite

Tests tool calling reliability across different scenarios:
1. Single tool call (baseline)
2. Multiple consecutive tool calls
3. Long context scenarios
4. With and without template fixes

Usage:
    python3 qwen_tool_call_test.py [--verbose] [--iterations N]
"""

import sys
import time
import argparse
import logging
from pathlib import Path
from typing import List, Dict, Any, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime
import json

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

try:
    from qwen_tool_call_wrapper import Qwen35ToolCallClient, Qwen35ToolCallError
except ImportError:
    print("❌ Error: qwen_tool_call_wrapper.py not found")
    print("   Run from: tools/agents/")
    sys.exit(1)

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("qwen35_test")


@dataclass
class TestResult:
    """Result of a single test"""

    test_name: str
    success: bool
    latency_ms: float
    attempts: int
    error: str = None


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


class Qwen35TestSuite:
    """Test suite for Qwen3.5 tool calling reliability"""

    def __init__(self, client: Qwen35ToolCallClient, verbose: bool = False):
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
        timeout: int = 60,
    ) -> TestResult:
        """Run a single test"""
        start_time = time.time()
        attempts = 0
        success = False
        error = None
        latency_ms = 0

        try:
            for attempt in range(3):  # Allow up to 3 attempts per test
                attempts += 1

                response = self.client.chat_with_tools(
                    messages=messages, tools=self.tools, timeout=timeout
                )

                tool_calls = response.choices[0].message.tool_calls

                if tool_calls and len(tool_calls) >= expected_tool_calls:
                    success = True
                    break
                else:
                    if self.verbose:
                        logger.warning(
                            f"Test '{test_name}' attempt {attempt + 1}: "
                            f"Expected {expected_tool_calls} tool calls, "
                            f"got {len(tool_calls) if tool_calls else 0}"
                        )

            latency_ms = (time.time() - start_time) * 1000

        except Qwen35ToolCallError as e:
            error = str(e)
            latency_ms = (time.time() - start_time) * 1000
            if self.verbose:
                logger.error(f"Test '{test_name}' failed: {error}")

        result = TestResult(
            test_name=test_name,
            success=success,
            latency_ms=latency_ms,
            attempts=attempts,
            error=error,
        )

        self.results.append(result)

        status = "✅ PASS" if success else "❌ FAIL"
        logger.info(
            f"{status} - {test_name} ({latency_ms:.0f}ms, {attempts} attempt(s))"
        )

        return result

    def test_single_tool_call(self) -> TestResult:
        """Test 1: Single tool call (baseline)"""
        return self.run_test(
            "Single Tool Call",
            [{"role": "user", "content": "Read file at /etc/hostname"}],
            expected_tool_calls=1,
        )

    def test_two_consecutive_tool_calls(self) -> TestResult:
        """Test 2: Two consecutive tool calls"""
        return self.run_test(
            "Two Consecutive Tool Calls",
            [{"role": "user", "content": "Read /etc/hostname and calculate 5 + 3"}],
            expected_tool_calls=2,
        )

    def test_three_tool_calls(self) -> TestResult:
        """Test 3: Three consecutive tool calls"""
        return self.run_test(
            "Three Tool Calls",
            [
                {
                    "role": "user",
                    "content": "Read /etc/hostname, calculate 10 * 5, and get system info for cpu",
                }
            ],
            expected_tool_calls=3,
        )

    def test_five_tool_calls(self) -> TestResult:
        """Test 4: Five consecutive tool calls (stress test)"""
        return self.run_test(
            "Five Tool Calls (Stress)",
            [
                {
                    "role": "user",
                    "content": """
                Read /etc/hostname
                Calculate 100 / 4
                Calculate 7 * 8
                Get system info for memory
                Get system info for disk
                """,
                }
            ],
            expected_tool_calls=5,
        )

    def test_with_reasoning_content(self) -> TestResult:
        """Test 5: Test that reasoning content doesn't interfere"""
        # This test verifies the thinking mode is disabled
        messages = [
            {"role": "system", "content": "Think step by step before answering"},
            {"role": "user", "content": "Read /etc/hosts"},
        ]

        return self.run_test("Reasoning Content Test", messages, expected_tool_calls=1)

    def test_invalid_tool_format_recovery(self) -> TestResult:
        """Test 6: Recovery from invalid tool format"""
        # This tests the retry logic
        return self.run_test(
            "Invalid Format Recovery",
            [{"role": "user", "content": "Call read_file with path /test.txt"}],
            expected_tool_calls=1,
        )

    def run_all_tests(self) -> TestSummary:
        """Run all tests"""
        logger.info("=" * 70)
        logger.info("Qwen3.5 Tool Call Reliability Test Suite")
        logger.info("=" * 70)
        logger.info(f"Model: {self.client.config['model']}")
        logger.info(f"Base URL: {self.client.config['base_url']}")
        logger.info(f"Temperature: {self.client.config['temperature']}")
        logger.info(f"Thinking Mode: {self.client.config['enable_thinking']}")
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
            status = "✅ PASS" if result.success else "❌ FAIL"
            print(f"{status} {result.test_name}")
            print(
                f"       Latency: {result.latency_ms:.0f}ms | Attempts: {result.attempts}"
            )
            if result.error:
                print(f"       Error: {result.error[:100]}...")
            print()

        print("-" * 70)

        # Performance analysis
        if summary.success_rate >= 90:
            print("✅ EXCELLENT: Tool calling is highly reliable")
        elif summary.success_rate >= 70:
            print("⚠️  GOOD: Tool calling is reliable with minor issues")
        elif summary.success_rate >= 50:
            print("❌ NEEDS IMPROVEMENT: Apply template fixes and retry logic")
        else:
            print("❌ CRITICAL: Tool calling is unreliable, review configuration")

        print("=" * 70)

        # Client metrics
        metrics = self.client.get_metrics()
        print("\nClient Metrics:")
        print(f"  Total Attempts: {metrics.total_attempts}")
        print(f"  Successful Calls: {metrics.successful_calls}")
        print(f"  Failed Calls: {metrics.failed_calls}")
        print(f"  Retries: {metrics.retries}")
        print(f"  Avg Latency: {metrics.avg_latency_ms:.0f}ms")
        print("=" * 70)

        return summary.success_rate >= 90

    def save_results(self, filename: str = None):
        """Save test results to JSON file"""
        if not filename:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"qwen35_test_results_{timestamp}.json"

        data = {
            "timestamp": datetime.now().isoformat(),
            "model": self.client.config["model"],
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
        }

        with open(filename, "w") as f:
            json.dump(data, f, indent=2)

        logger.info(f"Results saved to: {filename}")


def main():
    """Main test execution"""
    parser = argparse.ArgumentParser(description="Qwen3.5 Tool Call Reliability Test")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument("--output", "-o", type=str, help="Output results to JSON file")
    args = parser.parse_args()

    try:
        # Initialize client
        logger.info("Initializing Qwen3.5 tool call client...")
        client = Qwen35ToolCallClient()

        # Create test suite
        test_suite = Qwen35TestSuite(client, verbose=args.verbose)

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
        print("\n❌ Test interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Test failed with error: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
