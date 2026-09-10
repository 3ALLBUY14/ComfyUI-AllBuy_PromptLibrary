"""随机抽卡核心逻辑（纯函数，节点 execute 与 /draw 预览端点共用，保证预览 = 执行）。

设计要点：
- 抽卡必须可复现：相同 (库, 数量, 种子, 分类组合, 标签筛选, 锁定集, 变量取值) 永远抽到同一批卡。
- 抽卡与通配符展开共用同一个 random.Random(seed)，因此 seed 固定时整条结果（抽中哪些卡 + 合并文本里的通配符）完全确定。
- 锁定卡（v3.43）：锁定集内的卡只要通过分类筛选就必含（不受数量钳制），其余名额从未锁定的候选中随机抽取；
  锁定集变化时同 seed 结果自然不同，属预期行为。
- 前端 /draw 预览端点复用本模块，所见即所得，与队列执行结果逐字一致。
"""
import json
import os
import random

from . import library_store, merger, constants

# 随机种子最大值（与 ComfyUI 常规 seed widget 保持一致）
_MAX_SEED = 0xFFFFFFFFFFFFFFFF

# 库文件内容缓存（v3.43）：/draw 在调种子/数量时高频触发，按 mtime_ns:size 命中
# 则免去整库 JSON 读盘+解析。draw() 只读不写返回的 dict，故可安全共享同一份缓存。
# 仅对真实存在的文件库启用；locators 解析不到文件（含单测的假库）直接走原路径，绝不缓存。
_lib_cache = {}


def _load_cached(locator):
    try:
        path, _readonly = library_store.resolve(locator)
    except Exception:
        return library_store.load_library(locator)
    if not os.path.isfile(path):
        return library_store.load_library(locator)
    try:
        st = os.stat(path)
        sig = f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return library_store.load_library(locator)
    hit = _lib_cache.get(path)
    if hit and hit[0] == sig:
        return hit[1]
    data = library_store.load_library(locator)
    if isinstance(data, dict):
        _lib_cache[path] = (sig, data)
    return data


def resolve_locator(value):
    """把 combo 值（如 "user:default"）解析成 locator；直接输库名则按用户库处理。"""
    value = (value or "").strip()
    try:
        for l in library_store.list_libraries():
            if f"{l['source']}:{l['name']}" == value:
                return {"source": l["source"], "name": l["name"]}
    except Exception:
        pass
    if ":" in value:
        source, name = value.split(":", 1)
        if source in ("user", "builtin", "custom"):
            return {"source": source, "name": name}
    return {"source": "user", "name": value or constants.DEFAULT_LIBRARY_NAME}


def group_categories(g):
    """兼容读取单卡的分类：优先 categories（列表），回退 category（字符串）。返回去空字符串列表。"""
    cats = g.get("categories")
    if not cats:
        c = g.get("category")
        cats = [c] if c else []
    if isinstance(cats, str):
        cats = [cats]
    return [c for c in cats if c]


def all_categories(groups):
    """汇总整库出现过的所有分类（去重 + 稳定排序），供前端分类下拉使用。"""
    seen = []
    for g in groups or []:
        for c in group_categories(g):
            if c not in seen:
                seen.append(c)
    return sorted(seen)


def clamp_seed(seed):
    try:
        s = int(seed)
    except (TypeError, ValueError):
        s = 0
    return max(0, min(s, _MAX_SEED))


def _as_id_set(locked_ids):
    """锁定 id 容错归一：接受 list/set 或 JSON 字符串，返回去重的列表（保序）。"""
    if isinstance(locked_ids, str):
        import json
        try:
            locked_ids = json.loads(locked_ids)
        except Exception:
            locked_ids = []
    if not isinstance(locked_ids, (list, tuple, set)):
        return []
    seen, out = set(), []
    for i in locked_ids:
        if i and i not in seen:
            seen.add(i)
            out.append(i)
    return out


