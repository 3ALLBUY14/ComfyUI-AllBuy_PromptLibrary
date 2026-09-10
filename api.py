"""HTTP API 路由，供前端管理库与卡片。

采用 ComfyUI 社区标准做法：模块导入时直接通过 PromptServer.instance.routes
注册路由（此时 server 已就绪），避免延迟注册被 try/except 静默吞掉导致 404。
"""
import io
import math
import os
import re
from collections import OrderedDict

from aiohttp import web
from PIL import Image

from . import library_store, constants, random_draw, batch_image_node, media_asset

P = constants.API_PREFIX

# 缩略图内存缓存：(path, w) -> (mtime, jpeg_bytes)，上限 600 条，避免重绘重复压缩
_THUMB_CACHE = OrderedDict()
_THUMB_CACHE_MAX = 600
# 视频抽帧缓存：(path, w, t, mtime) -> jpeg_bytes，上限 200 条
_VTHUMB_CACHE = OrderedDict()
_VTHUMB_CACHE_MAX = 200


def _make_thumb(path, w):
    """把图缩到最长边=w 并转 JPEG（quality=82），带 mtime 失效的 LRU 缓存。"""
    key = (path, w)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
    cached = _THUMB_CACHE.get(key)
    if cached is not None and cached[0] == mtime:
        _THUMB_CACHE.move_to_end(key)  # 命中刷新位次，与 vthumb 缓存同为真 LRU
        return cached[1]
    with Image.open(path) as im:
        im.load()  # 触发解码，尽早暴露损坏文件
        w0, h0 = im.size
        longest = max(w0, h0)
        if longest > w:
            scale = w / float(longest)
            nw = max(1, int(round(w0 * scale)))
            nh = max(1, int(round(h0 * scale)))
            im = im.resize((nw, nh), Image.LANCZOS)
        buf = io.BytesIO()
        im.convert("RGB").save(buf, format="JPEG", quality=82, optimize=True)
        data = buf.getvalue()
    _THUMB_CACHE[key] = (mtime, data)
    _THUMB_CACHE.move_to_end(key)
    while len(_THUMB_CACHE) > _THUMB_CACHE_MAX:
        _THUMB_CACHE.popitem(last=False)
    return data


try:
    from server import PromptServer
    _routes = PromptServer.instance.routes
except Exception as _e:  # noqa: BLE001
    _routes = None
    print(f"[AllBuy_PromptLibrary] 警告：无法获取 PromptServer，API 路由未注册：{_e}")


def _get(path):
    if _routes is None:
        return lambda fn: fn
    return _routes.get(P + path)


def _post(path):
    if _routes is None:
        return lambda fn: fn
    return _routes.post(P + path)


def _json_error(msg, code=400):
    return web.json_response({"ok": False, "error": str(msg)}, status=code)


