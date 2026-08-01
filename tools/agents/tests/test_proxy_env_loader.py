"""Tests for the .uap/proxy.env loader (recipe/escalation/delivery env wiring)."""
import importlib.util
import os
import tempfile
import unittest
import unittest.mock
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proxy = _load_proxy_module()

KEYS = ("PROXY_RECIPE", "PROXY_ESCALATE_MODEL", "UAP_DELIVER_LOCAL_MODE", "QUOTED",
        "EXISTING_KEY", "UAP_PROXY_ENV_FILE")


class ProxyEnvLoaderTest(unittest.TestCase):
    def tearDown(self):
        for k in KEYS:
            os.environ.pop(k, None)

    def test_loads_keys_without_overriding_existing(self):
        d = tempfile.mkdtemp()
        env_file = Path(d) / "proxy.env"
        env_file.write_text(
            "# comment line\n"
            "PROXY_RECIPE=fusion\n"
            "PROXY_ESCALATE_MODEL=claude-opus-4-8\n"
            "UAP_DELIVER_LOCAL_MODE=deliver\n"
            'QUOTED="value with spaces"\n'
            "\n"
            "EXISTING_KEY=from_file\n"
        )
        for k in KEYS:
            os.environ.pop(k, None)
        os.environ["EXISTING_KEY"] = "from_env"  # must NOT be overridden
        os.environ["UAP_PROXY_ENV_FILE"] = str(env_file)

        proxy._load_proxy_env_file()

        self.assertEqual(os.environ["PROXY_RECIPE"], "fusion")
        self.assertEqual(os.environ["PROXY_ESCALATE_MODEL"], "claude-opus-4-8")
        self.assertEqual(os.environ["UAP_DELIVER_LOCAL_MODE"], "deliver")
        self.assertEqual(os.environ["QUOTED"], "value with spaces")
        self.assertEqual(os.environ["EXISTING_KEY"], "from_env")

    def test_missing_file_is_noop(self):
        os.environ["UAP_PROXY_ENV_FILE"] = "/nonexistent/does/not/exist.env"
        proxy._load_proxy_env_file()  # must not raise


class ProxyEnvWalkStopsAtRepoRootTest(unittest.TestCase):
    """The upward walk must stop at the repository, not the filesystem root.

    It used to run to "/", so a checkout nested under an unrelated checkout
    loaded the outer repo's proxy.env, PROXY_AUTH_TOKEN included. A WORKTREE is
    not that case — its .git file names the same repository — so it must still
    reach its own repo's config rather than start tokenless.
    """

    KEY = "UAP_WALK_PROBE_KEY"

    def tearDown(self):
        os.environ.pop(self.KEY, None)
        os.environ.pop("UAP_PROXY_ENV_FILE", None)

    def _tree(self, td):
        # outer/ is the "parent checkout" and holds the env file; outer/inner/
        # is the "worktree" — it has a .git FILE (as real worktrees do) and no
        # .uap/ of its own.
        outer = Path(td) / "outer"
        (outer / ".uap").mkdir(parents=True)
        (outer / ".git").mkdir()
        (outer / ".uap" / "proxy.env").write_text(f"{self.KEY}=from_the_repo\n")
        inner = outer / "inner"
        inner.mkdir()
        (inner / ".git").write_text("gitdir: ../.git/worktrees/inner\n")
        return outer, inner

    def _load_from(self, path):
        # cwd is process-global; restore it even if the loader raises. Safe
        # under unittest (serial) and pytest-xdist (separate processes); would
        # not be under a thread-parallel runner, and nothing here runs threaded.
        cwd = os.getcwd()
        os.chdir(path)
        try:
            os.environ.pop(self.KEY, None)
            proxy._load_proxy_env_file()
        finally:
            os.chdir(cwd)
        return os.environ.get(self.KEY)

    def test_a_worktree_still_reaches_its_own_repository_config(self):
        # A worktree's .git is a FILE naming the same repository. Stopping there
        # would leave the proxy with an empty PROXY_AUTH_TOKEN, and since the
        # auth middleware treats empty as "no auth configured", a non-loopback
        # bind would then be wide open. Same repo => follow the pointer home.
        with tempfile.TemporaryDirectory() as td:
            _outer, inner = self._tree(td)
            self.assertEqual(self._load_from(inner), "from_the_repo")

    def test_still_finds_the_env_file_at_the_repo_root_itself(self):
        # The bound is inclusive — stopping AT the repo root must not stop
        # BEFORE reading it, or the proxy loses its own config.
        with tempfile.TemporaryDirectory() as td:
            outer, _inner = self._tree(td)
            self.assertEqual(self._load_from(outer), "from_the_repo")

    def test_the_walk_actually_ascends(self):
        # Both cases above sit ON a boundary directory, so an implementation
        # that only ever looked at Path.cwd() would pass them. Start well below
        # the root, in a dir with neither .git nor .uap.
        with tempfile.TemporaryDirectory() as td:
            outer, _inner = self._tree(td)
            deep = outer / "a" / "b" / "c"
            deep.mkdir(parents=True)
            self.assertEqual(self._load_from(deep), "from_the_repo")

    def test_does_not_climb_out_of_one_repository_into_another(self):
        # The genuine cross-repo case the bound exists for: a checkout nested
        # under an unrelated checkout must not inherit the outer repo's secret.
        with tempfile.TemporaryDirectory() as td:
            outer, _inner = self._tree(td)
            nested = outer / "vendored"
            (nested / ".git").mkdir(parents=True)  # a real repo root, not a worktree
            self.assertIsNone(
                self._load_from(nested),
                "walk escaped a nested repository into the enclosing checkout",
            )


