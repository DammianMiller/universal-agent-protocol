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
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass


@dataclass
class Settings:
    enabled: bool
    recipe: str
    signal: str
    threshold: float
    fusion_n: int
    remom_quorum: int
    auto_fusion_chars: int
    model: str
    endpoint: str
    api_key: str
    allow_self_judge: bool = False

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
        if recipe not in {"auto", "single", "confidence", "fusion", "ratings", "remom", "workflow"}:
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
            remom_quorum=max(1, min(6, num("PROXY_REMOM_QUORUM", 2, int))),
            auto_fusion_chars=num("PROXY_AUTO_FUSION_CHARS", 600, int),
            model=os.environ.get("PROXY_ESCALATE_MODEL", ""),
            endpoint=os.environ.get("PROXY_ESCALATE_ENDPOINT", ""),
            api_key=os.environ.get("PROXY_ESCALATE_API_KEY", ""),
            allow_self_judge=flag("PROXY_ALLOW_SELF_JUDGE"),
        )

    def backend_configured(self) -> bool:
        return bool(self.model and self.endpoint)

    def judge_is_self(self, primary_model: str = "") -> bool:
        """True when the configured judge model name matches the primary
        (generator) model -- i.e. qwen judging qwen."""
        pm = (primary_model or "").strip().lower()
        jm = (self.model or "").strip().lower()
        return bool(pm) and bool(jm) and pm == jm

    def judge_available(self, primary_model: str = "") -> bool:
        """A judge backend that is configured AND distinct from the primary
        model. A same-model judge (qwen judging qwen) was MEASURED to add no
        quality lift, so judge-dependent recipes (fusion / ratings / remom and
        confidence-escalation) require a distinct judge by default and otherwise
        downgrade to single. Set PROXY_ALLOW_SELF_JUDGE=1 to force self-judging.
        When the primary model is unknown the judge is treated as distinct."""
        if not self.backend_configured():
            return False
        if self.allow_self_judge:
            return True
        return not self.judge_is_self(primary_model)


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


# ---- cross-process: consume the harness reactor's actual routeResult ----
# The reactor (TS, in the harness) writes a per-prompt signal keyed by a hash of
# the normalized prompt, plus a rolling latest.json. The proxy reads it here so
# recipe selection uses the reactor's real capability/complexity routing rather
# than re-deriving it. Falls back to the proxy's own signal extraction on miss.
def _default_signal_dir() -> str:
    return os.environ.get("UAP_RECIPE_SIGNAL_DIR") or os.path.join(
        os.path.expanduser("~"), ".cache", "uap", "recipe-signals"
    )


def normalize_prompt(text: str) -> str:
    return " ".join((text or "").strip().lower().split())


def prompt_hash(text: str) -> str:
    return hashlib.sha1(normalize_prompt(text).encode("utf-8")).hexdigest()


def load_reactor_signal(prompt_text, signal_dir=None, ttl=180.0, now=None):
    """Return the reactor's signal dict for this prompt, or None. Exact
    prompt-hash match first; then a recent latest.json fallback (single-session
    common case). Fresh within ttl seconds. Never raises."""
    d = signal_dir or _default_signal_dir()
    now = time.time() if now is None else now
    for path in (os.path.join(d, prompt_hash(prompt_text) + ".json"), os.path.join(d, "latest.json")):
        try:
            if os.path.exists(path):
                with open(path) as f:
                    sig = json.load(f)
                if now - float(sig.get("ts", 0)) <= ttl:
                    return sig
        except Exception:
            continue
    return None


# ---- cross-process: consume the LLM-Self-Tuning real-time adaptor (P4) --------
# The offline tuner finds a good STATIC config; the real-time adaptor writes a
# per-session adjustment (escalate / recipe / recon threshold / force-synthesis)
# from LIVE signals it observes out-of-band (tool-failure rate, per-turn quality,
# context pressure). The proxy freezes PROXY_* at startup and has no reload
# endpoint, so — exactly like the recipe signal — this is a file-signal read per
# request. OPT-IN via PROXY_REALTIME_ADAPT so default behavior is unchanged.
def _adaptation_signal_dir() -> str:
    return os.environ.get("UAP_ADAPTATION_SIGNAL_DIR") or os.path.join(
        os.path.expanduser("~"), ".cache", "uap", "adaptation-signals"
    )


def realtime_adapt_enabled() -> bool:
    return str(os.environ.get("PROXY_REALTIME_ADAPT", "")).strip().lower() in (
        "1",
        "true",
        "on",
        "yes",
    )


def load_adaptation_signal(session_id=None, signal_dir=None, ttl=180.0, now=None):
    """Return the fresh real-time adaptation signal dict, or None. Per-session
    file first when session_id is given, then a rolling latest.json (single-
    session common case). Fresh within ttl seconds. Never raises."""
    d = signal_dir or _adaptation_signal_dir()
    now = time.time() if now is None else now
    candidates = []
    if session_id:
        safe = "".join(c if (c.isalnum() or c in "_-") else "_" for c in str(session_id)) or "session"
        candidates.append(os.path.join(d, safe + ".json"))
    candidates.append(os.path.join(d, "latest.json"))
    for path in candidates:
        try:
            if os.path.exists(path):
                with open(path) as f:
                    sig = json.load(f)
                if now - float(sig.get("ts", 0)) <= ttl:
                    return sig
        except Exception:
            continue
    return None


