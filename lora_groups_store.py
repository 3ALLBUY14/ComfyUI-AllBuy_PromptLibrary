"""LoRA 自定义分组持久化存储。

数据文件：ComfyUI/user/allbuy_promptlibrary/lora_groups.json
结构：{"version": 1, "groups": [{"id", "name", "loras": [完整相对路径名]}]}

- 复用 library_store.get_user_libraries_folder() 数据目录与原子写盘模式（tmp + backup）
- 名称 sanitize（与库名同规则）、loras 列表去重、未知字段丢弃、坏 JSON 回退空数据
"""
import json
import os
import re
import threading

from . import library_store

GROUPS_VERSION = 1
DEFAULT_GROUP_NAME = "我的收藏"

_groups_lock = threading.Lock()


def _sanitize_name(name):
    """分组名清洗：去除路径分隔与非法字符，空名回退「未命名」。"""
    name = (name or "").strip()
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)
    return name or "未命名"


def _groups_path():
    return os.path.join(library_store.get_user_libraries_folder(), "lora_groups.json")


def _normalize_groups(raw):
    """把任意输入归一化为合法 groups 列表（含默认收藏组）。

    - 非法条目丢弃；条目须为 dict
    - name 经 _sanitize_name；loras 只保留字符串、去重保序
    - id 缺失/非法时按出现顺序生成稳定唯一 id
    """
    if not isinstance(raw, list):
        return []
    groups = []
    seen_ids = set()
    for i, g in enumerate(raw):
        if not isinstance(g, dict):
            continue
        name = _sanitize_name(g.get("name"))
        loras = []
        for item in g.get("loras") or []:
            if isinstance(item, str):
                item = item.strip()
                if item and item not in loras:
                    loras.append(item)
        gid = g.get("id")
        if not isinstance(gid, str) or not gid.strip() or gid in seen_ids:
            candidate = f"g{i}"
            n = 0
            while candidate in seen_ids:
                n += 1
                candidate = f"g{i}_{n}"
            gid = candidate
        gid = gid.strip()
        seen_ids.add(gid)
        groups.append({"id": gid, "name": name, "loras": loras})
    return groups


def _ensure_default_group(groups):
    """确保存在「我的收藏」默认组（无则追加到最前）。"""
    for g in groups:
        if g["name"] == DEFAULT_GROUP_NAME:
            return groups
    return [{"id": "_fav", "name": DEFAULT_GROUP_NAME, "loras": []}] + groups


def load_groups():
    """加载分组，返回 dict {"version", "groups"}（始终补齐「我的收藏」默认组）。文件缺失/损坏回退空结构。"""
    path = _groups_path()
    if not os.path.isfile(path):
        return {"version": GROUPS_VERSION,
                "groups": _ensure_default_group([])}
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        # 损坏时尝试 backup
        backup = path + ".backup"
        if os.path.isfile(backup):
            try:
                with open(backup, "r", encoding="utf-8") as f:
                    raw = json.load(f)
            except Exception:
                raw = {}
        else:
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    groups = _ensure_default_group(_normalize_groups(raw.get("groups")))
    return {"version": GROUPS_VERSION, "groups": groups}


def save_groups(data):
    """保存分组。data 可为 {"groups":[...]} 或裸列表；校验后原子写盘。"""
    if isinstance(data, list):
        groups_raw = data
    elif isinstance(data, dict):
        groups_raw = data.get("groups")
    else:
        raise ValueError("分组数据格式错误")
    groups = _ensure_default_group(_normalize_groups(groups_raw))
    payload = {"version": GROUPS_VERSION, "groups": groups}
    path = _groups_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    backup = path + ".backup"
    with _groups_lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        if os.path.isfile(path):
            try:
                import shutil
                shutil.copy2(path, backup)
            except Exception:
                pass
        os.replace(tmp, path)
    return payload
