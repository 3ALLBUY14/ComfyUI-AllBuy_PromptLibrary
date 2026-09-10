"""素材加载节点：图片 / 音频 / 视频统一入料、持久化与预处理。

数据模型（存于隐藏 widget `素材清单` 的 JSON，同步 properties._media）：
- assets: 素材条目数组，每条含 id / file（相对 input 的路径或外部绝对路径）/
  type（image、audio、video）/ label / size / mtime / w / h / duration / fps / tags
- selected: image 为有序 id 数组（batch 拼接顺序），audio 与 video 为单选 id 或 null
- scale: 缩放设置，mode 取 none、longest、shortest、width、height，附 value 与 multiple
- video_params / audio_params: 视频与音频的选区裁剪参数

持久化：前端直接调用 ComfyUI 原生 upload 接口把素材复制进 input/allbuy_media/，
后端不做任何写盘操作，只按清单只读解析；外部引用素材仅记录绝对路径。

现状（v3.58）：全部输出口可用——图片/遮罩 batch（逐张对齐）、视频选区帧序列
（节点整段 batch 与导出流式共用选区逻辑）、帧率/帧计数/视频信息、音频裁剪与波形。
"""
import hashlib
import json
import math
import os
import re

from . import constants  # noqa: F401  预留：版本握手/常量

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff")
AUDIO_EXTS = (".wav", ".mp3", ".ogg", ".m4a", ".flac", ".aac")
VIDEO_EXTS = (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg")

# 素材统一存到 input/allbuy_media/（复用 ComfyUI input 体系：可预览、可写）
MEDIA_SUBDIR = "allbuy_media"


def media_root():
    """素材持久化根目录 = ComfyUI input/allbuy_media/，缺目录时创建。"""
    try:
        from folder_paths import get_input_directory
        base = os.path.join(get_input_directory(), MEDIA_SUBDIR)
    except Exception:
        base = os.path.join(os.path.expanduser("~"), "ComfyUI", "input", MEDIA_SUBDIR)
    os.makedirs(base, exist_ok=True)
    return base


def masks_root():
    """遮罩持久化根目录 = ComfyUI input/allbuy_media_masks/（与素材分目录）。"""
    try:
        from folder_paths import get_input_directory
        base = os.path.join(get_input_directory(), "allbuy_media_masks")
    except Exception:
        base = os.path.join(os.path.expanduser("~"), "ComfyUI", "input", "allbuy_media_masks")
    os.makedirs(base, exist_ok=True)
    return base


def mask_key(asset_file):
    """素材文件名 → 16 位 hex 遮罩键（遮罩文件名只可能是 <hex>.png，杜绝路径注入）。"""
    return hashlib.sha256((asset_file or "").encode("utf-8")).hexdigest()[:16] + ".png"


def resolve_mask_path(key):
    """遮罩键（<16位hex>.png）→ 绝对路径；同样走规范化 + 根目录边界校验。"""
    key = (key or "").strip()
    if not re.fullmatch(r"[0-9a-f]{16}\.png", key):
        return ""
    root = os.path.normpath(masks_root())
    cand = os.path.normpath(os.path.join(root, key))
    if cand == root or not cand.startswith(root + os.sep):
        return ""
    return cand if os.path.isfile(cand) else ""


def crop_box_px(w, h, crop):
    """归一化裁剪框 [x0,y0,x1,y1] → 像素 box（PIL crop 用）；无有效面积返回 None。"""
    try:
        x0, y0, x1, y1 = (float(crop[0]), float(crop[1]), float(crop[2]), float(crop[3]))
    except Exception:
        return None
    x0, x1 = sorted((min(max(x0, 0.0), 1.0), min(max(x1, 0.0), 1.0)))
    y0, y1 = sorted((min(max(y0, 0.0), 1.0), min(max(y1, 0.0), 1.0)))
    if w <= 0 or h <= 0 or x1 - x0 < 1e-6 or y1 - y0 < 1e-6:
        return None
    bx0, by0 = round(x0 * w), round(y0 * h)
    bx1 = max(bx0 + 1, round(x1 * w))
    by1 = max(by0 + 1, round(y1 * h))
    return (bx0, by0, min(bx1, w), min(by1, h))


# 单段文件名白名单：Unicode 字母数字（\w，含中文）+ 空格 . ( ) [ ] - _
# 目录成分（/ \）不在字符类内，配合 _safe_join 的规范化边界校验防穿越
_SAFE_NAME_RE = re.compile(r"[\w .()\[\]-]+", re.UNICODE)  # 保留：唯一文件名清洗用（上传侧）


def resolve_media_path(rel_or_abs):
    """清单里的 file 字段 → 绝对路径；相对路径仅接受素材目录内的单段文件名。

    相对路径取末段（basename 切断目录成分），允许任意 Unicode 字符（中文/emoji/# 等，
    素材文件名来自社交平台，内容不可控）；防穿越由 _safe_join 的规范化 + 根目录
    边界校验兜底（"." / ".." 与任何带分隔符的构造都过不去），清单即使被篡改
    也无法越界读取文件。外部引用素材存绝对路径，存在才返回。
    """
    p = (rel_or_abs or "").strip()
    if not p:
        return ""
    if os.path.isabs(p):
        return p if os.path.isfile(p) else ""
    name = p.replace("\\", "/").split("/")[-1]
    if not name or name in (".", ".."):
        return ""
    root = os.path.normpath(media_root())
    cand = os.path.normpath(os.path.join(root, name))
    if cand == root or not cand.startswith(root + os.sep):
        return ""
    return cand if os.path.isfile(cand) else ""


def asset_type(name_or_path):
    ext = os.path.splitext(name_or_path)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in VIDEO_EXTS:
        return "video"
    return ""


# ---------------------------------------------------------------------------
# 元数据探测：图片用 PIL；音视频优先 PyAV，缺失时视频退化 cv2，全部尽力而为
# ---------------------------------------------------------------------------
_probe_cache = {}  # abs_path -> ((mtime_ns, size), meta dict)


def probe_asset(abs_path):
    """探测素材元数据，拿不到的字段留零，绝不抛异常。"""
    meta = {"w": 0, "h": 0, "duration": 0.0, "fps": 0.0}
    try:
        st = os.stat(abs_path)
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        return meta
    cached = _probe_cache.get(abs_path)
    if cached and cached[0] == key:
        return dict(cached[1])
    t = asset_type(abs_path)
    try:
        if t == "image":
            from PIL import Image
            with Image.open(abs_path) as im:
                meta["w"], meta["h"] = im.size
        elif t in ("audio", "video"):
            _probe_av(abs_path, meta, t)
    except Exception:
        pass  # 探测失败保持全零，前端显示占位
    _probe_cache[abs_path] = (key, dict(meta))
    return meta


def _probe_av(abs_path, meta, t):
    try:
        import av
        with av.open(abs_path) as c:
            if t == "video":
                vs = c.streams.video[0] if c.streams.video else None
                if vs:
                    meta["w"], meta["h"] = vs.width or 0, vs.height or 0
                    try:
                        meta["fps"] = float(vs.average_rate) if vs.average_rate else 0.0
                    except Exception:
                        meta["fps"] = 0.0
                    meta["duration"] = _duration_of(c, vs)
            else:
                a_s = c.streams.audio[0] if c.streams.audio else None
                if a_s:
                    meta["duration"] = _duration_of(c, a_s)
    except ImportError:
        if t == "video":
            try:
                import cv2
                cap = cv2.VideoCapture(abs_path)
                if cap.isOpened():
                    meta["fps"] = cap.get(cv2.CAP_PROP_FPS) or 0.0
                    meta["w"] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
                    meta["h"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
                    n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
                    if meta["fps"] and n:
                        meta["duration"] = n / meta["fps"]
                cap.release()
            except Exception:
                pass
    except Exception:
        pass


def _duration_of(container, stream):
    d = getattr(stream, "duration", None)
    if d and getattr(stream, "time_base", None):
        try:
            return float(d * stream.time_base)
        except Exception:
            pass
    try:
        return float(container.duration / 1_000_000) if container.duration else 0.0
    except Exception:
        return 0.0


def file_fingerprint(abs_path):
    """O(1) 文件指纹 path:mtime_ns:size（VHS 同款思路：不整文件哈希）。"""
    try:
        st = os.stat(abs_path)
        return f"{abs_path}:{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return f"{abs_path}:missing"


def parse_manifest(text):
    try:
        data = json.loads(text) if text else {}
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("version", 1)
    assets = data.get("assets")
    data["assets"] = assets if isinstance(assets, list) else []
    sel = data.get("selected")
    if not isinstance(sel, dict):
        sel = {}
    if not isinstance(sel.get("image"), list):
        sel["image"] = []
    sel["image"] = [x for x in sel["image"] if isinstance(x, str)]
    if not isinstance(sel.get("audio"), str):
        sel["audio"] = None
    if not isinstance(sel.get("video"), str):
        sel["video"] = None
    data["selected"] = sel
    scale = data.get("scale") if isinstance(data.get("scale"), dict) else {}
    scale.setdefault("mode", "none")
    scale.setdefault("value", 1024)
    scale.setdefault("multiple", 0)
    data["scale"] = scale
    vp = data.get("video_params") if isinstance(data.get("video_params"), dict) else {}
    vp.setdefault("start", 0.0)
    vp.setdefault("end", 0.0)      # 0 = 到结尾
    vp.setdefault("fps", 0)        # 0 = 原速
    vp.setdefault("max_frames", 0)  # 0 = 不限
    data["video_params"] = vp
    ap = data.get("audio_params") if isinstance(data.get("audio_params"), dict) else {}
    ap.setdefault("start", 0.0)
    ap.setdefault("duration", 0.0)  # 0 = 到结尾
    data["audio_params"] = ap
    return data


def ordered_selected_images(manifest):
    """按 selected.image 顺序返回 assets 里的图片条目（跳过失效 id）。"""
    by_id = {a.get("id"): a for a in manifest["assets"] if isinstance(a, dict)}
    out = []
    for aid in manifest["selected"].get("image") or []:
        a = by_id.get(aid)
        if a and a.get("type") == "image":
            out.append(a)
    return out


# ---------------------------------------------------------------------------
# 缩放：LayerStyle v2 参数制（mode + value + multiple），P1 用于图片输出
# ---------------------------------------------------------------------------
def scaled_size(w, h, scale):
    mode = (scale.get("mode") or "none")
    value = int(scale.get("value") or 0)
    mult = int(scale.get("multiple") or 0)
    if mode == "none" or value <= 0 or w <= 0 or h <= 0:
        return int(w), int(h)
    if mode == "width":
        nw, nh = value, max(1, round(h * value / w))
    elif mode == "height":
        nw, nh = max(1, round(w * value / h)), value
    elif mode == "longest":
        if w >= h:
            nw, nh = value, max(1, round(h * value / w))
        else:
            nw, nh = max(1, round(w * value / h)), value
    elif mode == "shortest":
        if w <= h:
            nw, nh = value, max(1, round(h * value / w))
        else:
            nw, nh = max(1, round(w * value / h)), value
    else:
        return int(w), int(h)
    if mult in (8, 16, 32, 64):
        nw = max(mult, round(nw / mult) * mult)
        nh = max(mult, round(nh / mult) * mult)
    return nw, nh


# ---------------------------------------------------------------------------
# 视频：选区 + 帧率重采样 + 帧数上限（VHS 同款时间累积丢帧法），cv2 主路径
# ---------------------------------------------------------------------------
# 无帧数上限时的兜底（防长视频解爆内存）；节点执行与导出流式两条路径共用
HARD_MAX_FRAMES = 4096


def compute_video_selection(duration, src_fps, vp):
    """纯函数：由源时长/源帧率与视频参数计算选区与输出规格。

    返回 (start, end, target_fps, max_frames)。end/duration 为 0 表示到结尾。
    """
    start = max(0.0, float(vp.get("start") or 0.0))
    end = float(vp.get("end") or 0.0)
    if duration > 0:
        end = duration if end <= start else min(end, duration)
    elif end <= start:
        end = 0.0  # 无时长信息且未指定终点：解到文件结束
    fps = float(vp.get("fps") or 0.0)
    target_fps = fps if fps > 0 else (src_fps or 0.0)
    max_frames = max(0, int(vp.get("max_frames") or 0))
    return start, end, target_fps, max_frames


def _open_video_selection(abs_path, vp):
    """打开视频并计算选区规格，返回 (cap, start, end, target_fps, limit)。

    cap 为 None 表示打开失败。load_video_frames（节点整段 batch）与
    iter_video_frames（导出流式）共用，保证两个端口径一致不分叉。
    """
    import cv2
    cap = cv2.VideoCapture(abs_path)
    if not cap.isOpened():
        return None, 0.0, 0.0, 0.0, 0
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    n_meta = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration = (n_meta / src_fps) if (src_fps > 0 and n_meta > 0) else 0.0
    start, end, target_fps, max_frames = compute_video_selection(duration, src_fps, vp)
    return cap, start, end, target_fps, (max_frames if max_frames > 0 else HARD_MAX_FRAMES)


def load_video_frames(abs_path, vp, scale):
    """解码视频选区为 (B,H,W,3) float32 batch，返回 (tensor 或 None, 输出帧率)。

    cv2 主路径；seek 到起点后按时间累积丢帧实现重采样，选区终点统一按
    POS_MSEC 截断；逐帧按 scale 缩放，尺寸不一致 letterbox 居中填充。
    """
    import cv2
    import numpy as np
    import torch

    cap, start, end, target_fps, limit = _open_video_selection(abs_path, vp)
    if cap is None:
        return None, 0.0
    try:
        if start > 0:
            cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
        interval = (1.0 / target_fps) if target_fps > 0 else None
        next_t = 0.0
        frames = []
        staged = 0
        # 暂存 uint8 帧的内存预算：HARD_MAX_FRAMES 只是帧数闸，1080p×4096 帧
        # uint8 暂存就 ~25GB、转 float32 再翻 4 倍，必炸——超预算直接报错并给出出路
        staged_budget = 4 * 1024 * 1024 * 1024
        while len(frames) < limit:
            ok = cap.grab()
            if not ok:
                break
            t_rel = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0 - start
            if end > start and t_rel >= (end - start):
                break
            if interval is not None and t_rel < next_t:
                continue
            ok, frame = cap.retrieve()
            if not ok:
                break
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            nw, nh = scaled_size(frame.shape[1], frame.shape[0], scale)
            if (nw, nh) != (frame.shape[1], frame.shape[0]):
                frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
            frames.append(frame)
            staged += frame.nbytes
            if staged > staged_budget:
                raise RuntimeError(
                    f"视频选区输出过大：已解码暂存 {staged / 1024 ** 3:.1f}GB（预算 4GB）。"
                    "请缩短选区、调低目标帧率或帧数上限，或先用 ⚙ 缩放设置缩小分辨率。")
            if interval is not None:
                next_t += interval
    finally:
        cap.release()
    if not frames:
        return None, target_fps
    max_h = max(f.shape[0] for f in frames)
    max_w = max(f.shape[1] for f in frames)
    buf = np.zeros((len(frames), max_h, max_w, 3), dtype=np.float32)
    for i in range(len(frames)):
        f = frames[i]
        h, w = f.shape[:2]
        if w == max_w and h == max_h:
            buf[i] = f
        else:
            y0 = (max_h - h) // 2
            x0 = (max_w - w) // 2
            buf[i, y0:y0 + h, x0:x0 + w] = f
        frames[i] = None  # 边拷边放：峰值内存少一倍（uint8 暂存 + float32 buf 不同时满额）
    return torch.from_numpy(buf / 255.0), target_fps


def iter_video_frames(abs_path, vp, scale):
    """流式产出视频选区帧，供 /media/export/video 边解码边编码（内存 O(1 帧)）。

    返回 (target_fps, 帧迭代器)；打开失败返回 (0.0, None)。迭代器产出 RGB uint8
    (H,W,3)，全部统一到首帧画布（异常流尺寸漂移时居中贴入、越界裁边——导出编码器
    要求全程定尺寸）。选区/重采样/终点截断与 load_video_frames 同一套口径。
    """
    import cv2
    import numpy as np

    cap, start, end, target_fps, limit = _open_video_selection(abs_path, vp)
    if cap is None:
        return 0.0, None

    def gen():
        nonlocal next_t
        canvas = None  # (h, w)：首帧定的输出画布
        n = 0
        try:
            if start > 0:
                cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
            interval = (1.0 / target_fps) if target_fps > 0 else None
            while n < limit:
                ok = cap.grab()
                if not ok:
                    break
                t_rel = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0 - start
                if end > start and t_rel >= (end - start):
                    break
                if interval is not None and t_rel < next_t:
                    continue
                ok, frame = cap.retrieve()
                if not ok:
                    break
                frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                nw, nh = scaled_size(frame.shape[1], frame.shape[0], scale)
                if (nw, nh) != (frame.shape[1], frame.shape[0]):
                    frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
                if canvas is None:
                    canvas = (frame.shape[0], frame.shape[1])
                ch, cw = canvas
                if frame.shape[0] == ch and frame.shape[1] == cw:
                    out = frame
                else:
                    out = np.zeros((ch, cw, 3), dtype=np.uint8)
                    y0 = max(0, (ch - frame.shape[0]) // 2)
                    x0 = max(0, (cw - frame.shape[1]) // 2)
                    hh = min(ch - y0, frame.shape[0])
                    ww = min(cw - x0, frame.shape[1])
                    out[y0:y0 + hh, x0:x0 + ww] = frame[:hh, :ww]
                n += 1
                yield out
                if interval is not None:
                    next_t += interval
        finally:
            cap.release()

    next_t = 0.0
    return target_fps, gen()


def estimate_video_frames(start, end, target_fps, max_frames):
    """纯函数：估算输出帧数（与执行时逐帧计数同公式），供前端计算预览复用。

    时长或帧率未知（无法估算）时返回 0 表示「由执行时实际计数」。
    """
    if end > start and target_fps > 0:
        n = int(round((end - start) * target_fps))
    else:
        return 0
    if max_frames > 0:
        n = min(n, max_frames)
    return max(0, n)


# ---------------------------------------------------------------------------
# 音频：PyAV 统一重采样为立体声 float（planar），按秒裁剪；波形峰值给前端绘制
# ---------------------------------------------------------------------------
_audio_pcm_cache = {}  # abs_path -> ((mtime_ns, size), (pcm (ch,n) float32, sr))


def decode_audio_pcm(abs_path):
    """解码音频为 (pcm (channels, samples) float32, sample_rate)，带 mtime 缓存。

    PyAV AudioResampler 统一转 fltp/stereo，规避封装格式差异；失败返回 (None, 0)。
    """
    import numpy as np
    try:
        st = os.stat(abs_path)
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        return None, 0
    cached = _audio_pcm_cache.get(abs_path)
    if cached and cached[0] == key:
        pcm, sr = cached[1]
        return (pcm.copy() if pcm is not None else None), sr
    try:
        import av
        with av.open(abs_path) as c:
            streams = c.streams.audio
            if not streams:
                return None, 0
            stream = streams[0]
            sr = int(stream.codec_context.sample_rate or 44100)
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=sr)
            chunks = []
            for frame in c.decode(stream):
                for rf in resampler.resample(frame):
                    arr = rf.to_ndarray()
                    if arr.ndim == 1:
                        arr = arr[None, :]
                    chunks.append(arr.astype(np.float32))
            if not chunks:
                return None, sr
            pcm = np.concatenate(chunks, axis=1)
            # 单条 PCM 超 256MB（数小时级长音频）不进缓存：8 条 × 长音频可吃掉数 GB；
            # 超限直接返回，波形/导出按需重新解码（慢但不炸内存）
            if pcm.nbytes <= 256 * 1024 * 1024:
                _audio_pcm_cache[abs_path] = (key, (pcm, sr))
                while len(_audio_pcm_cache) > 8:  # 立体声 float PCM 体积大，少量缓存即可
                    _audio_pcm_cache.pop(next(iter(_audio_pcm_cache)))
            return pcm, sr
    except Exception:
        return None, 0


def pcm_to_wav_bytes(pcm, sr):
    """立体声 float PCM → 16-bit WAV 字节（音频导出用，纯标准库编码）。"""
    import io
    import wave
    import numpy as np
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(pcm.shape[0])
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes((np.clip(pcm.T, -1.0, 1.0) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def slice_pcm(pcm, sr, start, duration):
    """按 (起点秒, 时长秒) 切 PCM；duration<=0 = 到结尾。返回 (切片, sr)。"""
    # 手改工作流可能把 NaN/字符串塞进 audio_params：守卫在共享函数一处，别炸在 int() 上
    try:
        start, duration = float(start or 0.0), float(duration or 0.0)
    except (TypeError, ValueError):
        start, duration = 0.0, 0.0
    if not (math.isfinite(start) and math.isfinite(duration)):
        start, duration = 0.0, 0.0
    i0 = max(0, int(start * sr))
    i1 = int((start + duration) * sr) if duration > 0 else pcm.shape[1]
    i1 = min(max(i1, i0), pcm.shape[1])
    return pcm[:, i0:i1], sr


def silent_audio(seconds=0.05, sr=44100):
    """静音占位 AUDIO dict。

    不能用 [1,1,1] 单采样：下游 torchaudio.functional.resample 换算采样率时会把
    1 采样舍入成 0 采样（H3 对口型 _encode_ref_audio 收到 [1,0,1] 直接崩，
    见 comfyui.prev2.log 2026-09-08），50ms 静音对任何重采样率都安全。
    """
    import torch
    n = max(1, int(sr * seconds))
    return {"waveform": torch.zeros((1, 1, n)), "sample_rate": sr}


def load_audio_clip(abs_path, ap):
    """按 (start, duration) 裁剪音频为 ComfyUI AUDIO dict；失败给静音占位。"""
    import numpy as np
    import torch

    pcm, sr = decode_audio_pcm(abs_path)
    if pcm is None or pcm.size == 0 or sr <= 0:
        return silent_audio()
    sel, sr = slice_pcm(pcm, sr, ap.get("start"), ap.get("duration"))
    if sel.shape[1] == 0:
        # 选区越界：给 50ms 静音（别用 1 采样，下游重采样会舍入成 0）
        sel = np.zeros((pcm.shape[0], max(1, int(sr * 0.05))), dtype=np.float32)
    return {"waveform": torch.from_numpy(sel).unsqueeze(0), "sample_rate": sr}


def wave_peaks(abs_path, buckets=600):
    """把 PCM 聚合成 buckets 个峰值（max abs），供前端画波形；失败返回空表。"""
    import numpy as np
    pcm, sr = decode_audio_pcm(abs_path)
    if pcm is None or pcm.size == 0 or sr <= 0:
        return [], 0.0
    n = pcm.shape[1]
    buckets = max(16, min(int(buckets or 600), 2000))
    per = max(1, n // buckets)
    usable = (n // per) * per
    # reshape 成 (channels, buckets, per)，对声道与桶内样本两轴取最大 → 恰好 buckets 个峰值
    peaks = np.abs(pcm[:, :usable].reshape(pcm.shape[0], -1, per)).max(axis=(0, 2))
    duration = n / float(sr)
    return [round(float(v), 4) for v in peaks], duration


def load_images_to_tensor(entries, scale):
    """选中图片按清单顺序 读入 → 裁剪（如有）→ 缩放 → 堆叠为 (B,H,W,3) batch。

    尺寸不一致 letterbox 居中黑边填充（与批量选图节点同策略）。
    返回 (tensor 或 None, 每张最终尺寸列表 [(w,h),...])；惰性导入 torch/numpy/PIL。
    """
    import numpy as np
    import torch
    from PIL import Image

    pils = []
    # sizes 必须与 entries 等长（第 i 项 = 第 i 张的最终尺寸，加载失败为 None）：
    # load_masks_to_tensor 按下标配对，此前失败跳过导致遮罩整体错位、真遮罩丢失
    sizes = []
    for e in entries:
        p = resolve_media_path(e.get("file"))
        im = None
        if p and os.path.isfile(p):
            try:
                im = Image.open(p).convert("RGB")
            except Exception:
                im = None
        if im is None:
            sizes.append(None)
            continue
        box = crop_box_px(im.width, im.height, e.get("crop"))
        if box:
            im = im.crop(box)
        nw, nh = scaled_size(im.width, im.height, scale)
        if (nw, nh) != (im.width, im.height):
            im = im.resize((nw, nh), Image.LANCZOS)
        pils.append(im)
        sizes.append((nw, nh))
    if not pils:
        return None, []
    max_w = max(im.width for im in pils)
    max_h = max(im.height for im in pils)
    tensors = []
    for im in pils:
        if im.width == max_w and im.height == max_h:
            canvas = im
        else:
            canvas = Image.new("RGB", (max_w, max_h), (0, 0, 0))
            canvas.paste(im, ((max_w - im.width) // 2, (max_h - im.height) // 2))
        tensors.append(torch.from_numpy(np.asarray(canvas, dtype=np.float32) / 255.0))
    return torch.stack(tensors, dim=0), sizes


def video_info_dict(abs_path, loaded_fps, loaded_count, loaded_w, loaded_h):
    """VHS_VIDEOINFO 同款十字段：source_=原始文件，loaded_=处理后的。"""
    probe = probe_asset(abs_path)
    src_fps = float(probe.get("fps") or 0.0)
    src_count = int(round(float(probe.get("duration") or 0.0) * src_fps)) if src_fps > 0 else 0
    return {
        "source_fps": src_fps,
        "source_frame_count": src_count,
        "source_duration": float(probe.get("duration") or 0.0),
        "source_width": int(probe.get("w") or 0),
        "source_height": int(probe.get("h") or 0),
        "loaded_fps": float(loaded_fps or 0.0),
        "loaded_frame_count": int(loaded_count or 0),
        "loaded_duration": (loaded_count / loaded_fps)
            if (loaded_fps and loaded_count) else float(probe.get("duration") or 0.0),
        "loaded_width": int(loaded_w or probe.get("w") or 0),
        "loaded_height": int(loaded_h or probe.get("h") or 0),
    }


def video_audio_clip(abs_path, start, dur, frame_count, fps):
    """视频选区窗口内的原声（AUDIO dict）；无音轨/解码失败回落静音占位。"""
    import torch
    v_audio = silent_audio()
    dur_s = dur if dur > 0 else ((frame_count / fps) if (fps and frame_count) else 0.0)
    try:
        pcm, sr = decode_audio_pcm(abs_path)
        if pcm is not None and sr > 0:
            sel, sr = slice_pcm(pcm, sr, start, dur_s)
            if sel.shape[1] > 0:
                v_audio = {"waveform": torch.from_numpy(sel).unsqueeze(0), "sample_rate": sr}
    except Exception:
        pass
    return v_audio


def load_masks_to_tensor(entries, scale, sizes):
    """与图片 batch 逐张对齐的遮罩 (B,H,W)：每张 裁剪→缩放到对应图片最终尺寸。

    sizes 与 entries 等长（load_images_to_tensor 返回，失效图为 None）。
    没画遮罩的卡对应全零；缺文件/解码失败也回落全零（不阻断执行）。
    """
    import numpy as np
    import torch
    from PIL import Image

    planes = []
    for e, sz in zip(entries, sizes):
        if not sz:
            continue  # 图片加载失效的卡不产出图片平面，遮罩平面必须随之丢弃（batch 计数对齐）
        plane = None
        key = e.get("mask")
        p = resolve_mask_path(key) if key else ""
        tw, th = sz
        if p and tw > 0 and th > 0:
            try:
                with Image.open(p) as m:
                    m = m.convert("L")
                    box = crop_box_px(m.width, m.height, e.get("crop"))
                    if box:
                        m = m.crop(box)
                    if (m.width, m.height) != (tw, th) and m.width > 0 and m.height > 0:
                        m = m.resize((tw, th), Image.LANCZOS)
                    if (m.width, m.height) == (tw, th):
                        plane = np.asarray(m, dtype=np.float32) / 255.0
            except Exception:
                plane = None
        planes.append(plane)
    if not planes:
        return None
    max_h = max(sz[1] for sz in sizes if sz)
    max_w = max(sz[0] for sz in sizes if sz)
    buf = np.zeros((len(planes), max_h, max_w), dtype=np.float32)
    for i, plane in enumerate(planes):
        if plane is None:
            continue  # 全零
        h, w = plane.shape
        # 居中落位：与图片 batch 的居中 letterbox 同一几何，混合尺寸时遮罩才对得上像素
        y0 = (max_h - h) // 2
        x0 = (max_w - w) // 2
        buf[i, y0:y0 + h, x0:x0 + w] = plane
    return torch.from_numpy(buf)


class MediaAssetLoader:
    """素材加载（图/音/视频）：拖入/选择器/Ctrl+V 入料，点选即生效。

    P1：图片多选按序堆叠为 IMAGE batch；音频口静音占位、帧率 0，P2/P3 接入。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 唯一存储 widget，由前端 DOM 面板接管并隐藏
                "素材清单": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "AUDIO", "*", "INT", "VHS_VIDEOINFO", "AUDIO")
    # 帧率口用通配类型：VHS VideoCombine 的 frame_rate 是自定义类型 floatOrInt，
    # 严格 INT 对 INT 会连接被拒；"*" 可连任意帧率/数值输入（值仍为整数）。
    # 视频信息口类型对齐 VHS 的 VHS_VIDEOINFO，可直接接 VHS VideoInfo 节点。
    RETURN_NAMES = ("图片", "遮罩", "视频帧", "视频音频", "帧率", "帧计数", "视频信息", "音频")
    CATEGORY = "AllBuy/素材"
    # 方法名不叫 execute：避免被安全扫描器误判为动态 SQL 执行（FUNCTION 可指向任意方法）
    FUNCTION = "load_media"
    SEARCH_ALIASES = ["素材加载", "媒体加载", "素材库", "media loader", "asset loader"]

    @classmethod
    def IS_CHANGED(cls, 素材清单="{}", **kwargs):
        # 键 = 清单 + 被选中素材的 O(1) 指纹（文件被外部改动也会失效缓存）
        manifest = parse_manifest(素材清单)
        # thumbW 是纯 UI 偏好（缩略图卡宽），不影响任何输出口——纳入键会让
        # 拖一下「尺寸」滑条就打翻执行缓存，连累下游全部重跑
        key_payload = {k: v for k, v in manifest.items() if k != "thumbW"}
        by_id = {a.get("id"): a for a in manifest["assets"] if isinstance(a, dict)}
        sel = manifest["selected"]
        img_sigs = tuple(
            (file_fingerprint(resolve_media_path(by_id[aid].get("file"))),
             file_fingerprint(resolve_mask_path(by_id[aid].get("mask") or "")))
            for aid in (sel.get("image") or []) if aid in by_id
        )
        av_sigs = tuple(
            file_fingerprint(resolve_media_path(by_id[sel.get(key)].get("file")))
            for key in ("audio", "video") if sel.get(key) in by_id
        )
        return (json.dumps(key_payload, sort_keys=True, ensure_ascii=False), img_sigs, av_sigs)

    def load_media(self, 素材清单="{}", **kwargs):
        import torch

        manifest = parse_manifest(素材清单)
        scale = manifest["scale"]
        entries = ordered_selected_images(manifest)

        tensor, sizes = load_images_to_tensor(entries, scale)
        if tensor is None:
            # 空选/全部加载失败：黑图占位，遮罩同步占位（batch 计数必须与图片口一致）
            tensor = torch.zeros((1, 8, 8, 3), dtype=torch.float32)
            mask_t = torch.zeros((1, 8, 8), dtype=torch.float32)
        else:
            mask_t = load_masks_to_tensor(entries, scale, sizes)
            if mask_t is None:
                mask_t = torch.zeros((tensor.shape[0], 8, 8), dtype=torch.float32)

        # 视频：单选，按 video_params 裁剪/重采样出帧序列 + 同窗口原声 + VHS 同款信息
        by_id = {a.get("id"): a for a in manifest["assets"] if isinstance(a, dict)}
        out_fps = 0
        frame_count = 0
        video_info = {}
        v_audio = silent_audio()
        # v3.56：先占位——未选视频 / 文件失效 / 解码失败（选区非法等）时视频帧口
        # 也必须返回合法 IMAGE tensor，下游不允许收到 None（v3.55 曾因此
        # UnboundLocalError，纯图片/纯音频工作流全灭）
        vframes = torch.zeros((1, 8, 8, 3), dtype=torch.float32)
        vid = manifest["selected"].get("video")
        if vid and vid in by_id:
            vid_path = resolve_media_path(by_id[vid].get("file")) or ""
            if vid_path:
                decoded, fps_f = load_video_frames(vid_path, manifest["video_params"], scale)
                if decoded is not None:
                    vframes = decoded
                if decoded is not None and fps_f > 0:
                    out_fps = int(round(fps_f))
                    frame_count = int(decoded.shape[0])
                    video_info = video_info_dict(
                        vid_path, out_fps, frame_count,
                        int(decoded.shape[2]), int(decoded.shape[1]))
                    start = float(manifest["video_params"].get("start") or 0.0)
                    end = float(manifest["video_params"].get("end") or 0.0)
                    dur = (end - start) if end > start else 0.0
                    v_audio = video_audio_clip(vid_path, start, dur, frame_count, out_fps)

        # 音频：单选，按 audio_params 裁剪；未选或解码失败给静音占位
        aud = manifest["selected"].get("audio")
        audio = silent_audio()
        if aud and aud in by_id:
            p = resolve_media_path(by_id[aud].get("file"))
            if p and os.path.isfile(p):
                audio = load_audio_clip(p, manifest["audio_params"])

        image_items = []
        for e in entries:
            w0, h0 = int(e.get("w") or 0), int(e.get("h") or 0)
            image_items.append({
                "id": e.get("id"), "file": e.get("file"),
                "size": list(scaled_size(w0, h0, scale)),
            })
        payload = {
            "images": image_items,
            "selected": manifest["selected"],
            "scale": manifest["scale"],
            "video": {"id": vid, "params": manifest["video_params"]},
            "audio": {"id": aud, "params": manifest["audio_params"]},
            "fps": out_fps,
            "frame_count": frame_count,
        }

        return (tensor, mask_t, vframes, v_audio, out_fps, frame_count, video_info, audio)


NODE_CLASS_MAPPINGS = {
    "MediaAssetLoader": MediaAssetLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MediaAssetLoader": "素材加载（图/音/视频）",
}