def _as_str_list(v):
    """筛选条件容错归一（v3.45）：接受 list/set、JSON 数组字符串（前端注入形态）、
    或单个普通字符串（旧存档/旧前端形态），返回去空、去重的字符串列表。"""
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                v = json.loads(s)
            except Exception:
                return [s]
        else:
            return [s]
    if isinstance(v, (list, tuple, set)):
        out = []
        for x in v:
            if isinstance(x, str) and x.strip() and x not in out:
                out.append(x.strip())
        return out
    return []


def draw(library, count, seed, separator=", ", filter_category="", prepend="", append="",
         locked_ids=None, vars=None, filter_tags=None):
    """执行一次随机抽卡，返回结构化结果 dict。

    返回字段：
    - library: 解析后的 locator
    - total: 参与抽样的候选卡片总数（已按分类组合 + 标签筛选）
    - count: 实际抽中的卡片数（锁定卡必含，其余从未锁定候选中抽，被候选总数钳制）
    - seed: 钳制后的种子
    - categories: 生效的分类组合（[] = 全部分类；命中任一分类即入池）
    - tags: 生效的标签筛选（[] = 全部标签；命中任一标签即入池）
    - drawn: 抽中的卡片精简信息 [{id, name, positive, negative, prefix, suffix, categories, locked}]
      （prefix/suffix/categories 供前端扫描命名槽与属性标签；locked 标记该卡来自锁定集）
    - positive / negative: 合并后的提示词字符串
    """
    locator = resolve_locator(library)
    data = _load_cached(locator)
    groups = data.get("groups", []) if isinstance(data, dict) else []

    # v3.45：分类组合 + 标签筛选（均为多选并集：命中任一即保留；分类与标签之间取交集）
    cat_filter = _as_str_list(filter_category)
    tag_filter = _as_str_list(filter_tags)
    if cat_filter:
        groups = [g for g in groups if any(c in group_categories(g) for c in cat_filter)]
    if tag_filter:
        groups = [g for g in groups if any(t in (g.get("tags") or []) for t in tag_filter)]

    locked_ids = _as_id_set(locked_ids)
    locked_set = set(locked_ids)
    # 锁定卡必须仍在候选池内（被分类筛掉的锁定视为失效），按库内顺序取
    locked_groups = [g for g in groups if g.get("id") in locked_set]
    rest_pool = [g for g in groups if g.get("id") not in locked_set]

    rng = random.Random(clamp_seed(seed))
    count = max(0, min(int(count or 0), len(groups)))
    n_rest = max(0, count - len(locked_groups))
    drawn_rest = rng.sample(rest_pool, n_rest) if n_rest else []
    sel_ids = set(locked_ids) | {g.get("id") for g in drawn_rest}
    # 展示顺序与合并文本一致（merge_groups 按库内顺序合并），不再按抽样顺序
    drawn = [g for g in groups if g.get("id") in sel_ids]

    pos, neg = merger.merge_groups(
        groups,
        [g.get("id") for g in drawn],
        separator=separator or constants.DEFAULT_SEPARATOR,
        prepend=prepend or "",
        append=append or "",
        rng=rng,  # 与抽卡共用同一随机源，seed 固定时整条结果可复现
        vars=vars,  # 命名槽/属性标签取值（v3.43 接入，与主节点同语义）
    )

    return {
        "ok": True,
        "library": locator,
        "total": len(groups),
        "count": len(drawn),
        "seed": clamp_seed(seed),
        "categories": cat_filter,
        "tags": tag_filter,
        "drawn": [
            {
                "id": g.get("id"),
                "name": g.get("name"),
                "positive": g.get("positive"),
                "negative": g.get("negative"),
                "prefix": g.get("prefix"),
                "suffix": g.get("suffix"),
                "categories": group_categories(g),
                "locked": g.get("id") in locked_set,
            }
            for g in drawn
        ],
        "positive": pos,
        "negative": neg,
    }
