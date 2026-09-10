"""ComfyUI-AllBuy_PromptLibrary 单元测试（不依赖 ComfyUI 环境）。

运行：python tests/test_merger.py
"""
import importlib
import json
import os
import random
import sys
import tempfile
import types
import unittest

# 把插件目录挂成 "vpl" 包（目录名带连字符无法直接 import），使包内相对导入可用
PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)

constants = importlib.import_module("vpl.constants")
from vpl import merger, nodes, random_draw  # noqa: E402


def g(gid, positive="", negative="", **kw):
    base = {"id": gid, "name": gid, "category": "", "positive": positive,
            "negative": negative, "weight": 1.0, "prefix": "", "suffix": ""}
    base.update(kw)
    return base


class TestMergeGroups(unittest.TestCase):
    def test_order_follows_selected_ids(self):
        groups = [g("a", "AA"), g("b", "BB"), g("c", "CC")]
        pos, neg = merger.merge_groups(groups, ["c", "a"])
        self.assertEqual(pos, "CC, AA")

    def test_negative_joined(self):
        groups = [g("a", "AA", "na"), g("b", "BB", "nb")]
        pos, neg = merger.merge_groups(groups, ["a", "b"])
        self.assertEqual(neg, "na, nb")

    def test_weight_wraps(self):
        groups = [g("a", "AA", weight=1.2)]
        pos, _ = merger.merge_groups(groups, ["a"])
        self.assertEqual(pos, "(AA:1.2)")

    def test_weight_ignored(self):
        groups = [g("a", "AA", weight=1.2)]
        pos, _ = merger.merge_groups(groups, ["a"], ignore_weight=True)
        self.assertEqual(pos, "AA")

    def test_prefix_suffix(self):
        groups = [g("a", "AA", prefix="p", suffix="s")]
        pos, _ = merger.merge_groups(groups, ["a"])
        self.assertEqual(pos, "pAAs")

    def test_prepend_append(self):
        pos, _ = merger.merge_groups([g("a", "AA")], ["a"], prepend="PRE", append="POST")
        self.assertEqual(pos, "PRE, AA, POST")

    def test_empty_expansion_leaves_no_debris(self):
        """展开为空（正文全是空通配符等）不包权重、不产生空碎片/双分隔符（v3.60）。"""
        pos, _ = merger.merge_groups([g("a", "{}", weight=1.5)], ["a"])
        self.assertEqual(pos, "")
        pos2, _ = merger.merge_groups([g("a", "{}"), g("b", "BB")], ["a", "b"])
        self.assertEqual(pos2, "BB")  # 旧实现会输出 ", BB"

    def test_negative_empty_expansion_skipped(self):
        _, neg = merger.merge_groups([g("a", "AA", negative="{}"), g("b", "BB", negative="nb")], ["a", "b"])
        self.assertEqual(neg, "nb")

    def test_empty_selection(self):
        self.assertEqual(merger.merge_groups([g("a", "AA")], []), ("", ""))


class TestWildcards(unittest.TestCase):
    def test_basic_choice(self):
        out = merger.expand_wildcards("{red|blue} dress", random.Random(0))
        self.assertIn(out, ("red dress", "blue dress"))

    def test_seed_reproducible(self):
        t = "{a|b|c|d|e} {x|y} {1|2|3}"
        r1 = merger.expand_wildcards(t, random.Random(42))
        r2 = merger.expand_wildcards(t, random.Random(42))
        self.assertEqual(r1, r2)

    def test_no_brace_untouched(self):
        self.assertEqual(merger.expand_wildcards("plain text", random.Random(0)), "plain text")

    def test_nested(self):
        out = merger.expand_wildcards("{small {red|blue}|big}", random.Random(7))
        self.assertIn(out, ("small red", "small blue", "big"))

    def test_options_trimmed(self):
        out = merger.expand_wildcards("{ red | blue }", random.Random(0))
        self.assertIn(out, ("red", "blue"))

    def test_merge_with_wildcard_seed(self):
        groups = [g("a", "{cat|dog} on {grass|roof}")]
        p1, _ = merger.merge_groups(groups, ["a"], rng=random.Random(9))
        p2, _ = merger.merge_groups(groups, ["a"], rng=random.Random(9))
        self.assertEqual(p1, p2)
        self.assertRegex(p1, r"(cat|dog) on (grass|roof)")

    def test_wildcard_in_prepend_append(self):
        pos, _ = merger.merge_groups([g("a", "AA")], ["a"], prepend="{Hello|Hi}", rng=random.Random(0))
        self.assertRegex(pos, r"(Hello|Hi), AA")


