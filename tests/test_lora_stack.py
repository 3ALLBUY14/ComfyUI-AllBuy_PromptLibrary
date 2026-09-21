"""LoRA 堆栈节点（lora_stack_node.py）P1 单元测试（不依赖 ComfyUI 环境）。

覆盖：entries 解析容错、schema v1 白名单/缺省兜底、有效条目签名稳定、
触发词去重保序、权重过滤、_gguf_list 聚合、IS_CHANGED 键含 LoRA 文件签名、
GGUF 加载器缺失与模型未选择错误路径。

运行：python tests/test_lora_stack.py
"""
import importlib
import json
import os
import sys
import tempfile
import types
import unittest

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)

lora = importlib.import_module("vpl.lora_stack_node")


class ParseEntriesTests(unittest.TestCase):
    def test_garbage_json(self):
        for raw in ("not json", "123", "{}"):
            with self.assertRaises(ValueError):
                lora._validated_entries(raw)

    def test_empty_tolerated_as_empty(self):
        # 空字符串与 None 都容错为空栈（stack_json 默认值即 ""）
        self.assertEqual(lora._validated_entries(""), [])
        self.assertEqual(lora._validated_entries(None), [])
        self.assertEqual(lora._validated_entries("[]"), [])

    def test_non_list_raises(self):
        with self.assertRaises(ValueError):
            lora._parse_entries('{"a":1}')
        with self.assertRaises(ValueError):
            lora._validated_entries("[1, 2]")

    def test_schema_whitelist_and_defaults(self):
        entry = lora._normalize_entry({"name": "a.safetensors", "weight": 1.5, "junk": 1}, 0)
        self.assertEqual(set(entry.keys()), {"id", "name", "weight", "min", "max", "enabled", "trigger"})
        self.assertEqual(entry["name"], "a.safetensors")
        self.assertEqual(entry["weight"], 1.5)
        self.assertEqual(entry["min"], 0.0)
        self.assertEqual(entry["max"], 2.0)
        self.assertTrue(entry["enabled"])
        self.assertEqual(entry["trigger"], "")
        self.assertNotIn("junk", entry)

    def test_non_object_raises(self):
        with self.assertRaises(ValueError) as ctx:
            lora._normalize_entry("x", 2)
        self.assertIn("第 3 条", str(ctx.exception))

    def test_bad_weight_raises(self):
        for bad in ("abc", None):
            with self.assertRaises(ValueError):
                lora._normalize_entry({"name": "x", "weight": bad}, 0)
        with self.assertRaises(ValueError):
            lora._normalize_entry({"name": "x", "weight": float("inf")}, 0)

    def test_minmax_fallback(self):
        e = lora._normalize_entry({"name": "x", "min": 5, "max": 5}, 0)
        self.assertEqual((e["min"], e["max"]), (0.0, 2.0))


class EffectiveSignatureTests(unittest.TestCase):
    def _sig(self, entries):
        return lora._effective_entry_signature([lora._normalize_entry(e, i) for i, e in enumerate(entries)])

    def test_disabled_vs_enabled(self):
        self.assertEqual(self._sig([{"enabled": False, "name": "a"}]),
                         [{"enabled": False}])
        self.assertEqual(self._sig([{"name": "None"}]),
                         [{"enabled": True, "name": "None"}])

    def test_zero_weight_normalized(self):
        s = self._sig([{"name": "a.safetensors", "weight": 0.0}])
        self.assertEqual(s, [{"enabled": True, "name": "a.safetensors", "weight": 0.0}])
        s2 = self._sig([{"name": "a.safetensors", "weight": 0.0000001}])
        self.assertEqual(s, s2)  # 亚阈值权重按 0 归一，缓存键稳定

    def test_effective_round_and_trigger_strip(self):
        s = self._sig([{"name": "a.safetensors", "weight": 0.123456789, "trigger": "  hi  "}])
        self.assertEqual(s, [{"enabled": True, "name": "a.safetensors",
                              "weight": 0.123457, "trigger": "hi"}])


class TriggerWordsTests(unittest.TestCase):
    def _trig(self, entries):
        return lora._trigger_words([lora._normalize_entry(e, i) for i, e in enumerate(entries)])

    def test_dedupe_casefold_order(self):
        entries = [
            {"name": "a", "weight": 1.0, "trigger": "cat"},
            {"name": "b", "weight": 1.0, "trigger": " CAT "},
            {"name": "c", "weight": 1.0, "trigger": "dog"},
            {"name": "d", "weight": 1.0, "trigger": "dog"},
        ]
        self.assertEqual(self._trig(entries), "cat, dog")

    def test_skip_disabled_zero_and_empty(self):
        entries = [
            {"name": "a", "weight": 1.0, "trigger": "keep"},
            {"name": "b", "weight": 1.0, "enabled": False, "trigger": "no"},
            {"name": "c", "weight": 0.0, "trigger": "zero"},
            {"name": "d", "weight": 1.0, "trigger": "   "},
            {"name": "None", "weight": 1.0, "trigger": "none"},
        ]
        self.assertEqual(self._trig(entries), "keep")


