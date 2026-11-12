"""Wrap the Claude CLI as a single LCB "LLM", in either single-shot or agentic mode.

Each LiveCodeBench prompt is handed to a headless `claude -p` session.

Modes (env LCB_CLAUDE_MODE):
- "agentic" (default): tools enabled (Bash/Read/Write/Edit), multi-round. The agent may
  run code against the public examples and iterate, then writes its final solution to
  `solution.py`, which we return wrapped in a ```python fence.
- "single": no tools, one turn. The model must emit the solution in a ```python block,
  which we read from the final result text. Approximates a single-shot model call.

Backend (env LCB_CLAUDE_REAL):
- unset/0 (default): inject litellm Anthropic-compatible env -> local qwen via :8216.
- "1": use the machine's normal `claude` auth (real Claude); pass --model LCB_CLAUDE_MODEL.
"""
import hashlib
import json
import os
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from lcb_runner.runner.base_runner import BaseRunner


USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
USAGE_MAX_PCT = float(os.getenv("LCB_USAGE_MAX_PCT", "90"))
CREDS_PATH = os.path.expanduser("~/.claude/.credentials.json")


def _oauth_token() -> str:
    with open(CREDS_PATH) as f:
        return json.load(f)["claudeAiOauth"]["accessToken"]


def _fetch_usage() -> dict:
    req = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {_oauth_token()}",
            "anthropic-beta": "oauth-2025-04-20",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


_usage_cache = {"ts": 0.0, "data": None}  # last successful reading (per process)
USAGE_CACHE_TTL = 60  # seconds an under-threshold reading is trusted, to limit polling


def _over_windows(data: dict) -> dict:
    return {
        k: v for k, v in data.items()
        if isinstance(v, dict) and v.get("utilization") is not None
        and v["utilization"] >= USAGE_MAX_PCT
    }


def usage_guard() -> None:
    """Block until every usage window is below USAGE_MAX_PCT, sleeping until the earliest
    reset of any over-threshold window. Robust to the usage endpoint rate-limiting our
    OWN polling (429): we do NOT blindly proceed on error — we reuse the last successful
    reading and only proceed if THAT was under threshold; if it was over (or we've never
    read), we keep waiting. Fail-open only if we never got a single reading."""
    c = _usage_cache
    if c["data"] is not None and time.time() - c["ts"] < USAGE_CACHE_TTL \
            and not _over_windows(c["data"]):
        return
    errors = 0
    while True:
        try:
            data = _fetch_usage()
            c["data"], c["ts"], errors = data, time.time(), 0
        except Exception as e:  # noqa: BLE001
            errors += 1
            print(f"[usage_guard] check failed ({errors}): {e!r}")
            if c["data"] is None:
                if errors >= 6:
                    print("[usage_guard] fail-open: never obtained a usage reading")
                    return
                time.sleep(min(10 * errors, 60))
                continue
            # Have a prior reading: trust it rather than overshooting.
            if not _over_windows(c["data"]):
                print("[usage_guard] endpoint error; last reading under threshold -> proceed")
                return
            print("[usage_guard] endpoint error; last reading OVER threshold -> wait 60s")
            time.sleep(60)
            continue
        over = _over_windows(data)
        if not over:
            return
        now = datetime.now(timezone.utc)
        waits = []
        for v in over.values():
            try:
                waits.append((datetime.fromisoformat(v["resets_at"]) - now).total_seconds())
            except Exception:  # noqa: BLE001
                waits.append(60.0)
        wait = min(max(5.0, min(waits)) + 10, 300)  # cap; re-check after
        worst = ", ".join(f"{k}={v['utilization']:.0f}%" for k, v in over.items())
        print(f"[usage_guard] over {USAGE_MAX_PCT:.0f}% ({worst}); sleeping {wait:.0f}s")
        time.sleep(wait)


# Local-qwen backend (used only when LCB_CLAUDE_REAL != "1").
LITELLM_ENV = {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "ANTHROPIC_AUTH_TOKEN": os.getenv("LCB_CLAUDE_AUTH_TOKEN", ""),
    "ANTHROPIC_BASE_URL": os.getenv("LCB_CLAUDE_BASE_URL", "http://localhost:8216/"),
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": os.getenv("LCB_CLAUDE_MODEL", "qwen3.6-27b-vllm"),
    "ANTHROPIC_MODEL": os.getenv("LCB_CLAUDE_MODEL", "qwen3.6-27b-vllm"),
    "ANTHROPIC_SMALL_FAST_MODEL": os.getenv("LCB_CLAUDE_MODEL", "qwen3.6-27b-vllm"),
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000",
}

WALL_SECONDS = int(os.getenv("LCB_CLAUDE_WALL_SECONDS", "900"))
MODE = os.getenv("LCB_CLAUDE_MODE", "agentic").lower()
REAL = os.getenv("LCB_CLAUDE_REAL") == "1"

# Per-problem transcript logging. ON by default; set LCB_CC_TRANSCRIPTS=0 to disable.
LOG_TRANSCRIPTS = os.getenv("LCB_CC_TRANSCRIPTS", "1") != "0"
LOG_DIR = os.getenv("LCB_CC_LOG_DIR", "claude_transcripts")

