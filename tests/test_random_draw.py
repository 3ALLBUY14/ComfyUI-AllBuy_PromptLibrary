"""随机抽卡核心逻辑单测（不依赖 ComfyUI 环境，monkeypatch load_library）。

验证：预览(draw) = 节点执行(execute)、seed 可复现、数量钳制、分类筛选、正负合并。
运行：python tests/test_random_draw.py
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

random_draw = importlib.import_module("vpl.random_draw")
nodes = importlib.import_module("vpl.nodes")

FAKE = {"version": 1, "name": "fake", "groups": [
    {"id": "a", "name": "A", "category": "X", "positive": "PA", "negative": "NA"},
    {"id": "b", "name": "B", "category": "X", "positive": "PB", "negative": ""},
    {"id": "c", "name": "C", "category": "Y", "positive": "PC", "negative": ""},
    {"id": "d", "name": "D", "category": "Y", "positive": "", "negative": "ND"},
]}


class TestDraw(unittest.TestCase):
    def setUp(self):
        self._orig = random_draw.library_store.load_library
        random_draw.library_store.load_library = lambda loc: FAKE

    def tearDown(self):
        random_draw.library_store.load_library = self._orig

    def _ids(self, r):
        return [d["id"] for d in r["drawn"]]

    def test_reproducible(self):
        r1 = random_draw.draw("user:fake", 2, 42, ", ")
        r2 = random_draw.draw("user:fake", 2, 42, ", ")
        self.assertEqual(self._ids(r1), self._ids(r2))
        self.assertEqual(r1["positive"], r2["positive"])
        self.assertEqual(r1["negative"], r2["negative"])

    def test_seed_deterministic_len(self):
        r = random_draw.draw("user:fake", 2, 7, ", ")
        self.assertEqual(len(r["drawn"]), 2)

    def test_clamp_count(self):
        r = random_draw.draw("user:fake", 99, 0, ", ")
        self.assertEqual(r["total"], 4)
        self.assertEqual(r["count"], 4)
        self.assertEqual(len(r["drawn"]), 4)

    def test_count_zero(self):
        r = random_draw.draw("user:fake", 0, 0, ", ")
        self.assertEqual((r["positive"], r["negative"]), ("", ""))

    def test_category_filter(self):
        r = random_draw.draw("user:fake", 99, 0, ", ", filter_category="X")
        self.assertEqual(r["total"], 2)
        self.assertTrue(all(i in ("a", "b") for i in self._ids(r)))

    def test_merge_positive_negative(self):
        r = random_draw.draw("user:fake", 4, 0, ", ")
        # 抽卡顺序随机（rng.sample 同时打乱顺序），校验为候选集的一个排列
        self.assertEqual(set(r["positive"].split(", ")), {"PA", "PB", "PC"})
        self.assertEqual(set(r["negative"].split(", ")), {"NA", "ND"})

    def test_draw_matches_node_execute(self):
        # 前端 /draw 预览与节点 execute 走同一 draw()，必须逐字一致
        pos, neg = nodes.PromptRandomDraw().execute("user:fake", 4, 0, ", ")
        r = random_draw.draw("user:fake", 4, 0, ", ")
        self.assertEqual(pos, r["positive"])
        self.assertEqual(neg, r["negative"])

    def test_prepend_append(self):
        r = random_draw.draw("user:fake", 4, 0, ", ", prepend="PRE", append="POST")
        mid = r["positive"].split(", ")
        self.assertEqual(mid[0], "PRE")
        self.assertEqual(mid[-1], "POST")
        self.assertEqual(set(mid[1:-1]), {"PA", "PB", "PC"})

    def test_category_compat_plural(self):
        fake2 = {"version": 1, "name": "fake2", "groups": [
            {"id": "a", "name": "A", "categories": ["X", "Z"], "positive": "PA", "negative": ""},
            {"id": "b", "name": "B", "category": "Y", "positive": "PB", "negative": ""},
        ]}
        random_draw.library_store.load_library = lambda loc: fake2
        r = random_draw.draw("user:fake2", 99, 0, ", ", filter_category="Z")
        self.assertEqual(r["total"], 1)
        self.assertEqual(self._ids(r), ["a"])

    def test_category_combo_union(self):
        # v3.45：分类组合多选并集——命中任一分类即入池
        r = random_draw.draw("user:fake", 99, 0, ", ", filter_category=["X", "Y"])
        self.assertEqual(r["total"], 4)
        r2 = random_draw.draw("user:fake", 99, 0, ", ", filter_category=["Y"])
        self.assertEqual(r2["total"], 2)
        self.assertTrue(all(i in ("c", "d") for i in self._ids(r2)))

    def test_category_json_string_and_legacy(self):
        # v3.45：前端注入 JSON 数组字符串；旧存档单字符串保持兼容
        r1 = random_draw.draw("user:fake", 99, 0, ", ", filter_category='["X"]')
        r2 = random_draw.draw("user:fake", 99, 0, ", ", filter_category="X")
        self.assertEqual(r1["total"], 2)
        self.assertEqual(r2["total"], 2)
        self.assertEqual(r1["categories"], ["X"])

    def test_tag_filter(self):
        # v3.45：标签筛选（多选并集），并与分类组合取交集
        fake3 = {"version": 1, "name": "fake3", "groups": [
            {"id": "a", "name": "A", "category": "X", "tags": ["人像", "室内"], "positive": "PA", "negative": ""},
            {"id": "b", "name": "B", "category": "X", "tags": ["风景"], "positive": "PB", "negative": ""},
            {"id": "c", "name": "C", "category": "Y", "tags": ["人像"], "positive": "PC", "negative": ""},
        ]}
        random_draw.library_store.load_library = lambda loc: fake3
        r1 = random_draw.draw("user:fake3", 99, 0, ", ", filter_tags=["人像"])
        self.assertEqual(r1["total"], 2)
        r2 = random_draw.draw("user:fake3", 99, 0, ", ",
                              filter_category=["X"], filter_tags=["人像", "风景"])
        self.assertEqual(r2["total"], 2)   # X ∩ (人像∪风景) = a、b
        r3 = random_draw.draw("user:fake3", 99, 0, ", ", filter_tags='["风景"]')
        self.assertEqual(r3["total"], 1)
        self.assertEqual(self._ids(r3), ["b"])


class TestLockedDraw(unittest.TestCase):
    """v3.43：锁定卡（必含、不占数量名额、不生效时忽略）。"""

    def setUp(self):
        self._orig = random_draw.library_store.load_library
        random_draw.library_store.load_library = lambda loc: FAKE

    def tearDown(self):
        random_draw.library_store.load_library = self._orig

    def _ids(self, r):
        return [d["id"] for d in r["drawn"]]

    def test_locked_always_included(self):
        for seed in (0, 1, 7, 42, 999):
            r = random_draw.draw("user:fake", 1, seed, ", ", locked_ids=["c"])
            self.assertIn("c", self._ids(r))
            self.assertEqual(len(r["drawn"]), 1)

    def test_locked_not_counted_against_count(self):
        # 锁定 2 张 + 数量 1 → 锁定的全保留，不再另抽（其余名额被钳为 0）
        r = random_draw.draw("user:fake", 1, 0, ", ", locked_ids=["a", "c"])
        self.assertEqual(self._ids(r), ["a", "c"])

    def test_locked_fill_rest_from_unlocked(self):
        r = random_draw.draw("user:fake", 3, 5, ", ", locked_ids=["d"])
        self.assertIn("d", self._ids(r))
        self.assertEqual(len(r["drawn"]), 3)
        self.assertEqual(len(set(self._ids(r))), 3)  # 无重复

    def test_locked_outside_pool_ignored(self):
        # 分类筛掉锁定卡 / 锁定 id 不存在 → 静默忽略，回退普通抽卡
        r1 = random_draw.draw("user:fake", 2, 42, ", ", filter_category="X", locked_ids=["c"])
        self.assertTrue(all(i in ("a", "b") for i in self._ids(r1)))
        r2 = random_draw.draw("user:fake", 2, 42, ", ", locked_ids=["zz", "zz"])
        self.assertEqual(len(self._ids(r2)), 2)
        self.assertNotIn("zz", self._ids(r2))

    def test_locked_deterministic(self):
        r1 = random_draw.draw("user:fake", 3, 42, ", ", locked_ids=["a"])
        r2 = random_draw.draw("user:fake", 3, 42, ", ", locked_ids=["a"])
        self.assertEqual(self._ids(r1), self._ids(r2))

    def test_locked_flag_and_count(self):
        r = random_draw.draw("user:fake", 2, 3, ", ", locked_ids=["b"])
        flags = {d["id"]: d["locked"] for d in r["drawn"]}
        self.assertTrue(flags["b"])
        self.assertEqual(r["count"], len(r["drawn"]))

    def test_count_zero_with_locked(self):
        r = random_draw.draw("user:fake", 0, 0, ", ", locked_ids=["a"])
        self.assertEqual(self._ids(r), ["a"])
        r2 = random_draw.draw("user:fake", 0, 0, ", ")
        self.assertEqual(self._ids(r2), [])


class TestVarsAndNodeInjection(unittest.TestCase):
    """v3.43：命名槽/属性标签取值透传 + 节点 execute 的 JSON 字符串注入参数。"""

    FAKE_VARS = {"version": 1, "name": "fakev", "groups": [
        {"id": "a", "name": "A", "positive": "#性别# 侧脸", "negative": ""},
        {"id": "b", "name": "B", "positive": "{镜头:特写|全景}", "negative": ""},
    ]}

    def setUp(self):
        self._orig = random_draw.library_store.load_library
        random_draw.library_store.load_library = lambda loc: self.FAKE_VARS

    def tearDown(self):
        random_draw.library_store.load_library = self._orig

    def test_vars_tag_replacement(self):
        r = random_draw.draw("user:fakev", 1, 0, ", ", locked_ids=["a"], vars={"性别": "女人"})
        self.assertEqual(r["positive"], "女人 侧脸")

    def test_vars_named_slot(self):
        r = random_draw.draw("user:fakev", 1, 0, ", ", locked_ids=["b"], vars={"镜头": "特写"})
        self.assertEqual(r["positive"], "特写")

    def test_no_vars_tag_bare_and_slot_random(self):
        r = random_draw.draw("user:fakev", 2, 0, ", ", locked_ids=["a", "b"])
        pos_a, pos_b = r["positive"].split(", ")
        self.assertEqual(pos_a, "#性别# 侧脸")            # 标签无值原样保留
        self.assertIn(pos_b, ("特写", "全景"))             # 命名槽无值按候选随机

    def test_node_execute_json_injection(self):
        # 前端 graphToPrompt 注入的是 JSON 字符串，节点 execute 必须容错解析
        pos, _ = nodes.PromptRandomDraw().execute(
            "user:fakev", 2, 0, ", ", 变量取值='{"性别":"女人"}', 锁定卡片='["a"]')
        self.assertIn("女人 侧脸", pos)

    def test_node_execute_bad_json_fallback(self):
        # 非法 JSON 不应抛异常，回退默认（锁定无效 = 普通抽卡；vars 空 = 原样/随机）
        pos, neg = nodes.PromptRandomDraw().execute(
            "user:fakev", 2, 0, ", ", 变量取值="not-json", 锁定卡片="also-bad")
        self.assertIn("侧脸", pos)
        self.assertIsInstance(neg, str)

    def test_is_changed_includes_locked_and_vars(self):
        cls = nodes.PromptRandomDraw
        k1 = cls.IS_CHANGED(库="user:x", 数量=1, 随机种子=0, 分隔符=", ",
                            变量取值='{"性别":"女人"}', 锁定卡片='["a"]')
        k2 = cls.IS_CHANGED(库="user:x", 数量=1, 随机种子=0, 分隔符=", ",
                            变量取值='{}', 锁定卡片='["a"]')
        k3 = cls.IS_CHANGED(库="user:x", 数量=1, 随机种子=0, 分隔符=", ",
                            变量取值='{}', 锁定卡片='[]')
        self.assertNotEqual(k1, k2)
        self.assertNotEqual(k2, k3)

    def test_node_execute_filter_injection(self):
        # v3.45：节点 execute 透传分类组合 / 标签筛选（JSON 字符串形态）；本类 setUp 用 FAKE_VARS 库，
        # 故此处在测试内临时换成 FAKE
        orig = random_draw.library_store.load_library
        random_draw.library_store.load_library = lambda loc: FAKE
        try:
            pos, _ = nodes.PromptRandomDraw().execute(
                "user:fake", 99, 0, ", ", 分类筛选='["X"]', 标签筛选="[]")
            self.assertEqual(set(pos.split(", ")), {"PA", "PB"})
        finally:
            random_draw.library_store.load_library = orig

    def test_is_changed_includes_filters(self):
        # v3.45：分类组合 / 标签筛选变化必须命中不同缓存键
        cls = nodes.PromptRandomDraw
        base = dict(库="user:x", 数量=1, 随机种子=0, 分隔符=", ")
        k1 = cls.IS_CHANGED(**base, 分类筛选='["X"]', 标签筛选="[]")
        k2 = cls.IS_CHANGED(**base, 分类筛选='["Y"]', 标签筛选="[]")
        k3 = cls.IS_CHANGED(**base, 分类筛选='["Y"]', 标签筛选='["t"]')
        self.assertNotEqual(k1, k2)
        self.assertNotEqual(k2, k3)


class TestLoadCached(unittest.TestCase):
    """v3.43：库内容缓存——命中 mtime 签名时不重复读盘；解析不到文件的 locator 直通不缓存。"""

    def setUp(self):
        random_draw._lib_cache.clear()

    def tearDown(self):
        random_draw._lib_cache.clear()

    def test_unresolvable_locator_bypasses_cache(self):
        calls = {"n": 0}
        orig = random_draw.library_store.load_library
        def fake_load(loc):
            calls["n"] += 1
            return {"groups": [{"id": "a"}]}
        random_draw.library_store.load_library = fake_load
        try:
            for _ in range(3):
                d = random_draw._load_cached({"source": "user", "name": "no_such_lib_xyz"})
                self.assertEqual(d["groups"][0]["id"], "a")
            self.assertEqual(calls["n"], 3)  # 每次都直通（单测 monkeypatch 语义不被缓存破坏）
        finally:
            random_draw.library_store.load_library = orig

    def test_real_file_cached_by_mtime(self):
        import tempfile
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        try:
            tmp.write('{"groups":[{"id":"a"}]}')
            tmp.close()
            loc = {"source": "custom", "name": tmp.name}
            orig_resolve = random_draw.library_store.resolve
            orig_load = random_draw.library_store.load_library
            calls = {"n": 0}
            def fake_resolve(x):
                return (tmp.name, False)
            def fake_load(_loc):
                calls["n"] += 1
                return {"groups": [{"id": "a"}]}
            random_draw.library_store.resolve = fake_resolve
            random_draw.library_store.load_library = fake_load
            try:
                t1 = 1700000000.0
                os.utime(tmp.name, (t1, t1))
                random_draw._load_cached(loc)
                random_draw._load_cached(loc)
                self.assertEqual(calls["n"], 1)  # 第二次命中缓存
                os.utime(tmp.name, (t1 + 10, t1 + 10))  # mtime 变化 → 失效重读
                random_draw._load_cached(loc)
                self.assertEqual(calls["n"], 2)
            finally:
                random_draw.library_store.resolve = orig_resolve
                random_draw.library_store.load_library = orig_load
        finally:
            os.unlink(tmp.name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
