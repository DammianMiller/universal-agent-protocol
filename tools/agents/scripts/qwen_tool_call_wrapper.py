#!/usr/bin/env python3
"""
Qwen3.5 Tool Call Wrapper with Retry Logic

Provides robust tool calling for Qwen3.5 35B A3B with automatic retry
on failures, addressing known issues with early termination.

Known Issues Fixed:
1. Template parsing failures after 1-2 tool calls
2. Reasoning mode interference with structured output
3. JSON parsing errors from leaked reasoning content
4. Context window reprocessing issues

Usage:
    from qwen_tool_call_wrapper import Qwen35ToolCallClient

    client = Qwen35ToolCallClient()
    response = client.chat_with_tools(
        messages=[{"role": "user", "content": "Call read_file with path='/etc/hosts'"}],
        tools=[...]
    )
"""

import openai
import time
import json
import logging
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime
from enum import Enum

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("qwen35_tool_call")


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

    def to_dict(self) -> Dict:
        return asdict(self)


class Qwen35ToolCallError(Exception):
    """Custom exception for Qwen3.5 tool call failures"""

    pass


class Qwen35ToolCallClient:
    """
    OpenAI-compatible client optimized for Qwen3.5 35B A3B tool calling.

    Implements:
    - Automatic retry with exponential backoff
    - Prompt correction for failed tool calls
    - Metrics tracking and monitoring
    - Thinking mode disablement
    - Template validation
    """

    # Default configuration for Qwen3.5
    DEFAULT_CONFIG = {
        "temperature": 0.6,
        "top_p": 0.95,
        "top_k": 20,
        "presence_penalty": 1.5,
        "max_tokens": 32768,
        "enable_thinking": False,
        "tool_call_parser": "qwen3_coder",
        "max_retries": 3,
        "backoff_factor": 2.0,
        "base_url": "http://127.0.0.1:8080/v1",
        "api_key": "not-needed",
        "model": "qwen35-a3b-iq4xs",
    }

    def __init__(
        self, config: Optional[Dict[str, Any]] = None, enable_metrics: bool = True
    ):
        """
        Initialize Qwen3.5 tool call client.

        Args:
            config: Override default configuration
            enable_metrics: Enable performance metrics tracking
        """
        self.config = {**self.DEFAULT_CONFIG, **(config or {})}
        self.enable_metrics = enable_metrics
        self.metrics = ToolCallMetrics()
        self._client = None

        # Initialize OpenAI client
        self._init_client()

        logger.info(f"Qwen35ToolCallClient initialized with config: {self.config}")

    def _init_client(self):
        """Initialize OpenAI-compatible client"""
        try:
            self._client = openai.Client(
                base_url=self.config["base_url"], api_key=self.config["api_key"]
            )
            logger.info(f"Connected to {self.config['base_url']}")
        except Exception as e:
            logger.error(f"Failed to initialize OpenAI client: {e}")
            raise Qwen35ToolCallError(f"Client initialization failed: {e}")

    def chat_with_tools(
        self,
        messages: List[Dict[str, str]],
        tools: List[Dict[str, Any]],
        max_retries: Optional[int] = None,
        timeout: int = 120,
        **kwargs,
    ) -> openai.types.chat.ChatCompletion:
        """
        Chat completion with automatic retry on tool call failures.

        This is the main method for making tool calls with Qwen3.5.
        It implements exponential backoff and prompt correction.

        Args:
            messages: List of chat messages
            tools: List of tool definitions
            max_retries: Override default max retries
            timeout: Request timeout in seconds
            **kwargs: Additional parameters passed to OpenAI API

        Returns:
            ChatCompletion response with tool calls

        Raises:
            Qwen35ToolCallError: After max retries exhausted
        """
        max_retries = max_retries or self.config["max_retries"]

        # Track timing
        start_time = time.time()

        # Make a copy of messages to avoid modifying original
        current_messages = [msg.copy() for msg in messages]

        for attempt in range(max_retries):
            self.metrics.total_attempts += 1

            try:
                # Build request with Qwen3.5 optimizations
                request_params = {
                    "model": self.config["model"],
                    "messages": current_messages,
                    "tools": tools,
                    "temperature": self.config["temperature"],
                    "top_p": self.config["top_p"],
                    "top_k": self.config["top_k"],
                    "presence_penalty": self.config["presence_penalty"],
                    "max_tokens": self.config["max_tokens"],
                    "timeout": timeout,
                    "extra_body": {
                        "chat_template_kwargs": {
                            "enable_thinking": self.config["enable_thinking"]
                        }
                    },
                    **kwargs,
                }

                logger.debug(f"Attempt {attempt + 1}/{max_retries}: Sending request")

                # Make API call
                response = self._client.chat.completions.create(**request_params)

                # Validate response
                tool_calls = response.choices[0].message.tool_calls

                if self._validate_tool_call(tool_calls):
                    # Success!
                    self.metrics.successful_calls += 1

                    # Calculate latency
                    latency_ms = (time.time() - start_time) * 1000
                    self.metrics.avg_latency_ms = latency_ms

                    logger.info(f"Tool call successful after {attempt + 1} attempt(s)")
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
                    raise Qwen35ToolCallError(
                        f"Failed after {max_retries} attempts: {str(e)}"
                    )

                # Retry with backoff
                backoff = self.config["backoff_factor"] ** attempt
                time.sleep(backoff)

        # Should not reach here, but just in case
        raise Qwen35ToolCallError("Max retries exceeded")

    def _validate_tool_call(self, tool_calls) -> bool:
        """
        Validate that tool call has correct format.

        Checks for:
        - Non-empty tool calls list
        - Proper parameter format with <parameter> tags
        - No reasoning content leakage
        """
        if not tool_calls:
            logger.debug("No tool calls returned")
            return False

        tool_call = tool_calls[0]

        # Check for reasoning content leakage
        content = tool_call.function.arguments

        # Verify proper parameter format
        has_open_param = "<parameter>" in content
        has_close_param = "</parameter>" in content

        if not has_open_param or not has_close_param:
            logger.debug(f"Invalid parameter format: {content[:100]}...")
            return False

        # Check for thinking tag leakage
        if "<thinking>" in content or "</thinking>" in content:
            logger.debug("Thinking tag leakage detected")
            return False

        return True

    def _correct_prompt(
        self, messages: List[Dict], response: openai.types.chat.ChatCompletion
    ) -> List[Dict]:
        """
        Correct prompt after invalid tool call.

        Appends correction message to guide model toward proper format.
        """
        invalid_content = response.choices[0].message.content

        # Add assistant's failed attempt
        messages.append(
            {
                "role": "assistant",
                "content": f"Invalid tool call format detected. "
                f"Content: {invalid_content[:200]}...",
            }
        )

        # Add user correction
        messages.append(
            {
                "role": "user",
                "content": "Please use the correct tool format. "
                "Example format:\n"
                "<function=tool_name>\n"
                "<parameter=arg_name>value</parameter>\n"
                "</function>",
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
            "model": self.config["model"],
            "base_url": self.config["base_url"],
            "metrics": self.metrics.to_dict(),
            "config": {
                k: v for k, v in self.config.items() if k not in ["base_url", "api_key"]
            },
        }


class Qwen35ToolCallAgent:
    """
    Higher-level agent for Qwen3.5 tool calling workflows.

    Combines tool calling with execution and result handling.
    """

    def __init__(
        self, tool_functions: Dict[str, callable], client_config: Optional[Dict] = None
    ):
        """
        Initialize Qwen3.5 tool call agent.

        Args:
            tool_functions: Dict mapping tool names to callable functions
            client_config: Configuration for tool call client
        """
        self.tool_functions = tool_functions
        self.client = Qwen35ToolCallClient(client_config)

        logger.info(f"Qwen35ToolCallAgent initialized with {len(tool_functions)} tools")

    def run(
        self, user_query: str, additional_messages: Optional[List[Dict]] = None
    ) -> Tuple[openai.types.chat.ChatCompletion, List[Any]]:
        """
        Run a complete tool calling workflow.

        Args:
            user_query: User's input query
            additional_messages: Optional additional conversation history

        Returns:
            Tuple of (ChatCompletion response, List of tool results)
        """
        # Build messages
        messages = []

        if additional_messages:
            messages.extend(additional_messages)

        messages.append({"role": "user", "content": user_query})

        # Make tool call request
        response = self.client.chat_with_tools(
            messages=messages, tools=list(self.tool_functions.values())
        )

        # Execute tool calls
        tool_calls = response.choices[0].message.tool_calls

        if tool_calls:
            results = self.client.execute_tool_call(tool_calls, self.tool_functions)
        else:
            results = []

        return response, results

    def get_status(self) -> Dict:
        """Get agent status"""
        return {
            "tools": list(self.tool_functions.keys()),
            "client_status": self.client.get_status(),
        }


# Convenience function for simple use cases
def qwen35_chat_with_tools(
    user_query: str,
    tools: List[Dict],
    tool_functions: Dict[str, callable],
    config: Optional[Dict] = None,
) -> Tuple[openai.types.chat.ChatCompletion, List[Any]]:
    """
    Simple function for quick tool calling with Qwen3.5.

    Args:
        user_query: User's input
        tools: Tool definitions
        tool_functions: Tool implementations
        config: Optional configuration

    Returns:
        Tuple of (response, results)
    """
    agent = Qwen35ToolCallAgent(tool_functions, config)
    return agent.run(user_query)


# Example usage
if __name__ == "__main__":
    # Example tools
    def read_file(path: str) -> str:
        """Read file contents"""
        with open(path, "r") as f:
            return f.read()

    def get_weather(city: str) -> str:
        """Get weather for city"""
        return f"Weather in {city}: Sunny, 25°C"

    tool_functions = {
        "read_file": {
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
        "get_weather": {
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
    }

    # Initialize agent
    agent = Qwen35ToolCallAgent(tool_functions)

    # Run example
    try:
        response, results = agent.run("Read /etc/hosts and get weather in Sydney")

        print("\n=== Tool Call Results ===")
        for result in results:
            print(f"Tool: {result['tool_name']}")
            print(f"Status: {result['status']}")
            if result["status"] == "success":
                print(f"Result: {result['result'][:200]}...")
            else:
                print(f"Error: {result['error']}")

        print("\n=== Metrics ===")
        metrics = agent.client.get_metrics()
        print(f"Total attempts: {metrics.total_attempts}")
        print(f"Successful calls: {metrics.successful_calls}")
        print(
            f"Success rate: {metrics.successful_calls / metrics.total_attempts * 100:.1f}%"
        )

    except Qwen35ToolCallError as e:
        print(f"Tool call failed: {e}")
