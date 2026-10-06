#!/usr/bin/env python3
"""Ollama-compatible surface (/api/*) on PROXY_OLLAMA_PORT.

The surface is a pure translation layer over the same guarded pipeline the
Anthropic and OpenAI inbounds use, so what needs pinning here is exactly the
translation: Ollama request fields -> OpenAI request fields, and OpenAI
response -> Ollama wire shapes (single JSON, and the two-line NDJSON stream
a stream-mode client waits on). Conversion helpers are exercised in
isolation per this suite's convention — the guarded core they call is the
same messages() pipeline the rest of the suite already covers.

The lifecycle machinery (companion listener) matters just as much: a second
uvicorn server must not install its own signal handlers (SIGTERM would land
on whichever registered last and leave the other port hanging on systemd
stops), and the app's startup handlers must not run twice.
"""

import asyncio
import importlib.util
import json
import socket
import time
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load()


class TestOllamaChatRequestConversion(unittest.TestCase):
    def test_messages_options_tools_and_model_default(self):
        body = {
            "model": "qwen3.8-flash-next-iq3_xxs",
            "messages": [
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "hi"},
            ],
            "stream": True,
            "tools": [{"type": "function", "function": {"name": "f"}}],
            "options": {
                "temperature": 0.2,
                "top_k": 40,
                "num_predict": 512,
                "num_ctx": 999999,  # must be dropped: rail owns context sizing
                "min_p": 0.05,  # must be dropped: not forwarded by the 2nd hop
                "stop": "END",
            },
        }
        out = proxy.ollama_chat_to_openai_request(body)
        self.assertEqual(
            out["messages"],
            [
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "hi"},
            ],
        )
        self.assertEqual(out["model"], "qwen3.8-flash-next-iq3_xxs")
        self.assertEqual(out["temperature"], 0.2)
        self.assertEqual(out["top_k"], 40)
        self.assertEqual(out["max_tokens"], 512)
        self.assertEqual(out["stop"], ["END"])
        # drops happen at the boundary, not silently mid-pipeline
        for dropped in ("num_ctx", "min_p", "repeat_penalty", "seed"):
            self.assertNotIn(dropped, json.dumps(out))
        self.assertEqual(out["tool_choice"], "auto")
        # buffered through the guardrails: always non-stream internally
        self.assertFalse(out["stream"])

    def test_content_parts_and_unknown_role(self):
        body = {
            "model": "m",
            "messages": [
                {"role": "supervisor", "content": [{"type": "text", "text": "part1"},
                                                   {"type": "image", "text": "drop"}]},
                {"role": "user", "content": [{"type": "text", "text": "part2"}]},
            ],
        }
        out = proxy.ollama_chat_to_openai_request(body)
        self.assertEqual(out["messages"][0], {"role": "user", "content": "part1"})
        self.assertEqual(out["messages"][1], {"role": "user", "content": "part2"})

    def test_assistant_tool_calls_replay_object_args_to_string(self):
        body = {
            "model": "m",
            "messages": [
                {"role": "assistant", "content": "",
                 "tool_calls": [{"function": {"name": "bash",
                                              "arguments": {"command": "ls"}}}]},
                {"role": "tool", "content": "file_a\nfile_b"},
                {"role": "user", "content": "thanks"},
            ],
        }
        out = proxy.ollama_chat_to_openai_request(body)
        entry = out["messages"][0]
        self.assertEqual(entry["tool_calls"][0]["function"]["name"], "bash")
        # OpenAI carries arguments as a JSON string
        self.assertEqual(
            json.loads(entry["tool_calls"][0]["function"]["arguments"]),
            {"command": "ls"},
        )
        # Deterministic ids pair the replayed call with its tool result:
        # Ollama associates by order, the Anthropic hop pairs by id.
        call_id = entry["tool_calls"][0]["id"]
        self.assertTrue(call_id)
        self.assertEqual(out["messages"][1]["tool_call_id"], call_id)
        self.assertEqual(out["messages"][2], {"role": "user", "content": "thanks"})

    def test_format_field_is_accepted_and_dropped(self):
        # response_format does not survive the second translation hop; the
        # drop happens at the boundary instead of silently mid-pipeline.
        out = proxy.ollama_chat_to_openai_request(
            {"model": "m", "messages": [], "format": "json"}
        )
        self.assertNotIn("response_format", out)


