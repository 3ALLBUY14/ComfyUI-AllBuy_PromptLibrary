"""素材加载节点（media_asset.py）P1 单元测试（不依赖 ComfyUI 环境）。

覆盖：清单解析容错、选择顺序、缩放计算、文件指纹稳定、IS_CHANGED 键、
相对路径防穿越（file 字段不得越出素材目录）。

运行：python tests/test_media_asset.py
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

media = importlib.import_module("vpl.media_asset")


class ParseManifestTests(unittest.TestCase):
    def test_empty_and_garbage(self):
        for raw in ("", None, "not json", "[1,2]", "123"):
            m = media.parse_manifest(raw)
            self.assertEqual(m["assets"], [])
            self.assertEqual(m["selected"], {"image": [], "audio": None, "video": None})
            self.assertEqual(m["scale"]["mode"], "none")

    def test_roundtrip_preserves_fields(self):
        raw = json.dumps({
            "version": 1,
            "assets": [{"id": "a1", "file": "allbuy_media/x.png", "type": "image",
                        "label": "x", "size": 1, "mtime": 2, "w": 3, "h": 4}],
            "selected": {"image": ["a1"], "audio": None, "video": None},
            "scale": {"mode": "longest", "value": 512, "multiple": 8},
        })
        m = media.parse_manifest(raw)
        self.assertEqual(m["assets"][0]["id"], "a1")
        self.assertEqual(m["selected"]["image"], ["a1"])
        self.assertEqual(m["scale"], {"mode": "longest", "value": 512, "multiple": 8})

    def test_selected_type_coercion(self):
        m = media.parse_manifest(json.dumps({"selected": {"image": "a1", "audio": 5}}))
        self.assertEqual(m["selected"]["image"], [])
        self.assertIsNone(m["selected"]["audio"])


class OrderedSelectedTests(unittest.TestCase):
    def test_order_follows_selected(self):
        manifest = media.parse_manifest(json.dumps({
            "assets": [
                {"id": "a", "file": "allbuy_media/a.png", "type": "image"},
                {"id": "b", "file": "allbuy_media/b.png", "type": "image"},
                {"id": "c", "file": "allbuy_media/c.wav", "type": "audio"},
            ],
            "selected": {"image": ["b", "a"]},
        }))
        ids = [e["id"] for e in media.ordered_selected_images(manifest)]
        self.assertEqual(ids, ["b", "a"])  # 音频条目不进图片列表

    def test_stale_ids_skipped(self):
        manifest = media.parse_manifest(json.dumps({
            "assets": [{"id": "a", "file": "allbuy_media/a.png", "type": "image"}],
            "selected": {"image": ["ghost", "a"]},
        }))
        self.assertEqual([e["id"] for e in media.ordered_selected_images(manifest)], ["a"])


class ScaledSizeTests(unittest.TestCase):
    def test_none_mode_passthrough(self):
        self.assertEqual(media.scaled_size(100, 50, {"mode": "none", "value": 1024}), (100, 50))

    def test_longest_shortest_width_height(self):
        s = {"value": 200, "multiple": 0}
        self.assertEqual(media.scaled_size(400, 200, {**s, "mode": "longest"}), (200, 100))
        self.assertEqual(media.scaled_size(400, 200, {**s, "mode": "shortest"}), (400, 200))
        self.assertEqual(media.scaled_size(400, 200, {**s, "mode": "width"}), (200, 100))
        self.assertEqual(media.scaled_size(400, 200, {**s, "mode": "height"}), (400, 200))
        self.assertEqual(media.scaled_size(200, 400, {**s, "mode": "longest"}), (100, 200))

    def test_multiple_alignment(self):
        self.assertEqual(media.scaled_size(1000, 333, {"mode": "longest", "value": 512, "multiple": 8}), (512, 168))
        self.assertEqual(media.scaled_size(1000, 333, {"mode": "longest", "value": 512, "multiple": 0}), (512, 170))

    def test_invalid_inputs(self):
        self.assertEqual(media.scaled_size(0, 0, {"mode": "longest", "value": 512}), (0, 0))
        self.assertEqual(media.scaled_size(100, 50, {"mode": "longest", "value": 0}), (100, 50))


class FingerprintTests(unittest.TestCase):
    def test_stable_and_missing(self):
        fp = media.file_fingerprint(__file__)
        self.assertEqual(fp, media.file_fingerprint(__file__))
        self.assertIn("missing", media.file_fingerprint("Z:/definitely/not/here.bin"))


class IsChangedTests(unittest.TestCase):
    def test_key_changes_with_manifest(self):
        k1 = media.MediaAssetLoader.IS_CHANGED('{"selected":{"image":["a"]}}')
        k2 = media.MediaAssetLoader.IS_CHANGED('{"selected":{"image":["a","b"]}}')
        self.assertNotEqual(k1, k2)

    def test_key_stable_without_change(self):
        m = '{"selected":{"image":[]}}'
        self.assertEqual(media.MediaAssetLoader.IS_CHANGED(m), media.MediaAssetLoader.IS_CHANGED(m))

    def test_key_ignores_thumbw(self):
        """thumbW 是纯 UI 偏好（缩略图卡宽），不得打翻执行缓存（v3.60 回归）。"""
        base = '{"assets":[{"id":"a","file":"allbuy_media/a.png","type":"image"}],"selected":{"image":["a"]},"thumbW":120}'
        widened = base.replace('"thumbW":120', '"thumbW":360')
        self.assertEqual(media.MediaAssetLoader.IS_CHANGED(base),
                         media.MediaAssetLoader.IS_CHANGED(widened))
        # 其他字段变化仍要换键
        moved = base.replace('"image":["a"]', '"image":[]')
        self.assertNotEqual(media.MediaAssetLoader.IS_CHANGED(base),
                            media.MediaAssetLoader.IS_CHANGED(moved))

    def test_function_renamed_not_execute(self):
        # 防回归：方法名不得叫 execute（安全扫描器误报动态 SQL），FUNCTION 指向 load_media
        self.assertNotIn("execute", media.MediaAssetLoader.FUNCTION)
        self.assertTrue(callable(getattr(media.MediaAssetLoader, media.MediaAssetLoader.FUNCTION)))


class SafePathTests(unittest.TestCase):
    def test_relative_rejects_directory_escape(self):
        # 防穿越：相对路径只接受素材目录内单段文件名（环境无 folder_paths 时 media_root
        # 回退到 ~/ComfyUI/input，此处仅验证路径拼接与白名单逻辑，不依赖真实文件存在）
        self.assertEqual(media.resolve_media_path("allbuy_media/sub/../../evil.png"), "")
        self.assertEqual(media.resolve_media_path("other_dir/x.png"), "")
        self.assertEqual(media.resolve_media_path(""), "")

    def test_asset_type(self):
        self.assertEqual(media.asset_type("a.PNG"), "image")
        self.assertEqual(media.asset_type("b.Mp3"), "audio")
        self.assertEqual(media.asset_type("c.mkv"), "video")
        self.assertEqual(media.asset_type("d.txt"), "")

    def test_safe_name_allows_unicode(self):
        # v3.54：中文文件名必须能通过白名单（缩略图 404 回归）
        self.assertTrue(media._SAFE_NAME_RE.fullmatch("Krea2_双采_底图_00001_.png"))
        self.assertTrue(media._SAFE_NAME_RE.fullmatch("clip 01 (v2).mp4"))
        self.assertFalse(media._SAFE_NAME_RE.fullmatch("a/b.png"))
        self.assertFalse(media._SAFE_NAME_RE.fullmatch("a\\b.png"))


class VideoSelectionTests(unittest.TestCase):
    def test_full_clip_defaults(self):
        s, e, fps, mf = media.compute_video_selection(12.0, 24.0, {})
        self.assertEqual((s, e, fps, mf), (0.0, 12.0, 24.0, 0))

    def test_selection_window(self):
        vp = {"start": 2.0, "end": 8.0, "fps": 16, "max_frames": 100}
        s, e, fps, mf = media.compute_video_selection(12.0, 24.0, vp)
        self.assertEqual((s, e, fps, mf), (2.0, 8.0, 16.0, 100))

    def test_end_clamped_to_duration(self):
        _, e, _, _ = media.compute_video_selection(5.0, 30.0, {"start": 1.0, "end": 99.0})
        self.assertEqual(e, 5.0)

    def test_end_before_start_means_full(self):
        _, e, _, _ = media.compute_video_selection(5.0, 30.0, {"start": 3.0, "end": 1.0})
        self.assertEqual(e, 5.0)

    def test_fps_zero_means_source(self):
        _, _, fps, _ = media.compute_video_selection(10.0, 25.0, {"fps": 0})
        self.assertEqual(fps, 25.0)

    def test_estimate(self):
        self.assertEqual(media.estimate_video_frames(1.0, 9.0, 16.0, 0), 128)
        self.assertEqual(media.estimate_video_frames(1.0, 9.0, 16.0, 50), 50)
        self.assertEqual(media.estimate_video_frames(0.0, 0.0, 16.0, 0), 0)   # 未知终点
        self.assertEqual(media.estimate_video_frames(1.0, 9.0, 0.0, 0), 0)    # 未知帧率


class ManifestParamsTests(unittest.TestCase):
    def test_video_audio_params_roundtrip(self):
        raw = json.dumps({
            "video_params": {"start": 1.5, "end": 8.0, "fps": 16, "max_frames": 128},
            "audio_params": {"start": 7.4, "duration": 12.8},
        })
        m = media.parse_manifest(raw)
        self.assertEqual(m["video_params"]["fps"], 16)
        self.assertEqual(m["audio_params"]["duration"], 12.8)

    def test_params_defaults(self):
        m = media.parse_manifest("{}")
        self.assertEqual(m["video_params"], {"start": 0.0, "end": 0.0, "fps": 0, "max_frames": 0})
        self.assertEqual(m["audio_params"], {"start": 0.0, "duration": 0.0})

    def test_params_type_coercion(self):
        m = media.parse_manifest(json.dumps({"video_params": "bad", "audio_params": [1]}))
        self.assertEqual(m["video_params"]["end"], 0.0)
        self.assertEqual(m["audio_params"]["start"], 0.0)


class AudioClipParamsTests(unittest.TestCase):
    def test_clip_with_missing_file_gives_silence(self):
        out = media.load_audio_clip("Z:/no/such.wav", {"start": 1.0, "duration": 2.0})
        self.assertIn("waveform", out)
        self.assertEqual(out["sample_rate"], 44100)


class CropAndMaskTests(unittest.TestCase):
    def test_crop_box_px_basic(self):
        self.assertEqual(media.crop_box_px(1000, 500, [0.1, 0.2, 0.5, 0.8]), (100, 100, 500, 400))

    def test_crop_box_px_clamps_and_sorts(self):
        # 越界收紧、两点顺序无关
        self.assertEqual(media.crop_box_px(100, 100, [0.9, 0.9, 0.2, 0.1]), (20, 10, 90, 90))
        self.assertEqual(media.crop_box_px(100, 100, [-0.5, -0.5, 1.5, 1.5]), (0, 0, 100, 100))

    def test_crop_box_px_invalid(self):
        self.assertIsNone(media.crop_box_px(100, 100, [0.5, 0.5, 0.5, 0.5]))  # 零面积
        self.assertIsNone(media.crop_box_px(100, 100, None))
        self.assertIsNone(media.crop_box_px(100, 100, "bad"))
        self.assertIsNone(media.crop_box_px(0, 0, [0.0, 0.0, 1.0, 1.0]))

    def test_mask_key_shape_and_stability(self):
        k = media.mask_key("allbuy_media/x.png")
        self.assertTrue(__import__("re").fullmatch(r"[0-9a-f]{16}\.png", k))
        self.assertEqual(k, media.mask_key("allbuy_media/x.png"))
        self.assertNotEqual(k, media.mask_key("allbuy_media/y.png"))

    def test_resolve_mask_path_rejects_non_hex(self):
        self.assertEqual(media.resolve_mask_path("../../evil.png"), "")
        self.assertEqual(media.resolve_mask_path("zzzz.png"), "")
        self.assertEqual(media.resolve_mask_path(""), "")

    def test_is_changed_includes_mask(self):
        m1 = '{"assets":[{"id":"a","file":"allbuy_media/a.png","type":"image","mask":null}],"selected":{"image":["a"]}}'
        m2 = '{"assets":[{"id":"a","file":"allbuy_media/a.png","type":"image","mask":"0123456789abcdef.png"}],"selected":{"image":["a"]}}'
        k1 = media.MediaAssetLoader.IS_CHANGED(m1)
        k2 = media.MediaAssetLoader.IS_CHANGED(m2)
        self.assertNotEqual(k1, k2)  # 挂上遮罩后缓存键必须变化

    def test_return_types_include_mask(self):
        self.assertEqual(media.MediaAssetLoader.RETURN_TYPES,
                         ("IMAGE", "MASK", "IMAGE", "AUDIO", "*", "INT",
                          "VHS_VIDEOINFO", "AUDIO"))
        # 帧率口必须是通配类型：VHS 的 frame_rate 是自定义 floatOrInt，严格 INT 连不上（v3.55 回归）
        self.assertEqual(media.MediaAssetLoader.RETURN_NAMES[4], "帧率")
        self.assertEqual(media.MediaAssetLoader.RETURN_TYPES[4], "*")
        # 视频音频口：选中视频按选区裁剪的原声（AUDIO）
        self.assertEqual(media.MediaAssetLoader.RETURN_NAMES[3], "视频音频")
        self.assertEqual(media.MediaAssetLoader.RETURN_TYPES[3], "AUDIO")
        # VHS LoadVideo 同款：帧计数 INT + 视频信息 VHS_VIDEOINFO
        self.assertEqual(media.MediaAssetLoader.RETURN_NAMES[5], "帧计数")
        self.assertEqual(media.MediaAssetLoader.RETURN_TYPES[5], "INT")
        self.assertEqual(media.MediaAssetLoader.RETURN_NAMES[6], "视频信息")
        self.assertEqual(media.MediaAssetLoader.RETURN_TYPES[6], "VHS_VIDEOINFO")
        # 用户要求移除的口不得复活（v3.55：视频文件口与素材JSON口）
        self.assertNotIn("VIDEO", media.MediaAssetLoader.RETURN_TYPES)
        self.assertNotIn("素材JSON", media.MediaAssetLoader.RETURN_NAMES)


class LoadMediaTests(unittest.TestCase):
    """load_media 端到端（v3.56 回归，此前零覆盖）：八输出口必须永远合法。

    v3.55 未选视频时 return 引用未赋值的 vframes（UnboundLocalError），
    纯图片/纯音频工作流全灭；解码失败路径还会把 None 塞进视频帧口。
    """

    def test_empty_manifest_returns_placeholder_tuple(self):
        node = media.MediaAssetLoader()
        out = node.load_media("{}")
        self.assertEqual(len(out), 8)
        image_t, mask_t, vframes_t, v_audio, fps, n_frames, video_info, audio = out
        # 图片 / 遮罩 / 视频帧口都是合法 tensor，绝不允许 None
        self.assertEqual(tuple(image_t.shape), (1, 8, 8, 3))
        self.assertEqual(tuple(mask_t.shape), (1, 8, 8))
        self.assertEqual(tuple(vframes_t.shape), (1, 8, 8, 3))
        self.assertEqual(fps, 0)
        self.assertEqual(n_frames, 0)
        self.assertEqual(video_info, {})
        # 两个音频口都是静音占位 AUDIO dict
        for a in (v_audio, audio):
            self.assertIn("waveform", a)
            self.assertEqual(a["sample_rate"], 44100)

    def test_video_selected_but_file_missing_gives_placeholder(self):
        node = media.MediaAssetLoader()
        m = json.dumps({
            "assets": [{"id": "v1", "file": "allbuy_media/ghost.mp4", "type": "video"}],
            "selected": {"image": [], "audio": None, "video": "v1"},
        })
        out = node.load_media(m)
        self.assertEqual(tuple(out[2].shape), (1, 8, 8, 3))  # 占位而非 None/崩溃
        self.assertEqual(out[4], 0)
        self.assertEqual(out[5], 0)

    def test_video_id_not_in_assets_gives_placeholder(self):
        node = media.MediaAssetLoader()
        m = json.dumps({"selected": {"image": [], "audio": None, "video": "ghost"}})
        out = node.load_media(m)
        self.assertEqual(tuple(out[2].shape), (1, 8, 8, 3))

    def test_image_only_manifest_with_real_file(self):
        import os
        import tempfile
        from PIL import Image
        node = media.MediaAssetLoader()
        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            Image.new("RGB", (32, 16), (200, 10, 10)).save(path)
            # file 用绝对路径（resolve_media_path 对存在的外部绝对路径原样放行）
            m = json.dumps({
                "assets": [{"id": "p1", "file": path, "type": "image", "w": 32, "h": 16}],
                "selected": {"image": ["p1"], "audio": None, "video": None},
            })
            out = node.load_media(m)
            image_t, mask_t = out[0], out[1]
            self.assertEqual(tuple(image_t.shape), (1, 16, 32, 3))
            self.assertEqual(tuple(mask_t.shape), (1, 16, 32))  # 遮罩与图片 batch 逐张对齐
            self.assertAlmostEqual(float(image_t[0, 0, 0, 0]), 200 / 255.0, places=5)
        finally:
            os.unlink(path)

    def test_mask_aligned_when_earlier_image_fails(self):
        """回归（v3.60）：排序靠前的图片加载失效时，幸存图的真遮罩不得错位/丢失。

        旧实现 load_images_to_tensor 失败即跳过，sizes 与 entries 失配，
        load_masks_to_tensor 的 zip 把幸存图的遮罩配给了失效图 —— 遮罩悄悄变全零。
        """
        import os
        import tempfile
        from PIL import Image
        node = media.MediaAssetLoader()
        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            Image.new("RGB", (32, 16), (10, 200, 10)).save(path)
            key = media.mask_key("aligned_mask_test.png")
            mask_path = os.path.join(media.masks_root(), key)
            Image.new("L", (32, 16), 255).save(mask_path)  # 全白遮罩
            try:
                m = json.dumps({
                    "assets": [
                        {"id": "bad", "file": "allbuy_media/ghost_missing.png", "type": "image"},
                        {"id": "ok", "file": path, "type": "image", "w": 32, "h": 16, "mask": key},
                    ],
                    "selected": {"image": ["bad", "ok"], "audio": None, "video": None},
                })
                out = node.load_media(m)
                image_t, mask_t = out[0], out[1]
                self.assertEqual(image_t.shape[0], 1)  # 只有一张加载成功
                self.assertEqual(mask_t.shape[0], image_t.shape[0])  # batch 计数必须对齐
                # 关键：幸存那张的真遮罩必须还在（全白 → 1.0），不能错位成全零
                self.assertGreater(float(mask_t[0].max()), 0.99)
            finally:
                os.unlink(mask_path)
        finally:
            os.unlink(path)

    def test_mask_batch_all_failed_matches_placeholder_count(self):
        """全部图片失效：图片口落黑图占位，遮罩口 batch 计数必须同为 1。"""
        node = media.MediaAssetLoader()
        m = json.dumps({
            "assets": [
                {"id": "b1", "file": "allbuy_media/ghost1.png", "type": "image"},
                {"id": "b2", "file": "allbuy_media/ghost2.png", "type": "image"},
            ],
            "selected": {"image": ["b1", "b2"], "audio": None, "video": None},
        })
        out = node.load_media(m)
        self.assertEqual(tuple(out[0].shape), (1, 8, 8, 3))
        self.assertEqual(tuple(out[1].shape), (1, 8, 8))  # 旧实现会输出 (2,H,W)，与图片口错位


class AudioExportTests(unittest.TestCase):
    def test_slice_pcm(self):
        import numpy as np
        sr = 100
        pcm = np.arange(200, dtype=np.float32).reshape(1, 200) / 200.0
        sel, _ = media.slice_pcm(pcm, sr, 0.5, 1.0)   # 0.5s~1.5s → 50~150
        self.assertEqual(sel.shape, (1, 100))
        sel2, _ = media.slice_pcm(pcm, sr, 1.5, 0.0)  # duration=0 → 到结尾
        self.assertEqual(sel2.shape, (1, 50))

    def test_slice_pcm_nan_and_garbage(self):
        # 手改工作流可能把 NaN/非数字塞进 audio_params（2026-09-09 审查 R4）：
        # 必须回退全曲，不得炸在 int() 上
        import numpy as np
        pcm = np.zeros((2, 100), dtype=np.float32)
        sel, _ = media.slice_pcm(pcm, 100, float("nan"), 1.0)
        self.assertEqual(sel.shape, (2, 100))
        sel2, _ = media.slice_pcm(pcm, 100, "abc", float("inf"))
        self.assertEqual(sel2.shape, (2, 100))

    def test_pcm_to_wav_bytes(self):
        import io
        import wave
        import numpy as np
        pcm = np.tile(np.linspace(-1, 1, 100, dtype=np.float32), (2, 1))
        data = media.pcm_to_wav_bytes(pcm, 44100)
        with wave.open(io.BytesIO(data), "rb") as w:
            self.assertEqual(w.getnchannels(), 2)
            self.assertEqual(w.getsampwidth(), 2)
            self.assertEqual(w.getframerate(), 44100)
            self.assertEqual(w.getnframes(), 100)
        # 极值不削波溢出：±1 → ±32767
        self.assertLessEqual(max(abs(d) for d in data[44:48]), 32767)


class SafeImagePathTests(unittest.TestCase):
    """/image 端点边界（batch_image_node.is_safe_image_path）。

    v3.57 修复任意文件读取：现在必须「绝对路径 + 图片扩展名 + PIL 可解码」
    三关全过；批量选图"任意绝对目录"既定功能不回归（resolve_root 仍放行）。
    """

    def setUp(self):
        import tempfile
        from PIL import Image
        fd, self.png = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        Image.new("RGB", (4, 4), (1, 2, 3)).save(self.png)
        fd, self.fake = tempfile.mkstemp(suffix=".png")  # 扩展名伪装的非图片
        os.write(fd, "这是文本文件，不是图片".encode("utf-8"))
        os.close(fd)

    def tearDown(self):
        for p in (self.png, self.fake):
            try:
                os.unlink(p)
            except OSError:
                pass

    def test_real_image_passes(self):
        bips = importlib.import_module("vpl.batch_image_node")
        self.assertTrue(bips.is_safe_image_path(self.png))

    def test_disguised_text_rejected(self):
        # 只骗过扩展名不够：内容不可解码为图片必须拒绝
        bips = importlib.import_module("vpl.batch_image_node")
        self.assertFalse(bips.is_safe_image_path(self.fake))

    def test_non_image_ext_rejected(self):
        import tempfile
        bips = importlib.import_module("vpl.batch_image_node")
        fd, txt = tempfile.mkstemp(suffix=".txt")
        os.write(fd, b"secret")
        os.close(fd)
        try:
            self.assertFalse(bips.is_safe_image_path(txt))
        finally:
            os.unlink(txt)

    def test_relative_empty_missing_rejected(self):
        bips = importlib.import_module("vpl.batch_image_node")
        self.assertFalse(bips.is_safe_image_path("input/rel.png"))
        self.assertFalse(bips.is_safe_image_path(""))
        self.assertFalse(bips.is_safe_image_path("Z:/definitely/not/here.png"))

    def test_resolve_root_still_accepts_any_abs_dir(self):
        # 既定功能不回归：任意存在的绝对目录仍可作为批量选图根目录
        bips = importlib.import_module("vpl.batch_image_node")
        d = os.path.dirname(self.png)
        self.assertEqual(bips.resolve_root(d), d)


class IterVideoFramesTests(unittest.TestCase):
    """v3.57 导出流式帧迭代器：与 load_video_frames 选区口径一致、全程定尺寸。"""

    @classmethod
    def setUpClass(cls):
        import tempfile
        import cv2
        import numpy as np
        fd, path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 24.0, (48, 32))
        if not vw.isOpened():
            vw.release()
            try:
                os.unlink(path)
            except OSError:
                pass
            raise unittest.SkipTest("cv2 mp4v VideoWriter 不可用")
        for i in range(24):
            frame = np.zeros((32, 48, 3), dtype=np.uint8)
            frame[:, :, 2] = int(255 * i / 23.0)  # BGR 的 R 通道随帧号渐变
            vw.write(frame)
        vw.release()
        cls.path = path

    @classmethod
    def tearDownClass(cls):
        try:
            os.unlink(cls.path)
        except OSError:
            pass

    def test_missing_file_gives_none(self):
        fps, it = media.iter_video_frames("Z:/definitely/not/here.mp4", {}, {"mode": "none"})
        self.assertIsNone(it)
        self.assertEqual(fps, 0.0)

    def test_full_clip_all_frames(self):
        import cv2
        import numpy as np
        # 基准取 cv2 顺序解码裸帧数。end=duration 时选区截断条件用 grab 后的
        # POS_MSEC（已指向下一帧位置），恰好跨过 end 的末帧会被切——这是
        # load_video_frames 的既有边界语义，流式迭代器必须与它完全一致，
        # 相对裸解码最多差这 1 帧
        cap = cv2.VideoCapture(self.path)
        n_raw = 0
        while True:
            ok, _f = cap.read()
            if not ok:
                break
            n_raw += 1
        cap.release()
        self.assertGreater(n_raw, 0)
        fps, it = media.iter_video_frames(self.path, {}, {"mode": "none"})
        frames = list(it)
        batch, _ = media.load_video_frames(self.path, {}, {"mode": "none"})
        self.assertEqual(len(frames), batch.shape[0])  # 两端口径一致
        self.assertIn(len(frames), (n_raw, n_raw - 1))
        self.assertGreater(fps, 0)
        self.assertEqual(frames[0].shape, (32, 48, 3))
        self.assertEqual(frames[0].dtype, np.uint8)

    def test_window_matches_batch_path(self):
        # 导出流式与节点整段 batch 必须抽到同一批帧（同一选区口径）。
        # 合成 mp4v 的实际时基可能偏离标称帧率，帧数只对两端口径与公式量级断言，
        # 不钉死容器时基细节（estimate 公式本身已由 VideoSelectionTests 单独钉死）
        vp = {"start": 0.5, "end": 1.5, "fps": 12, "max_frames": 0}
        scale = {"mode": "none"}
        _, it = media.iter_video_frames(self.path, vp, scale)
        streamed = sum(1 for _ in it)
        batch, _ = media.load_video_frames(self.path, vp, scale)
        self.assertEqual(batch.shape[0], streamed)
        est = media.estimate_video_frames(0.5, 1.5, 12.0, 0)
        self.assertGreaterEqual(streamed, 1)
        self.assertLessEqual(streamed, est + 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
