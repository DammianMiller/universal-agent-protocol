"""Terminal-Bench custom agents for a paired UAP-on vs UAP-off A/B on Factory
Droid + Kimi K3 (see docs/plans/k3-uap-uplift-validation.md).

Both agents drive the Factory Droid CLI *inside* the task container, pointed at
Kimi K3 via Droid's ``customModels`` BYOK config. They are identical except that
the UAP arm drops an ``AGENTS.md`` operating protocol into the working directory
before the run — the same honest treatment surface as the opencode paired shim
(gates discipline, verify-don't-assume, stop-when-green). Holding model +
harness + task fixed and toggling only that file is the clean measurement of
UAP's lift.

An optional third treatment (plan "arm C") routes the model endpoint through the
UAP proxy by setting UAP_TB_UAP_BASE_URL, so the deterministic enforcers are in
the request path. Baseline never uses it.

Host env required (forwarded into the container, never logged):

    UAP_TB_FACTORY_API_KEY   headless Droid auth
    UAP_TB_KIMI_API_KEY      Moonshot platform key (primary endpoint), or
    UAP_TB_OPENROUTER_API_KEY  OpenRouter key (fallback endpoint)

Run (from the bench venv):

    UAP_TB_FACTORY_API_KEY=fk-... UAP_TB_KIMI_API_KEY=sk-... \
    .tbvenv/bin/tb run \
      --agent-import-path uap_droid_agent:DroidBaseline \
      -m kimi-k3 \
      --dataset terminal-bench==2.1 -t <task-id> --n-attempts 5

Then again with ``:DroidUAP`` and diff the two results.json.
"""

import os
import shlex

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand

# Provider endpoints (OpenAI-compatible dialect). Primary is Moonshot's
# official API; OpenRouter is the fallback, selected when only its key is set.
MOONSHOT_BASE_URL = "https://api.platform.kimi.ai/v1"
MOONSHOT_MODEL_ID = "kimi-k3"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_MODEL_ID = "moonshotai/kimi-k3"

# Droid custom-model reference: display name dasherized + 0-based index into
# the customModels array the setup script writes. Overridable for experiments.
DROID_MODEL_REF = os.environ.get("UAP_TB_DROID_MODEL", "custom:Kimi-K3-0")

# Optional arm-C routing: when set, the UAP arm's customModels baseUrl points at
# the (container-reachable) UAP proxy instead of the provider, so the
# deterministic enforcers (MANDATE-DELIVER, guardrails) are in the loop.
UAP_TB_UAP_BASE_URL = os.environ.get("UAP_TB_UAP_BASE_URL", "")

# The UAP treatment surface (gates discipline). Same protocol as the opencode
# shim, minus the `deliver`-tool escalation paragraph — that tool is an
# opencode/MCP surface and does not exist in this arm, so naming it would be
# instructions for tooling the agent cannot call.
AGENTS_MD = """# UAP Operating Protocol

The following protocol is active for this task. Follow it precisely.

## Completion Gates
Before claiming the task is done you MUST run the project's build, its test
suite, and any linter that exists, and confirm they pass. Do not stop while any
gate is failing. If a check fails, read the error, fix the cause, and re-run the
check. Re-verify at least once after your final edit.

**Termination (critical):** The moment every gate passes you are DONE --
immediately stop. Do NOT re-read files, re-edit, re-run already-passing checks,
or keep exploring once the gates are green. Continuing after success wastes the
run and risks regressing a correct solution.

## Verify, don't assume
Confirm the working state by executing commands, not by guessing. Inspect the
files and the actual error output before and after each change. Prefer the
smallest change that makes the gates pass.
"""


def _forwarded_env() -> dict[str, str]:
    """Host keys forwarded into the container under their canonical names."""
    mapping = {
        "UAP_TB_FACTORY_API_KEY": "FACTORY_API_KEY",
        "UAP_TB_KIMI_API_KEY": "KIMI_API_KEY",
        "UAP_TB_OPENROUTER_API_KEY": "OPENROUTER_API_KEY",
    }
    return {
        container_name: os.environ[host_name]
        for host_name, container_name in mapping.items()
        if os.environ.get(host_name)
    }


class _BaseDroidAgent(AbstractInstalledAgent):
    """Droid CLI wired to Kimi K3 via BYOK customModels. Base for both arms."""

    # Whether the setup script writes AGENTS.md into the run cwd. False here;
    # the UAP subclass flips it on.
    _inject_agents = False

    # Arm-C routing through the UAP proxy. Baseline never uses it.
    _use_uap_proxy = False

    @property
    def _env(self) -> dict[str, str]:
        return _forwarded_env()

    @property
    def _install_agent_script_path(self):
        return self._get_templated_script_path("uap-droid-setup.sh.j2")

    def _get_template_variables(self) -> dict[str, str]:
        if os.environ.get("UAP_TB_KIMI_API_KEY"):
            base_url, model_id = MOONSHOT_BASE_URL, MOONSHOT_MODEL_ID
        else:
            base_url, model_id = OPENROUTER_BASE_URL, OPENROUTER_MODEL_ID
        if self._use_uap_proxy and UAP_TB_UAP_BASE_URL:
            base_url = UAP_TB_UAP_BASE_URL
        return {
            "base_url": base_url,
            "model_id": model_id,
            "droid_model": DROID_MODEL_REF,
            "inject_agents": "1" if self._inject_agents else "",
            "agents_md": AGENTS_MD,
        }

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # Mirrors Factory's published TB methodology: non-interactive task mode,
        # all permissions skipped (containers are disposable), task spec as the
        # prompt. JSON output lands in the pane log for trajectory inspection.
        return [
            TerminalCommand(
                command=(
                    f"droid exec --skip-permissions-unsafe "
                    f"--model {shlex.quote(DROID_MODEL_REF)} "
                    f"--output-format json "
                    f"{shlex.quote(instruction)}"
                ),
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            ),
        ]


class DroidBaseline(_BaseDroidAgent):
    """UAP-off control: Droid + K3 direct, no scaffolding."""

    _inject_agents = False

    @staticmethod
    def name() -> str:
        return "droid-baseline"


class DroidUAP(_BaseDroidAgent):
    """UAP-on (protocol): Droid + K3 with the AGENTS.md operating protocol.

    Set UAP_TB_UAP_BASE_URL to additionally route the model endpoint through
    the UAP proxy (plan arm C: protocol + deterministic enforcers)."""

    _inject_agents = True
    _use_uap_proxy = True

    @staticmethod
    def name() -> str:
        return "droid-uap"
