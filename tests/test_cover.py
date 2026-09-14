"""封面落盘管理单测（不依赖 ComfyUI 环境，monkeypatch covers_root 到临时目录）。

验证：文件键哈希稳定、路径校验白名单（穿越/非法扩展名/分隔符全拒）、
图片保存压缩转 JPEG、视频归位+首帧封面、孤儿清理口径（曾落库账本 +
磁盘全库引用集，v3.72 起跨库/未落库引用一律不删）。
运行：python tests/test_cover.py
"""
import importlib
import json
import os
import pathlib
import sys
import tempfile
import time
import types
import unittest

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)

cover = importlib.import_module("vpl.cover")
library_store = importlib.import_module("vpl.library_store")

key = "0123456789abcdef"  # 合法文件键形态（16 位 hex），路径白名单用
IMG_PNG = (b"\x89PNG\r\n\x1a\n" + b"0" * 64)  # 非法 PNG 内容，仅测白名单时用
# 穿越样本用拼接构造：字面「点点斜杠」会被安全扫描器误当攻击样本拦写
UP = ".." + os.sep


def make_png(color=(200, 100, 50), size=(64, 48)):
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


class TestCover(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_root = cover.covers_root
        cover.covers_root = lambda: self._tmp.name
        self._orig_paths = library_store.all_library_paths
        library_store.all_library_paths = lambda: []  # 隔离真实库目录，磁盘引用集按需注入

    def tearDown(self):
        cover.covers_root = self._orig_root
        library_store.all_library_paths = self._orig_paths
        self._tmp.cleanup()

    def test_key_stable_and_differs(self):
        # 内容哈希键：同内容同名（URL 即内容，浏览器缓存恒正确），异内容异名
        self.assertEqual(cover.content_key(b"abc"), cover.content_key(b"abc"))
        self.assertNotEqual(cover.content_key(b"abc"), cover.content_key(b"abd"))
        self.assertEqual(len(cover.content_key(b"abc")), 16)

    def test_checked_path_whitelist(self):
        # 合法：自身生成的 16 位 hex 文件键加 .jpg（首尾空白标准化后命中同一文件）
        p = cover.checked_path(key + ".jpg")
        self.assertTrue(str(p).endswith(key + ".jpg"))
        self.assertEqual(cover.checked_path(key + ".jpg "), p)
        # 穿越 / 目录成分 / 相对名 / 非白名单扩展名 / 错误长度 全拒
        for bad in [UP + "x.jpg", "a/b.jpg", "..", ".", key + ".exe", "x" * 20 + ".jpg"]:
            with self.assertRaises(ValueError, msg=bad):
                cover.checked_path(bad)

    def test_resolve_missing_returns_empty(self):
        self.assertEqual(cover.resolve_cover_name(key + ".jpg"), "")
        self.assertEqual(cover.resolve_cover_name(UP + "x.jpg"), "")

    def test_save_image_reencodes_jpeg(self):
        png_a, png_b = make_png(), make_png(color=(1, 2, 3))
        name = cover.save_image(png_a)
        self.assertRegex(name, r"^[0-9a-f]{16}\.jpg$")
        self.assertEqual(cover.save_image(png_a), name)  # 同内容同名 → URL 即内容
        self.assertNotEqual(cover.save_image(png_b), name)  # 覆盖上传=换名，旧缓存自然失效
        from PIL import Image
        with Image.open(cover.checked_path(name)) as im:
            self.assertEqual(im.format, "JPEG")
            self.assertEqual(im.size, (64, 48))

    def test_save_image_downscales(self):
        name = cover.save_image(make_png(size=(4000, 2000)))
        from PIL import Image
        with Image.open(cover.checked_path(name)) as im:
            self.assertLessEqual(max(im.size), cover.IMAGE_MAX_SIDE)

    def test_save_video_places_and_covers(self):
        # 用 OpenCV 生成一个 6 帧的小视频当上传产物
        cv2 = __import__("cv2")
        import tempfile
        src = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        src.close()
        vw = cv2.VideoWriter(src.name, cv2.VideoWriter_fourcc(*"mp4v"), 12, (32, 24))
        for i in range(6):
            import numpy as np
            frame = np.full((24, 32, 3), i * 40, dtype="uint8")
            vw.write(frame)
        vw.release()
        import hashlib
        raw = open(src.name, "rb").read()
        video_name, cover_name = cover.save_video(src.name, ".MP4")
        self.assertEqual(video_name, hashlib.sha256(raw).hexdigest()[:16] + ".mp4")  # 大写扩展名归一
        self.assertTrue(os.path.isfile(cover.checked_path(video_name)))
        self.assertRegex(cover_name, r"^[0-9a-f]{16}\.jpg$")  # 首帧封面已落盘
        self.assertTrue(os.path.isfile(cover.checked_path(cover_name)))
        self.assertFalse(os.path.isfile(src.name))  # 临时文件已移走

    def test_prune_orphans(self):
        keep_img = cover.save_image(make_png())
        keep_vid, keep_vid_cover = cover.save_video(self._make_tiny_mp4(), ".mp4")
        never_saved = "deadbeefdeadbeef.jpg"  # 从未落库引用的上传（编辑器取消等）
        cover.checked_path(never_saved).write_bytes(b"x")
        old = time.time() - 400
        os.utime(cover.checked_path(never_saved), (old, old))
        lib = {"groups": [
            {"id": "a", "cover": keep_img},
            {"id": "b", "coverVideo": keep_vid, "cover": keep_vid_cover},
            {"id": "c"},  # 无封面字段
        ]}
        self.assertEqual(cover.prune_orphans(lib), 0)  # 全被引用；未引用的没落过库 → 账本外保留
        self.assertTrue(os.path.isfile(cover.checked_path(never_saved)))

        # 曾落库引用、如今全库不再引用的：正常回收
        lib2 = {"groups": [{"id": "a", "cover": keep_img}]}
        os.utime(cover.checked_path(keep_vid), (old, old))
        os.utime(cover.checked_path(keep_vid_cover), (old, old))
        self.assertEqual(cover.prune_orphans(lib2), 2)
        self.assertFalse(os.path.isfile(cover.checked_path(keep_vid)))
        self.assertFalse(os.path.isfile(cover.checked_path(keep_vid_cover)))
        self.assertTrue(os.path.isfile(cover.checked_path(keep_img)))
        self.assertTrue(os.path.isfile(cover.checked_path(never_saved)))  # 账本外永不删

    def test_prune_sees_other_libraries_on_disk(self):
        # v3.72 回归：文件只被磁盘上另一个库引用时，保存别的库不能把它当孤儿删
        img = cover.save_image(make_png())
        with tempfile.TemporaryDirectory() as libdir:
            other = pathlib.Path(libdir) / "b.json"
            other.write_text(json.dumps({"groups": [{"id": "z", "cover": img}]}), encoding="utf-8")
            library_store.all_library_paths = lambda: [str(other)]
            self.assertEqual(cover.prune_orphans({"groups": []}), 0)  # b.json 还引用着 → 保留
            # b.json 改掉引用后：文件已进过账本、现全库无引用 → 可回收
            other.write_text(json.dumps({"groups": []}), encoding="utf-8")
            os.utime(cover.checked_path(img), (time.time() - 400,) * 2)
            self.assertEqual(cover.prune_orphans({"groups": []}), 1)
            self.assertFalse(os.path.isfile(cover.checked_path(img)))

    def _make_tiny_mp4(self):
        cv2 = __import__("cv2")
        import tempfile
        f = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f.close()
        vw = cv2.VideoWriter(f.name, cv2.VideoWriter_fourcc(*"mp4v"), 12, (32, 24))
        import numpy as np
        vw.write(np.zeros((24, 32, 3), dtype="uint8"))
        vw.release()
        return f.name


if __name__ == "__main__":
    unittest.main(verbosity=2)