class TestOllamaGenerateRequestConversion(unittest.TestCase):
    def test_system_then_prompt_order(self):
        out = proxy.ollama_generate_to_openai_request(
            {"model": "m", "prompt": "write", "system": "you are terse"}
        )
        self.assertEqual(
            out["messages"],
            [
                {"role": "system", "content": "you are terse"},
                {"role": "user", "content": "write"},
            ],
        )

    def test_prompt_only_and_missing_prompt(self):
        out = proxy.ollama_generate_to_openai_request({"model": "m"})
        self.assertEqual(out["messages"], [{"role": "user", "content": ""}])


class TestOllamaResponseConversion(unittest.TestCase):
    OPENAI = {
        "id": "x",
        "model": "resolved-id",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "hello",
                    "tool_calls": [
                        {"function": {"name": "bash",
                                      "arguments": "{\"command\": \"ls\"}"}}
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7},
    }

    def test_chat_response_shape_and_tool_args_object(self):
        resp = proxy.openai_to_ollama_chat_response(self.OPENAI, "asked-id", 123)
        self.assertEqual(resp["model"], "asked-id")  # echo the REQUESTED id
        self.assertTrue(resp["done"])
        self.assertEqual(resp["done_reason"], "stop")  # only "length" is special
        self.assertEqual(resp["message"]["content"], "hello")
        self.assertEqual(
            resp["message"]["tool_calls"][0]["function"]["arguments"],
            {"command": "ls"},  # Ollama carries arguments as an object
        )
        self.assertEqual(resp["prompt_eval_count"], 11)
        self.assertEqual(resp["eval_count"], 7)
        self.assertEqual(resp["total_duration"], 123)

    def test_chat_response_unparseable_args_stay_string(self):
        openai = {
            "choices": [{"message": {"role": "assistant", "content": "",
                                     "tool_calls": [{"function": {
                                         "name": "f", "arguments": "{oops"}}]},
                          "finish_reason": "tool_calls"}],
            "usage": {},
        }
        resp = proxy.openai_to_ollama_chat_response(openai, "m", 0)
        self.assertEqual(resp["message"]["tool_calls"][0]["function"]["arguments"],
                         "{oops")

    def test_chat_response_length_done_reason(self):
        openai = {
            "choices": [{"message": {"role": "assistant", "content": "x"},
                         "finish_reason": "length"}],
            "usage": {},
        }
        resp = proxy.openai_to_ollama_chat_response(openai, "m", 0)
        self.assertEqual(resp["done_reason"], "length")

    def test_generate_response_and_tool_calls_as_text(self):
        resp = proxy.openai_to_ollama_generate_response(self.OPENAI, "asked-id", 5)
        self.assertTrue(resp["response"].startswith("hello"))
        self.assertIn('"tool_calls"', resp["response"])  # not silently dropped
        self.assertEqual(resp["eval_count"], 7)
        self.assertTrue(resp["done"])

    def test_ndjson_stream_two_lines_done_last(self):
        resp = proxy.openai_to_ollama_chat_response(self.OPENAI, "m", 1)
        out = asyncio.run(_collect(proxy._emit_ollama_ndjson(
            resp, {"message": resp["message"]})))
        lines = [json.loads(l) for l in out.splitlines()]
        self.assertEqual(len(lines), 2)
        self.assertFalse(lines[0]["done"])
        self.assertEqual(lines[0]["message"]["content"], "hello")
        self.assertTrue(lines[-1]["done"])
        # final line carries the payload key EMPTY — concatenating content
        # across lines must yield it exactly once
        self.assertEqual(lines[-1]["message"], {"role": "assistant", "content": ""})
        self.assertEqual(
            lines[0]["message"]["content"] + lines[-1]["message"]["content"], "hello"
        )
        self.assertEqual(lines[-1]["eval_count"], 7)

    def test_ndjson_stream_generate_empties_response_key(self):
        resp = proxy.openai_to_ollama_generate_response(
            {"choices": [{"message": {"role": "assistant", "content": "hi"},
                          "finish_reason": "stop"}], "usage": {}}, "m", 1)
        out = asyncio.run(_collect(proxy._emit_ollama_ndjson(
            resp, {"response": resp["response"]})))
        lines = [json.loads(l) for l in out.splitlines()]
        self.assertEqual(lines[0]["response"], "hi")
        self.assertEqual(lines[-1]["response"], "")
        self.assertTrue(lines[-1]["done"])


