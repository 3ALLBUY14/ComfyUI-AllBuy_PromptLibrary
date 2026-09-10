"""v3.51 新增行为的单元测试（不依赖 ComfyUI 环境）。

覆盖：
1. 通配符固定种子：同 seed 可复现、可缓存；关闭后恢复每次随机。
2. 批量选图节点 IS_CHANGED 包含库文件内容签名（v3.32 同型漏洞的回归测试）。

运行：python tests/test_v351.py
"""
import importlib
import json
import os
import sys
import types
import unittest

# 把插件目录挂成 "vpl" 包（目录名带连字符无法直接 import），使包内相对导入可用
PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)

from vpl import merger, nodes                       # noqa: E402
bips = importlib.import_module("vpl.batch_image_node")  # noqa: E402


def g(gid, positive="", negative="", **kw):
    base = {"id": gid, "name": gid, "category": "", "positive": positive,
            "negative": negative, "weight": 1.0, "prefix": "", "suffix": ""}
    base.update(kw)
    return base


class WildcardSeedTests(unittest.TestCase):
    def setUp(self):
        self.lib = json.dumps({"source": "inline", "name": "t"})
        self.data = json.dumps({"version": 1, "name": "t", "groups": [g("a", "{x|y} {m|n}")]})

    def test_fixed_seed_reproducible(self):
        r1 = nodes.PromptLibrary().execute(
            self.lib, '["a"]', ", ", 库数据=self.data, 通配符固定=True, 通配符种子=9)
        r2 = nodes.PromptLibrary().execute(
            self.lib, '["a"]', ", ", 库数据=self.data, 通配符固定=True, 通配符种子=9)
        self.assertEqual(r1, r2)
        self.assertTrue(r1[0])  # 确实展开了通配符

    def test_unfixed_is_random_each_run(self):
        # 关闭固定（默认）：两次执行键不同（随机 token），行为与 v3.50 一致
        c1 = nodes.PromptLibrary.IS_CHANGED(self.lib, '["a"]', ", ", 库数据=self.data)
        c2 = nodes.PromptLibrary.IS_CHANGED(self.lib, '["a"]', ", ", 库数据=self.data)
        self.assertNotEqual(c1, c2)
        self.assertEqual(c1[0], "wildcard")

    def test_fixed_seed_cacheable(self):
        c1 = nodes.PromptLibrary.IS_CHANGED(
            self.lib, '["a"]', ", ", 库数据=self.data, 通配符固定=True, 通配符种子=7)
        c2 = nodes.PromptLibrary.IS_CHANGED(
            self.lib, '["a"]', ", ", 库数据=self.data, 通配符固定=True, 通配符种子=7)
        self.assertEqual(c1, c2)
        self.assertNotIn("wildcard", c1)
        # 默认路径键保持 8 元组（与 v3.50 一致，不含种子位）
        c0 = nodes.PromptLibrary.IS_CHANGED(self.lib, '["a"]', ", ", 库数据=self.data)
        self.assertEqual(len(c0[1]), 8)

    def test_different_seed_different_result_key(self):
        c1 = nodes.PromptLibrary.IS_CHANGED(
            self.lib, '["a"]', ", ", 库数据=self.data, 通配符固定=True, 通配符种子=7)
        c2 = nodes.PromptLibrary.IS_CHANGED(
            self.lib, '["a"]', ", ", 库数据=self.data, 通配符固定=True, 通配符种子=8)
        self.assertNotEqual(c1, c2)

    def test_merger_rng_passthrough(self):
        # 纯函数层：同 rng 种子可复现
        groups = [g("a", "{x|y}")]
        p1, _ = merger.merge_groups(groups, ["a"], rng=__import__("random").Random(3))
        p2, _ = merger.merge_groups(groups, ["a"], rng=__import__("random").Random(3))
        self.assertEqual(p1, p2)


class BipsCacheKeyTests(unittest.TestCase):
    """批量选图 IS_CHANGED 必须包含库内容签名（改库后缓存必须失效）。"""

    def _mapping(self, locator):
        return json.dumps({
            "version": 1, "folder": "", "mode": "image_to_prompts",
            "library_locator": locator, "thumbnail_size": 96,
            "images": [], "links": [],
        })

    def test_key_includes_library_signature(self):
        loc = {"source": "user", "name": "default"}
        c = bips.BatchImagePromptSelector.IS_CHANGED(self._mapping(loc), "")
        self.assertEqual(len(c), 3)          # (库签名, 映射数据, 库数据)
        self.assertIsInstance(c[0], str)     # 首位 = 库内容签名（或 missing）
        c2 = bips.BatchImagePromptSelector.IS_CHANGED(self._mapping(loc), "")
        self.assertEqual(c, c2)              # 库没变 → 键稳定，可缓存

    def test_no_library_still_returns_key(self):
        c = bips.BatchImagePromptSelector.IS_CHANGED(self._mapping(None), "")
        self.assertEqual(len(c), 3)
        # 无 locator 时 resolve 回退到 default 用户库：文件存在 → 真实签名；不存在 → "missing"
        self.assertIsInstance(c[0], str)
        self.assertTrue(c[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