class ProxyBindAuthGuardTest(unittest.TestCase):
    """A non-loopback bind with no token must fail closed.

    PROXY_AUTH_TOKEN comes from .uap/proxy.env; PROXY_HOST commonly comes from
    the systemd EnvironmentFile. So any failure to find the former leaves the
    latter intact — bind-all survives, require-a-credential does not — and the
    middleware reads an empty token as "no auth configured". Without this guard
    a config-discovery bug silently produces an open LLM proxy on the LAN.
    """

    def test_loopback_without_a_token_is_allowed(self):
        for host in ("127.0.0.1", "::1", "localhost"):
            with self.subTest(host=host):
                proxy._assert_bind_is_authenticated(host, "")  # must not raise

    def test_any_bind_with_a_token_is_allowed(self):
        proxy._assert_bind_is_authenticated("0.0.0.0", "a-real-token")

    def test_non_loopback_without_a_token_refuses_to_start(self):
        for host in ("0.0.0.0", "192.168.1.50", "::"):
            with self.subTest(host=host):
                with unittest.mock.patch.dict(os.environ, {}, clear=False):
                    os.environ.pop("PROXY_ALLOW_UNAUTHENTICATED_BIND", None)
                    with self.assertRaises(SystemExit) as ctx:
                        proxy._assert_bind_is_authenticated(host, "")
                    self.assertIn("unauthenticated", str(ctx.exception))

    def test_explicit_override_permits_an_open_listener(self):
        with unittest.mock.patch.dict(
            os.environ, {"PROXY_ALLOW_UNAUTHENTICATED_BIND": "1"}
        ):
            proxy._assert_bind_is_authenticated("0.0.0.0", "")  # must not raise


class ProxyEnvAutoloadOptOutTest(unittest.TestCase):
    """Importing the module must be inert when the opt-out is set."""

    def test_autoload_enabled_by_default(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("UAP_PROXY_ENV_AUTOLOAD", None)
            self.assertTrue(proxy._proxy_env_autoload_enabled())

    def test_opt_out_values_disable_autoload(self):
        for val in ("0", "off", "false", "no", "OFF", " 0 "):
            with self.subTest(val=val):
                with unittest.mock.patch.dict(
                    os.environ, {"UAP_PROXY_ENV_AUTOLOAD": val}
                ):
                    self.assertFalse(proxy._proxy_env_autoload_enabled())

    def test_other_values_leave_autoload_on(self):
        for val in ("1", "on", "true", "yes"):
            with self.subTest(val=val):
                with unittest.mock.patch.dict(
                    os.environ, {"UAP_PROXY_ENV_AUTOLOAD": val}
                ):
                    self.assertTrue(proxy._proxy_env_autoload_enabled())


if __name__ == "__main__":
    unittest.main()
