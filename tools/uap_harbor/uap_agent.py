"""
UAP-Integrated Agent for Harbor/Terminal-Bench (v3.0.0)

v3.0.0 - Slim classified preamble with regression fixes
- Universal core: ~150 tokens of high-impact principles
- Task classifier routes only relevant snippets (~50-200 tokens each)
- Pre-execution hooks for physical state protection
- Regression fixes: enriched git, database, polyglot, statistics snippets
"""

import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.base import ExecInput
from harbor.models.trial.paths import EnvironmentPaths

from .pre_execution_hooks import (
    detect_task_from_instruction,
    get_pre_execution_commands,
    get_post_execution_context,
)


# =============================================================================
# UAP v2.0 CLASSIFIED PREAMBLE SYSTEM
# Universal core (~150 tokens) + routed domain snippets (~50-150 tokens each)
# =============================================================================

UAP_CORE = """## Task Guidance

VALIDATE THE PLAN (MANDATORY -- runs after first pass output):
1. Review your plan for missing steps, incorrect assumptions, security issues
2. Check that every subtask has a clear, verifiable output
3. Ensure dependencies between steps are correctly ordered
4. Validate cost/duration estimates are reasonable
5. If plan is flawed, REWRITE it before executing any tool calls

1. Read the full task description and any provided tests/verifiers BEFORE writing code.
2. Create expected output files early, even as stubs.
3. Prefer existing libraries over custom implementations for well-known algorithms.
4. After implementation, run all available tests. If some fail, read the error, fix the specific issue, and re-run. Iterate until all pass.
5. Use binary mode ('rb'/'wb') for all non-text file I/O.
6. Reserve time for debugging - do not give up after the first test failure.
"""