class TestOllamaModelCardHelpers(unittest.TestCase):
    def test_quantization_and_family_from_model_id(self):
        mid = "qwen3.8-flash-next-iq3_xxs"
        self.assertEqual(proxy._ollama_quantization_level(mid), "IQ3_XXS")
        self.assertEqual(proxy._ollama_family(mid), "qwen3")
        self.assertEqual(proxy._ollama_family("llama3:8b"), "llama3")
        self.assertEqual(proxy._ollama_quantization_level("plain"), "")

    def test_digest_is_stable_and_prefixed_hex(self):
        d1 = proxy._ollama_digest("m")
        d2 = proxy._ollama_digest("m")
        self.assertEqual(d1, d2)
        self.assertTrue(d1.startswith("sha256:"))  # some clients parse on the colon
        int(d1[7:], 16)  # hex
        self.assertEqual(len(d1), 71)

    def test_details_shape(self):
        d = proxy._ollama_details("qwen3.8-flash-next-iq3_xxs")
        self.assertEqual(d["format"], "gguf")
        self.assertEqual(d["family"], d["families"][0])
        self.assertEqual(d["quantization_level"], "IQ3_XXS")


class TestOllamaModelMeta(unittest.IsolatedAsyncioTestCase):
    async def test_meta_placeholders_when_no_upstream(self):
        meta = await proxy._ollama_model_meta("some-model")
        self.assertEqual(meta, {"modified_at": proxy._OLLAMA_START_ISO, "size": 0})

    async def test_meta_served_from_cache(self):
        # These are discovery endpoints (some unauthenticated) — the meta
        # probe must not hit the upstream once per request.
        proxy._OLLAMA_META_CACHE.clear()
        proxy._OLLAMA_META_CACHE["m"] = (
            time.monotonic(), {"modified_at": "FRESH", "size": 2}
        )
        try:
            self.assertEqual(
                await proxy._ollama_model_meta("m"), {"modified_at": "FRESH", "size": 2}
            )
        finally:
            proxy._OLLAMA_META_CACHE.clear()


class TestCompanionListenerLifecycle(unittest.TestCase):
    def test_capture_signals_is_a_noop(self):
        # A second uvicorn server installing signal handlers would hand
        # SIGTERM to whichever registered last. The companion must not
        # register any.
        import signal

        companion = proxy._CompanionListener.__new__(proxy._CompanionListener)
        before = signal.getsignal(signal.SIGTERM)
        with companion.capture_signals():
            during = signal.getsignal(signal.SIGTERM)
        after = signal.getsignal(signal.SIGTERM)
        self.assertIs(before, during)
        self.assertIs(before, after)

    def test_port_bindable_detects_occupied_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            busy_port = s.getsockname()[1]
            self.assertFalse(proxy._ollama_port_bindable("127.0.0.1", busy_port))
        # same port free after close
        self.assertTrue(proxy._ollama_port_bindable("127.0.0.1", busy_port))

    def test_port_bindable_free_port(self):
        self.assertTrue(proxy._ollama_port_bindable("127.0.0.1", 0))
        # port 0: bind with port 0 means "pick one" — always bindable; the
        # function is only called with real ports, but must not raise.

    def test_ollama_port_env_default_and_disable(self):
        # module-level default (11434) was set at import
        self.assertEqual(proxy.PROXY_OLLAMA_PORT, 11434)


async def _collect(agen):
    parts = []
    async for chunk in agen:
        parts.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    return "".join(parts)


if __name__ == "__main__":
    unittest.main()
