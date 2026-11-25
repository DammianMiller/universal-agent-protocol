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
        # The result is cached in a module global for the process lifetime;
        # the failure-backoff clock is reset with it so one test's failed
        # fetch does not suppress the next test's (tests run milliseconds
        # apart, well inside the retry window).
        self._saved_client = proxy.http_client
        proxy._upstream_model_ids = None
        proxy._upstream_ids_failed_at = 0.0

    def tearDown(self):
        proxy.http_client = self._saved_client
        proxy._upstream_model_ids = None
        proxy._upstream_ids_failed_at = 0.0

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

    def test_a_failed_fetch_backs_off_within_the_window(self):
        # Uplift: full automation — a failed /models fetch is remembered for
        # _UPSTREAM_IDS_RETRY_SECS, so a hung/unreachable upstream costs ONE
        # timeout per window, not one per caller (the handler warmup and the
        # placement resolver both ask). A success still caches for the
        # process lifetime; only the failure backoff is windowed.
        proxy.http_client = _FakeClient({"data": [{"id": "x"}]}, status_code=503)
        self.assertIsNone(asyncio.run(proxy._upstream_model_ids_cached()))
        self.assertGreater(proxy._upstream_ids_failed_at, 0.0)

        class _Boom:
            async def get(self, _url, timeout=None):  # noqa: ARG002
                raise AssertionError("must not refetch inside the backoff window")

        # Inside the window the clock answers — the endpoint is not asked.
        proxy.http_client = _Boom()
        self.assertIsNone(asyncio.run(proxy._upstream_model_ids_cached()))


class ServedIds404RefreshTests(unittest.TestCase):
    """`_maybe_refresh_served_ids_on_404`: recover from a stale ids cache.

    The cache is process-lifetime, so after an arm switch it still names the
    evicted arm. The upstream answers a request carrying the old id with
        HTTP 404  The model old-arm-id does not exist.
                    Valid aliases: qwen3.8-27b
    and the recovery is: clear the cache, re-fetch, re-reconcile, retry once.
    """

    def setUp(self):
        self._saved_client = proxy.http_client
        self._saved_placement = proxy.PROXY_PLACEMENT_MODE
        proxy._upstream_model_ids = None
        proxy._upstream_ids_failed_at = 0.0  # see UpstreamModelAliasTests.setUp
        proxy.PROXY_PLACEMENT_MODE = "off"  # reconcile must not be skipped

    def tearDown(self):
        proxy.http_client = self._saved_client
        proxy._upstream_model_ids = None
        proxy._upstream_ids_failed_at = 0.0
        proxy.PROXY_PLACEMENT_MODE = self._saved_placement

    def _prime_stale_cache(self, stale_ids):
        proxy._upstream_model_ids = list(stale_ids)

    def _serve_models(self, payload):
        proxy.http_client = _FakeClient(payload)

    def test_stale_404_clears_refetches_rewrites_and_retries(self):
        self._prime_stale_cache(["old-arm-id"])
        self._serve_models({"data": [{"id": "qwen3.8-27b", "aliases": []}]})
        body = {"model": "old-arm-id"}
        retry = asyncio.run(
            proxy._maybe_refresh_served_ids_on_404(
                body,
                404,
                'The model old-arm-id does not exist. Valid aliases: qwen3.8-27b',
                "non-stream",
            )
        )
        self.assertTrue(retry)
        self.assertEqual(body["model"], "qwen3.8-27b")
        # The cache now reflects the LIVE arm, not the evicted one.
        self.assertEqual(proxy._upstream_model_ids, ["qwen3.8-27b"])

    def test_non_404_or_aliasless_bodies_are_not_this_failure(self):
        self._prime_stale_cache(["old-arm-id"])
        self._serve_models({"data": [{"id": "qwen3.8-27b", "aliases": []}]})
        body = {"model": "old-arm-id"}
        for status, text in (
            (400, "tool_choice required not supported"),
            (500, "The model old-arm-id does not exist. Valid aliases: x"),
            (404, "model 'x' not found"),  # no served-alias listing
            (404, "unrelated not found"),
        ):
            self.assertFalse(
                asyncio.run(
                    proxy._maybe_refresh_served_ids_on_404(
                        dict(body), status, text, "stream"
                    )
                ),
                (status, text),
            )

    def test_a_real_404_does_not_retry(self):
        # The re-fetched ids still serve the requested id: the 404 was not
        # staleness (e.g. a slot hiccup) — a retry would 404 identically.
        self._prime_stale_cache(["stale-entry"])
        self._serve_models({"data": [{"id": "served-id", "aliases": []}]})
        body = {"model": "served-id"}
        retry = asyncio.run(
            proxy._maybe_refresh_served_ids_on_404(
                body, 404,
                "The model served-id does not exist. Valid aliases: served-id",
                "strict-stream",
            )
        )
        self.assertFalse(retry)
        self.assertEqual(body["model"], "served-id")  # untouched

    def test_no_ids_after_refetch_means_no_retry(self):
        self._prime_stale_cache(["old-arm-id"])
        # The fake client answers a non-200: discovery yields nothing.
        proxy.http_client = _FakeClient({"data": []}, status_code=503)
        body = {"model": "old-arm-id"}
        retry = asyncio.run(
            proxy._maybe_refresh_served_ids_on_404(
                body,
                404,
                'The model old-arm-id does not exist. Valid aliases: x',
                "non-stream",
            )
        )
        self.assertFalse(retry)
        self.assertEqual(body["model"], "old-arm-id")


if __name__ == "__main__":
    unittest.main()
