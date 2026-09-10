"""批量选图节点：GUI 管理图片与提示词组的双向映射。

数据模型（全部存于隐藏 widget `mapping` 的 JSON 中）：
{
  "version": 1,
  "folder": "<相对 input 目录的子目录 或 绝对路径>",
  "mode": "image_to_prompts" | "prompt_to_images",
  "library_locator": {"source":"user","name":"default"} | null,
  "thumbnail_size": 96,
  "images": [ {"file": "<文件名>", "abs": "<绝对路径>", "w": int, "h": int,
               "category": str, "group": str, "order": int} ],
  "links": [ {"abs": "<图片绝对路径>", "gid": "<提示词组 id>"} ]
}

两种映射模式：
- image_to_prompts：每张图片对应多组提示词（links 以图片为主视角，UI 在图片卡上勾选提示词组）
- prompt_to_images：每组提示词对应多张图片（links 以提示词组为主视角，UI 在提示词组分区里挂载图片）

后端 execute 输出：
- images：参与映射的图片（按 order 排序）堆叠成的 IMAGE batch（letterbox 填充到统一尺寸）
- positive / negative：所有被引用提示词组的合并结果（去重后按库顺序）
- mapping_json：完整结构化映射（含每张图的提示词、每组的图片），供下游消费
"""
import json
import os

from . import library_store, merger, constants
from .media_asset import IMAGE_EXTS


def resolve_root(folder):
    """把前端传来的 folder 归一化为绝对根目录。

    - 绝对路径且存在 → 直接用
    - 相对路径 → 拼到 ComfyUI input 目录下
    """
    folder = (folder or "").strip()
    if folder and os.path.isabs(folder) and os.path.isdir(folder):
        return folder
    try:
        from folder_paths import get_input_directory
        base = get_input_directory()
    except Exception:
        base = os.path.join(os.path.expanduser("~"), "ComfyUI", "input")
    if not folder:
        return base
    candidate = os.path.join(base, folder)
    return candidate if os.path.isdir(candidate) else base


def is_safe_image_path(path):
    """/image 端点边界校验：绝对路径 + 图片扩展名 + PIL 可解码的真实图片文件。

    批量选图的图片目录允许任意绝对路径（既定功能），无法限定在 input 根内；
    防线因此收敛为「扩展名 + 内容双确认」，防止端点被当任意文件读取原语滥用
    （v3.57 之前任何路径的任何文件都会被原样回吐）。只读头部不解码全图，开销可忽略。
    """
    p = (path or "").strip()
    if not p or not os.path.isabs(p):
        return False
    if os.path.splitext(p)[1].lower() not in IMAGE_EXTS:
        return False
    p = os.path.normpath(p)
    if not os.path.isfile(p):
        return False
    try:
        from PIL import Image
        with Image.open(p) as im:
            im.verify()
        return True
    except Exception:
        return False


