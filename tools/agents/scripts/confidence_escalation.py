"""Serving-layer recipe runtime (vLLM Semantic Router micro-agent patterns).

One bounded micro-agent loop behind one model API. Recipes:
  - single     : no collaboration (default).
  - confidence : try the cheap primary; if a confidence signal is below
                 threshold, escalate the same single-answer turn to a stronger
                 backend (#1). The signal is pluggable: "heuristic" (cheap text)
                 or "selfverify" (a judge model rates the answer 0-10 -- the
                 gate-as-confidence idea at the serving layer, #5).
  - fusion     : run N breadth candidates from the primary, then a judge picks
                 the best; falls back to the primary on judge failure (#3).
A signal-driven selector (#2) chooses the recipe per request.

All orchestration is via INJECTED async callables (call_primary, call_judge) so
it is testable without a live backend. The proxy supplies real ones. Everything
is OFF by default and fails open.

Env:
  PROXY_CONFIDENCE_ESCALATE=on        master switch
  PROXY_RECIPE=auto|single|confidence|fusion   (default auto)
  PROXY_CONFIDENCE_SIGNAL=heuristic|selfverify (default heuristic)
  PROXY_CONFIDENCE_THRESHOLD=0.5
  PROXY_FUSION_N=3                    candidates incl. the primary (2..6)
  PROXY_AUTO_FUSION_CHARS=600         auto: prompts longer than this -> fusion
  PROXY_ESCALATE_MODEL / _ENDPOINT / _API_KEY   stronger backend (judge/escalate)
"""
from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass


@dataclass
class Settings:
    enabled: bool
    recipe: str
    signal: str
    threshold: float
    fusion_n: int
    auto_fusion_chars: int
    model: str
    endpoint: str
    api_key: str

    @classmethod
    def from_env(cls) -> "Settings":
        def flag(name, default="off"):
            return os.environ.get(name, default).lower() not in {"", "0", "off", "false", "no"}

        def num(name, default, cast=float):
            try:
                return cast(os.environ.get(name, str(default)))
            except (ValueError, TypeError):
                return default

        recipe = os.environ.get("PROXY_RECIPE", "auto").lower()
        if recipe not in {"auto", "single", "confidence", "fusion"}:
            recipe = "auto"
        signal = os.environ.get("PROXY_CONFIDENCE_SIGNAL", "heuristic").lower()
        if signal not in {"heuristic", "selfverify"}:
            signal = "heuristic"
        return cls(
            enabled=flag("PROXY_CONFIDENCE_ESCALATE"),
            recipe=recipe,
            signal=signal,
            threshold=num("PROXY_CONFIDENCE_THRESHOLD", 0.5, float),
            fusion_n=max(2, min(6, num("PROXY_FUSION_N", 3, int))),
            auto_fusion_chars=num("PROXY_AUTO_FUSION_CHARS", 600, int),
            model=os.environ.get("PROXY_ESCALATE_MODEL", ""),
            endpoint=os.environ.get("PROXY_ESCALATE_ENDPOINT", ""),
            api_key=os.environ.get("PROXY_ESCALATE_API_KEY", ""),
        )

    def backend_configured(self) -> bool:
        return bool(self.model and self.endpoint)


# ---- helpers --------------------------------------------------------------
def latest_user_text(anthropic_body: dict) -> str:
    for msg in reversed((anthropic_body or {}).get("messages", []) or []):
        if msg.get("role") != "user":
            continue
        c = msg.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


def extract_text(anthropic_resp: dict) -> str:
    parts = []
    for blk in (anthropic_resp or {}).get("content", []) or []:
        if isinstance(blk, dict) and blk.get("type") == "text":
            parts.append(blk.get("text", ""))
    return "".join(parts)


