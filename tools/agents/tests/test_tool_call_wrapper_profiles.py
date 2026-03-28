import importlib.util
import unittest
from pathlib import Path


def _load_wrapper_module():
    wrapper_path = Path(__file__).resolve().parents[1] / "scripts" / "tool_call_wrapper.py"
    spec = importlib.util.spec_from_file_location("tool_call_wrapper", wrapper_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wrapper = _load_wrapper_module()


class TestToolCallWrapperProfiles(unittest.TestCase):
    def test_per_request_profile_override_uses_profile_config(self):
        client = wrapper.ToolCallClient(config={"model_profile": "generic"})
        config, profile_used = client._resolve_request_config("qwen35")
        self.assertEqual(profile_used, "qwen35")
        self.assertEqual(config["model"], "qwen3.5-a3b-iq4xs")
        self.assertTrue(config["batch_tool_calls"])

    def test_missing_profile_falls_back_to_generic(self):
        client = wrapper.ToolCallClient(config={"model_profile": "generic"})
        config, profile_used = client._resolve_request_config("missing-profile")
        self.assertEqual(profile_used, "generic")
        self.assertEqual(config["temperature"], 0.6)
