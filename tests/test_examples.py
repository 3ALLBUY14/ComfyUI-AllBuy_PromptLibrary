"""示例工作流加载测试（对齐 NO8D 的 test_example_workflows 思路）。

保证 examples/ 下每个工作流：
1. 是合法 JSON；
2. 用到的节点类型都在 NODE_CLASS_MAPPINGS 里（老别名也算）；
3. links 引用的节点/槽位存在（防止改输出口后示例悄悄失效）。

运行：python tests/test_examples.py
"""
import importlib
import json
import os
import sys
import types
import unittest

# 把插件目录挂成 "vpl" 包（目录名带连字符无法直接 import）
PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)

nodes_mod = importlib.import_module("vpl.nodes")
bips_mod = importlib.import_module("vpl.batch_image_node")
media_mod = importlib.import_module("vpl.media_asset")

EXAMPLES_DIR = os.path.join(PKG_DIR, "examples")
KNOWN_TYPES = (set(nodes_mod.NODE_CLASS_MAPPINGS) | set(bips_mod.NODE_CLASS_MAPPINGS)
               | set(media_mod.NODE_CLASS_MAPPINGS))
# 本测试不加载 ComfyUI 核心环境，示例里用到的节点单独放行：
# - CORE_TYPES：ComfyUI 核心
# - DEMO_TYPES：示例模板引用的第三方演示节点（Easy-Use 文本预览 / VHS 视频信息 /
#   核心 Save 系列）。白名单只放行这几个，出现别的未知类型仍会报错拦住
CORE_TYPES = {"CLIPTextEncode", "PreviewImage", "Note", "CheckpointLoaderSimple",
              "UNETLoader", "VAELoader", "CLIPLoader", "SaveAudio", "SaveVideo"}
DEMO_TYPES = {"easy showAnything", "CreateVideo", "VHS_VideoInfoLoaded"}


def _example_files():
    return sorted(
        os.path.join(EXAMPLES_DIR, f)
        for f in os.listdir(EXAMPLES_DIR)
        if f.endswith(".json")
    )


class ExampleWorkflowTests(unittest.TestCase):
    def test_examples_exist(self):
        files = _example_files()
        self.assertTrue(files, "examples/ 目录下没有任何示例工作流")

    def test_each_example_loads_and_types_known(self):
        self.assertTrue(_example_files())
        for path in _example_files():
            with self.subTest(example=os.path.basename(path)):
                with open(path, "r", encoding="utf-8") as fh:
                    wf = json.load(fh)
                nodes = wf.get("nodes", [])
                self.assertTrue(nodes, "工作流没有节点")
                types_in_wf = {n.get("type") for n in nodes}
                unknown = types_in_wf - KNOWN_TYPES - CORE_TYPES - DEMO_TYPES - {"Note"}
                self.assertFalse(
                    unknown,
                    f"{os.path.basename(path)} 引用了未注册的节点类型: {unknown}",
                )
                # links 格式 [id, origin_id, origin_slot, target_id, target_slot, type]
                node_ids = {n.get("id") for n in nodes}
                for lk in wf.get("links", []):
                    if isinstance(lk, dict):  # 新前端序列化格式
                        origin, target = lk.get("origin_id"), lk.get("target_id")
                    else:  # 旧数组格式
                        origin, target = lk[1], lk[3]
                    self.assertIn(origin, node_ids, f"link 起点 {origin} 不存在")
                    self.assertIn(target, node_ids, f"link 终点 {target} 不存在")


if __name__ == "__main__":
    unittest.main(verbosity=2)