AGENTIC_CONTRACT = """\

---
You are solving a single competitive-programming problem. You have a scratch working
directory and MUST use Bash to write code, run python3, and verify before finalizing.

Required workflow:
1. Write a candidate solution and confirm it reproduces EVERY provided example exactly.
2. VERIFY beyond the examples before you finalize. Do not stop at the sample cases —
   the hidden tests target the cases you didn't think of. Specifically:
   - Enumerate edge cases from the constraints: minimum sizes (n=0/1), maximum sizes,
     boundary values, empty/degenerate input, duplicates, all-equal, negatives, overflow
     (use enough integer width), ties, and any special case the statement calls out.
   - Construct your own additional test inputs covering those cases and run them. Where
     feasible, write a simple brute-force reference and stress-test your solution against
     it on many small random inputs, fixing any mismatch you find.
   - Check the time/space complexity against the stated limits (n, t, value ranges) and
     confirm the solution is fast enough; if not, redesign before finalizing.
3. Only once it passes the examples AND your own verification, write your FINAL, COMPLETE
   solution to `solution.py` in the current working directory. It must match the required
   I/O format EXACTLY (read stdin / print stdout, or complete the given function signature
   without renaming it) and contain only valid Python source (no prose, no fences).

Writing `solution.py` is the deliverable — do that last, after verification.
"""

SINGLE_CONTRACT = """\

---
Solve this competitive-programming problem. Respond with your final, complete Python 3
solution inside a single ```python code block, matching the required I/O format exactly
(read stdin / print stdout, or complete the given function signature). Output only the
code block.
"""


class ClaudeCodeRunner(BaseRunner):
    def __init__(self, args, model):
        super().__init__(args, model)
        self.model = model

    def _format_task(self, prompt) -> str:
        if isinstance(prompt, list):
            parts = [
                (m.get("content", "") if isinstance(m, dict) else str(m)) for m in prompt
            ]
            return "\n\n".join(p for p in parts if p)
        if isinstance(prompt, tuple):
            return (prompt[0] or "") + "\n\n" + json.dumps(prompt[1])
        return str(prompt)

    def _invoke_once(self, task: str) -> str:
        if REAL:
            usage_guard()
        with tempfile.TemporaryDirectory(prefix="lcb_cc_") as workdir:
            wd = Path(workdir)
            single = MODE == "single"
            cmd = [
                "claude", "-p",
                "--output-format", "stream-json", "--verbose",
                "--no-session-persistence",
                "--append-system-prompt", SINGLE_CONTRACT if single else AGENTIC_CONTRACT,
            ]
            if single:
                cmd += ["--tools", ""]
            else:
                cmd += [
                    "--add-dir", str(wd),
                    "--permission-mode", "bypassPermissions",
                    "--tools", os.getenv("LCB_CLAUDE_TOOLS", "Read,Write,Edit,Bash,Glob,Grep"),
                ]
            if REAL:
                cmd += ["--model", os.getenv("LCB_CLAUDE_MODEL", "sonnet")]
                env = {**os.environ}
            else:
                env = {
                    **os.environ,
                    **{k: v for k, v in LITELLM_ENV.items() if v != ""},
                }
            env["PATH"] = os.environ["PATH"]
            env["HOME"] = os.environ["HOME"]
            # Pass the task via stdin, NOT as a trailing positional: `--tools` is a
            # variadic flag and would otherwise swallow the prompt as a tool name.
            timed_out = False
            try:
                proc = subprocess.run(
                    cmd, input=task, capture_output=True, timeout=WALL_SECONDS,
                    text=True, env=env, cwd=str(wd),
                )
                stdout, stderr, rc = proc.stdout, proc.stderr, proc.returncode
            except subprocess.TimeoutExpired as e:
                timed_out = True
                stdout = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
                stderr = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
                rc = None

            self._write_transcript(task, stdout, stderr, rc, timed_out)

            if os.getenv("LCB_CC_DEBUG"):
                print(f"[cc_debug] rc={rc} timed_out={timed_out} "
                      f"stdout_len={len(stdout)} stderr={stderr[:300]!r}")

            if not single:
                sol = self._read_solution(wd)
                if sol:
                    return sol
            return self._result_text(stdout)

    def _write_transcript(self, task, stdout, stderr, rc, timed_out) -> None:
        if not LOG_TRANSCRIPTS:
            return
        try:
            d = Path(LOG_DIR) / self.model.model_repr
            d.mkdir(parents=True, exist_ok=True)
            name = hashlib.md5(task.encode()).hexdigest()[:12] + ".jsonl"
            with (d / name).open("w") as f:
                meta = {
                    "_meta": True, "mode": MODE, "real": REAL,
                    "model": os.getenv("LCB_CLAUDE_MODEL", "sonnet" if REAL else "qwen"),
                    "returncode": rc, "timed_out": timed_out,
                    "stderr": stderr[:2000], "task": task,
                }
                f.write(json.dumps(meta) + "\n")
                f.write(stdout)  # stream-json: one event JSON per line
        except OSError:
            pass

    @staticmethod
    def _read_solution(wd: Path) -> str:
        p = wd / "solution.py"
        if p.is_file():
            code = p.read_text().strip()
            if code:
                return f"```python\n{code}\n```"
        return ""

    @staticmethod
    def _result_text(stdout: str) -> str:
        # stream-json: one event per line; the final answer is the `result` field of
        # the terminal type=="result" event.
        result = ""
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "result":
                result = ev.get("result") or ""
        return result if "```" in result else ""

    def _run_single(self, prompt) -> list[str]:
        task = self._format_task(prompt)
        outputs = []
        for _ in range(self.args.n):
            try:
                outputs.append(self._invoke_once(task))
            except Exception as e:  # noqa: BLE001
                print("ClaudeCodeRunner exception:", repr(e))
                outputs.append("")
        return outputs