def load_images_to_tensor(image_entries):
    """把图片条目列表读成 ComfyUI IMAGE tensor (B,H,W,3) float32 0-1。

    不同尺寸用 letterbox（居中黑边）填充到统一最大尺寸，避免拉伸变形。
    读取失败/空列表返回 None。惰性导入 torch/numpy/PIL，避免模块加载期依赖失败。
    """
    import numpy as np
    import torch
    from PIL import Image

    if not image_entries:
        return None
    pils = []
    max_w = max_h = 0
    for e in image_entries:
        abs_path = e.get("abs") or e.get("file") or ""
        if not abs_path or not os.path.isfile(abs_path):
            continue
        try:
            im = Image.open(abs_path).convert("RGB")
        except Exception:
            continue
        pils.append(im)
        max_w = max(max_w, im.width)
        max_h = max(max_h, im.height)
    if not pils:
        return None
    tensors = []
    for im in pils:
        if im.width == max_w and im.height == max_h:
            canvas = im
        else:
            canvas = Image.new("RGB", (max_w, max_h), (0, 0, 0))
            canvas.paste(im, ((max_w - im.width) // 2, (max_h - im.height) // 2))
        arr = np.asarray(canvas, dtype=np.float32) / 255.0
        tensors.append(torch.from_numpy(arr))
    return torch.stack(tensors, dim=0)


def _parse_config(mapping):
    try:
        cfg = json.loads(mapping) if mapping else {}
    except Exception:
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    cfg.setdefault("version", 1)
    cfg.setdefault("folder", "")
    cfg.setdefault("mode", "image_to_prompts")
    cfg.setdefault("library_locator", None)
    cfg.setdefault("thumbnail_size", 96)
    cfg.setdefault("images", [])
    cfg.setdefault("links", [])
    if not isinstance(cfg["images"], list):
        cfg["images"] = []
    if not isinstance(cfg["links"], list):
        cfg["links"] = []
    return cfg


class BatchImagePromptSelector:
    """批量选图：GUI 管理图片与提示词组关联，输出图片 batch + 合并提示词。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 唯一存储 widget，由前端 DOM 面板接管并隐藏原生输入
                "映射数据": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {
                # 当 library_locator 的 source 为 "inline" 时，库数据内嵌于此
                "库数据": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("图片", "正提示词", "负提示词", "映射JSON")
    CATEGORY = "AllBuy/提示词库"
    FUNCTION = "execute"
    SEARCH_ALIASES = ["批量选图", "图文映射", "图片提示词", "batch image"]

    @classmethod
    def IS_CHANGED(cls, 映射数据="{}", 库数据="", **kwargs):
        # 映射数据字符串变化即重新执行；库文件内容签名必须入键（v3.51，补 PromptLibrary
        # v3.32 的同型漏洞）：面板里编辑/保存库只改磁盘 JSON，不改映射数据，
        # 缓存键若只有映射数据，改了卡片内容后 bips 会一直输出旧提示词。
        # 含通配符的提示词组仍强制每次重抽。
        try:
            cfg = _parse_config(映射数据)
            loc = cfg.get("library_locator")
            if isinstance(loc, dict) and loc.get("source") == "inline" and 库数据:
                lib_sig = "inline"  # 库数据本身是输入值，变化自然换键
            else:
                try:
                    path, _ro = library_store.resolve(loc)
                    st = os.stat(path)
                    lib_sig = f"{st.st_mtime_ns}:{st.st_size}"
                except Exception:
                    lib_sig = "missing"
            lib = cls._load_groups(cfg, 库数据)
            has_wc = False
            group_files = cls._resolve_group_refs(cfg, lib)
            by_id = {g.get("id"): g for g in lib if isinstance(g, dict)}
            for gid in group_files:
                g = by_id.get(gid)
                if g and merger.has_wildcards(
                    g.get("positive") or "", g.get("negative") or "",
                    g.get("prefix") or "", g.get("suffix") or "",
                ):
                    has_wc = True
            if has_wc:
                import secrets
                return ("wildcard", lib_sig, 映射数据, secrets.token_hex(8))
            return (lib_sig, 映射数据, 库数据)
        except Exception:
            return (映射数据, 库数据)

    @staticmethod
    def _resolve_group_refs(cfg, groups):
        """统一口径：每组 → 图片绝对路径列表 = links(gid) ∪ 卡片「分组」字段匹配组名。

        卡片分组徽标与底部关联面板是同一件事，两条数据路径合并计算（去重保序）。
        """
        links = cfg.get("links", [])
        images = cfg.get("images", [])
        by_gid = {}
        for lk in links:
            gid, abs_path = lk.get("gid"), lk.get("abs")
            if gid and abs_path:
                files = by_gid.setdefault(gid, [])
                if abs_path not in files:
                    files.append(abs_path)
        for g in groups:
            if not isinstance(g, dict):
                continue
            gid, name = g.get("id"), (g.get("name") or "").strip()
            if not gid or not name:
                continue
            files = by_gid.setdefault(gid, [])
            for e in images:
                abs_path = e.get("abs")
                if abs_path and (e.get("group") or "").strip() == name and abs_path not in files:
                    files.append(abs_path)
        return {gid: f for gid, f in by_gid.items() if f}

    @classmethod
    def _load_groups(cls, cfg, library_data):
        loc = cfg.get("library_locator")
        if isinstance(loc, dict) and loc.get("source") == "inline" and library_data:
            try:
                data = json.loads(library_data)
            except Exception:
                data = constants.make_empty_library()
        elif isinstance(loc, dict):
            data = library_store.load_library(loc)
        else:
            data = constants.make_empty_library()
        return data.get("groups", []) if isinstance(data, dict) else []

    def execute(self, 映射数据="{}", 库数据="", **kwargs):
        cfg = _parse_config(映射数据)
        groups = self._load_groups(cfg, 库数据)
        group_files = self._resolve_group_refs(cfg, groups)

        # 被引用的提示词组（有图片的组），按库顺序去重
        ref_gids = [g.get("id") for g in groups if isinstance(g, dict) and group_files.get(g.get("id"))]
        positive, negative = merger.merge_groups(
            groups,
            ref_gids,
            separator=constants.DEFAULT_SEPARATOR,
            ignore_weight=True,  # 生视频提示词不需要 (text:w) 包裹
        )

        # 参与映射的图片（所有组图片的并集）
        active_abs = set()
        for files in group_files.values():
            active_abs.update(files)
        images = cfg["images"]
        # 只输出明确参与映射的图片；没有任何归属时不回退、输出空
        # （1x1 黑图占位），避免未挂组时把整个目录几百张图灌进下游导致卡死
        ordered = sorted(images, key=lambda e: e.get("order", 0))
        chosen = [e for e in ordered if e.get("abs") in active_abs]

        img_tensor = load_images_to_tensor(chosen)
        if img_tensor is None:
            # 无图片时返回 1x1 黑图，保证 IMAGE 输出类型合法、不报错
            import torch
            img_tensor = torch.zeros((1, 8, 8, 3), dtype=torch.float32)

        # 结构化输出：两种视角
        img_view = []
        for e in ordered:
            abs_path = e.get("abs")
            gids = [gid for gid in ref_gids if abs_path in group_files.get(gid, [])]
            img_view.append({
                "file": e.get("file", ""),
                "abs": abs_path,
                "category": e.get("category", ""),
                "group": e.get("group", ""),
                "prompts": gids,
            })
        grp_view = []
        for g in groups:
            if not isinstance(g, dict):
                continue
            gid = g.get("id")
            if not gid:
                continue
            grp_view.append({
                "gid": gid,
                "name": g.get("name", ""),
                "images": group_files.get(gid, []),
            })

        mapping_json = json.dumps({
            "mode": cfg.get("mode"),
            "folder": cfg.get("folder"),
            "images": img_view,
            "prompt_groups": grp_view,
            "positive": positive,
            "negative": negative,
        }, ensure_ascii=False)

        return (img_tensor, positive, negative, mapping_json)


NODE_CLASS_MAPPINGS = {
    "BatchImagePromptSelector": BatchImagePromptSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BatchImagePromptSelector": "批量选图（图↔提示词映射）",
}
