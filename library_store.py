"""库文件存储：内置库（插件/libraries，只读）、用户库（ComfyUI/user/allbuy_promptlibrary，可读写）、自定义路径（只读）。"""
import os
import json
import re
import shutil
import threading

from . import constants

_write_lock = threading.Lock()


# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------
def get_user_libraries_folder():
    """返回用户库目录，不存在则创建。优先用 ComfyUI 的 user 目录。

    v3.47 插件改名：数据目录由 videoprompt_library → allbuy_promptlibrary，
    检测到旧目录且新目录不存在时整体搬移一次，老用户的库自动平移不丢数据。
    """
    base = None
    try:
        from folder_paths import get_user_directory
        base = get_user_directory()
    except Exception:
        pass
    if not base:
        try:
            from folder_paths import base_path
            base = os.path.join(base_path, "user")
        except Exception:
            base = os.path.join(os.path.expanduser("~"), "ComfyUI", "user")
    folder = os.path.join(base, "allbuy_promptlibrary")
    legacy = os.path.join(base, "videoprompt_library")
    try:
        if os.path.isdir(legacy) and not os.path.isdir(folder):
            os.replace(legacy, folder)
    except Exception:
        pass  # 迁移失败（被占用等）不阻塞加载，继续用新目录
    os.makedirs(folder, exist_ok=True)
    return folder


def _sanitize_filename(name):
    name = (name or "").strip()
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)
    return name or "untitled"


def _builtin_path(name):
    return os.path.join(constants.BUILTIN_LIBRARIES_FOLDER, f"{_sanitize_filename(name)}.json")


def _user_path(name):
    return os.path.join(get_user_libraries_folder(), f"{_sanitize_filename(name)}.json")


# ---------------------------------------------------------------------------
# locator 解析
# ---------------------------------------------------------------------------
def parse_locator(locator):
    """把前端传来的 locator（JSON 字符串或 dict）归一化为 dict。

    {"source":"builtin","name":"default"}
    {"source":"user","name":"default"}
    {"source":"custom","path":"D:/xxx.json"}
    """
    if isinstance(locator, str):
        locator = locator.strip()
        if not locator:
            return {"source": "user", "name": constants.DEFAULT_LIBRARY_NAME}
        try:
            locator = json.loads(locator)
        except Exception:
            # 兼容旧版：纯字符串当作 user 库名
            return {"source": "user", "name": locator}
    if not isinstance(locator, dict):
        return {"source": "user", "name": constants.DEFAULT_LIBRARY_NAME}
    return locator


def resolve(locator):
    """返回 (绝对路径, 是否只读)。找不到时抛 FileNotFoundError。"""
    loc = parse_locator(locator)
    source = loc.get("source", "user")
    if source == "builtin":
        path = _builtin_path(loc.get("name", constants.DEFAULT_LIBRARY_NAME))
        return path, True
    if source == "custom":
        path = loc.get("path", "")
        if not path or not os.path.isfile(path):
            raise FileNotFoundError(f"自定义库文件不存在: {path}")
        return path, True
    # user
    path = _user_path(loc.get("name", constants.DEFAULT_LIBRARY_NAME))
    return path, False


# ---------------------------------------------------------------------------
# 读写
# ---------------------------------------------------------------------------
def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _atomic_write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    backup = path + ".backup"
    with _write_lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        if os.path.isfile(path):
            try:
                shutil.copy2(path, backup)
            except Exception:
                pass
        os.replace(tmp, path)


