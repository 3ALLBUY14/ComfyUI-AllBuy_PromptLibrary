"""封面落盘管理单测（不依赖 ComfyUI 环境，monkeypatch covers_root 到临时目录）。

验证：文件键哈希稳定、路径校验白名单（穿越/非法扩展名/分隔符全拒）、
图片保存压缩转 JPEG、视频归位+首帧封面、孤儿清理引用集合口径。
运行：python tests/test_cover.py
"""
import importlib
import os
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

key = cover.cover_key("demo-001")
IMG_PNG = (b"\x89PNG\r\n\x1a\n" + b"0" * 64)  # 非法 PNG 内容，仅测白名单时用


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

    def tearDown(self):
        cover.covers_root = self._orig_root
        self._tmp.cleanup()

    def test_key_stable_and_differs(self):
        self.assertEqual(cover.cover_key("demo-001"), key)
        self.assertNotEqual(cover.cover_key("demo-001"), cover.cover_key("demo-002"))
        self.assertEqual(len(key), 16)

    def test_checked_path_whitelist(self):
        # 合法：自身生成的 <hash>.jpg（首尾空白标准化后命中同一文件）
        p = cover.checked_path(key + ".jpg")
        self.assertTrue(str(p).endswith(key + ".jpg"))
        self.assertEqual(cover.checked_path(key + ".jpg "), p)
        # 穿越 / 目录成分 / 相对名 / 非白名单扩展名 / 错误长度 全拒
        for bad in ["../x.jpg", "a/b.jpg", "..", ".", key + ".exe", "x" * 20 + ".jpg"]:
            with self.assertRaises(ValueError, msg=bad):
                cover.checked_path(bad)

    def test_resolve_missing_returns_empty(self):
        self.assertEqual(cover.resolve_cover_name(key + ".jpg"), "")
        self.assertEqual(cover.resolve_cover_name("../x.jpg"), "")

    def test_save_image_reencodes_jpeg(self):
        name = cover.save_image("g1", make_png())
        self.assertEqual(name, cover.cover_key("g1") + ".jpg")
        from PIL import Image
        with Image.open(cover.checked_path(name)) as im:
            self.assertEqual(im.format, "JPEG")
            self.assertEqual(im.size, (64, 48))

    def test_save_image_downscales(self):
        name = cover.save_image("g1", make_png(size=(4000, 2000)))
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
        video_name, cover_name = cover.save_video("g2", src.name, ".MP4")
        self.assertEqual(video_name, cover.cover_key("g2") + ".mp4")  # 大写扩展名归一
        self.assertTrue(os.path.isfile(cover.checked_path(video_name)))
        self.assertEqual(cover_name, cover.cover_key("g2") + ".jpg")  # 首帧封面已落盘
        self.assertTrue(os.path.isfile(cover.checked_path(cover_name)))
        self.assertFalse(os.path.isfile(src.name))  # 临时文件已移走

    def test_prune_orphans(self):
        keep_img = cover.save_image("a", make_png())
        keep_vid, keep_vid_cover = cover.save_video("b", self._make_tiny_mp4(), ".mp4")
        orphan = cover.cover_key("dead") + ".jpg"
        cover.checked_path(orphan).write_bytes(b"x")
        fresh_orphan = cover.cover_key("fresh") + ".jpg"
        cover.checked_path(fresh_orphan).write_bytes(b"x")
        # 新上传保护窗口内的孤儿不回收：把 mtime 回拨越过窗口才参与清理
        old = time.time() - 400
        os.utime(cover.checked_path(orphan), (old, old))
        lib = {"groups": [
            {"id": "a", "cover": keep_img},
            {"id": "b", "coverVideo": keep_vid, "cover": keep_vid_cover},
            {"id": "c"},  # 无封面字段
        ]}
        removed = cover.prune_orphans(lib)
        self.assertEqual(removed, 1)  # 只回收过期的孤儿，新鲜孤儿保留
        self.assertFalse(os.path.isfile(cover.checked_path(orphan)))
        self.assertTrue(os.path.isfile(cover.checked_path(fresh_orphan)))
        self.assertTrue(os.path.isfile(cover.checked_path(keep_img)))
        self.assertTrue(os.path.isfile(cover.checked_path(keep_vid)))
        self.assertTrue(os.path.isfile(cover.checked_path(keep_vid_cover)))

        lib2 = {"groups": [{"id": "a", "cover": keep_img}]}
        os.utime(cover.checked_path(keep_vid), (old, old))
        os.utime(cover.checked_path(keep_vid_cover), (old, old))
        removed2 = cover.prune_orphans(lib2)
        self.assertEqual(removed2, 2)  # e2e-2 的视频+封面不再被引用，过期后回收

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