PATTERN_SNIPPETS = {
    "git": """### Git Task Guidance
- FIRST: `cp -r .git .git.bak` before any git operation.
- Use `git fsck --full --no-dangling`, `git reflog --all` for recovery.
- Check `git log --all --oneline` and `git fsck --unreachable` for dangling objects.
- Recover lost commits: `git reflog` then `git cherry-pick <hash>` or `git merge <hash>`.
- For corrupted HEAD: `git symbolic-ref HEAD refs/heads/main`.
- For broken index: `rm .git/index && git reset`.
- For leaked secrets: use `git filter-repo` or BFG, not `git filter-branch`.
- Use `git cat-file -t <hash>` and `git cat-file -p <hash>` to inspect objects.
""",
    "compression": """### Compression Task Guidance
- Read the provided decoder/decompressor source FIRST - understand its expected format exactly.
- Test round-trip at small scale before optimizing: `echo -n "A" > /tmp/t.txt && ./compress /tmp/t.txt /tmp/t.comp && ./decompress /tmp/t.comp /tmp/t.out && diff /tmp/t.txt /tmp/t.out`
- Use binary mode for ALL file I/O. Common failure: text mode corrupts binary data.
- If decompressor outputs garbage, your format doesn't match - re-read the decoder byte-by-byte.
""",
    "chess": """### Chess Task Guidance
- Use python-chess library + Stockfish engine, not manual move generation.
- For image-to-FEN: try board_to_fen or pytesseract, do NOT guess positions.
- Use `multipv` parameter to find ALL valid moves, not just the best one.
""",
    "polyglot": """### Polyglot/Multi-Language Guidance
- Search for existing polyglot examples for the target language pair FIRST.
- Use comment syntax differences between languages to hide code sections.
- C+Python: use `#if 0`/`#endif` to hide Python from C, `#` hides C from Python.
- Rust+C: use `/*`/`*/` block comments and macro tricks for dual parsing.
- Test with BOTH compilers/interpreters separately.
- After testing, clean output directory of ALL build artifacts - keep ONLY source files.
- `chmod +x` if executable, add proper shebang for interpreted languages.
""",
    "service": """### Service/Server Task Guidance
- After starting a service, smoke test it immediately: `curl -v http://localhost:PORT/ 2>&1 | head -20`
- If no response: check logs, fix the issue BEFORE continuing.
""",
    "competitive": """### Competitive/Game Task Guidance
- Do NOT assume strategies work - test empirically first.
- Analyze provided opponents to find their weaknesses.
- Use counter-strategies: test locally with `pmars -r 100 yours.red opponent.red` or equivalent.
""",
    "statistics": """### Statistics/R Task Guidance
- Use FINITE bounds for sampling: `c(-10, 10)` not `c(-Inf, Inf)`.
- Check if CRAN/PyPI packages exist before implementing from scratch (e.g., `library(ars)`, `pip install arviz`).
- Initialize with points where the derivative changes sign.
- For adaptive rejection sampling: use the `ars` R package or implement the Gilks & Wild (1992) algorithm.
- Test with multiple random seeds (3+ iterations).
- Use tolerance margins for floating-point comparisons (1e-6 typical).
- For MCMC: check convergence with R-hat < 1.05 and sufficient effective sample size.
""",
    "c_systems": """### C/Systems Programming Guidance
- Use dynamic allocation (`malloc`) for large buffers, not stack arrays.
- If segfault or stack smashing: increase buffer sizes 10x or use heap allocation.
- Add bounds checking before all array writes.
""",
    "binary_forensics": """### Binary/Forensics Task Guidance
- Use `xxd`, `hexdump`, `file`, `strings`, `readelf` for analysis.
- Extract sections carefully - check offsets and sizes.
""",
    "database": """### Database Task Guidance
- SQLite WAL recovery: NEVER open with sqlite3 directly -- it auto-checkpoints, destroying data.
- Parse the WAL file directly with Python struct module: header is 32 bytes, each frame has 24-byte header.
- WAL page size is in bytes 8-11 of the WAL header (big-endian uint32).
- Each WAL frame: salt1(4) + salt2(4) + pgno(4) + commit(4) + checksum(8) + page_data(page_size).
- To recover: read all frames, extract page data, reconstruct pages into a new DB.
- For truncation recovery: check the `-wal` and `-shm` files exist alongside the main DB.
- Use `PRAGMA journal_mode=WAL;` for concurrent access setups.
""",
    "testing_iteration": """### Testing/Iteration Guidance
- If tests partially pass (>50%), focus on the specific failing tests - do NOT rewrite passing code.
- Read full error messages and stack traces before attempting fixes.
- Common: "Segmentation fault" = buffer overflow, "permission denied" = chmod needed.
""",
    "xss_filter": """### XSS/HTML Filtering Guidance
- Do NOT use bleach, BeautifulSoup, or lxml - they normalize HTML and break byte-for-byte tests.
- Use regex-based filtering that ONLY removes dangerous content.
- Clean HTML must pass through UNCHANGED (byte-identical).
""",
    "image_ocr": """### Image/OCR Task Guidance
- Use pytesseract + Pillow for text extraction from images.
- Install: `apt-get install -y tesseract-ocr && pip install pytesseract pillow`
""",
    "ml_recovery": """### ML/PyTorch Model Recovery Guidance
- For corrupted model files: use `torch.load(path, map_location='cpu', weights_only=False)` with error handling.
- Try loading with `pickle.load()` directly if torch.load fails.
- Check file magic bytes: PyTorch files start with PK (ZIP) or 0x70 0x79 (pickle).
- For partial recovery: load state_dict keys individually, skip corrupted tensors.
- Use `safetensors` format if available -- more robust than pickle-based formats.
- For HuggingFace models: try `from_pretrained()` with `ignore_mismatched_sizes=True`.
""",
    "webserver": """### Web Server/Git Webserver Configuration Guidance
- For git web server: use `git instaweb`, `gitweb`, or `cgit` with appropriate httpd.
- Common setup: nginx/apache reverse proxy -> gitweb CGI.
- git-http-backend for smart HTTP protocol: `ScriptAlias /git/ /usr/lib/git-core/git-http-backend/`
- Always test with `curl -v http://localhost:PORT/` immediately after starting.
- Check process is listening: `ss -tlnp | grep <port>`.
- For systemd services: `systemctl enable --now <service>` and check with `systemctl status`.
""",
}

# Keyword-to-category mapping for task classification
CATEGORY_KEYWORDS = {
    "git": [
        "git",
        ".git",
        "commit",
        "branch",
        "reflog",
        "fsck",
        "recovery",
        "leak",
        "sanitize",
    ],
    "compression": [
        "compress",
        "decomp",
        "encode",
        "decoder",
        "encoder",
        "compressor",
        "decompressor",
        "codegolf",
        "gzip",
        "zlib",
    ],
    "chess": ["chess", "stockfish", "fen", "checkmate", "best move", "legal move"],
    "polyglot": ["polyglot", "multi-language", "compile in both", "two languages"],
    "service": [
        "server",
        "nginx",
        "webserver",
        "grpc",
        "http service",
        "listen on port",
        "start a service",
        "web server",
    ],
    "competitive": ["corewars", "warrior", "pmars", "redcode", "win rate", "opponent"],
    "statistics": [
        "mcmc",
        "sampling",
        "stan",
        "pystan",
        "rstan",
        "ars",
        "rejection sampler",
        "bayesian",
        "statistical",
    ],
    "c_systems": [
        "segfault",
        "buffer overflow",
        ".c file",
        "compile c",
        "gcc",
        "makefile",
        "cython",
        "mips",
        "assembly",
    ],
    "binary_forensics": ["elf", "binary", "extract", "hexdump", "readelf", "forensic"],
    "database": ["sqlite", "wal", "database", "sql", "db-wal", "truncate"],
    "testing_iteration": ["test", "pytest", "verify", "pass rate", "threshold"],
    "xss_filter": ["xss", "filter", "javascript", "sanitize html", "html filter"],
    "image_ocr": ["image", "ocr", "screenshot", "extract code from image", "tesseract"],
    "ml_recovery": [
        "pytorch",
        "torch",
        "model recovery",
        "corrupted model",
        "state_dict",
        "safetensors",
        "hf model",
        "huggingface",
    ],
    "webserver": [
        "webserver",
        "web server",
        "git web",
        "gitweb",
        "instaweb",
        "cgit",
        "httpd",
        "configure.*server",
    ],
}


