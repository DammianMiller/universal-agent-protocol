"""Tests for the .uap/proxy.env loader (recipe/escalation/delivery env wiring)."""
import importlib.util
import os
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


if __name__ == "__main__":
    unittest.main()