@_get("/libraries")
async def list_libraries(request):
    try:
        return web.json_response({"ok": True, "libraries": library_store.list_libraries()})
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_get("/library")
async def get_library(request):
    locator = request.query.get("locator", "")
    try:
        data = library_store.load_library(locator)
        return web.json_response({"ok": True, "library": data})
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_post("/library/save")
async def save_library(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _json_error("请求体不是合法 JSON")
    locator = body.get("locator")
    data = body.get("data")
    if data is None:
        return _json_error("缺少 data")
    try:
        library_store.save_library(locator, data)
        return web.json_response({"ok": True})
    except PermissionError as e:
        return _json_error(e, 403)
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_post("/library/create")
async def create_library(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _json_error("请求体不是合法 JSON")
    name = (body.get("name") or "").strip()
    if not name:
        return _json_error("库名称不能为空")
    try:
        locator = library_store.create_library(name)
        return web.json_response({"ok": True, "locator": locator})
    except FileExistsError as e:
        return _json_error(e, 409)
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_post("/library/delete")
async def delete_library(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _json_error("请求体不是合法 JSON")
    name = (body.get("name") or "").strip()
    if not name:
        return _json_error("缺少库名称")
    try:
        library_store.delete_library(name)
        return web.json_response({"ok": True})
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_get("/separators")
async def separators(request):
    return web.json_response({"ok": True, "separators": constants.SEPARATOR_PRESETS})


@_post("/draw")
async def draw(request):
    """随机抽卡预览：复用 random_draw.draw，前端面板实时展示抽中卡片与合并结果。
    与节点 execute 共用同一函数，预览与队列执行结果逐字一致。"""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _json_error("请求体不是合法 JSON")
    try:
        result = random_draw.draw(
            library=body.get("library", "user:default"),
            count=body.get("count", 1),
            seed=body.get("seed", 0),
            separator=body.get("separator", constants.DEFAULT_SEPARATOR),
            filter_category=body.get("filter_category", "") or "",
            filter_tags=body.get("filter_tags") or [],
            prepend=body.get("prepend", "") or "",
            append=body.get("append", "") or "",
            locked_ids=body.get("locked_ids") or [],
            vars=body.get("vars") or None,
        )
        return web.json_response(result)
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_get("/version")
async def version(request):
    """后端版本号，供前端握手对比：不一致 = 后端未重启到新版（旧 Python 代码仍在跑）。"""
    return web.json_response({"ok": True, "version": constants.PLUGIN_VERSION})


# ---------------------------------------------------------------------------
# 批量选图相关端点
# ---------------------------------------------------------------------------
def _input_directory():
    try:
        from folder_paths import get_input_directory
        return get_input_directory()
    except Exception:
        return os.path.join(os.path.expanduser("~"), "ComfyUI", "input")


@_get("/folders")
async def list_folders(request):
    """列出 ComfyUI input 目录下的子目录（相对路径），供文件夹选择器使用。"""
    try:
        base = _input_directory()
        result = []
        for root, dirs, _files in os.walk(base):
            for d in dirs:
                full = os.path.join(root, d)
                rel = os.path.relpath(full, base).replace(os.sep, "/")
                result.append(rel)
        result.sort()
        return web.json_response({"ok": True, "base": base, "folders": result})
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_get("/images")
async def list_images(request):
    """扫描指定目录，返回图片列表（含绝对路径与尺寸）。

    folder 可为相对 input 的子目录或绝对路径；resolve_root 与节点执行时一致。
    """
    folder = request.query.get("folder", "")
    try:
        root = batch_image_node.resolve_root(folder)
        images = []
        for fn in sorted(os.listdir(root)):
            if not fn.lower().endswith(batch_image_node.IMAGE_EXTS):
                continue
            full = os.path.join(root, fn)
            if not os.path.isfile(full):
                continue
            w = h = 0
            try:
                with Image.open(full) as im:
                    w, h = im.size
            except Exception:
                pass
            mtime = 0.0
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                pass
            images.append({"name": fn, "abs": os.path.abspath(full), "w": w, "h": h, "mtime": mtime})
        return web.json_response({"ok": True, "folder": folder, "root": root, "images": images})
    except Exception as e:  # noqa: BLE001
        return _json_error(e)


@_get("/image")
async def serve_image(request):
    """按绝对路径返回图片字节，供前端渲染缩略图（绕过 ComfyUI /view 的子目录限制）。

    任意绝对路径是批量选图节点的既定功能（自由目录），但 v3.57 起端点有边界：
    batch_image_node.is_safe_image_path 要求「绝对路径 + 图片扩展名 + PIL 可解码」
    三关全过，防止被当任意文件读取原语滥用。带 w 参数时返回压缩 JPEG 缩略图。
    """
    path = request.query.get("path", "")
    if not batch_image_node.is_safe_image_path(path):
        return web.Response(status=404, text="not found")
    path = os.path.normpath(path.strip())
    try:
        w = int(request.query.get("w", "0") or 0)
    except ValueError:
        w = 0

    if w and w > 0:
        try:
            data = _make_thumb(path, w)
            return web.Response(
                body=data, content_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=86400"},
            )
        except Exception as e:  # noqa: BLE001
            # 缩略图生成失败（损坏/异常格式）回退原图
            print(f"[AllBuy_PromptLibrary] 缩略图生成失败，回退原图：{path} - {e}")

    ext = os.path.splitext(path)[1].lower()
    mime = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".bmp": "image/bmp", ".gif": "image/gif",
        ".tif": "image/tiff", ".tiff": "image/tiff",
    }.get(ext, "application/octet-stream")
    try:
        with open(path, "rb") as f:
            data = f.read()
        return web.Response(
            body=data, content_type=mime,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except Exception as e:  # noqa: BLE001
        return _json_error(e, 500)


@_get("/media/thumb")
async def media_thumb(request):
    """素材加载节点专用缩略图：name 限 input/allbuy_media/ 内的单段文件名。

    与 /image 相比无需前端持有绝对路径（防穿越校验在 resolve_media_path 内），
    复用同一 LRU 缩略图缓存。
    """
    name = request.query.get("name", "")
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    try:
        w = int(request.query.get("w", "240") or 240)
    except ValueError:
        w = 240
    try:
        data = _make_thumb(path, max(32, min(w, 1024)))
        return web.Response(
            body=data, content_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except Exception:
        return web.Response(status=404, text="thumb failed")


@_get("/media/probe")
async def media_probe(request):
    """素材元数据探测：name 限素材目录内。返回 尺寸/时长/帧率（尽力而为）。"""
    name = request.query.get("name", "")
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "not found"}, status=404)
    meta = media_asset.probe_asset(path)
    return web.json_response({"ok": True, "name": name, **meta})


@_get("/media/wave")
async def media_wave(request):
    """音频波形峰值：聚合为 buckets 个点（max abs），供前端绘制波形与选区。"""
    name = request.query.get("name", "")
    try:
        buckets = int(request.query.get("buckets", "600") or 600)
    except ValueError:
        buckets = 600
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "not found"}, status=404)
    peaks, duration = media_asset.wave_peaks(path, buckets)
    return web.json_response({"ok": True, "name": name, "peaks": peaks, "duration": duration})


