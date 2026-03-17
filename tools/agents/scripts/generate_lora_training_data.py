#!/usr/bin/env python3
"""
LoRA Fine-Tune Training Data Generator for Qwen3.5 Tool Calling

Generates synthetic training examples in the ChatML format matching
the official Qwen3 chat template. These examples teach the model to:
1. Emit properly formatted <tool_call> blocks with JSON payloads
2. Parse tool responses from <tool_response> blocks
3. Handle multi-tool calls in a single turn
4. Avoid <think> tag leakage into tool call arguments

Output formats:
- JSONL (for axolotl, LLaMA-Factory, unsloth)
- ShareGPT (for LLaMA-Factory ShareGPT format)

Usage:
    python3 generate_lora_training_data.py --output training_data.jsonl --count 200
    python3 generate_lora_training_data.py --output training_data.jsonl --format sharegpt
"""

import json
import argparse
import random
from typing import List, Dict, Any
from pathlib import Path


# Tool definitions used in training examples
TOOLS = {
    "read_file": {
        "description": "Read file contents from the filesystem",
        "parameters": {"path": "string"},
        "examples": [
            {"path": "/etc/hosts"},
            {"path": "/home/user/project/README.md"},
            {"path": "/tmp/output.log"},
            {"path": "src/main.py"},
            {"path": "package.json"},
        ],
    },
    "write_file": {
        "description": "Write content to a file",
        "parameters": {"path": "string", "content": "string"},
        "examples": [
            {"path": "/tmp/test.txt", "content": "Hello, World!"},
            {"path": "output.json", "content": '{"status": "ok"}'},
        ],
    },
    "run_command": {
        "description": "Execute a shell command",
        "parameters": {"command": "string", "cwd": "string"},
        "examples": [
            {"command": "ls -la", "cwd": "/home/user"},
            {"command": "git status", "cwd": "."},
            {"command": "npm test", "cwd": "/home/user/project"},
            {"command": "python3 -c 'print(1+1)'", "cwd": "."},
        ],
    },
    "search_files": {
        "description": "Search for files matching a pattern",
        "parameters": {"pattern": "string", "path": "string"},
        "examples": [
            {"pattern": "*.py", "path": "src/"},
            {"pattern": "*.test.ts", "path": "."},
            {"pattern": "Dockerfile*", "path": "."},
        ],
    },
    "grep_content": {
        "description": "Search file contents for a regex pattern",
        "parameters": {"pattern": "string", "include": "string"},
        "examples": [
            {"pattern": "def main", "include": "*.py"},
            {"pattern": "import.*React", "include": "*.tsx"},
            {"pattern": "TODO|FIXME", "include": "*.ts"},
        ],
    },
    "calculate": {
        "description": "Perform a mathematical calculation",
        "parameters": {"expression": "string"},
        "examples": [
            {"expression": "2 + 2"},
            {"expression": "100 * 0.15"},
            {"expression": "sqrt(144)"},
        ],
    },
    "get_system_info": {
        "description": "Get system information",
        "parameters": {"info_type": "string"},
        "examples": [
            {"info_type": "cpu"},
            {"info_type": "memory"},
            {"info_type": "disk"},
            {"info_type": "all"},
        ],
    },
}

# User query templates for single tool calls
SINGLE_TOOL_QUERIES = [
    ("Read the file at {path}", "read_file", lambda ex: ex),
    ("Show me the contents of {path}", "read_file", lambda ex: ex),
    ("What's in {path}?", "read_file", lambda ex: ex),
    ("Run the command: {command}", "run_command", lambda ex: ex),
    ("Execute `{command}` in {cwd}", "run_command", lambda ex: ex),
    ("Find all {pattern} files in {path}", "search_files", lambda ex: ex),
    ("Search for {pattern} in {include} files", "grep_content", lambda ex: ex),
    ("Calculate {expression}", "calculate", lambda ex: ex),
    ("What is {expression}?", "calculate", lambda ex: ex),
    ("Get {info_type} system information", "get_system_info", lambda ex: ex),
]