# ---- #2 recipe selection (reactor-aligned signals) ------------------------
# Faithful port of src/utils/query-complexity.ts (the SAME difficulty signal the
# reactor's capability-router / auto-optimizer use), plus a task-shape signal.
# The serving layer extracts its own signals (vLLM-SR philosophy) so recipe
# choice is task-shaped, not prompt-length guesswork. Optional override:
# the harness may stamp x-uap-task-signal style hints into the request later.
_TECH_PATTERNS = [
    re.compile(r"debug|fix|error|exception|bug", re.I),
    re.compile(r"implement|refactor|optimize|build", re.I),
    re.compile(r"configure|setup|install|deploy", re.I),
    re.compile(r"security|vulnerability|cve|auth", re.I),
    re.compile(r"performance|memory|cpu|latency", re.I),
    re.compile(r"database|query|migration|schema", re.I),
    re.compile(r"test|coverage|mock|spec", re.I),
]
_FILE_RE = re.compile(r"[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|yaml|sh|sql)", re.I)
_MULTISTEP = re.compile(r"and then|after that|followed by|step \d|first.*then|also|additionally", re.I)
_WHYHOW = re.compile(r"^(why|how|what caused|explain)", re.I)
_ACTIONS = re.compile(r"\b(fix|implement|configure|debug|create|update|delete|add|remove)\b", re.I)
_REASONING = re.compile(
    r"\b(prove|derive|theorem|reason|analy[sz]e|compare|evaluate|calculate|which of|true or false)\b"
    r"|\b[A-D]\)\s", re.I,
)
_CODE = re.compile(r"```|\b(function|class|api|endpoint|module|compile|script)\b", re.I)


def complexity_score(text: str) -> float:
    """Port of query-complexity.ts measureQueryComplexity."""
    t = text or ""
    score = 0.0
    wc = len(t.split())
    if wc > 30:
        score += 1.5
    elif wc > 12:
        score += 0.75
    elif wc > 6:
        score += 0.25
    for pat in _TECH_PATTERNS:
        if pat.search(t):
            score += 0.4
    files = _FILE_RE.findall(t)
    score += len(files) * 0.3
    if _MULTISTEP.search(t):
        score += 1.0
    if _WHYHOW.search(t):
        score += 0.5
    actions = _ACTIONS.findall(t)
    if len(actions) > 1:
        score += len(actions) * 0.3
    return score


def query_complexity(text: str) -> str:
    score = complexity_score(text)
    if score >= 2:
        return "complex"
    if score >= 1:
        return "moderate"
    return "simple"


def task_shape(text: str) -> str:
    t = text or ""
    if _REASONING.search(t):
        return "reasoning"
    if _CODE.search(t) or _FILE_RE.search(t) or any(p.search(t) for p in _TECH_PATTERNS[:3]):
        return "code"
    if t.strip().endswith("?") and len(t.split()) <= 14:
        return "qa"
    return "general"


def task_signals(anthropic_body: dict) -> dict:
    text = latest_user_text(anthropic_body)
    return {"complexity": query_complexity(text), "shape": task_shape(text)}


def select_recipe(anthropic_body: dict, settings: Settings, has_tools: bool) -> str:
    if not settings.enabled or has_tools:
        return "single"
    if settings.recipe != "auto":
        return settings.recipe
    # Task-shaped auto-selection (the article's lesson: best loop is task-shaped).
    sig = task_signals(anthropic_body)
    if settings.backend_configured() and (
        sig["complexity"] == "complex" or sig["shape"] == "reasoning"
    ):
        # High reasoning variance / disagreement-prone -> breadth + judge.
        return "fusion"
    # Long-prompt fallback trigger (tunable) keeps the old escape hatch.
    if settings.backend_configured() and len(latest_user_text(anthropic_body)) >= settings.auto_fusion_chars:
        return "fusion"
    return "confidence"


# ---- #1/#5 confidence signal ----------------------------------------------
_UNCERTAIN = re.compile(
    r"\b(i'?m not sure|i am not sure|i don'?t know|i cannot|i can'?t (?:help|do|determine)|"
    r"unable to|not certain|no idea|as an ai|i'?m sorry,? but)\b",
    re.I,
)


def text_confidence(text: str) -> float:
    t = (text or "").strip()
    if not t:
        return 0.0
    if _UNCERTAIN.search(t):
        return 0.2
    if len(t) < 20:
        return 0.3
    return 0.9


def build_verify_payload(anthropic_body: dict, answer_text: str, settings: Settings) -> dict:
    q = latest_user_text(anthropic_body)
    prompt = (
        "Rate from 0 to 10 how well this ANSWER satisfies the REQUEST "
        "(0 = wrong or incomplete, 10 = fully correct and complete). "
        "Reply with ONLY the number.\n\nREQUEST:\n" + q + "\n\nANSWER:\n" + answer_text
    )
    return {"model": settings.model, "max_tokens": 16,
            "messages": [{"role": "user", "content": prompt}]}