class GgufListTests(unittest.TestCase):
    def test_aggregate_dedupe(self):
        class FakeFolder:
            def __init__(self, lists):
                self._lists = lists
            def get_filename_list(self, key):
                return self._lists.get(key, [])

        fp = FakeFolder({
            "unet_gguf": ["a.gguf", "b/Q4.gguf"],
            "diffusion_models": ["b/Q4.gguf", "c.safetensors", "d.gguf"],
            "unet": ["d.gguf", "e.gguf"],
        })
        orig = lora._folder_paths
        lora._folder_paths = lambda: fp
        try:
            self.assertEqual(lora._gguf_list(), ["a.gguf", "b/Q4.gguf", "d.gguf", "e.gguf"])
        finally:
            lora._folder_paths = orig

    def test_missing_keys_fallback(self):
        class FakeFolder:
            def get_filename_list(self, key):
                raise Exception("no key")

        orig = lora._folder_paths
        lora._folder_paths = lambda: FakeFolder()
        try:
            self.assertEqual(lora._gguf_list(), [])
        finally:
            lora._folder_paths = orig


class LoraFileSignatureTests(unittest.TestCase):
    def test_missing_and_existing(self):
        with tempfile.TemporaryDirectory() as td:
            real = os.path.join(td, "real.safetensors")
            with open(real, "w") as f:
                f.write("x")
            class FakeFolder:
                def get_full_path(self, key, name):
                    return real if name == "real.safetensors" else None

            entries = [
                lora._normalize_entry({"name": "real.safetensors", "weight": 1.0}, 0),
                lora._normalize_entry({"name": "ghost.safetensors", "weight": 1.0}, 1),
                lora._normalize_entry({"name": "off.safetensors", "weight": 1.0, "enabled": False}, 2),
                lora._normalize_entry({"name": "zero.safetensors", "weight": 0.0}, 3),
            ]
            orig = lora._folder_paths
            lora._folder_paths = lambda: FakeFolder()
            try:
                sigs = lora._lora_files_signature(entries)
            finally:
                lora._folder_paths = orig
            self.assertEqual(len(sigs), 2)
            by_name = dict(sigs)
            self.assertIn(":1", by_name["real.safetensors"])  # <mtime_ns>:<size=1>
            self.assertEqual(by_name["ghost.safetensors"], "missing")


class ISChangedTests(unittest.TestCase):
    def _changed(self, **kw):
        base = {"模型类型": "UNET", "ckpt_name": "None", "unet_name": "m.safetensors",
                "gguf_name": "None", "lora_picker": "x", "stack_json": "[]"}
        base.update(kw)
        return lora.AllBuyLoRAStack.IS_CHANGED(**base)

    def test_stability_and_sensitivity(self):
        a = self._changed()
        b = self._changed()
        self.assertEqual(a, b)
        c = self._changed(stack_json=json.dumps([{"name": "a", "weight": 0.5}]))
        self.assertNotEqual(a, c)
        d = self._changed(stack_json=json.dumps([{"name": "a", "weight": 0.6}]))
        self.assertNotEqual(c, d)
        e = self._changed(stack_json=json.dumps([{"name": "a", "weight": 0.6, "trigger": "x"}]))
        self.assertNotEqual(d, e)

    def test_zero_weight_trigger_intentionally_stable(self):
        # 权重 0 的条目不参与文件签名，且有效签名中权重≈0 分支不含 trigger
        #（trigger 只在 weight≠0 时输出，0 权重改 trigger 不影响结果 → 键不变是正确行为）
        a = self._changed(stack_json=json.dumps([{"name": "nope.safetensors", "weight": 0.0}]))
        b = self._changed(stack_json=json.dumps([{"name": "nope.safetensors", "weight": 0.0, "trigger": "t"}]))
        self.assertEqual(a, b)
        # 非零权重改 trigger 必须换键
        c = self._changed(stack_json=json.dumps([{"name": "nope.safetensors", "weight": 0.5}]))
        d = self._changed(stack_json=json.dumps([{"name": "nope.safetensors", "weight": 0.5, "trigger": "t"}]))
        self.assertNotEqual(c, d)


class LoadBaseModelTests(unittest.TestCase):
    def test_gguf_loader_missing_raises(self):
        class FakeNodes:
            def __getattr__(self, name):
                raise AttributeError(name)

        orig = lora._comfy_nodes
        lora._comfy_nodes = lambda: FakeNodes()
        try:
            with self.assertRaises(RuntimeError) as ctx:
                lora.AllBuyLoRAStack._load_base_model(
                    "GGUF", "None", "None", "m.gguf",
                    gguf_dequant_dtype="default", gguf_patch_dtype="default", gguf_patch_on_device=False)
            self.assertIn("ComfyUI-GGUF", str(ctx.exception))
        finally:
            lora._comfy_nodes = orig

    def test_model_not_selected_raises(self):
        for t, args in [
            ("Checkpoint", ("None", "None", "None")),
            ("UNET", ("None", "None", "None")),
            ("GGUF", ("None", "None", "None")),
        ]:
            with self.assertRaises(ValueError):
                lora.AllBuyLoRAStack._load_base_model(t, *args)


if __name__ == "__main__":
    unittest.main()
