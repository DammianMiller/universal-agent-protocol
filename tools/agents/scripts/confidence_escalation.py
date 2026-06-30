"""Confidence-escalation looper (vLLM Semantic Router "Confidence" recipe).

Try the cheap primary model first; if a confidence signal on its answer is below
threshold, escalate the SAME request to a stronger backend and return that
answer instead. Bounded (one escalation), default OFF, fails open. Scoped to
non-tool (single-answer) turns — escalating a mid-loop tool turn would need the
stronger model to share the whole tool/context state, which is out of scope for
this primitive.

The confidence signal is intentionally pluggable. This module ships a cheap
text heuristic; a stronger signal (token logprob margin, or UAP's real
execution/acceptance GATE-pass — the differentiator vs logprob) can replace
``text_confidence`` without touching the proxy hook.

All config is env-driven and OFF by default:
  PROXY_CONFIDENCE_ESCALATE=on        enable the looper
  PROXY_CONFIDENCE_THRESHOLD=0.5      escalate when confidence < this
  PROXY_ESCALATE_MODEL=<id>           model id sent to the escalation backend
  PROXY_ESCALATE_ENDPOINT=<url>       Anthropic-compatible /v1/messages base
  PROXY_ESCALATE_API_KEY=<key>        x-api-key for the escalation backend
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass


@dataclass
class Settings:
    enabled: bool
    threshold: float
    model: str
    endpoint: str
    api_key: str

    @classmethod
    def from_env(cls) -> "Settings":
        on = os.environ.get("PROXY_CONFIDENCE_ESCALATE", "off").lower() not in {
            "", "0", "off", "false", "no",
        }
        try:
            thr = float(os.environ.get("PROXY_CONFIDENCE_THRESHOLD", "0.5"))
        except ValueError:
            thr = 0.5
        return cls(
            enabled=on,
            threshold=thr,
            model=os.environ.get("PROXY_ESCALATE_MODEL", ""),
            endpoint=os.environ.get("PROXY_ESCALATE_ENDPOINT", ""),
            api_key=os.environ.get("PROXY_ESCALATE_API_KEY", ""),
        )

    def backend_configured(self) -> bool:
        return bool(self.model and self.endpoint)


_UNCERTAIN = re.compile(
    r"\b(i'?m not sure|i am not sure|i don'?t know|i cannot|i can'?t (?:help|do|determine)|"
    r"unable to|not certain|no idea|as an ai|i'?m sorry,? but)\b",
    re.I,
)


def text_confidence(text: str) -> float:
    """Cheap heuristic confidence in [0,1]. Conservative: only clearly weak
    answers (empty, refusal/uncertainty, trivially short) score low."""
    t = (text or "").strip()
    if not t:
        return 0.0
    if _UNCERTAIN.search(t):
        return 0.2
    if len(t) < 20:
        return 0.3
    return 0.9


def extract_text(anthropic_resp: dict) -> str:
    """Concatenate text blocks of an Anthropic message response."""
    parts = []
    for blk in (anthropic_resp or {}).get("content", []) or []:
        if isinstance(blk, dict) and blk.get("type") == "text":
            parts.append(blk.get("text", ""))
    return "".join(parts)


def should_escalate(text: str, settings: Settings, has_tools: bool) -> bool:
    if not settings.enabled or not settings.backend_configured():
        return False
    if has_tools:  # single-answer scope only
        return False
    return text_confidence(text) < settings.threshold


def build_escalation_payload(anthropic_body: dict, settings: Settings) -> dict:
    """Re-issue the same conversation to the stronger model (no tools)."""
    payload = {
        "model": settings.model,
        "max_tokens": anthropic_body.get("max_tokens", 4096),
        "messages": anthropic_body.get("messages", []),
    }
    if anthropic_body.get("system"):
        payload["system"] = anthropic_body["system"]
    return payload