def parse_verify_score(text: str):
    m = re.search(r"\d+(?:\.\d+)?", text or "")
    if not m:
        return None
    return max(0.0, min(1.0, float(m.group(0)) / 10.0))


# ---- escalation / fusion payloads -----------------------------------------
def build_escalation_payload(anthropic_body: dict, settings: Settings) -> dict:
    payload = {"model": settings.model,
               "max_tokens": anthropic_body.get("max_tokens", 4096),
               "messages": anthropic_body.get("messages", [])}
    if anthropic_body.get("system"):
        payload["system"] = anthropic_body["system"]
    return payload


def build_fusion_variants(openai_body: dict, n: int) -> list[dict]:
    """N-1 extra primary variants (the live response is candidate 0). Vary
    temperature for breadth; everything else identical."""
    out = []
    for i in range(max(0, n - 1)):
        v = dict(openai_body)
        v["stream"] = False
        v["temperature"] = round(0.4 + 0.2 * i, 2)
        out.append(v)
    return out


def build_judge_payload(anthropic_body: dict, candidate_texts: list[str], settings: Settings) -> dict:
    q = latest_user_text(anthropic_body)
    listing = "\n\n".join(f"[{i}]\n{t}" for i, t in enumerate(candidate_texts))
    prompt = (
        "You are a strict judge. Choose the SINGLE best answer to the REQUEST. "
        "Reply with ONLY the index number of the best answer.\n\nREQUEST:\n"
        + q + "\n\nANSWERS:\n" + listing
    )
    return {"model": settings.model, "max_tokens": 8,
            "messages": [{"role": "user", "content": prompt}]}


def parse_judge_index(text: str, n: int):
    m = re.search(r"\d+", text or "")
    if not m:
        return None
    i = int(m.group(0))
    return i if 0 <= i < n else None


def should_escalate(text: str, settings: Settings, has_tools: bool) -> bool:
    """Back-compat (heuristic confidence path)."""
    if not settings.enabled or not settings.backend_configured() or has_tools:
        return False
    return text_confidence(text) < settings.threshold


# ---- orchestration (injected callables) -----------------------------------
async def _confidence_score(text, anthropic_body, settings, call_judge):
    if settings.signal == "selfverify" and settings.backend_configured() and call_judge is not None:
        jr = await call_judge(build_verify_payload(anthropic_body, text, settings))
        score = parse_verify_score(extract_text(jr)) if isinstance(jr, dict) else None
        if score is not None:
            return score
    return text_confidence(text)


async def apply_recipe(primary_resp, anthropic_body, openai_body, settings, has_tools,
                       call_primary, call_judge):
    """Dispatch to the selected recipe. Returns an anthropic response dict.
    call_primary(openai_variant)->anthropic_resp|None ; call_judge(anthropic_payload)->anthropic_resp|None.
    Fails open: returns primary_resp on any problem."""
    try:
        recipe = select_recipe(anthropic_body, settings, has_tools)
        if recipe == "single" or not isinstance(primary_resp, dict):
            return primary_resp
        primary_text = extract_text(primary_resp)

        if recipe == "confidence":
            conf = await _confidence_score(primary_text, anthropic_body, settings, call_judge)
            if conf < settings.threshold and settings.backend_configured() and call_judge is not None:
                esc = await call_judge(build_escalation_payload(anthropic_body, settings))
                if isinstance(esc, dict):
                    return esc
            return primary_resp

        if recipe == "fusion":
            variants = build_fusion_variants(openai_body or {}, settings.fusion_n)
            results = await asyncio.gather(*[call_primary(v) for v in variants],
                                           return_exceptions=True)
            candidates = [primary_resp] + [r for r in results if isinstance(r, dict)]
            if len(candidates) <= 1 or not settings.backend_configured() or call_judge is None:
                return primary_resp
            texts = [extract_text(c) for c in candidates]
            jr = await call_judge(build_judge_payload(anthropic_body, texts, settings))
            idx = parse_judge_index(extract_text(jr), len(candidates)) if isinstance(jr, dict) else None
            if idx is not None:
                return candidates[idx]
            return primary_resp  # fallback to best valid evidence
    except Exception:
        return primary_resp
    return primary_resp
