"""Tests for the PROXY_SOCKET unix-socket surface (bridge P4: D1 egress boundary).

The socket is the ONLY network reach of a `uap sandbox --net proxy` session,
so its preparation is the boundary itself: correct bind, tight permissions
(0600 socket in a 0700 parent), stale-corpse cleanup, and refusal to evict a
live proxy's socket.
"""
import contextlib
import importlib.util
import os
import shutil
import socket
import stat
import tempfile
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()


class ProxySocketPrepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uap-sock-")
        # The parent dir exists up front so tests can bind corpses directly.
        os.makedirs(os.path.join(self.tmp, "sub"))
        self.sock_path = os.path.join(self.tmp, "sub", "proxy.sock")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _close_quietly(self, sock):
        # Teardown: an already-closed socket (uvicorn may have shut it down)
        # must not fail the test run. contextlib.suppress states that intent.
        with contextlib.suppress(OSError):
            sock.close()

    def test_binds_with_tight_permissions(self):
        prepared = proxy._prepare_proxy_socket(self.sock_path)
        self.assertIsNotNone(prepared)
        try:
            mode = stat.S_IMODE(os.stat(self.sock_path).st_mode)
            self.assertEqual(mode, 0o600, "the socket is the egress boundary; 0600 or nothing")
            self.assertTrue(proxy._socket_is_live(self.sock_path))
        finally:
            self._close_quietly(prepared)

    def test_unlinks_a_stale_corpse_and_rebinds(self):
        # A corpse from a crashed run: nothing accepts on the other end.
        corpse = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        corpse.bind(self.sock_path)
        corpse.close()  # bound but never listening => connect() refused
        prepared = proxy._prepare_proxy_socket(self.sock_path)
        self.assertIsNotNone(prepared, "a stale socket must be reclaimed, not fatal")
        self.assertTrue(proxy._socket_is_live(self.sock_path))
        self._close_quietly(prepared)

    def test_refuses_to_evict_a_live_proxy(self):
        live = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        live.bind(self.sock_path)
        live.listen(8)
        try:
            prepared = proxy._prepare_proxy_socket(self.sock_path)
            self.assertIsNone(prepared, "a LIVE socket must be left to its owner")
            self.assertTrue(proxy._socket_is_live(self.sock_path))
        finally:
            live.close()

    def test_empty_and_too_long_paths_disable_the_surface(self):
        self.assertIsNone(proxy._prepare_proxy_socket(""))
        too_long = os.path.join(self.tmp, "x" * 130 + ".sock")
        self.assertIsNone(proxy._prepare_proxy_socket(too_long))
        self.assertFalse(os.path.exists(too_long))


if __name__ == "__main__":
    unittest.main()
