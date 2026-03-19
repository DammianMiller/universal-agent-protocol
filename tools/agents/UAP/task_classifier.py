"""
Shared task classification and preamble building for UAP agents.

This module consolidates the duplicated CATEGORY_KEYWORDS and classify_task()
logic that was previously maintained separately in:
  - tools/agents/opencode_uap_agent.py
  - tools/uap_harbor/uap_agent.py

Both agents should import from here to stay in sync.
"""

# Superset of all category keywords from both agent implementations.
# When adding new categories, add them here — both agents inherit automatically.
CATEGORY_KEYWORDS: dict[str, list[str]] = {
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
    "chess": [
        "chess",
        "stockfish",
        "fen",
        "checkmate",
        "best move",
        "legal move",
    ],
    "polyglot": [
        "polyglot",
        "multi-language",
        "compile in both",
        "two languages",
        "works as both",
    ],
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
    "competitive": [
        "corewars",
        "warrior",
        "pmars",
        "redcode",
        "win rate",
        "opponent",
    ],
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
        ".pyx",
        "build_ext",
        "gcov",
        "compile",
        "from source",
    ],
    "binary_forensics": [
        "elf",
        "binary",
        "extract",
        "hexdump",
        "readelf",
        "forensic",
    ],
    "crypto": [
        "7z",
        "7zip",
        "hash",
        "crack",
        "password",
        "john",
        "hashcat",
        "encrypt",
        "decrypt",
        "brute",
    ],
    "database": [
        "sqlite",
        "wal",
        "database",
        "sql",
        "db-wal",
        "truncate",
    ],
    "testing_iteration": [
        "test",
        "pytest",
        "verify",
        "pass rate",
        "threshold",
    ],
    "xss_filter": [
        "xss",
        "filter",
        "javascript",
        "sanitize html",
        "html filter",
    ],
    "image_ocr": [
        "ocr",
        "screenshot",
        "extract code from image",
        "tesseract",
        "image to text",
    ],
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
        "post-receive",
    ],
    "vulnerability": [
        "vulnerability",
        "vulnerabilities",
        "cwe",
        "crlf",
        "injection",
        "security fix",
        "bottle.py",
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


def build_classified_preamble(
    instruction: str,
    core_prompt: str,
    pattern_snippets: dict[str, str],
) -> str:
    """Build a minimal preamble with only relevant pattern snippets.

    Args:
        instruction: The task instruction to classify.
        core_prompt: The base UAP_CORE prompt string.
        pattern_snippets: Map of category -> snippet text.

    Returns:
        Combined preamble with core + matched snippets + task header.
    """
    categories = classify_task(instruction)
    parts = [core_prompt]
    for cat in categories:
        snippet = pattern_snippets.get(cat)
        if snippet:
            parts.append(snippet)
    parts.append("\n## YOUR TASK:\n\n")
    return "\n".join(parts)
