#!/usr/bin/env python3
"""
UAP Tool Call Wrapper with Retry Logic

Model-agnostic OpenAI-compatible tool calling client with automatic retry
on failures, addressing common issues with local and hosted models.

Strategies implemented:
1. tool_choice="required" + parallel_tool_calls=true in API requests
2. Improved multi-tool system prompt with explicit format guidance
3. Retry escalation: auto -> required -> required+lower temp
4. Per-tool tool_choice for single-tool scenarios
5. Thinking mode suppression via chat_template_kwargs
6. Dynamic temperature decay on retries

Model Profiles:
  Set UAP_MODEL_PROFILE env var to load model-specific defaults.
  Supported profiles: qwen35, llama, generic (default)
  Or pass a custom config dict to override any setting.

Usage:
    from tool_call_wrapper import ToolCallClient

    client = ToolCallClient()
    response = client.chat_with_tools(
        messages=[{"role": "user", "content": "Call read_file with path='/etc/hosts'"}],
        tools=[...]
    )

    # With explicit model profile
    client = ToolCallClient(config={"model_profile": "qwen35"})

Backward Compatibility:
    # Legacy names still work
    from tool_call_wrapper import Qwen35ToolCallClient  # alias for ToolCallClient
"""

try:
    import openai
except ImportError:
    raise ImportError(
        "The 'openai' package is required but not installed.\n"
        "Install it with: pip install openai\n"
        "Or: pip install -r requirements.txt"
    )

import time
import json
import os
import logging
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime
from enum import Enum
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("uap_tool_call")


# ── Model Profiles ──────────────────────────────────────────────────────────

MODEL_PROFILES: Dict[str, Dict[str, Any]] = {
    "generic": {
        "temperature": 0.6,
        "top_p": 0.9,
        "presence_penalty": 0.0,
        "max_tokens": 4096,
        "enable_thinking": False,
        "model": "default",
        "base_url": "http://127.0.0.1:8080/v1",
        "api_key": "not-needed",
        "default_tool_choice": "auto",
        "parallel_tool_calls": True,
        "batch_tool_calls": True,
        "escalate_tool_choice": True,
        "use_per_tool_choice": True,
        "dynamic_temperature": True,
        "dynamic_temp_decay": 0.5,
        "dynamic_temp_floor": 0.2,
    },
    "qwen35": {
        "temperature": 0.3,
        "top_p": 0.9,
        "presence_penalty": 0.0,
        "max_tokens": 16384,
        "enable_thinking": True,
        "model": "qwen35-a3b-iq4xs",
        "base_url": "http://127.0.0.1:8080/v1",
        "api_key": "not-needed",
        "default_tool_choice": "required",
        "parallel_tool_calls": True,
        "batch_tool_calls": True,
        "escalate_tool_choice": True,
        "use_per_tool_choice": True,
        "dynamic_temperature": True,
        "dynamic_temp_decay": 0.5,
        "dynamic_temp_floor": 0.2,
        # Qwen-specific: thinking mode enabled for better reasoning and longer outputs
        # suppress_thinking sends chat_template_kwargs to control template behavior
        "suppress_thinking": True,
        "batch_system_prompt": (
            "CRITICAL: You MUST emit ALL tool calls in a SINGLE response. "
            "Each tool call must use the <tool_call><function=name><parameter=key>value</parameter></function></tool_call> format. "
            "Do NOT call one tool and wait - emit ALL tool calls together NOW. "
            "You must produce all required tool calls in one response. "
            "IMPORTANT: You MUST always produce visible output on every turn. "
            "Never respond with only internal reasoning and no external content. "
            "Always either use a tool or write a text response to the user."
        ),
    },
    "llama": {
        "temperature": 0.6,
        "top_p": 0.9,
        "presence_penalty": 0.0,
        "max_tokens": 4096,
        "enable_thinking": False,
        "model": "default",
        "base_url": "http://127.0.0.1:8080/v1",
        "api_key": "not-needed",
        "default_tool_choice": "auto",
        "parallel_tool_calls": True,
        "batch_tool_calls": True,
        "escalate_tool_choice": True,
        "use_per_tool_choice": True,
        "dynamic_temperature": True,
        "dynamic_temp_decay": 0.5,
        "dynamic_temp_floor": 0.2,
    },
}

