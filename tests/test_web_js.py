"""web/ 前端 JS 模块严格语法检查（不依赖 ComfyUI 环境）。

背景：node --check 对 .js 按 CommonJS 解析，`const` 重复声明等 ESM 早期错误
可能漏报（v3.92 事故：image_compare.js 重复声明 onMouseDown，浏览器模块解析
失败、扩展静默不加载）。这里把每个 .js 复制为 .mjs 后以 ESM 模式严格检查。

运行：python tests/test_web_js.py（需 node 在 PATH）
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


class WebJsSyntaxTests(unittest.TestCase):
    def test_every_web_js_parses_as_esm(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过前端语法检查")
        js_files = sorted(f for f in os.listdir(WEB_DIR) if f.endswith(".js"))
        self.assertTrue(js_files, "web/ 下没有任何 .js")
        with tempfile.TemporaryDirectory() as td:
            for name in js_files:
                dst = os.path.join(td, name + ".mjs")
                shutil.copyfile(os.path.join(WEB_DIR, name), dst)
                r = subprocess.run(
                    [shutil.which("node"), "--check", dst],
                    capture_output=True, text=True,
                )
                self.assertEqual(
                    r.returncode, 0,
                    f"{name} 无法按 ESM 模块解析（浏览器将静默不加载本扩展）:\n{r.stderr}",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
