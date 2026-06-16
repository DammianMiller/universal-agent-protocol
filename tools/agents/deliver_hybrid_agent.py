"""
Deliver-hybrid harbor agent: opencode solves, then `uap deliver` repairs —
never regressing.

Empirically, deliver-as-the-sole-solver underperforms a strong agentic baseline
on a hidden-verifier benchmark (its self-gate is a misleading proxy). This agent
instead makes deliver STRICTLY ADDITIVE:

  1. opencode (the strong baseline harness) solves the task — this is the floor.
  2. `uap deliver --no-self-gate --keep-best` runs an agentic repair pass against
     the project's REAL detected gates (Makefile/pytest/test-script/npm). With
     no real gate it no-ops and opencode's output stands; with a real gate it can
     only improve the gate score (`--keep-best` rolls back any regression).

So the result is >= baseline by construction, and beats it where a detectable
gate was left failing and deliver repairs it.

Run:
  harbor run -d terminal-bench@2.0 \
    --agent-import-path tools.agents.deliver_hybrid_agent:DeliverHybrid ...
"""

from __future__ import annotations

import shlex

from harbor.agents.installed.base import ExecInput
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from tools.agents.opencode_uap_agent import OpenCodeUAP, logger


class DeliverHybrid(OpenCodeUAP):
    """opencode solves; `uap deliver --keep-best` repairs against real gates."""

    @staticmethod
    def name() -> str:
        return "deliver-hybrid"

    # Single execution — the opencode retry-on-zero-tools logic would also
    # re-run the appended deliver-repair step, which is wasteful.
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._execute_run(instruction, environment, context, attempt=0)
        self.populate_context_post_run(context)

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        # Stage 1: the full opencode solve (baseline floor).
        commands = super().create_run_agent_commands(instruction)

        # Stage 2: deliver repair against REAL gates only, never regressing.
        # --no-self-gate: do NOT invent a proxy gate; if no real gate is
        #   detected, deliver exits non-zero and `|| true` keeps opencode's work.
        # --keep-best: snapshot first; roll back if the real-gate score drops.
        escaped = shlex.quote(instruction)
        endpoint = self._api_endpoint
        repair = (
            "source $HOME/.nvm/nvm.sh && cd /app && "
            f"UAP_DELIVER_ACTIVE=1 uap deliver {escaped} "
            f"--project-root /app --endpoint {endpoint} --model qwen35-a3b "
            "--executor agentic --no-self-gate --keep-best --max-turns 4 --no-until-delivered "
            "2>&1 | tee /logs/agent/uap-deliver-repair.txt || true"
        )
        logger.info("[DeliverHybrid] appending deliver repair pass (real gates, --keep-best)")
        commands.append(ExecInput(command=repair))
        return commands