# Default batch system prompt (used when batch_tool_calls is True and no profile-specific one)
DEFAULT_BATCH_SYSTEM_PROMPT = (
    "When multiple tools are needed, call ALL of them in a single response. "
    "Do not call one tool and wait for a response before calling the next."
)


def _load_profile(profile_name: str) -> Dict[str, Any]:
    """Load a model profile by name, falling back to generic."""
    base = MODEL_PROFILES.get("generic", {}).copy()
    profile = MODEL_PROFILES.get(profile_name, {})
    base.update(profile)
    return base


def _detect_profile() -> str:
    """Auto-detect model profile from environment."""
    return os.environ.get("UAP_MODEL_PROFILE", "generic")


# ── Core Classes ─────────────────────────────────────────────────────────────


class ToolCallStatus(Enum):
    """Status of tool call attempts"""

    SUCCESS = "success"
    FAILURE = "failure"
    RETRY = "retry"
    MAX_RETRIES = "max_retries"


@dataclass
class ToolCallMetrics:
    """Metrics for tool call performance"""

    total_attempts: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    retries: int = 0
    avg_latency_ms: float = 0.0
    last_error: Optional[str] = None
    tool_choice_escalations: int = 0
    parallel_calls_requested: int = 0
    parallel_calls_received: int = 0

    def to_dict(self) -> Dict:
        return asdict(self)


class ToolCallError(Exception):
    """Custom exception for tool call failures"""

    pass