# User query templates for multi-tool calls
MULTI_TOOL_QUERIES = [
    (
        "Read {path1} and then run `{command}`",
        [
            (
                "read_file",
                lambda: {"path": random.choice(TOOLS["read_file"]["examples"])["path"]},
            ),
            ("run_command", lambda: random.choice(TOOLS["run_command"]["examples"])),
        ],
    ),
    (
        "Find all Python files and read the main one",
        [
            ("search_files", lambda: {"pattern": "*.py", "path": "src/"}),
            ("read_file", lambda: {"path": "src/main.py"}),
        ],
    ),
    (
        "Check system memory and disk usage",
        [
            ("get_system_info", lambda: {"info_type": "memory"}),
            ("get_system_info", lambda: {"info_type": "disk"}),
        ],
    ),
    (
        "Read package.json, run npm test, and check the output log",
        [
            ("read_file", lambda: {"path": "package.json"}),
            ("run_command", lambda: {"command": "npm test", "cwd": "."}),
            ("read_file", lambda: {"path": "/tmp/output.log"}),
        ],
    ),
    (
        "Search for TODO comments in TypeScript files and calculate how many there might be",
        [
            ("grep_content", lambda: {"pattern": "TODO|FIXME", "include": "*.ts"}),
            ("calculate", lambda: {"expression": "15 * 3"}),
        ],
    ),
]

# Fake tool responses
TOOL_RESPONSES = {
    "read_file": [
        "# Project README\n\nThis is a sample project.",
        '{"name": "my-project", "version": "1.0.0"}',
        "127.0.0.1 localhost\n::1 localhost",
        "def main():\n    print('Hello')\n\nif __name__ == '__main__':\n    main()",
        "import express from 'express';\nconst app = express();",
    ],
    "run_command": [
        "total 24\ndrwxr-xr-x 5 user user 4096 Mar 13 10:00 .\n-rw-r--r-- 1 user user 1234 Mar 13 09:00 README.md",
        "On branch main\nnothing to commit, working tree clean",
        "PASS src/tests/main.test.ts\nTests: 5 passed, 5 total",
        "2",
    ],
    "search_files": [
        "src/main.py\nsrc/utils.py\nsrc/tests/test_main.py",
        "src/App.test.tsx\nsrc/utils.test.ts",
        "Dockerfile\nDockerfile.dev",
    ],
    "grep_content": [
        "src/main.py:10: # TODO: refactor this\nsrc/utils.py:25: # FIXME: handle edge case",
        "src/App.tsx:1: import React from 'react';\nsrc/index.tsx:1: import React from 'react';",
    ],
    "calculate": ["4", "15.0", "12.0"],
    "get_system_info": [
        "CPU: 8 cores, Intel i7-12700K @ 3.6GHz\nLoad: 0.45, 0.52, 0.48",
        "Memory: 32GB total, 18GB used, 14GB free\nSwap: 8GB total, 0GB used",
        "Disk: /dev/sda1 500GB total, 320GB used, 180GB free (64%)",
        "CPU: 8 cores @ 3.6GHz\nMemory: 32GB (56% used)\nDisk: 500GB (64% used)",
    ],
    "write_file": ["File written successfully: 13 bytes"],
}


def format_tool_call(tool_name: str, arguments: Dict[str, Any]) -> str:
    """Format a tool call in the official Qwen3 format."""
    args_json = json.dumps(arguments, ensure_ascii=False)
    return (
        f"<tool_call>\n"
        f'{{"name": "{tool_name}", "arguments": {args_json}}}\n'
        f"</tool_call>"
    )


def format_tool_response(tool_name: str, content: str) -> str:
    """Format a tool response in the official Qwen3 format."""
    return f"<tool_response>\n{content}\n</tool_response>"


def generate_single_tool_example() -> Dict[str, Any]:
    """Generate a single tool call training example."""
    query_template, tool_name, arg_fn = random.choice(SINGLE_TOOL_QUERIES)
    tool_args = random.choice(TOOLS[tool_name]["examples"])

    # Format the user query
    user_query = query_template.format(**tool_args)

    # Format the assistant response (tool call)
    assistant_content = format_tool_call(tool_name, tool_args)

    # Format the tool response
    tool_response = random.choice(TOOL_RESPONSES.get(tool_name, ["OK"]))

    # Format the final assistant response
    final_response = f"Here are the results:\n\n{tool_response}"

    return {
        "messages": [
            {
                "role": "system",
                "content": "You are a helpful assistant with access to tools. Use them when needed.",
            },
            {"role": "user", "content": user_query},
            {"role": "assistant", "content": assistant_content},
            {"role": "tool", "name": tool_name, "content": tool_response},
            {"role": "assistant", "content": final_response},
        ]
    }