class TestMainNode(unittest.TestCase):
    def _inline(self, groups):
        return json.dumps({"source": "inline", "name": "t"}), json.dumps(
            {"version": 1, "name": "t", "groups": groups})

    def test_execute_inline(self):
        lib, data = self._inline([g("a", "AA"), g("b", "BB")])
        pos, neg = nodes.PromptLibrary().execute(lib, '["b","a"]', ", ", 库数据=data)
        self.assertEqual(pos, "BB, AA")

    def test_execute_inline_ignore_weight(self):
        lib, data = self._inline([g("a", "AA", weight=1.3), g("b", "BB", weight=0.7)])
        pos, _ = nodes.PromptLibrary().execute(
            lib, '["a", "b"]', ", ", 库数据=data, 忽略权重=True)
        self.assertEqual(pos, "AA, BB")

    def test_is_changed_stable_without_wildcard(self):
        lib, data = self._inline([g("a", "AA")])
        c = nodes.PromptLibrary.IS_CHANGED(lib, '["a"]', ", ", 库数据=data)
        # inline 源：库数据本身是输入值 library_data（已在键里），首位只是来源标记
        self.assertEqual(c, ("inline", '["a"]', ", ", "", "", data, False, "{}"))

    def test_is_changed_varies_with_wildcard(self):
        lib, data = self._inline([g("a", "{x|y}")])
        c1 = nodes.PromptLibrary.IS_CHANGED(lib, '["a"]', ", ", 库数据=data)
        c2 = nodes.PromptLibrary.IS_CHANGED(lib, '["a"]', ", ", 库数据=data)
        self.assertNotEqual(c1, c2)

    def test_execute_inline_named_slot(self):
        lib, data = self._inline([g("a", "{性别:男人|女人} 走路")])
        pos, _ = nodes.PromptLibrary().execute(
            lib, '["a"]', ", ", 库数据=data,
            变量取值=json.dumps({"性别": "女人"}))
        self.assertEqual(pos, "女人 走路")

    def test_is_changed_varies_with_var_values(self):
        lib, data = self._inline([g("a", "AA")])
        c1 = nodes.PromptLibrary.IS_CHANGED(
            lib, '["a"]', ", ", 库数据=data, 变量取值='{"性别": "男人"}')
        c2 = nodes.PromptLibrary.IS_CHANGED(
            lib, '["a"]', ", ", 库数据=data, 变量取值='{"性别": "女人"}')
        self.assertNotEqual(c1, c2)  # 改命名槽取值必须换缓存键，否则输出不刷新


