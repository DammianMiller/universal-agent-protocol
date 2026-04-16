"""
Claude Code agent optimized for local LLM inference (claude-local).

Reduces tool count to essentials only, improving tool-call accuracy
for smaller/quantized models that struggle with large tool schemas.
Also adds --dangerously-skip-permissions to match claude-local behavior.
"""

import os
import shlex

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.base import ExecInput
from harbor.models.trial.paths import EnvironmentPaths


class ClaudeLocalAgent(ClaudeCode):
    """Claude Code agent with minimal tools for local model benchmarks."""

    # Only essential tools - fewer choices = better accuracy for small models
    ALLOWED_TOOLS = [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
    ]

    @staticmethod
    def name() -> str:
        return "claude-local"

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        escaped_instruction = shlex.quote(instruction)

        env = {
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            "ANTHROPIC_BASE_URL": os.environ.get("ANTHROPIC_BASE_URL", None),
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "FORCE_AUTO_BACKGROUND_TASKS": "1",
            "ENABLE_BACKGROUND_TASKS": "1",
        }

        env = {k: v for k, v in env.items() if v}

        if self.model_name:
            if "ANTHROPIC_BASE_URL" in env:
                env["ANTHROPIC_MODEL"] = self.model_name
            else:
                env["ANTHROPIC_MODEL"] = self.model_name.split("/")[-1]
        elif "ANTHROPIC_MODEL" in os.environ:
            env["ANTHROPIC_MODEL"] = os.environ["ANTHROPIC_MODEL"]

        # Route all model aliases to the same local model
        if "ANTHROPIC_BASE_URL" in env and "ANTHROPIC_MODEL" in env:
            env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = env["ANTHROPIC_MODEL"]
            env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = env["ANTHROPIC_MODEL"]
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = env["ANTHROPIC_MODEL"]
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = env["ANTHROPIC_MODEL"]

        max_thinking_tokens = self._max_thinking_tokens
        if max_thinking_tokens is not None:
            env["MAX_THINKING_TOKENS"] = str(max_thinking_tokens)
        elif "MAX_THINKING_TOKENS" in os.environ:
            env["MAX_THINKING_TOKENS"] = os.environ["MAX_THINKING_TOKENS"]

        env["CLAUDE_CONFIG_DIR"] = (EnvironmentPaths.agent_dir / "sessions").as_posix()

        return [
            ExecInput(
                command=(
                    "mkdir -p $CLAUDE_CONFIG_DIR/debug $CLAUDE_CONFIG_DIR/projects/-app "
                    "$CLAUDE_CONFIG_DIR/shell-snapshots $CLAUDE_CONFIG_DIR/statsig "
                    "$CLAUDE_CONFIG_DIR/todos && "
                    "if [ -d ~/.claude/skills ]; then "
                    "cp -r ~/.claude/skills $CLAUDE_CONFIG_DIR/skills 2>/dev/null || true; "
                    "fi"
                ),
                env=env,
            ),
            ExecInput(
                command=(
                    f"claude --verbose "
                    f"--output-format stream-json "
                    f"-p {escaped_instruction} --allowedTools "
                    f"{' '.join(self.ALLOWED_TOOLS)} 2>&1 </dev/null | tee "
                    f"/logs/agent/claude-code.txt"
                ),
                env=env,
            ),
        ]
