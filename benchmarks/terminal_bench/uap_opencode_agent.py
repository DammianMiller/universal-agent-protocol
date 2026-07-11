"""Terminal-Bench custom agents for a paired UAP-on vs UAP-off A/B.

Both agents drive `opencode` *inside* the task container, pointed at a
self-hosted Anthropic-compatible endpoint (qwen via the UAP bench proxy). They
are identical except that the UAP arm drops an ``AGENTS.md`` "operating
protocol" into the working directory before the run -- the same honest treatment
surface UAP's paired harness injects (run build/tests/lint, iterate to green,
then STOP). Holding model + harness + task fixed and toggling only that file is
the only clean measurement of UAP's lift.

Run (from the dedicated venv), with the bench proxy up on the host:

    UAP_TB_BASE_URL=http://<host-ip>:4100/v1 \
    .tbvenv/bin/tb run \
      --agent-import-path uap_opencode_agent:OpencodeBaseline \
      -m uap-local/qwen35-a3b-iq4xs \
      --dataset terminal-bench-core==0.1.1 -t <task> --n-attempts 5

Then again with ``:OpencodeUAP`` and diff the two results.json.
"""

import os

from terminal_bench.agents.installed_agents.opencode.opencode_agent import (
    OpenCodeAgent,
)

# The endpoint the in-container opencode calls. The proxy binds 0.0.0.0:4100 on
# the host, so the task container reaches it via the host's LAN IP. Override per
# environment with UAP_TB_BASE_URL / UAP_TB_API_KEY.
UAP_TB_BASE_URL = os.environ.get("UAP_TB_BASE_URL", "http://172.17.0.1:8080/v1")
# The UAP arm routes through the UAP proxy (:4100, container-reachable) so the
# proxy guardrails — including MANDATE-DELIVER, which forces the `deliver` tool
# when a direct edit is gated — are in the loop. Baseline stays direct to qwen.
UAP_TB_UAP_BASE_URL = os.environ.get("UAP_TB_UAP_BASE_URL", "http://172.17.0.1:4100/v1")
UAP_TB_API_KEY = os.environ.get("UAP_TB_API_KEY", "sk-qwen35b")

# The UAP treatment surface (gates discipline). Kept terminal-task-flavoured:
# build/test/lint until green, then stop -- the behaviour that separates a
# disciplined loop from a one-shot edit.
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

## When to escalate to the `deliver` tool (intelligent routing)
First try to complete the task with direct edits and your own build/test checks.
But if after ~2 focused attempts the build or tests STILL fail, stop hand-editing
and call the `deliver` tool with a one-line description of the change — it runs a
verified execute->test->fix convergence loop until the gates pass. One-shot the
simple tasks directly; escalate to `deliver` only when you are genuinely stuck.
Never loop indefinitely on manual edits.
"""


class _LocalOpencodeAgent(OpenCodeAgent):
    """opencode wired to a self-hosted endpoint. Base for both arms."""

    # opencode's built-in provider-key whitelist would reject our custom local
    # provider; the provider is defined by the setup script's opencode.json, so
    # no host API keys are needed in the container.
    @property
    def _env(self) -> dict[str, str]:
        return {}

    @property
    def _install_agent_script_path(self):
        return self._get_templated_script_path("uap-opencode-setup.sh.j2")

    # Whether the setup script writes AGENTS.md into the run cwd. False here;
    # the UAP subclass flips it on.
    _inject_agents = False

    def _get_template_variables(self) -> dict[str, str]:
        provider = self._model_name.split("/", 1)[0]
        model_id = self._model_name.split("/", 1)[1]
        return {
            "version": self.version or "latest",
            "provider": provider,
            "model_id": model_id,
            "base_url": UAP_TB_BASE_URL,
            "api_key": UAP_TB_API_KEY,
            "inject_agents": "1" if self._inject_agents else "",
            "agents_md": AGENTS_MD,
        }


class OpencodeBaseline(_LocalOpencodeAgent):
    """UAP-off control: opencode + local model, no scaffolding."""

    _inject_agents = False

    @staticmethod
    def name() -> str:
        return "opencode-baseline"


class OpencodeUAP(_LocalOpencodeAgent):
    """UAP-on: full UAP surface (MCP deliver tool + enforcement + reactor via
    `uap init`), routed through the UAP proxy so MANDATE-DELIVER is in the loop."""

    _inject_agents = True

    def _get_template_variables(self):  # type: ignore[override]
        v = super()._get_template_variables()
        v["base_url"] = UAP_TB_UAP_BASE_URL  # route through the guardrail proxy
        return v

    @property
    def _env(self):  # type: ignore[override]
        # Runtime env for the in-container opencode AND its policy-gate hook
        # subprocess. BLOCK mode incl. local sessions (the enforcer otherwise
        # relaxes local-model writes to advisory) so a direct edit is GATED ->
        # the proxy's MANDATE-DELIVER forces the deliver tool. UAP_INFERENCE_
        # ENDPOINT points the in-container `uap deliver` at host qwen.
        model_id = self._model_name.split("/", 1)[1] if "/" in self._model_name else self._model_name
        return {
            "UAP_ENFORCE_DELIVERY": "advisory",  # LAZY: allow one-shot; escalate to deliver on failure
            "UAP_INFERENCE_ENDPOINT": "http://172.17.0.1:8080/v1",
            "UAP_DELIVER_MODEL": model_id,
        }

    @staticmethod
    def name() -> str:
        return "opencode-uap"
