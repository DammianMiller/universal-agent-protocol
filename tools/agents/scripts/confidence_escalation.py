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


# ---- #2 recipe selection --------------------------------------------------
def select_recipe(anthropic_body: dict, settings: Settings, has_tools: bool) -> str:
    if not settings.enabled or has_tools:
        return "single"
    if settings.recipe != "auto":
        return settings.recipe
    # Auto: signal-driven. Longer/harder prompts have higher reasoning variance
    # -> fusion (breadth+judge); shorter -> confidence (cheap, escalate if weak).
    if len(latest_user_text(anthropic_body)) >= settings.auto_fusion_chars and settings.backend_configured():
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
