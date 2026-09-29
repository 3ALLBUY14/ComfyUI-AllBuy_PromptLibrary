"""AllBuy-文本框节点（textbox_node.py）P1 单元测试（不依赖 ComfyUI 环境）。

覆盖：替换表解析与应用、去空行、处理顺序（先替换再去空行）、@素材名解析与
imageN 映射、执行输出形状（双输出 + 四图占位）、IS_CHANGED 键含被引用素材签名。

运行：python tests/test_textbox.py
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

from vpl import textbox_node as tb  # noqa: E402
from vpl import media_asset  # noqa: E402


class PipelineTests(unittest.TestCase):
    def test_replacement_table(self):
        # 每行 旧=新；首个 = 分割（新值可含 =）；空行/无=行忽略
        self.assertEqual(tb._parse_replacements("a=b\n空行跳过\n c = d=e \n"),
                         [("a", "b"), ("c", "d=e")])

    def test_replace_then_drop_blank_order(self):
        # 先替换再去空行：替换产生的空行也被清
        out = tb.apply_replacements_and_blank("第一行\n占位\n第三行", "占位=", True)
        self.assertEqual(out, "第一行\n第三行")
        # 关闭去空行：空行保留
        out2 = tb.apply_replacements_and_blank("第一行\n\n第三行", "", False)
        self.assertEqual(out2, "第一行\n\n第三行")
        # 只删纯空白行，不动行内空格
        out3 = tb.apply_replacements_and_blank("  \na b\n\t\n", "", True)
        self.assertEqual(out3, "a b")

    def test_at_names_dedupe_order(self):
        self.assertEqual(tb.resolve_at_names("看 @猫 在跑，@狗 在追 @猫 尾巴"),
                         ["猫", "狗"])


class ExecuteTests(unittest.TestCase):
    def _run(self, text, table="", drop=True):
        return tb.AllBuyTextBox().execute(文本=text, 替换表=table, 去空行=drop)

    def test_outputs_shape_and_lines(self):
        r = self._run("镜头一：城市夜景\n\n镜头二：日出\n")
        full, lines = r["result"][0], r["result"][1]
        self.assertEqual(full, "镜头一：城市夜景\n镜头二：日出")
        self.assertEqual(lines, ["镜头一：城市夜景", "镜头二：日出"])

    def test_at_replaced_and_placeholders(self):
        # @素材 无匹配文件 → 文本仍替换为 imageN，图口为占位（形状 1x64x64x3）
        r = self._run("主角 @不存在的素材 走来")
        full, lines = r["result"][0], r["result"][1]
        self.assertEqual(full, "主角 image1 走来")
        img1 = r["result"][2]
        self.assertEqual(tuple(img1.shape), (1, 64, 64, 3))
        self.assertTrue((img1 == 0).all().item())

    def test_at_with_real_media_file(self):
        import numpy as np
        from PIL import Image
        import torch  # noqa: F401  确认环境有 torch

        with tempfile.TemporaryDirectory() as td:
            # 打到 media_asset 模块上：_find_media_file/resolve_media_path 内部用的是它
            orig_root = media_asset.media_root
            media_asset.media_root = lambda: td
            try:
                Image.new("RGB", (8, 6), (255, 0, 0)).save(os.path.join(td, "红图.png"), "PNG")
                r = self._run("以 @红图 开场")
                self.assertEqual(r["result"][0], "以 image1 开场")
                img = r["result"][2]
                self.assertEqual(tuple(img.shape), (1, 6, 8, 3))
                self.assertAlmostEqual(float(img.mean()), 255.0 / 255.0 / 3.0, places=2)
                used = r["ui"]["images_used"]
                self.assertEqual(used[0]["slot"], "image1")
                self.assertTrue(used[0]["found"])
                # 未引用的口是占位
                self.assertEqual(tuple(r["result"][3].shape), (1, 64, 64, 3))
            finally:
                media_asset.media_root = orig_root

    def test_max_ten_and_extra_kept(self):
        text = " ".join(f"@素材{i}" for i in range(12))
        r = self._run(text)
        self.assertEqual(r["result"][0],
                         " ".join(f"image{i}" for i in range(1, 11)) + " @素材10 @素材11")
        used = r["ui"]["images_used"]
        self.assertEqual([u["slot"] for u in used], [f"image{i}" for i in range(1, 11)])
        # 第 10 口为占位（未匹配文件），形状合法
        self.assertEqual(tuple(r["result"][11].shape), (1, 64, 64, 3))

    def test_is_changed_includes_media_sig(self):
        import numpy as np
        from PIL import Image

        with tempfile.TemporaryDirectory() as td:
            orig_root = media_asset.media_root
            media_asset.media_root = lambda: td
            try:
                p = os.path.join(td, "图A.png")
                Image.new("RGB", (4, 4), (0, 255, 0)).save(p, "PNG")
                k1 = tb.AllBuyTextBox.IS_CHANGED(文本="用 @图A", 替换表="", 去空行=True)
                Image.new("RGB", (4, 4), (0, 0, 255)).save(p, "PNG")  # 内容变 → 签名必变
                k2 = tb.AllBuyTextBox.IS_CHANGED(文本="用 @图A", 替换表="", 去空行=True)
                self.assertNotEqual(k1, k2)
                k3 = tb.AllBuyTextBox.IS_CHANGED(文本="用 @图A", 替换表="", 去空行=True)
                self.assertEqual(k2, k3)  # 文件没变 → 键稳定可缓存
            finally:
                media_asset.media_root = orig_root


if __name__ == "__main__":
    unittest.main(verbosity=2)