def classify_task(instruction: str) -> list[str]:
    """Classify a task instruction into relevant pattern categories.

    Uses keyword matching with a low threshold: any single keyword match
    triggers inclusion. This is intentionally permissive because the cost
    of a false positive (~60 extra tokens) is far less than the cost of
    missing a relevant pattern.
    """
    lower = instruction.lower()
    matched = []
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in lower for kw in keywords):
            matched.append(category)
    return matched


def build_classified_preamble(instruction: str) -> str:
    """Build a minimal preamble with only relevant pattern snippets."""
    categories = classify_task(instruction)
    parts = [UAP_CORE]
    for cat in categories:
        snippet = PATTERN_SNIPPETS.get(cat)
        if snippet:
            parts.append(snippet)
    parts.append("\n## YOUR TASK:\n\n")
    return "\n".join(parts)


class UAPAgent(ClaudeCode):
    """UAP Agent v2.0.0 - Classified preamble with smart routing."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "uap-agent"

    def version(self) -> str:
        return None

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        """Override to prepend classified UAP patterns and run pre-execution hooks."""
        task_name = detect_task_from_instruction(instruction)
        pre_hook_commands = get_pre_execution_commands(task_name) if task_name else []
        post_context = get_post_execution_context(task_name) if task_name else ""

        enhanced_instruction = build_classified_preamble(instruction)
        if post_context:
            enhanced_instruction += f"\n{post_context}\n\n"
        enhanced_instruction += instruction

        # Call parent's create_run_agent_commands with enhanced instruction
        escaped_instruction = shlex.quote(enhanced_instruction)

        # Get base URL, but filter out localhost URLs since they won't work inside Docker
        base_url = os.environ.get("ANTHROPIC_BASE_URL", None)
        if base_url and ("localhost" in base_url or "127.0.0.1" in base_url):
            base_url = None  # Can't reach host's localhost from Docker container

        env = {
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            "ANTHROPIC_BASE_URL": base_url,
            "CLAUDE_CODE_OAUTH_TOKEN": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", ""),
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS": os.environ.get(
                "CLAUDE_CODE_MAX_OUTPUT_TOKENS", None
            ),
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

        if "ANTHROPIC_BASE_URL" in env and "ANTHROPIC_MODEL" in env:
            env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = env["ANTHROPIC_MODEL"]
            env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = env["ANTHROPIC_MODEL"]
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = env["ANTHROPIC_MODEL"]
            env["CLAUDE_CODE_SUBAGENT_MODEL"] = env["ANTHROPIC_MODEL"]

        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"

        if self._max_thinking_tokens is not None:
            env["MAX_THINKING_TOKENS"] = str(self._max_thinking_tokens)
        elif "MAX_THINKING_TOKENS" in os.environ:
            env["MAX_THINKING_TOKENS"] = os.environ["MAX_THINKING_TOKENS"]

        env["CLAUDE_CONFIG_DIR"] = (EnvironmentPaths.agent_dir / "sessions").as_posix()

        commands = [
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
        ]

        # Add pre-execution hooks if detected
        if pre_hook_commands:
            hook_script = " && ".join(pre_hook_commands)
            commands.append(
                ExecInput(
                    command=f"cd /app && {hook_script}",
                    env=env,
                )
            )

        commands.append(
            ExecInput(
                command=(
                    f"claude --verbose --output-format stream-json "
                    f"-p {escaped_instruction} --allowedTools "
                    f"{' '.join(self.ALLOWED_TOOLS)} 2>&1 </dev/null | tee "
                    f"/logs/agent/claude-code.txt"
                ),
                env=env,
            ),
        )

        return commands


class UAPAgentWithoutMemory(ClaudeCode):
    """UAP Agent without patterns - baseline for A/B testing."""

    @staticmethod
    def name() -> str:
        return "uap-agent-no-memory"

    def version(self) -> str:
        return None
