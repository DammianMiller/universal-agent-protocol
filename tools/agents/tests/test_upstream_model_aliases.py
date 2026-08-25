#!/usr/bin/env python3
"""An advertised alias is a servable model id.

llama-server registers aliases in a std::set and reports ONE primary `id` --
`*begin()`, i.e. the ASCII-first entry -- alongside an `aliases` array carrying
all of them. The proxy read only `id`, so every client configured with any other
registered alias looked unservable and had its model rewritten on EVERY request
(MODEL REWRITE, 6 in a 3h window on 2026-08-25).

That made --alias half-useless for the thing it was added to fix: naming legacy
ids alongside a new one so an older client config keeps resolving untouched.
"""

import asyncio
import importlib.util
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)

    def json(self):
        return self._payload


class _FakeClient:
    """Stands in for the httpx client; records nothing, just answers /models."""

    def __init__(self, payload, status_code=200):
        self._response = _FakeResponse(payload, status_code)

    async def get(self, _url, timeout=None):  # noqa: ARG002 - signature parity
        return self._response


class UpstreamModelAliasTests(unittest.TestCase):
    def setUp(self):
        # The result is cached in a module global for the process lifetime.
        self._saved_client = proxy.http_client
        proxy._upstream_model_ids = None

    def tearDown(self):
        proxy.http_client = self._saved_client
        proxy._upstream_model_ids = None

    def _ids(self, payload, status_code=200):
        proxy.http_client = _FakeClient(payload, status_code)
        return asyncio.run(proxy._upstream_model_ids_cached())

    def test_aliases_are_reported_as_served_ids(self):
        ids = self._ids(
            {
                "data": [
                    {
                        "id": "Qwen3.8-27B",
                        "aliases": ["Qwen3.8-27B", "qwen36-35b-a3b-iq4xs", "qwen35-a3b-iq4xs"],
                    }
                ]
            }
        )
        # The legacy ids are exactly the ones that were being rewritten.
        self.assertIn("qwen36-35b-a3b-iq4xs", ids)
        self.assertIn("qwen35-a3b-iq4xs", ids)
        self.assertIn("Qwen3.8-27B", ids)

    def test_the_primary_id_stays_first(self):
        # Callers pick ids[0] as the rewrite target, so the primary must lead
        # even though it also appears in the aliases array.
        ids = self._ids({"data": [{"id": "Primary", "aliases": ["Primary", "Alt"]}]})
        self.assertEqual(ids[0], "Primary")

    def test_the_primary_id_is_not_duplicated_by_its_own_alias_entry(self):
        # llama-server lists the primary inside `aliases` too.
        ids = self._ids({"data": [{"id": "Same", "aliases": ["Same"]}]})
        self.assertEqual(ids, ["Same"])

    def test_a_payload_with_no_aliases_key_still_works(self):
        # Older llama-server builds, and any other OpenAI-compatible upstream.
        ids = self._ids({"data": [{"id": "OnlyId"}]})
        self.assertEqual(ids, ["OnlyId"])

    def test_junk_entries_are_skipped_rather_than_raising(self):
        # Discovery must never take the proxy down.
        ids = self._ids(
            {
                "data": [
                    "not-a-dict",
                    {"no_id": True},
                    {"id": "Good", "aliases": [None, "", "AlsoGood"]},
                ]
            }
        )
        self.assertEqual(ids, ["Good", "AlsoGood"])

    def test_a_non_200_yields_no_ids(self):
        self.assertIsNone(self._ids({"data": [{"id": "x"}]}, status_code=503))


if __name__ == "__main__":
    unittest.main()
