"""AllBuy-文本框节点（textbox_node.py）P1 单元测试（不依赖 ComfyUI 环境）。

覆盖：替换表解析与应用、去空行、处理顺序（先替换再去空行）、@素材名解析与
imageN 文本映射（纯文本标记，无图片输出）、执行输出形状（双输出）。

运行：python tests/test_textbox.py
"""
import os
import sys
import types
import unittest

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)

from vpl import textbox_node as tb  # noqa: E402


class PipelineTests(unittest.TestCase):
    def test_replacement_table(self):
        # 每行 旧=新；首个 = 分割（新值可含 =）；两端去空白；空行/无=行忽略
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
        self.assertEqual(len(r["result"]), 2)  # 纯双输出：提示词 / 提示词行
        full, lines = r["result"]
        self.assertEqual(full, "镜头一：城市夜景\n镜头二：日出")
        self.assertEqual(lines, ["镜头一：城市夜景", "镜头二：日出"])

    def test_at_replaced_as_text_marks(self):
        # @素材 → imageN 纯文本标记（图片本体由素材加载节点提供）
        r = self._run("主角 @猫 走来，背景 @城市；再提 @猫")
        self.assertEqual(r["result"][0], "主角 image1 走来，背景 image2；再提 image1")
        self.assertEqual([u["slot"] for u in r["ui"]["images_used"]],
                         ["image1", "image2"])

    def test_max_ten_and_extra_kept(self):
        text = " ".join(f"@素材{i}" for i in range(12))
        r = self._run(text)
        self.assertEqual(r["result"][0],
                         " ".join(f"image{i}" for i in range(1, 11)) + " @素材10 @素材11")
        self.assertEqual([u["slot"] for u in r["ui"]["images_used"]],
                         [f"image{i}" for i in range(1, 11)])

    def test_empty_text(self):
        r = self._run("")
        self.assertEqual(r["result"], ("", []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
