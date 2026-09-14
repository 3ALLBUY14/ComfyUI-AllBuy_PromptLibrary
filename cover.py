"""提示词组预览图 / 预览视频的落盘管理（v3.64；v3.71 起文件名按内容哈希）。

设计说明见函数 docstring；文件名由后端按**文件内容**哈希生成——同内容同名、
换内容换名，/cover/file、/cover/video 的 max-age 缓存因此恒正确（URL 即内容），
覆盖首帧图/替换视频后浏览器不会再到一天前的旧缓存里拿旧画面。
被替换下来的旧文件成为孤儿，由 prune_orphans 按「曾落库引用」账本在下次整库保存时回收。
前端不指定路径，所有路径经 checked_path 校验。
"""
import hashlib
import json
import os
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


def content_key(data):
    """文件内容 → 16 位 hex 文件键（组 id 字符集不可控，哈希后文件名恒安全）。"""
    return hashlib.sha256(data).hexdigest()[:16]


def checked_path(name):
    """单段封面文件名 → 目录内的绝对路径；白名单 + resolve 边界校验，非法抛 ValueError。

    所有落盘 / 读取 / 删除都从这里取路径：文件名先过白名单（只能是我们自己
    生成的 16 位 hex 文件键加受控扩展名），再 resolve 复核仍落在 covers 目录内。
    """
    name = (name or "").strip()
    if not _COVER_NAME_RE.fullmatch(name):
        raise ValueError(f"非法封面路径: {name!r}")
    root = pathlib.Path(covers_root()).resolve()
    target = (root / name).resolve()
    if target.parent != root:
        raise ValueError(f"非法封面路径: {name!r}")
    return target


def resolve_cover_name(name):
    """同 checked_path 但不抛错：非法或文件不存在返回 ""（读取端点用）。"""
    try:
        target = checked_path(name)
    except ValueError:
        return ""
    return str(target) if target.is_file() else ""


def _group_refs(data):
    """库 JSON → 该库引用的封面文件名集合（cover/coverVideo 字段即文件名）。"""
    refs = set()
    groups = data.get("groups") if isinstance(data, dict) else None
    for g in (groups or []):
        if not isinstance(g, dict):
            continue
        for k in ("cover", "coverVideo"):
            v = (g.get(k) or "").strip()
            if v:
                refs.add(v)
    return refs


def _disk_refs():
    """磁盘上全部库 JSON（内置+用户）的封面引用并集。

    covers 目录全局共享而库可以有任意多个：引用集若只看本次保存的库，
    会把别的库正在引用的封面当孤儿删掉（v3.72 修的跨库误删）。
    """
    from . import library_store
    refs = set()
    for path in library_store.all_library_paths():
        try:
            with open(path, "r", encoding="utf-8") as f:
                refs |= _group_refs(json.load(f))
        except Exception:  # noqa: BLE001
            continue  # 读不动的库跳过：宁可少删，不可因读失败扩大删除面
    return refs


def _refs_book_path():
    """「曾被引用」账本文件：covers 目录内的隐藏 json，名字不匹配封面白名单，
    天然不会被 prune 当孤儿扫到。"""
    return pathlib.Path(covers_root()) / ".refs.json"


def _load_refs_book():
    try:
        with open(_refs_book_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return {str(x) for x in data} if isinstance(data, list) else set()
    except Exception:  # noqa: BLE001
        return set()  # 账本缺失/损坏按空处理：空集 = 本轮不删任何文件（失败方向安全）


def _save_refs_book(refs):
    book = _refs_book_path()
    tmp = book.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(sorted(refs), ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, book)


def save_image(raw):
    """图片字节 → 重编码 JPEG 落盘（顺带抹掉原始 payload），按内容哈希返回文件名。抛 ValueError 为不可解码。"""
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
    name = content_key(data) + ".jpg"
    checked_path(name).write_bytes(data)
    return name


def save_video(src_path, orig_ext):
    """已流式落盘的临时视频文件 → 以内容哈希命名归位（保留原扩展名）；尽力抽首帧按内容哈希存 jpg 当封面。

    返回 (video_name, cover_name_or_None)。cv2 缺失或取帧失败时封面为 None
    （前端回退占位图标）；cv2 能打开本身就是格式校验。
    """
    h = hashlib.sha256()
    with open(src_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    ext = (orig_ext or "").lower()
    if ext not in media_asset.VIDEO_EXTS:
        ext = ".mp4"
    video_name = h.hexdigest()[:16] + ext
    target = checked_path(video_name)
    # shutil.move：跨盘符时 os.replace 会 WinError 17（调用方应已同盘，此处防御）
    import shutil
    shutil.move(src_path, str(target))

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
                        cover_name = content_key(buf.tobytes()) + ".jpg"
                        checked_path(cover_name).write_bytes(buf.tobytes())
        finally:
            cap.release()
    except ImportError:
        pass
    except Exception:
        pass  # 首帧抽取失败不阻塞上传：视频有效，封面走前端占位
    return video_name, cover_name


def prune_orphans(library_data):
    """整库保存后调用：回收「曾经落库引用、如今全库无引用」的封面文件。

    v3.72 起删除须同时满足：文件名合法、不被磁盘上任何库（内置+用户，
    含刚保存的这个）引用、名字在 .refs.json「曾被引用」账本里（每次保存把
    当时的全部引用累积进去）。跨库切换、inline 库（只存 workflow，永不
    落库）的封面因此永不误删；换图/换视频/删组留下的旧文件照常回收。
    ponytail: 从未落库的上传（编辑器取消、上传后没保存）从此永不自动回收，
    会慢慢积累——宁可积文件不可误删；要清理可手动清 allbuy_covers 目录。
    """
    refs = _group_refs(library_data) | _disk_refs()
    book = _load_refs_book()
    book |= refs
    try:
        _save_refs_book(book)
    except OSError:
        pass  # 账本写失败只影响后续轮次的口径，本轮用的是内存态
    root = pathlib.Path(covers_root())
    now = time.time()
    removed = 0
    for entry in root.iterdir():
        fn = entry.name
        if fn in refs or fn not in book or not _COVER_NAME_RE.fullmatch(fn):
            continue
        try:
            if now - entry.stat().st_mtime < 300:
                continue  # 刚写入的不碰：重传同内容后未落库的极端时序保险
            checked_path(fn).unlink()
            removed += 1
        except (ValueError, OSError):
            pass
    return removed
