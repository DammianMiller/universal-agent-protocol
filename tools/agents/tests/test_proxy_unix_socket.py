"""Tests for the PROXY_SOCKET unix-socket surface (bridge P4: D1 model-path
choke point).

The socket is a permission-gated transport for the model gateway — only the
owning user can dial it (0600 socket in a 0700 parent) — serving alongside
the TCP port. Its preparation is the boundary itself: correct bind, tight
permissions, stale-corpse cleanup, refusal to evict a live proxy's socket
(including one that cannot be dialed — EACCES is not proof of death), refusal
to replace a non-socket file at the path, and a warning when the parent dir
is group/other-writable.
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

    def test_creates_a_missing_parent_dir_with_0700(self):
        # A deep path whose leaf directory does not exist yet: the surface
        # must create it PRIVATE (0700) — a world-readable parent would let
        # any local user name-squat the socket path.
        deep = os.path.join(self.tmp, "a", "b", "c", "proxy.sock")
        prepared = proxy._prepare_proxy_socket(deep)
        self.assertIsNotNone(prepared)
        try:
            leaf = os.path.dirname(deep)
            mode = stat.S_IMODE(os.stat(leaf).st_mode)
            self.assertEqual(mode & 0o777, 0o700, "parent dirs of the socket must be 0700")
            self.assertTrue(proxy._socket_is_live(deep))
        finally:
            self._close_quietly(prepared)

    def test_binds_when_the_parent_exists_with_loose_perms(self):
        # The pre-existing-parent case must not regress: bind still works
        # and the SOCKET itself stays 0600 (the parent is left as the
        # operator made it — chmod-ing a dir the operator owns would be a
        # surprising side effect).
        os.chmod(os.path.dirname(self.sock_path), 0o755)
        prepared = proxy._prepare_proxy_socket(self.sock_path)
        self.assertIsNotNone(prepared)
        try:
            mode = stat.S_IMODE(os.stat(self.sock_path).st_mode)
            self.assertEqual(mode, 0o600)
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

    def test_refuses_to_evict_a_live_socket_it_cannot_dial(self):
        # EACCES must read as LIVE, not corpse (P4 security review): another
        # user's 0600 socket in a shared dir cannot be proven dead, and
        # evicting it would let this process impersonate their endpoint.
        # Simulated same-user: chmod 000 on the socket makes connect() fail
        # with EACCES while the server keeps accepting on its own fd.
        live = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        live.bind(self.sock_path)
        live.listen(8)
        os.chmod(self.sock_path, 0o000)
        try:
            prepared = proxy._prepare_proxy_socket(self.sock_path)
            self.assertIsNone(prepared, "an undialable LIVE socket must not be evicted")
            self.assertTrue(os.path.exists(self.sock_path), "the socket file must survive")
        finally:
            os.chmod(self.sock_path, 0o600)
            live.close()

    def test_never_replaces_a_regular_file(self):
        # PROXY_SOCKET can arrive from the operator's env or .uap/proxy.env
        # (inside the sandbox-writable checkout): a typo or planted value
        # must not become an arbitrary-file-delete primitive. The file must
        # survive byte-for-byte.
        data = b'{"important": "operator data"}'
        with open(self.sock_path, "wb") as f:
            f.write(data)
        prepared = proxy._prepare_proxy_socket(self.sock_path)
        self.assertIsNone(prepared, "a non-socket at the path must disable the surface")
        with open(self.sock_path, "rb") as f:
            self.assertEqual(f.read(), data, "the file must be untouched")

    def test_warns_when_the_parent_dir_is_shared(self):
        # A group/other-writable parent lets another local user unlink or
        # squat the socket path; the operator gets the consequence named.
        os.chmod(os.path.dirname(self.sock_path), 0o770)
        try:
            with self.assertLogs("uap.anthropic_proxy", level="WARNING") as logs:
                prepared = proxy._prepare_proxy_socket(self.sock_path)
            self.assertIsNotNone(prepared)
            self.assertTrue(any("group/other-writable" in line for line in logs.output), logs.output)
            self._close_quietly(prepared)
        finally:
            os.chmod(os.path.dirname(self.sock_path), 0o755)

    def test_empty_and_too_long_paths_disable_the_surface(self):
        self.assertIsNone(proxy._prepare_proxy_socket(""))
        too_long = os.path.join(self.tmp, "x" * 130 + ".sock")
        self.assertIsNone(proxy._prepare_proxy_socket(too_long))
        self.assertFalse(os.path.exists(too_long))


if __name__ == "__main__":
    unittest.main()