class ToolCallClient:
    """
    OpenAI-compatible client for reliable tool calling with any model.

    Implements 6 strategies for maximum tool call reliability:
    1. tool_choice + parallel_tool_calls in every request
    2. Explicit multi-tool system prompt with format guidance
    3. Retry escalation: auto -> required -> required+lower temp
    4. Per-tool tool_choice for single-tool scenarios
    5. Thinking mode suppression (model-specific)
    6. Dynamic temperature decay on retries

    Supports model profiles for model-specific tuning.
    """

    DEFAULT_CONFIG = {
        "temperature": 0.6,
        "top_p": 0.9,
        "presence_penalty": 0.0,
        "max_tokens": 4096,
        "enable_thinking": False,
        "max_retries": 3,
        "backoff_factor": 1.0,
        "base_url": "http://127.0.0.1:8080/v1",
        "api_key": "not-needed",
        "model": "default",
        "default_tool_choice": "auto",
        "parallel_tool_calls": True,
        "batch_tool_calls": True,
        "batch_system_prompt": DEFAULT_BATCH_SYSTEM_PROMPT,
        "escalate_tool_choice": True,
        "use_per_tool_choice": True,
        "dynamic_temperature": True,
        "dynamic_temp_decay": 0.5,
        "dynamic_temp_floor": 0.2,
        "suppress_thinking": False,
    }

    def __init__(
        self, config: Optional[Dict[str, Any]] = None, enable_metrics: bool = True
    ):
        """
        Initialize tool call client.

        Args:
            config: Override default configuration. Can include "model_profile"
                    key to load a named profile as the base.
            enable_metrics: Enable performance metrics tracking
        """
        # Determine base config from profile
        user_config = config or {}
        profile_name = user_config.pop("model_profile", None) or _detect_profile()
        profile_config = _load_profile(profile_name)

        # Layer: defaults < profile < user overrides
        self.config = {**self.DEFAULT_CONFIG, **profile_config, **user_config}
        self.profile_name = profile_name
        self.enable_metrics = enable_metrics
        self.metrics = ToolCallMetrics()
        self._client = None

        # Initialize OpenAI client
        self._init_client()

        logger.info(
            f"ToolCallClient initialized (profile: {profile_name}, "
            f"model: {self.config['model']}, base_url: {self.config['base_url']})"
        )

    def _init_client(self):
        """Initialize OpenAI-compatible client"""
        try:
            self._client = openai.Client(
                base_url=self.config["base_url"], api_key=self.config["api_key"]
            )
            logger.info(f"Connected to {self.config['base_url']}")
        except Exception as e:
            logger.error(f"Failed to initialize OpenAI client: {e}")
            raise ToolCallError(f"Client initialization failed: {e}")

    def _get_tool_choice(
        self,
        tools: List[Dict[str, Any]],
        attempt: int,
        expected_tool: Optional[str] = None,
    ) -> Any:
        """
        Determine tool_choice based on strategy and attempt number.

        Strategy 3 (escalation):
          - Attempt 0: use default_tool_choice (usually "required")
          - Attempt 1+: escalate to "required" (no-op if already required)

        Strategy 5 (per-tool):
          - If expected_tool is set and only one tool matches, use per-tool choice
        """
        # Strategy 5: Per-tool choice for single expected tool
        if expected_tool and self.config.get("use_per_tool_choice") and attempt == 0:
            for tool in tools:
                func = tool.get("function", {})
                if func.get("name") == expected_tool:
                    logger.debug(f"Using per-tool choice: {expected_tool}")
                    return {
                        "type": "function",
                        "function": {"name": expected_tool},
                    }

        # Strategy 3: Escalation on retries
        if attempt > 0 and self.config.get("escalate_tool_choice"):
            self.metrics.tool_choice_escalations += 1
            logger.info(f"Escalating tool_choice to 'required' (attempt {attempt + 1})")
            return "required"

        return self.config.get("default_tool_choice", "auto")

    def chat_with_tools(
        self,
        messages: List[Dict[str, str]],
        tools: List[Dict[str, Any]],
        max_retries: Optional[int] = None,
        timeout: int = 120,
        expected_tool: Optional[str] = None,
        expected_tool_calls: Optional[int] = None,
        **kwargs,
    ) -> openai.types.chat.ChatCompletion:
        """
        Chat completion with automatic retry on tool call failures.

        Implements all 6 strategies for reliable tool calling.

        Args:
            messages: List of chat messages
            tools: List of tool definitions
            max_retries: Override default max retries
            timeout: Request timeout in seconds
            expected_tool: If set, use per-tool tool_choice (Strategy 5)
            expected_tool_calls: Expected number of tool calls (for validation)
            **kwargs: Additional parameters passed to OpenAI API

        Returns:
            ChatCompletion response with tool calls

        Raises:
            ToolCallError: After max retries exhausted
        """
        max_retries = max_retries or self.config["max_retries"]

        # Track timing
        start_time = time.time()

        # Make a copy of messages to avoid modifying original
        current_messages = [msg.copy() for msg in messages]

        # Strategy 2: Inject multi-tool system prompt (only when multiple tool calls expected)
        if (
            self.config.get("batch_tool_calls")
            and expected_tool_calls
            and expected_tool_calls > 1
        ):
            batch_prompt = self.config.get(
                "batch_system_prompt", DEFAULT_BATCH_SYSTEM_PROMPT
            )
            if batch_prompt:
                has_system = any(m.get("role") == "system" for m in current_messages)
                if has_system:
                    for m in current_messages:
                        if m.get("role") == "system":
                            m["content"] = m["content"] + "\n\n" + batch_prompt
                            break
                else:
                    current_messages.insert(
                        0,
                        {"role": "system", "content": batch_prompt},
                    )

        # Track parallel call expectations
        if expected_tool_calls and expected_tool_calls > 1:
            self.metrics.parallel_calls_requested += 1

        # Base temperature for dynamic adjustment
        base_temperature = self.config["temperature"]

        for attempt in range(max_retries):
            self.metrics.total_attempts += 1

            # Strategy 6: Dynamic temperature - reduce on retries
            if self.config.get("dynamic_temperature") and attempt > 0:
                decay = self.config.get("dynamic_temp_decay", 0.5)
                floor = self.config.get("dynamic_temp_floor", 0.2)
                current_temp = max(floor, base_temperature * (decay**attempt))
                logger.info(
                    f"Dynamic temperature: {current_temp:.2f} (attempt {attempt + 1})"
                )
            else:
                current_temp = base_temperature

            # Strategy 1 + 3 + 5: Determine tool_choice
            tool_choice = self._get_tool_choice(tools, attempt, expected_tool)

            try:
                # Build request with all strategies applied
                request_params = {
                    "model": self.config["model"],
                    "messages": current_messages,
                    "tools": tools,
                    "tool_choice": tool_choice,
                    "parallel_tool_calls": self.config.get("parallel_tool_calls", True),
                    "temperature": current_temp,
                    "top_p": self.config["top_p"],
                    "presence_penalty": self.config["presence_penalty"],
                    "max_tokens": self.config["max_tokens"],
                    "timeout": timeout,
                    **kwargs,
                }

                # Strategy 5: Thinking mode suppression (model-specific)
                if self.config.get("suppress_thinking"):
                    request_params["extra_body"] = {
                        "chat_template_kwargs": {
                            "enable_thinking": self.config.get("enable_thinking", False)
                        }
                    }
                    # Version check: llama.cpp >= 3761 supports chat_template_kwargs
                    # Older versions will ignore unknown extra_body keys
                    logger.debug(
                        f"Sending chat_template_kwargs with enable_thinking={self.config.get('enable_thinking', False)}"
                    )

                logger.debug(
                    f"Attempt {attempt + 1}/{max_retries}: "
                    f"tool_choice={tool_choice}, temp={current_temp:.2f}, "
                    f"parallel={self.config.get('parallel_tool_calls', True)}"
                )

                # Make API call
                response = self._client.chat.completions.create(**request_params)

                # Validate response
                tool_calls = response.choices[0].message.tool_calls

                if self._validate_tool_call(tool_calls):
                    # Success!
                    self.metrics.successful_calls += 1

                    # Track parallel call success
                    if tool_calls and len(tool_calls) > 1:
                        self.metrics.parallel_calls_received += 1

                    # Calculate latency
                    latency_ms = (time.time() - start_time) * 1000
                    self.metrics.avg_latency_ms = latency_ms

                    logger.info(
                        f"Tool call successful after {attempt + 1} attempt(s): "
                        f"{len(tool_calls)} call(s)"
                    )
                    return response
                else:
                    # Invalid format, retry with correction
                    logger.warning(f"Invalid tool call format on attempt {attempt + 1}")
                    current_messages = self._correct_prompt(current_messages, response)
                    self.metrics.retries += 1

                    if attempt < max_retries - 1:
                        # Exponential backoff
                        backoff = self.config["backoff_factor"] ** attempt
                        time.sleep(backoff)
                        logger.info(f"Retrying in {backoff:.1f}s...")

            except Exception as e:
                self.metrics.last_error = str(e)
                logger.error(f"Error on attempt {attempt + 1}: {e}")

                if attempt == max_retries - 1:
                    # Last attempt failed
                    self.metrics.failed_calls += 1
                    raise ToolCallError(
                        f"Failed after {max_retries} attempts: {str(e)}"
                    )

                # Retry with backoff
                backoff = self.config["backoff_factor"] ** attempt
                time.sleep(backoff)

        # Should not reach here, but just in case
        self.metrics.failed_calls += 1
        raise ToolCallError("Max retries exceeded")

    def _validate_tool_call(self, tool_calls) -> bool:
        """
        Validate that tool call has correct format.

        Checks for:
        - Non-empty tool calls list
        - Valid function name
        - Parseable JSON arguments
        - No reasoning content leakage (<thinking>/<think> tags in arguments)
        """
        if not tool_calls:
            logger.debug("No tool calls returned")
            return False

        for tool_call in tool_calls:
            # Check function name exists
            if not tool_call.function or not tool_call.function.name:
                logger.debug("Tool call missing function name")
                return False

            # Check arguments are present
            arguments = tool_call.function.arguments
            if not arguments:
                logger.debug("Tool call missing arguments")
                return False

            # Check for thinking/reasoning tag leakage in arguments
            # This affects models with reasoning modes (Qwen3, DeepSeek, etc.)
            for tag in ["<thinking>", "</thinking>", "<think>", "</think>"]:
                if tag in arguments:
                    logger.debug(f"Reasoning tag leakage detected: {tag}")
                    return False

            # Validate arguments are parseable JSON
            try:
                parsed = json.loads(arguments)
                if not isinstance(parsed, dict):
                    logger.debug(f"Arguments not a JSON object: {type(parsed)}")
                    return False
            except (json.JSONDecodeError, TypeError) as e:
                logger.debug(f"Arguments not valid JSON: {e}")
                return False

        return True

    def _correct_prompt(
        self, messages: List[Dict], response: openai.types.chat.ChatCompletion
    ) -> List[Dict]:
        """
        Correct prompt after invalid tool call.

        Appends correction message to guide model toward proper format.
        """
        invalid_content = response.choices[0].message.content or ""

        # Add assistant's failed attempt
        messages.append(
            {
                "role": "assistant",
                "content": f"I attempted a tool call but the format was invalid: "
                f"{invalid_content[:200]}",
            }
        )

        # Add user correction with format guidance matching the chat template
        messages.append(
            {
                "role": "user",
                "content": "Please call the tool using the correct format. "
                "You must use the tool calling interface - respond with a tool call, "
                "not with text describing the call. "
                "Use <tool_call> tags with a JSON object containing 'name' and 'arguments' keys.",
            }
        )

        return messages

    def execute_tool_call(
        self, tool_calls: List, tool_functions: Dict[str, callable]
    ) -> List[Any]:
        """
        Execute tool calls and collect results.

        Args:
            tool_calls: List of tool call objects from response
            tool_functions: Dict mapping tool names to functions

        Returns:
            List of tool results
        """
        results = []

        for tool_call in tool_calls:
            tool_name = tool_call.function.name
            tool_args = json.loads(tool_call.function.arguments)

            logger.info(f"Executing tool: {tool_name} with args: {tool_args}")

            if tool_name not in tool_functions:
                results.append(
                    {
                        "tool_name": tool_name,
                        "status": "error",
                        "error": f"Tool '{tool_name}' not found",
                    }
                )
                continue

            try:
                result = tool_functions[tool_name](**tool_args)
                results.append(
                    {"tool_name": tool_name, "status": "success", "result": result}
                )
            except Exception as e:
                results.append(
                    {"tool_name": tool_name, "status": "error", "error": str(e)}
                )

        return results

    def get_metrics(self) -> ToolCallMetrics:
        """Get current metrics"""
        return self.metrics

    def reset_metrics(self):
        """Reset metrics counters"""
        self.metrics = ToolCallMetrics()
        logger.info("Metrics reset")

    def get_status(self) -> Dict:
        """Get client status"""
        return {
            "profile": self.profile_name,
            "model": self.config["model"],
            "base_url": self.config["base_url"],
            "metrics": self.metrics.to_dict(),
            "config": {
                k: v for k, v in self.config.items() if k not in ["base_url", "api_key"]
            },
        }


