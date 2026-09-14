"""提示词组预览图 / 预览视频的落盘管理（v3.64）。

设计说明见函数 docstring；文件名由后端按 group_id 哈希生成，
前端不指定路径，所有路径经 checked_path 校验。
"""
import hashlib
import pathlib
import re
import time

from . import media_asset

# 预览视频上限：预览是示例效果片不是素材本体，200MB 足够宽裕
VIDEO_MAX_BYTES = 200 * 1024 * 1024
# 封面图压缩上限（最长边），列表/弹窗都够用
IMAGE_MAX_SIDE = 1920

_COVER_NAME_RE = re.compile(
    r"[0-9a-f]{16}\.(?:jpg|jpeg|png|webp|gif|bmp|tif|tiff|mp4|mov|webm|mkv|avi|m4v|mpg|mpeg)")


def covers_root():
    """封面持久化根目录 = ComfyUI input/allbuy_covers/（与素材/遮罩分目录）。"""
    try:
        from folder_paths import get_input_directory
        base = pathlib.Path(get_input_directory()) / "allbuy_covers"
    except Exception:
        base = pathlib.Path.home() / "ComfyUI" / "input" / "allbuy_covers"
    base.mkdir(parents=True, exist_ok=True)
    return base


def cover_key(group_id):
    """组 id → 16 位 hex 文件键（组 id 字符集不可控，哈希后文件名恒安全、同组覆盖上传同名）。"""
    return hashlib.sha256(str(group_id or "").encode("utf-8")).hexdigest()[:16]


def checked_path(name):
    """单段封面文件名 → 目录内的绝对路径；白名单 + resolve 边界校验，非法抛 ValueError。

    所有落盘 / 读取 / 删除都从这里取路径：文件名只能是我们自己生成的
    <16位hex>.<受控扩展名> 形态，任何带分隔符或 ".." 的构造都进不来。
    """
    name = (name or "").strip()
    root = pathlib.Path(covers_root()).resolve()
    target = (root / name).resolve() if name else root
    if not _COVER_NAME_RE.fullmatch(name) or target.parent != root:
        raise ValueError(f"非法封面路径: {name!r}")
    return target


def resolve_cover_name(name):
    """同 checked_path 但不抛错：非法或文件不存在返回 ""（读取端点用）。"""
    try:
        target = checked_path(name)
    except ValueError:
        return ""
    return str(target) if target.is_file() else ""


def save_image(group_id, raw):
    """图片字节 → 重编码 JPEG 落盘（顺带抹掉原始 payload），返回文件名。抛 ValueError 为不可解码。"""
    import io
    from PIL import Image
    with Image.open(io.BytesIO(raw)) as im:
        im.load()
        w, h = im.size
        longest = max(w, h)
        if longest > IMAGE_MAX_SIDE:
            scale = IMAGE_MAX_SIDE / float(longest)
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.convert("RGB").save(buf, format="JPEG", quality=85, optimize=True)
        data = buf.getvalue()
    name = cover_key(group_id) + ".jpg"
    checked_path(name).write_bytes(data)
    return name


def save_video(group_id, src_path, orig_ext):
    """已流式落盘的临时视频文件 → 以 <hash><ext> 归位；尽力抽首帧存 <hash>.jpg 当封面。

    返回 (video_name, cover_name_or_None)。cv2 缺失或取帧失败时封面为 None
    （前端回退占位图标）；cv2 能打开本身就是格式校验。
    """
    key = cover_key(group_id)
    ext = (orig_ext or "").lower()
    if ext not in media_asset.VIDEO_EXTS:
        ext = ".mp4"
    video_name = key + ext
    target = checked_path(video_name)
    pathlib.Path(src_path).replace(target)

    cover_name = None
    try:
        import cv2
        cap = cv2.VideoCapture(str(target))
        try:
            if cap.isOpened():
                ok, frame = cap.read()
                if ok and frame is not None:
                    ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if ok2:
                        cover_name = key + ".jpg"
                        checked_path(cover_name).write_bytes(buf.tobytes())
        finally:
            cap.release()
    except ImportError:
        pass
    except Exception:
        pass  # 首帧抽取失败不阻塞上传：视频有效，封面走前端占位
    return video_name, cover_name


def prune_orphans(library_data):
    """整库保存后调用：删除 covers 目录里不再被任何组引用的文件。

    cover/coverVideo 字段即文件名，引用集合 = 全部组两个字段的并集。
    删除组、编辑时换图/换视频留下的旧文件都在下一次保存时回收。
    ponytail: 新上传 <5 分钟的文件不删——上传后字段尚未落库的窗口里，
    任何并发的旧内存态整库保存（如另一标签页点星标）都会让文件短暂
    "无引用"，此时直接删会把刚上传的封面误删；5 分钟后下一次保存再回收。
    """
    refs = set()
    for g in ((library_data or {}).get("groups") or []):
        if not isinstance(g, dict):
            continue
        for k in ("cover", "coverVideo"):
            v = (g.get(k) or "").strip()
            if v:
                refs.add(v)
    root = pathlib.Path(covers_root())
    now = time.time()
    removed = 0
    for entry in root.iterdir():
        fn = entry.name
        if fn in refs or not _COVER_NAME_RE.fullmatch(fn):
            continue
        try:
            if now - entry.stat().st_mtime < 300:
                continue
            checked_path(fn).unlink()
            removed += 1
        except (ValueError, OSError):
            pass
    return removed