@_get("/media/vthumb")
async def media_vthumb(request):
    """视频抽帧缩略图：name 限素材目录内，t=取样时间（秒），w=最长边像素。

    cv2 取帧转 JPEG，LRU 缓存（含 mtime 失效）；cv2 缺失/取帧失败返回 404，
    前端回退到图标占位。
    """
    try:
        import cv2
    except ImportError:
        return web.Response(status=404, text="cv2 unavailable")

    name = request.query.get("name", "")
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    try:
        w = max(32, min(int(request.query.get("w", "240") or 240), 1024))
    except ValueError:
        w = 240
    try:
        t = max(0.0, float(request.query.get("t", "0") or 0))
    except ValueError:
        t = 0.0
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
    key = (path, w, round(t, 1), mtime)
    cached = _VTHUMB_CACHE.get(key)
    if cached is not None:
        _VTHUMB_CACHE.move_to_end(key)  # 命中刷新位次（v3.58 起真 LRU，与缩略图缓存同款语义）
    else:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            return web.Response(status=404, text="decode failed")
        if t > 0:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        cap.release()
        if not ok or frame is None:
            return web.Response(status=404, text="decode failed")
        h0, w0 = frame.shape[:2]
        scale = w / float(max(w0, h0))
        if scale < 1.0:
            frame = cv2.resize(frame, (max(1, int(w0 * scale)), max(1, int(h0 * scale))),
                               interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if not ok:
            return web.Response(status=404, text="encode failed")
        cached = buf.tobytes()
        _VTHUMB_CACHE[key] = cached
    while len(_VTHUMB_CACHE) > _VTHUMB_CACHE_MAX:
        _VTHUMB_CACHE.popitem(last=False)
    return web.Response(
        body=cached, content_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@_post("/media/mask")
async def media_mask_save(request):
    """保存图片遮罩：dataURL(PNG) → 灰度化 → 落盘 input/allbuy_media_masks/<sha256_16>.png。

    文件名由后端按素材名生成（16 位 hex），前端不可指定路径；内容经 PIL 重编码。
    """
    import base64
    try:
        body = await request.json()
    except Exception:
        return _json_error("请求体不是合法 JSON")
    asset_name = (body.get("name") or "").strip()
    dataurl = body.get("data") or ""
    m = re.match(r"^data:image/png;base64,(.+)$", dataurl, re.S)
    if not asset_name or not m:
        return _json_error("缺少 name 或合法的 PNG dataURL")
    import pathlib
    key = media_asset.mask_key(asset_name)
    root = pathlib.Path(media_asset.masks_root()).resolve()
    target = (root / key).resolve()
    if target.parent != root:
        return _json_error("invalid mask key")
    try:
        raw = base64.b64decode(m.group(1), validate=True)
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as im:
            gray = im.convert("L")
            buf = io.BytesIO()
            gray.save(buf, format="PNG")
            data = buf.getvalue()
        with open(target, "wb") as fh:
            fh.write(data)
        return web.json_response({"ok": True, "mask": key})
    except Exception as e:
        return _json_error(e, 500)


@_get("/media/mask")
async def media_mask_get(request):
    """读取遮罩 PNG（key=<16位hex>.png），供编辑弹窗回显已有遮罩。"""
    key = request.query.get("key", "")
    path = media_asset.resolve_mask_path(key)
    if not path:
        return web.Response(status=404, text="not found")
    try:
        with open(path, "rb") as fh:
            return web.Response(body=fh.read(), content_type="image/png",
                                headers={"Cache-Control": "no-store"})
    except OSError as e:
        return _json_error(e, 500)


def _find_ffmpeg():
    """ffmpeg 查找：imageio-ffmpeg（VHS 依赖自带二进制）优先，其次系统 PATH。"""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    import shutil
    return shutil.which("ffmpeg")


def _q_float(request, key, default=0.0):
    try:
        v = float(request.query.get(key, "") or default)
    except ValueError:
        return default
    # NaN/Infinity 会在调用方 int() 处炸成未处理 500（scale_value/max_frames 等参数），一律回默认
    return v if math.isfinite(v) else default


def _download_response(data, content_type, label, ext):
    """附件下载响应：ASCII 兜底名 + RFC 5987 UTF-8 原名（中文文件名不乱码）。"""
    import urllib.parse
    safe = urllib.parse.quote((label or "clip")[:80])
    return web.Response(
        body=data, content_type=content_type,
        headers={
            "Content-Disposition":
                f"attachment; filename=\"clip.{ext}\"; filename*=UTF-8''{safe}.{ext}",
            "Cache-Control": "no-store",
        },
    )


@_get("/media/export/audio")
async def media_export_audio(request):
    """导出裁剪后的音频片段为 WAV（按当前 audio_params 选区）。"""
    import asyncio
    name = request.query.get("name", "")
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    start = _q_float(request, "start")
    duration = _q_float(request, "duration")

    def work():
        pcm, sr = media_asset.decode_audio_pcm(path)
        if pcm is None or pcm.size == 0 or sr <= 0:
            return None
        sel, sr = media_asset.slice_pcm(pcm, sr, start, duration)
        if sel.shape[1] == 0:
            return None
        return media_asset.pcm_to_wav_bytes(sel, sr)

    try:
        data = await asyncio.to_thread(work)
    except Exception as e:  # noqa: BLE001
        return _json_error(f"导出失败：{e}", 500)
    if data is None:
        return web.Response(status=404, text="decode failed")
    label = os.path.splitext(name)[0] + "_clip"
    return _download_response(data, "audio/wav", label, "wav")


@_get("/media/export/video")
async def media_export_video(request):
    """导出裁剪后的视频片段为 MP4（选区/帧率/帧数上限 + 缩放设置实时生效）。

    iter_video_frames 流式逐帧喂给编码器，内存 O(1 帧)——此前整段 float32 batch
    进内存再 stdin 一次性灌入，4096 帧上限的长片段会把内存吃爆。编码优先
    ffmpeg libx264（静态参数列表 + shell=False，用户数据只经 stdin 像素流，不进
    命令行）；缺失时退化 cv2 mp4v。解码/编码在线程池执行，不阻塞事件循环。
    """
    import asyncio
    name = request.query.get("name", "")
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    vp = {
        "start": _q_float(request, "start"),
        "end": _q_float(request, "end"),
        "fps": _q_float(request, "fps"),
        "max_frames": int(_q_float(request, "max_frames")),
    }
    scale = {
        "mode": request.query.get("scale_mode", "none") or "none",
        "value": int(_q_float(request, "scale_value", 0)),
        "multiple": int(_q_float(request, "scale_multiple", 0)),
    }

    def work():
        import subprocess
        import tempfile
        fps, it = media_asset.iter_video_frames(path, vp, scale)
        if it is None:
            return None
        try:
            first = next(it, None)
            if first is None:
                return None
            h, w = int(first.shape[0]), int(first.shape[1])
            # 不设 120 上限：帧流按 target_fps 产出，编码帧率必须一致——
            # 钳小会让导出快放且音频按错误帧率裁齐（与节点输出口径分叉）
            fps = max(1, int(round(fps)) if fps and fps > 0 else 24)
            tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
            tmp.close()
            ff = _find_ffmpeg()
            try:
                if ff:
                    # 音轨直通：帧管线只有画面，此前导出/降级预览一律无声（v1.23 修复）。
                    # 源文件作为第二输入，音频可选映射（无音轨文件不受影响）；文件路径只是
                    # 单个 argv 值（shell=False 无 shell 解析，不存在注入面）。
                    # 音频与选区同步裁剪；max_frames 截断视频时按 帧数/生效帧率 裁齐音频。
                    pre = []
                    if vp["start"] > 0:
                        pre += ["-ss", f"{vp['start']:.3f}"]
                    dur = (vp["end"] - vp["start"]) if vp["end"] > vp["start"] else None
                    if vp["max_frames"] > 0 and fps > 0:
                        d2 = vp["max_frames"] / fps
                        dur = min(dur, d2) if dur else d2
                    if dur:
                        pre += ["-t", f"{dur:.3f}"]
                    cmd = [str(ff), "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                           "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                           *pre, "-i", str(path),
                           "-map", "0:v:0", "-map", "1:a:0?",
                           "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
                           "-movflags", "+faststart", str(tmp.name)]
                    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                            stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL, shell=False)
                    try:
                        proc.stdin.write(first.tobytes())
                        for fr in it:
                            proc.stdin.write(fr.tobytes())
                        proc.stdin.close()
                        if proc.wait() != 0:
                            raise RuntimeError(f"ffmpeg 退出码 {proc.returncode}")
                    finally:
                        if proc.poll() is None:
                            proc.kill()
                            proc.wait()
                else:
                    import cv2
                    vw = cv2.VideoWriter(tmp.name, cv2.VideoWriter_fourcc(*"mp4v"),
                                         float(fps), (w, h))
                    vw.write(cv2.cvtColor(first, cv2.COLOR_RGB2BGR))
                    for fr in it:
                        vw.write(cv2.cvtColor(fr, cv2.COLOR_RGB2BGR))
                    vw.release()
                with open(tmp.name, "rb") as fh:
                    return fh.read()
            finally:
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass
        finally:
            it.close()  # 提前放弃（如编码中途失败）时释放底层 VideoCapture

    try:
        data = await asyncio.to_thread(work)
    except Exception as e:  # noqa: BLE001
        return _json_error(f"编码失败：{e}", 500)
    if data is None:
        return web.Response(status=404, text="decode failed")
    label = os.path.splitext(name)[0] + "_clip"
    return _download_response(data, "video/mp4", label, "mp4")


@_get("/media/export/image")
async def media_export_image(request):
    """导出编辑后的图片为 PNG（当前裁剪框 + 缩放设置实时生效）。"""
    import asyncio
    name = request.query.get("name", "")
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    crop = [_q_float(request, "x0"), _q_float(request, "y0"),
            _q_float(request, "x1"), _q_float(request, "y1")]
    scale = {
        "mode": request.query.get("scale_mode", "none") or "none",
        "value": int(_q_float(request, "scale_value", 0)),
        "multiple": int(_q_float(request, "scale_multiple", 0)),
    }

    def work():
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("RGB")
            box = media_asset.crop_box_px(im.width, im.height, crop)
            if box:
                im = im.crop(box)
            nw, nh = media_asset.scaled_size(im.width, im.height, scale)
            if (nw, nh) != (im.width, im.height):
                im = im.resize((nw, nh), Image.LANCZOS)
            import io
            buf = io.BytesIO()
            im.save(buf, format="PNG")
            return buf.getvalue()

    try:
        data = await asyncio.to_thread(work)
    except Exception as e:  # noqa: BLE001
        return _json_error(f"导出失败：{e}", 500)
    if data is None:
        return web.Response(status=404, text="decode failed")
    label = os.path.splitext(name)[0] + "_edit"
    return _download_response(data, "image/png", label, "png")


@_get("/media/export/frame")
async def media_export_frame(request):
    """导出视频某一帧为 PNG（首帧 t=选区起点，尾帧 t=选区终点附近）。"""
    import asyncio
    name = request.query.get("name", "")
    path = media_asset.resolve_media_path(f"{media_asset.MEDIA_SUBDIR}/{name}")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    t = max(0.0, _q_float(request, "t"))
    scale = {
        "mode": request.query.get("scale_mode", "none") or "none",
        "value": int(_q_float(request, "scale_value", 0)),
        "multiple": int(_q_float(request, "scale_multiple", 0)),
    }

    def work():
        import cv2
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            return None
        try:
            if t > 0:
                cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
        finally:
            cap.release()
        if not ok or frame is None:
            return None
        # 注意：保持 cv2 原生 BGR 序，imencode 直接编码（转 RGB 反而会通道互换）
        nw, nh = media_asset.scaled_size(frame.shape[1], frame.shape[0], scale)
        if (nw, nh) != (frame.shape[1], frame.shape[0]):
            frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".png", frame)
        return buf.tobytes() if ok else None

    try:
        data = await asyncio.to_thread(work)
    except Exception as e:  # noqa: BLE001
        return _json_error(f"导出失败：{e}", 500)
    if data is None:
        return web.Response(status=404, text="decode failed")
    label = os.path.splitext(name)[0] + ("_last" if t > 0 else "_first")
    return _download_response(data, "image/png", label, "png")


def register_routes():
    """兼容保留：路由已在模块导入时注册。"""
    return _routes is not None
