"""LoRA 自定义分组存储（lora_groups_store.py）P1 单元测试（不依赖 ComfyUI 环境）。

覆盖：名称 sanitize、分组归一化（丢弃非法条目、id 生成、loras 去重）、
「我的收藏」默认组、save/load roundtrip、坏 JSON 与 backup 恢复。

运行：python tests/test_lora_groups.py
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

groups_store = importlib.import_module("vpl.lora_groups_store")
library_store = importlib.import_module("vpl.library_store")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_ulf = library_store.get_user_libraries_folder
        library_store.get_user_libraries_folder = lambda: self._tmp.name
        self._orig = groups_store._groups_path
        groups_store._groups_path = lambda: os.path.join(self._tmp.name, "lora_groups.json")

    def tearDown(self):
        groups_store._groups_path = self._orig
        library_store.get_user_libraries_folder = self._orig_ulf
        self._tmp.cleanup()

    def test_sanitize_name(self):
        self.assertEqual(groups_store._sanitize_name(" 人像/写实 "), "人像_写实")
        self.assertEqual(groups_store._sanitize_name(""), "未命名")
        self.assertEqual(groups_store._sanitize_name("   "), "未命名")

    def test_normalize_drops_junk_and_dedupes(self):
        raw = [
            {"id": "g1", "name": "组A", "loras": ["a.safetensors", "a.safetensors", "b.gguf", 5, None]},
            "not-a-dict",
            {"id": "g1", "name": "组B"},  # id 冲突 → 按位置重新生成
            {"name": "组C"},
        ]
        groups = groups_store._normalize_groups(raw)
        self.assertEqual(len(groups), 3)
        self.assertEqual(groups[0]["loras"], ["a.safetensors", "b.gguf"])
        ids = [g["id"] for g in groups]
        self.assertEqual(len(set(ids)), 3)  # id 唯一
        self.assertEqual(groups[0]["id"], "g1")
        self.assertEqual(groups[1]["id"], "g2")
        self.assertEqual(groups[2]["id"], "g3")

    def test_ensure_default_group(self):
        self.assertEqual(groups_store._ensure_default_group([])[0]["name"], "我的收藏")
        groups = [{"id": "x", "name": "我的收藏", "loras": []}]
        self.assertEqual(groups_store._ensure_default_group(groups), groups)

    def test_roundtrip(self):
        data = {"groups": [{"id": "a", "name": "人像", "loras": ["x.safetensors"]}]}
        saved = groups_store.save_groups(data)
        self.assertEqual(saved["groups"][0]["name"], "我的收藏")  # 默认组补齐到最前
        by_name = {g["name"]: g for g in saved["groups"]}
        self.assertEqual(by_name["人像"]["loras"], ["x.safetensors"])
        self.assertEqual(by_name["我的收藏"]["loras"], [])
        loaded = groups_store.load_groups()
        self.assertEqual(loaded, saved)

    def test_save_accepts_bare_list(self):
        saved = groups_store.save_groups([{"name": "A", "loras": ["a"]}])
        by_name = {g["name"]: g for g in saved["groups"]}
        self.assertEqual(by_name["A"]["loras"], ["a"])

    def test_bad_json_falls_back(self):
        path = groups_store._groups_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("not json {")
        loaded = groups_store.load_groups()
        self.assertEqual(loaded["groups"][0]["name"], "我的收藏")

    def test_backup_recovery(self):
        path = groups_store._groups_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".backup", "w", encoding="utf-8") as f:
            json.dump({"version": 1, "groups": [{"id": "b", "name": "备份组", "loras": []}]}, f)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{broken")
        loaded = groups_store.load_groups()
        names = [g["name"] for g in loaded["groups"]]
        self.assertIn("备份组", names)
        self.assertIn("我的收藏", names)

    def test_missing_file_empty(self):
        loaded = groups_store.load_groups()
        self.assertEqual(loaded["groups"][0]["name"], "我的收藏")
        self.assertEqual(loaded["groups"][0]["loras"], [])


if __name__ == "__main__":
    unittest.main()