class TestIsChangedFileLibrary(unittest.TestCase):
    """回归（v3.32）：编辑保存组只改库 JSON 文件、不改任何 widget 输入，
    IS_CHANGED 缓存键必须随之变化——否则 ComfyUI 复用旧输出，
    表现为「改了组不生效，复制副本重新勾选才生效」。"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="vpl_test_")
        self._orig = nodes.library_store.get_user_libraries_folder
        nodes.library_store.get_user_libraries_folder = lambda: self._tmp
        self._path = nodes.library_store._user_path("t")
        self._data = {"version": 1, "name": "t", "groups": [g("a", "AA")]}
        self._write()
        self._lib = json.dumps({"source": "user", "name": "t"})

    def tearDown(self):
        nodes.library_store.get_user_libraries_folder = self._orig

    def _write(self):
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(self._data, f)
        os.utime(self._path, None)  # 显式刷新 mtime

    def test_key_changes_when_group_edited(self):
        c1 = nodes.PromptLibrary.IS_CHANGED(self._lib, '["a"]', ", ")
        self._data["groups"][0]["positive"] = "AA edited"
        self._write()
        c2 = nodes.PromptLibrary.IS_CHANGED(self._lib, '["a"]', ", ")
        self.assertNotEqual(c1, c2)  # 输入值全同、文件已改 → 键必须变

    def test_key_stable_when_untouched(self):
        c1 = nodes.PromptLibrary.IS_CHANGED(self._lib, '["a"]', ", ")
        c2 = nodes.PromptLibrary.IS_CHANGED(self._lib, '["a"]', ", ")
        self.assertEqual(c1, c2)  # 文件未动 → 键稳定，正常命中缓存

    def test_missing_library_key_stable(self):
        lib = json.dumps({"source": "user", "name": "no_such_lib"})
        c1 = nodes.PromptLibrary.IS_CHANGED(lib, '["a"]', ", ")
        c2 = nodes.PromptLibrary.IS_CHANGED(lib, '["a"]', ", ")
        self.assertEqual(c1, c2)


class TestNamedSlots(unittest.TestCase):
    """v3.34：命名槽 {名称:选项1|选项2} —— 面板固定取值替换；留空按选项随机；
    纯占位符 {名称} 无值原样保留；普通 {a|b} 行为不变。"""

    def test_named_slot_fixed_value(self):
        text = "a {性别:男人|女人} b"
        out = merger.expand_wildcards(text, random.Random(0), vars={"性别": "女人"})
        self.assertEqual(out, "a 女人 b")

    def test_named_slot_random_when_unset(self):
        out = merger.expand_wildcards("{性别:男人|女人}", random.Random(0))
        self.assertIn(out, ("男人", "女人"))

    def test_named_slot_options_with_colon_body(self):
        # 选项里带冒号（如时间/比例）仍按槽处理
        out = merger.expand_wildcards("{比例:16:9|9:16}", random.Random(0), vars={"比例": "9:16"})
        self.assertEqual(out, "9:16")

    def test_time_like_content_not_misjudged(self):
        # 名称纯数字 → 不算命名槽，仍按普通通配符整项随机（"09:00" / "18:00"）
        out = merger.expand_wildcards("{09:00|18:00}", random.Random(0))
        self.assertIn(out, ("09:00", "18:00"))

    def test_bare_placeholder_kept_when_unset(self):
        self.assertEqual(merger.expand_wildcards("a {人物} b"), "a {人物} b")

    def test_bare_placeholder_replaced(self):
        out = merger.expand_wildcards("a {人物} b", vars={"人物": "武士"})
        self.assertEqual(out, "a 武士 b")

    def test_plain_wildcard_unchanged_behavior(self):
        out = merger.expand_wildcards("{red|blue}", random.Random(0))
        self.assertIn(out, ("red", "blue"))

    def test_merge_groups_passes_vars(self):
        groups = [g("a", "{性别:男人|女人} 走路", prefix="{前:昏暗|明亮}")]
        pos, _ = merger.merge_groups(groups, ["a"], rng=random.Random(0), vars={"性别": "男人", "前": "明亮"})
        self.assertEqual(pos, "明亮男人 走路")

    def test_vars_empty_values_fall_back(self):
        # 空字符串取值视为未填 → 随机
        out = merger.expand_wildcards("{性别:男人|女人}", random.Random(0), vars={"性别": "  "})
        self.assertIn(out, ("男人", "女人"))

    def test_attr_tag_replaced_when_filled(self):
        # v3.35：#名称# 属性标签——填了值直接替换
        out = merger.expand_wildcards("#性别# 站在街头", vars={"性别": "女人"})
        self.assertEqual(out, "女人 站在街头")

    def test_attr_tag_kept_when_unset(self):
        self.assertEqual(merger.expand_wildcards("#性别# 站在街头"), "#性别# 站在街头")

    def test_attr_tag_coexists_with_wildcard(self):
        out = merger.expand_wildcards("#发型#{颜色|红色} 裙", random.Random(0), vars={"发型": "长发"})
        self.assertEqual(out, "长发红色 裙")

    def test_unpaired_hash_untouched(self):
        # 单个 # 不构成标签，保持原样
        self.assertEqual(merger.expand_wildcards("COCO #1 风格"), "COCO #1 风格")

    def test_fullwidth_hash_normalized(self):
        # v3.36：全角＃标签也能识别替换
        out = merger.expand_wildcards("＃性别＃ 站在街头", vars={"性别": "女人"})
        self.assertEqual(out, "女人 站在街头")


class TestRandomDraw(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="vpl_test_")
        self._orig = nodes.library_store.get_user_libraries_folder
        nodes.library_store.get_user_libraries_folder = lambda: self._tmp

    def tearDown(self):
        nodes.library_store.get_user_libraries_folder = self._orig

    def test_seed_reproducible(self):
        n = nodes.PromptRandomDraw()
        p1, _ = n.execute("builtin:default", 2, 123, ", ")
        p2, _ = n.execute("builtin:default", 2, 123, ", ")
        self.assertEqual(p1, p2)
        self.assertTrue(p1)  # 内置库有 5 张卡

    def test_count_clamped(self):
        n = nodes.PromptRandomDraw()
        p, neg = n.execute("builtin:default", 999, 1, "\n")
        # 内置库 5 张全抽出；其中 demo-005 是纯负向卡（positive 为空），正向只有 4 段
        self.assertEqual(p.count("\n") + 1, 4)
        self.assertIn("blurry", neg)

    def test_count_zero(self):
        n = nodes.PromptRandomDraw()
        p, neg = n.execute("builtin:default", 0, 1, ", ")
        self.assertEqual((p, neg), ("", ""))

    def test_category_filter(self):
        n = nodes.PromptRandomDraw()
        p, _ = n.execute("builtin:default", 999, 5, ", ", 分类筛选="光影")
        self.assertIn("rim light", p)

    def test_resolve_library_by_name(self):
        self.assertEqual(random_draw.resolve_locator("default"),
                         {"source": "user", "name": "default"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