def load_library(locator):
    """加载库，返回 dict。库不存在时返回空库结构（不报错，方便前端新建）。"""
    try:
        path, _readonly = resolve(locator)
    except FileNotFoundError:
        loc = parse_locator(locator)
        return constants.make_empty_library(loc.get("name", "未命名"))
    if not os.path.isfile(path):
        loc = parse_locator(locator)
        return constants.make_empty_library(loc.get("name", "未命名"))
    try:
        data = _read_json(path)
    except Exception:
        # 损坏时尝试 backup
        backup = path + ".backup"
        if os.path.isfile(backup):
            try:
                data = _read_json(backup)
            except Exception:
                data = constants.make_empty_library()
        else:
            data = constants.make_empty_library()
    if not isinstance(data, dict):
        data = constants.make_empty_library()
    data.setdefault("version", 1)
    data.setdefault("name", "")
    data.setdefault("groups", [])
    return data


def save_library(locator, data):
    """保存整库。仅 user 库可写。"""
    path, readonly = resolve(locator)
    if readonly:
        raise PermissionError("内置库 / 自定义路径库为只读，无法保存")
    if not isinstance(data, dict):
        raise ValueError("库数据格式错误")
    data.setdefault("version", 1)
    data.setdefault("groups", [])
    _atomic_write_json(path, data)
    return True


def list_libraries():
    """列出所有可用库（builtin + user）。
    v2.10：每条带 `count` 字段（卡片数），前端用于排序和「空(0)/N 张」后缀。
    """
    result = []

    def scan(folder, source):
        if not os.path.isdir(folder):
            return
        for fn in sorted(os.listdir(folder)):
            if not fn.lower().endswith(".json"):
                continue
            if fn.endswith(".backup") or fn.endswith(".tmp"):
                continue
            name = fn[:-5]
            count = 0
            display = name
            try:
                data = _read_json(os.path.join(folder, fn))
                groups = data.get("groups") if isinstance(data, dict) else None
                count = len(groups) if isinstance(groups, list) else 0
                display = data.get("name") or name
            except Exception:
                pass
            result.append({
                "source": source,
                "name": name,
                "display_name": display,
                "readonly": source == "builtin",
                "count": count,
            })

    scan(constants.BUILTIN_LIBRARIES_FOLDER, "builtin")
    scan(get_user_libraries_folder(), "user")
    return result


def all_library_paths():
    """全部库 JSON 的绝对路径（内置 + 用户），供封面孤儿回收聚合跨库引用集。"""
    paths = []
    for folder in (constants.BUILTIN_LIBRARIES_FOLDER, get_user_libraries_folder()):
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for fn in names:
            if fn.endswith(".json"):  # .backup / .tmp 后缀天然不匹配
                paths.append(os.path.join(folder, fn))
    return paths


def create_library(name):
    """在用户目录创建新库，返回 locator。"""
    safe = _sanitize_filename(name)
    path = _user_path(safe)
    if os.path.isfile(path):
        raise FileExistsError(f"库已存在: {safe}")
    data = constants.make_empty_library(name)
    _atomic_write_json(path, data)
    return {"source": "user", "name": safe}


def delete_library(name):
    """删除用户库（同时删除 backup）。"""
    path = _user_path(name)
    with _write_lock:
        if os.path.isfile(path):
            os.remove(path)
        backup = path + ".backup"
        if os.path.isfile(backup):
            os.remove(backup)
    return True


def ensure_default_library():
    """启动时确保用户目录的 default.json 可用：不存在、损坏或分组为空时，
    从内置示例库复制一份（可编辑）。default 是示例库，空了就重新填充。"""
    try:
        user_path = _user_path(constants.DEFAULT_LIBRARY_NAME)
        builtin = _builtin_path(constants.DEFAULT_LIBRARY_NAME)
        if not os.path.isfile(builtin):
            return
        need_copy = False
        if not os.path.isfile(user_path):
            need_copy = True
        else:
            try:
                data = _read_json(user_path)
                if not isinstance(data, dict) or not data.get("groups"):
                    need_copy = True  # 空库 / 损坏 → 用内置示例补回
            except Exception:
                need_copy = True
        if need_copy:
            os.makedirs(os.path.dirname(user_path), exist_ok=True)
            shutil.copy2(builtin, user_path)
    except Exception:
        pass