class ToolCallAgent:
    """
    Higher-level agent for tool calling workflows.

    Combines tool calling with execution and result handling.
    Works with any OpenAI-compatible model.

    Args:
        tool_definitions: List of OpenAI-format tool definitions (for the API)
        tool_implementations: Dict mapping tool names to callable functions (for execution)
        client_config: Configuration for tool call client
    """

    def __init__(
        self,
        tool_definitions: List[Dict[str, Any]],
        tool_implementations: Dict[str, callable],
        client_config: Optional[Dict] = None,
    ):
        self.tool_definitions = tool_definitions
        self.tool_implementations = tool_implementations
        self.client = ToolCallClient(client_config)

        logger.info(
            f"ToolCallAgent initialized with {len(tool_definitions)} tools: "
            f"{list(tool_implementations.keys())}"
        )

    def run(
        self,
        user_query: str,
        additional_messages: Optional[List[Dict]] = None,
        expected_tool: Optional[str] = None,
    ) -> Tuple[openai.types.chat.ChatCompletion, List[Any]]:
        """
        Run a complete tool calling workflow.

        Args:
            user_query: User's input query
            additional_messages: Optional additional conversation history
            expected_tool: If set, use per-tool tool_choice

        Returns:
            Tuple of (ChatCompletion response, List of tool results)
        """
        # Build messages
        messages = []

        if additional_messages:
            messages.extend(additional_messages)

        messages.append({"role": "user", "content": user_query})

        # Make tool call request (pass definitions to API)
        response = self.client.chat_with_tools(
            messages=messages,
            tools=self.tool_definitions,
            expected_tool=expected_tool,
        )

        # Execute tool calls (pass implementations for execution)
        tool_calls = response.choices[0].message.tool_calls

        if tool_calls:
            results = self.client.execute_tool_call(
                tool_calls, self.tool_implementations
            )
        else:
            results = []

        return response, results

    def get_status(self) -> Dict:
        """Get agent status"""
        return {
            "tools": list(self.tool_implementations.keys()),
            "client_status": self.client.get_status(),
        }