def select_recipe(anthropic_body: dict, settings: Settings, has_tools: bool) -> str:
    if not settings.enabled or has_tools:
        return "single"
    if settings.recipe != "auto":
        return settings.recipe
    pm = (anthropic_body or {}).get("model", "")
    text = latest_user_text(anthropic_body)
    # Prefer the harness reactor's ACTUAL routeResult signal when fresh; else the
    # proxy's own signal extraction (faithful port of query-complexity).
    rsig = load_reactor_signal(text)
    if rsig is not None:
        rec = rsig.get("recipe")
        if rec in {"single", "confidence", "fusion"}:
            if rec == "fusion" and not settings.judge_available(pm):
                return "confidence"
            return rec
        complexity = rsig.get("complexity") or query_complexity(text)
        shape = rsig.get("shape") or task_shape(text)
    else:
        complexity = query_complexity(text)
        shape = task_shape(text)
    if settings.judge_available(pm) and (complexity == "complex" or shape == "reasoning"):
        chosen = "fusion"
    elif settings.judge_available(pm) and len(text) >= settings.auto_fusion_chars:
        chosen = "fusion"
    else:
        chosen = "confidence"
    # Real-time adaptation (opt-in): a fresh per-session signal may escalate this
    # turn to the judge (e.g. tool-failure spike or a quality dip observed live).
    if realtime_adapt_enabled() and settings.judge_available(pm):
        asig = load_adaptation_signal()
        if asig and (asig.get("escalate") or asig.get("recipe") == "fusion"):
            chosen = "fusion"
    return chosen


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


def build_synthesis_payload(anthropic_body: dict, candidate_texts: list[str], settings: Settings) -> dict:
    q = latest_user_text(anthropic_body)
    listing = "\n\n".join(f"[{i}]\n{t}" for i, t in enumerate(candidate_texts))
    prompt = (
        "Synthesize a SINGLE best answer to the REQUEST by merging the correct, "
        "complementary parts of the candidate answers below. Resolve disagreements "
        "and keep the required output format. Reply with ONLY the final answer."
        "\n\nREQUEST:\n" + q + "\n\nCANDIDATES:\n" + listing
    )
    return {"model": settings.model, "max_tokens": anthropic_body.get("max_tokens", 4096),
            "messages": [{"role": "user", "content": prompt}]}


async def _fanout_candidates(primary_resp, openai_body, settings, call_primary):
    """[primary] + up to fusion_n-1 temperature-varied breadth candidates."""
    variants = build_fusion_variants(openai_body or {}, settings.fusion_n)
    results = await asyncio.gather(*[call_primary(v) for v in variants], return_exceptions=True)
    return [primary_resp] + [r for r in results if isinstance(r, dict)]


def should_escalate(text: str, settings: Settings, has_tools: bool) -> bool:
    """Back-compat (heuristic confidence path)."""
    if not settings.enabled or not settings.backend_configured() or has_tools:
        return False
    return text_confidence(text) < settings.threshold


# ---- orchestration (injected callables) -----------------------------------
async def _confidence_score(text, anthropic_body, settings, call_judge, primary_model=""):
    if settings.signal == "selfverify" and settings.judge_available(primary_model) and call_judge is not None:
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
        primary_model = (openai_body or {}).get("model", "")
        # Judge-dependent recipes need a configured, DISTINCT (non-self) judge.
        # A same-model judge adds no measured lift, so downgrade to single BEFORE
        # spending fan-out / judge calls.
        if recipe in {"fusion", "ratings", "remom"} and not settings.judge_available(primary_model):
            return primary_resp

        if recipe == "confidence":
            conf = await _confidence_score(primary_text, anthropic_body, settings, call_judge, primary_model)
            if conf < settings.threshold and settings.judge_available(primary_model) and call_judge is not None:
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

        if recipe == "ratings":
            # Bounded ensemble: rate each candidate independently, pick the best.
            candidates = await _fanout_candidates(primary_resp, openai_body, settings, call_primary)
            if len(candidates) <= 1 or not settings.backend_configured() or call_judge is None:
                return primary_resp
            rs = await asyncio.gather(
                *[call_judge(build_verify_payload(anthropic_body, extract_text(c), settings))
                  for c in candidates],
                return_exceptions=True,
            )
            scored = []
            for c, jr2 in zip(candidates, rs):
                sc = parse_verify_score(extract_text(jr2)) if isinstance(jr2, dict) else None
                scored.append((sc if sc is not None else text_confidence(extract_text(c)), c))
            return max(scored, key=lambda x: x[0])[1]

        if recipe == "remom":
            # Breadth -> quorum -> synthesis into the output contract; fall back
            # to the best valid evidence if synthesis fails (no API error).
            candidates = await _fanout_candidates(primary_resp, openai_body, settings, call_primary)
            valid = [c for c in candidates if extract_text(c).strip()]
            if len(valid) >= settings.remom_quorum and settings.backend_configured() and call_judge is not None:
                synth = await call_judge(
                    build_synthesis_payload(anthropic_body, [extract_text(c) for c in valid], settings)
                )
                if isinstance(synth, dict) and extract_text(synth).strip():
                    return synth
            return max(valid, key=lambda c: len(extract_text(c))) if valid else primary_resp

        if recipe == "workflow":
            # Workflows (planner/patcher/verifier under a contract) are the
            # deliver convergence loop's job — it owns the real execution +
            # acceptance gates and repo state a stateless serving turn lacks.
            # Pass through; the harness routes workflow tasks through uap deliver.
            return primary_resp
    except Exception:
        return primary_resp
    return primary_resp
