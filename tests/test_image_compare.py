"""A/B 图像对比节点（image_compare_node.py）P1 单元测试（不依赖 ComfyUI 环境）。

覆盖：保存前缀、ui.a_images/b_images 回传、auto_output 透传语义、
缺图 ExecutionBlocker 行为。

运行：python tests/test_image_compare.py
"""
import importlib
import os
import sys
import types
import unittest

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)

compare = importlib.import_module("vpl.image_compare_node")


class FakePreviewImage:
    """记录 save_images 调用（img, prefix, prompt, extra_pnginfo），返回固定 ui 结构。"""
    recorded = []

    def __init__(self):
        self.calls = []

    def save_images(self, img, filename_prefix="", prompt=None, extra_pnginfo=None):
        self.calls.append((img, filename_prefix, prompt, extra_pnginfo))
        FakePreviewImage.recorded.append((img, filename_prefix, prompt, extra_pnginfo))
        return {"ui": {"images": [{"filename": filename_prefix + ".png"}]}}


class FakeExecutionBlocker:
    def __init__(self, value):
        self.value = value


class ABCompareTests(unittest.TestCase):
    def setUp(self):
        self._prev_cls = compare._preview_image_cls
        self._block_cls = compare._execution_blocker_cls
        FakePreviewImage.recorded = []
        compare._preview_image_cls = lambda: FakePreviewImage
        compare._execution_blocker_cls = lambda: FakeExecutionBlocker

    def tearDown(self):
        compare._preview_image_cls = self._prev_cls
        compare._execution_blocker_cls = self._block_cls

    def node(self):
        return compare.AllBuyABCompare()

    def test_both_images_and_prefixes(self):
        fake = object()
        out = self.node().preview(image_a=fake, image_b=fake)
        self.assertEqual(len(out["ui"]["a_images"]), 1)
        self.assertEqual(out["ui"]["a_images"][0]["filename"], "AllBuyCompare_A.png")
        self.assertEqual(out["ui"]["b_images"][0]["filename"], "AllBuyCompare_B.png")
        self.assertIs(out["result"][0], fake)
        self.assertIs(out["result"][1], fake)

    def test_auto_output_false_blocks_both(self):
        fake = object()
        out = self.node().preview(auto_output=False, image_a=fake, image_b=fake)
        self.assertIsInstance(out["result"][0], FakeExecutionBlocker)
        self.assertIsInstance(out["result"][1], FakeExecutionBlocker)
        # 图仍保存（对比功能不受 auto_output 影响）
        self.assertEqual(len(out["ui"]["a_images"]), 1)
        self.assertEqual(len(out["ui"]["b_images"]), 1)

    def test_missing_a_blocks_only_a(self):
        fake = object()
        out = self.node().preview(image_a=None, image_b=fake)
        self.assertIsInstance(out["result"][0], FakeExecutionBlocker)
        self.assertIs(out["result"][1], fake)
        self.assertEqual(out["ui"]["a_images"], [])

    def test_missing_b_blocks_only_b(self):
        fake = object()
        out = self.node().preview(image_a=fake, image_b=None)
        self.assertIs(out["result"][0], fake)
        self.assertIsInstance(out["result"][1], FakeExecutionBlocker)

    def test_both_missing_empty_ui(self):
        out = self.node().preview(image_a=None, image_b=None)
        self.assertEqual(out["ui"]["a_images"], [])
        self.assertEqual(out["ui"]["b_images"], [])
        self.assertIsInstance(out["result"][0], FakeExecutionBlocker)
        self.assertIsInstance(out["result"][1], FakeExecutionBlocker)

    def test_metadata_forwarded(self):
        fake = object()
        prompt = {"p": 1}
        extra = {"x": 2}
        out = self.node().preview(image_a=fake, image_b=fake, prompt=prompt, extra_pnginfo=extra)
        self.assertEqual(len(out["ui"]["a_images"]), 1)
        # save_images 收到 img/prefix/prompt/extra_pnginfo（透传给 PreviewImage）
        self.assertEqual(FakePreviewImage.recorded, [
            (fake, "AllBuyCompare_A", prompt, extra),
            (fake, "AllBuyCompare_B", prompt, extra),
        ])


if __name__ == "__main__":
    unittest.main()