# ── Backward Compatibility Aliases ──────────────────────────────────────────

# Legacy names still work for existing code
Qwen35ToolCallClient = ToolCallClient
Qwen35ToolCallAgent = ToolCallAgent
Qwen35ToolCallError = ToolCallError


# ── Convenience Function ────────────────────────────────────────────────────


def chat_with_tools(
    user_query: str,
    tool_definitions: List[Dict],
    tool_implementations: Dict[str, callable],
    config: Optional[Dict] = None,
) -> Tuple[openai.types.chat.ChatCompletion, List[Any]]:
    """
    Simple function for quick tool calling.

    Args:
        user_query: User's input
        tool_definitions: OpenAI-format tool definitions
        tool_implementations: Dict mapping tool names to callables
        config: Optional configuration (can include "model_profile" key)

    Returns:
        Tuple of (response, results)
    """
    agent = ToolCallAgent(tool_definitions, tool_implementations, config)
    return agent.run(user_query)


# Legacy alias
qwen35_chat_with_tools = chat_with_tools


# ── Example Usage ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Example tool implementations (actual callables)
    def read_file(path: str) -> str:
        """Read file contents"""
        with open(path, "r") as f:
            return f.read()

    def get_weather(city: str) -> str:
        """Get weather for city"""
        return f"Weather in {city}: Sunny, 25C"

    # Tool implementations: name -> callable
    implementations = {
        "read_file": read_file,
        "get_weather": get_weather,
    }

    # Tool definitions: OpenAI-format schemas (sent to the API)
    definitions = [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read file contents",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather information",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            },
        },
    ]

    # Initialize agent with both definitions and implementations
    agent = ToolCallAgent(definitions, implementations)

    # Run example
    try:
        response, results = agent.run("Read /etc/hosts and get weather in Sydney")

        print("\n=== Tool Call Results ===")
        for result in results:
            print(f"Tool: {result['tool_name']}")
            print(f"Status: {result['status']}")
            if result["status"] == "success":
                print(f"Result: {str(result['result'])[:200]}...")
            else:
                print(f"Error: {result['error']}")

        print("\n=== Metrics ===")
        metrics = agent.client.get_metrics()
        print(f"Total attempts: {metrics.total_attempts}")
        print(f"Successful calls: {metrics.successful_calls}")
        print(f"Escalations: {metrics.tool_choice_escalations}")
        print(f"Parallel requested: {metrics.parallel_calls_requested}")
        print(f"Parallel received: {metrics.parallel_calls_received}")
        print(
            f"Success rate: {metrics.successful_calls / metrics.total_attempts * 100:.1f}%"
        )

    except ToolCallError as e:
        print(f"Tool call failed: {e}")