def generate_multi_tool_example() -> Dict[str, Any]:
    """Generate a multi-tool call training example."""
    query_text, tool_specs = random.choice(MULTI_TOOL_QUERIES)

    messages = [
        {
            "role": "system",
            "content": "You are a helpful assistant with access to tools. Use them when needed.",
        },
        {"role": "user", "content": query_text},
    ]

    # Generate all tool calls in one assistant turn
    tool_calls_content = ""
    tool_results = []

    for tool_name, arg_fn in tool_specs:
        args = arg_fn()
        tool_calls_content += format_tool_call(tool_name, args) + "\n"
        tool_response = random.choice(TOOL_RESPONSES.get(tool_name, ["OK"]))
        tool_results.append((tool_name, tool_response))

    messages.append({"role": "assistant", "content": tool_calls_content.strip()})

    # Add tool responses
    for tool_name, response in tool_results:
        messages.append({"role": "tool", "name": tool_name, "content": response})

    # Final summary
    summary_parts = [f"- {name}: completed" for name, _ in tool_results]
    messages.append(
        {
            "role": "assistant",
            "content": "All operations completed:\n" + "\n".join(summary_parts),
        }
    )

    return {"messages": messages}


def generate_no_tool_example() -> Dict[str, Any]:
    """Generate an example where no tool call is needed (teaches restraint)."""
    queries = [
        (
            "What is Python?",
            "Python is a high-level, interpreted programming language known for its readability and versatility.",
        ),
        (
            "How do I write a for loop in JavaScript?",
            "In JavaScript, you can write a for loop like this:\n\n```javascript\nfor (let i = 0; i < 10; i++) {\n  console.log(i);\n}\n```",
        ),
        (
            "Explain what a REST API is",
            "A REST API (Representational State Transfer Application Programming Interface) is an architectural style for building web services.",
        ),
    ]

    query, response = random.choice(queries)

    return {
        "messages": [
            {
                "role": "system",
                "content": "You are a helpful assistant with access to tools. Use them when needed.",
            },
            {"role": "user", "content": query},
            {"role": "assistant", "content": response},
        ]
    }


def convert_to_sharegpt(example: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a messages-format example to ShareGPT format."""
    conversations = []
    for msg in example["messages"]:
        role = msg["role"]
        if role == "system":
            conversations.append({"from": "system", "value": msg["content"]})
        elif role == "user":
            conversations.append({"from": "human", "value": msg["content"]})
        elif role == "assistant":
            conversations.append({"from": "gpt", "value": msg["content"]})
        elif role == "tool":
            tool_name = msg.get("name", "unknown")
            conversations.append(
                {
                    "from": "tool",
                    "value": format_tool_response(tool_name, msg["content"]),
                }
            )

    return {"conversations": conversations}


def main():
    parser = argparse.ArgumentParser(
        description="Generate LoRA training data for Qwen3.5 tool calling"
    )
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default="tool_call_training_data.jsonl",
        help="Output file path (default: tool_call_training_data.jsonl)",
    )
    parser.add_argument(
        "--count",
        "-n",
        type=int,
        default=200,
        help="Number of training examples to generate (default: 200)",
    )
    parser.add_argument(
        "--format",
        "-f",
        choices=["messages", "sharegpt"],
        default="messages",
        help="Output format: messages (axolotl/unsloth) or sharegpt (LLaMA-Factory)",
    )
    parser.add_argument(
        "--seed",
        "-s",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )
    args = parser.parse_args()

    random.seed(args.seed)

    examples = []
    for i in range(args.count):
        # Distribution: 50% single tool, 30% multi-tool, 20% no-tool
        r = random.random()
        if r < 0.5:
            example = generate_single_tool_example()
        elif r < 0.8:
            example = generate_multi_tool_example()
        else:
            example = generate_no_tool_example()

        if args.format == "sharegpt":
            example = convert_to_sharegpt(example)

        examples.append(example)

    # Write output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        for example in examples:
            f.write(json.dumps(example, ensure_ascii=False) + "\n")

    print(f"Generated {len(examples)} training examples")
    print(f"Output: {output_path}")
    print(f"Format: {args.format}")
    print(
        f"Distribution: ~{int(args.count * 0.5)} single-tool, "
        f"~{int(args.count * 0.3)} multi-tool, "
        f"~{int(args.count * 0.2)} no-tool"
    )
    print()
    print("Next steps:")
    print("  1. Review and augment with real examples from your use case")
    print("  2. Fine-tune with unsloth or axolotl:")
    print(
        f"     unsloth train --model Qwen/Qwen3.5-35B-A3B --data {output_path} --lora-rank 16"
    )
    print("  3. Merge LoRA adapter:")
    print("     unsloth merge --adapter ./output/adapter --output ./merged-model")
    print("  4. Convert to GGUF:")
    print("     python convert_hf_to_gguf.py ./merged-model --outtype q4_k_m")


if __name__ == "__main__":
    main()
