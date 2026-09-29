"""AllBuy-文本框：大文本提示词编辑节点（后端执行逻辑）。

特性：
- 双输出：「提示词」整段 STRING；「提示词行」按换行分段（每行一项的 STRING 列表，
  下游按批消费）；两者都基于同一套处理管线
- 去空行开关：只删纯空白行，不动行内内容
- 替换表：每行「旧=新」（首个 = 分割，空行忽略），按顺序应用；先替换再去空行，
  替换产生的空行也会被清掉
- @素材：文本中的 @素材名 引用素材库（input/allbuy_media），按首次出现顺序映射为
  image1..image10 占位符写进提示词，对应「图片1..10」输出口加载该素材图片；
  未引用/加载失败的口输出黑图占位（口永不 None，与其他节点同口径）

处理顺序：替换表 → 去空行 → @素材替换（@替换不产生空行）。
"""
import os
import re

from . import constants
from . import media_asset

_MAX_IMAGES = 10
# @素材名：到空白或常见中英文标点为止（素材文件名来自社交平台，内容不可控，
# 这里取宽松字符集、在标点/空白处截断，用户在提示词里写「@图片，」也能命中）
_AT_TOKEN = re.compile(r"@([^\s@，。,.：:；;！!？?（）()【】\[\]、]+)")


def _parse_replacements(table):
    """替换表文本 → [(旧, 新), ...]：每行首个 = 分割，两端去空白，空行与无 = 的行忽略。"""
    pairs = []
    for line in (table or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        old, new = line.split("=", 1)
        old = old.strip()
        if old:
            pairs.append((old, new.strip()))
    return pairs


def apply_replacements_and_blank(text, table, drop_blank):
    """替换表 → 去空行，返回处理后的整段文本。纯函数（测试与前端口径对齐用）。"""
    for old, new in _parse_replacements(table):
        text = text.replace(old, new)
    lines = text.splitlines()
    if drop_blank:
        lines = [ln for ln in lines if ln.strip()]
    return "\n".join(lines)


def _find_media_file(name):
    """@名字 → 素材绝对路径：先按完整名解析（可含扩展名），再按去扩展名主干匹配。"""
    p = media_asset.resolve_media_path(name)
    if p:
        return p
    root = media_asset.media_root()
    try:
        files = sorted(os.listdir(root))
    except OSError:
        return ""
    for f in files:
        if os.path.splitext(f)[0] == name:
            return media_asset.resolve_media_path(f)
    return ""


def resolve_at_names(text):
    """文本里按首次出现顺序去重的 @素材名（最多 _MAX_IMAGES 个参与映射）。"""
    seen = []
    for name in _AT_TOKEN.findall(text or ""):
        if name and name not in seen:
            seen.append(name)
    return seen


def _image_tensor(path):
    """单图 → (1,H,W,3) float32；无路径/非图片/失败 → 64x64 黑图占位。惰性导入。"""
    import numpy as np
    import torch

    im = None
    if path and media_asset.asset_type(path) == "image":
        try:
            from PIL import Image

            with Image.open(path) as f:
                im = f.convert("RGB")
        except Exception:  # noqa: BLE001
            im = None
    if im is None:
        return torch.zeros((1, 64, 64, 3), dtype=torch.float32)
    arr = np.asarray(im, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _files_signature(paths):
    sigs = []
    for p in paths:
        try:
            st = os.stat(p)
            sigs.append(f"{p}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            sigs.append(f"{p}:missing")
    return tuple(sigs)


class AllBuyTextBox:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"multiline": True, "default": ""}),
                "替换表": ("STRING", {"multiline": True, "default": ""}),
                "去空行": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING") + ("IMAGE",) * 10
    RETURN_NAMES = ("提示词", "提示词行") + tuple(f"图片{i}" for i in range(1, 11))
    CATEGORY = "AllBuy/提示词库"
    FUNCTION = "execute"
    SEARCH_ALIASES = ["文本框", "提示词框", "大文本", "textbox"]

    @classmethod
    def IS_CHANGED(cls, 文本="", 替换表="", 去空行=True, **kwargs):
        # 输出随文本/替换表/开关与被引用素材文件变：素材签名必须入键（缓存铁律）
        try:
            names = resolve_at_names(apply_replacements_and_blank(文本, 替换表, 去空行))[:_MAX_IMAGES]
            sigs = _files_signature([_find_media_file(n) for n in names])
            return (文本, 替换表, bool(去空行), sigs)
        except Exception:  # noqa: BLE001
            return (文本, 替换表, bool(去空行), "err")

    def execute(self, 文本="", 替换表="", 去空行=True, **kwargs):
        base = apply_replacements_and_blank(文本 or "", 替换表 or "", bool(去空行))
        names = resolve_at_names(base)[:_MAX_IMAGES]
        slot = {name: f"image{i + 1}" for i, name in enumerate(names)}
        full = _AT_TOKEN.sub(lambda m: slot.get(m.group(1), m.group(0)), base)
        lines = full.splitlines() if full else []

        imgs = []
        used = []
        for i in range(_MAX_IMAGES):
            name = names[i] if i < len(names) else None
            path = _find_media_file(name) if name else ""
            imgs.append(_image_tensor(path))
            if name:
                used.append({"slot": f"image{i + 1}", "name": name, "found": bool(path)})
        return {
            "ui": {"images_used": used, "version": constants.PLUGIN_VERSION},
            "result": (full, lines, *imgs),
        }


NODE_CLASS_MAPPINGS = {
    "AllBuyTextBox": AllBuyTextBox,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AllBuyTextBox": "AllBuy-文本框",
}
