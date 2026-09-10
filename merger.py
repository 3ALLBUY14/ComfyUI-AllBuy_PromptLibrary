"""提示词合并逻辑（纯函数，便于单测）。"""
import random
import re
from typing import Any, Optional

# 匹配最内层（不含嵌套大括号）的 {...}
_WILDCARD_RE = re.compile(r"\{([^{}]*)\}")
# 匹配属性标签 #名称#（名称不含空白/#/:{}|，≤24 字）
_TAG_RE = re.compile(r"#([^#\s{}:|]{1,24})#")


def has_wildcards(*texts):
    """判断任意文本中是否含通配符语法 {a|b}。"""
    return any(t and "{" in t for t in texts)


def split_named_slot(content):
    """识别命名槽头部 {名称:其余}，返回 (名称, 其余) 或 None。

    名称 ≤24 字、不含 | : { }、非纯数字——避免把 {09:00|18:00} 这类
    带冒号的普通通配符误判成槽位。
    """
    if ":" not in content:
        return None
    head, _, rest = content.partition(":")
    head = head.strip()
    if not head or head.isdigit() or len(head) > 24:
        return None
    if any(c in head for c in "|{}"):
        return None
    return head, rest


def is_bare_placeholder(content):
    """识别纯占位符 {名称}（无冒号无竖线，≤24 字，非纯数字）。"""
    bare = content.strip()
    if not bare or bare.isdigit() or len(bare) > 24:
        return False
    return not any(c in bare for c in "|:{}")


def _slot_value(name, vars):
    if not vars:
        return ""
    return str(vars.get(name, "") or "").strip()


def _expand_slot(m, rng, vars):
    content = m.group(1)
    named = split_named_slot(content)
    if named is not None:
        name, rest = named
        val = _slot_value(name, vars)
        if val:
            return val  # 面板里固定了取值 → 直接替换
        opts = [o.strip() for o in rest.split("|") if o.strip()]
        if opts:
            return rng.choice(opts)  # 未固定 → 按选项随机
        return m.group(0)  # {名称:} 无值无选项 → 原样保留
    if is_bare_placeholder(content):
        val = _slot_value(content.strip(), vars)
        if val:
            return val
        return m.group(0)  # {名称} 未填 → 原样保留（肉眼可见未填）
    return _pick_option(content, rng)


def expand_wildcards(text, rng=None, vars=None):
    """展开提示词里的占位符，返回替换后的完整文本。

    ① 属性标签 #名称#：面板变量行填了值 → 替换成该值；没填 → 原样保留（肉眼可见未填）。
    ② 命名槽 {名称:选项1|选项2}：填了值固定替换，没填按选项随机。
    ③ 纯占位符 {名称}：填了值替换，没填原样保留。
    ④ 普通通配符 {a|b|c}：随机选一（向后兼容）。
    支持嵌套：从最内层开始逐层展开。
    rng: random.Random 实例；传入相同 seed 的 rng 可复现结果。
    vars: 取值 {名称/标签名: 值}，命名槽与属性标签共用同一张表。
    """
    if not text:
        return text
    vars = vars or {}
    if "＃" in text:
        text = text.replace("＃", "#")  # 全角＃兼容
    if "#" in text:
        text = _TAG_RE.sub(
            lambda m: (_slot_value(m.group(1), vars) or m.group(0)),
            text,
        )
    if "{" not in text:
        return text
    if rng is None:
        rng = random
    prev = None
    while text != prev:
        prev = text
        text = _WILDCARD_RE.sub(
            lambda m: _expand_slot(m, rng, vars),
            text,
        )
    return text


def _pick_option(content, rng):
    options = [o.strip() for o in content.split("|")]
    options = [o for o in options if o]
    if not options:
        return ""
    return rng.choice(options)


def _safe_float(v: Any, default: float = 1.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def merge_groups(groups, selected_ids, separator=", ", prepend="", append="", rng: Optional[random.Random] = None, ignore_weight: bool = False, vars=None):
    """把勾选的提示词卡片按 selected_ids 顺序合并成 (positive, negative)。

    groups: 库中的 groups 列表
    selected_ids: 有序 id 列表（决定拼接顺序）
    separator: 卡片之间的分隔符
    prepend/append: 全局前置/后置文本
    rng: 通配符随机源；None 时用全局 random（不可复现，每次执行重新抽取）
    vars: 命名槽取值 {名称: 值}，见 expand_wildcards
    """
    if not selected_ids:
        return ("", "")

    by_id = {}
    for g in groups or []:
        gid = g.get("id")
        if gid:
            by_id[gid] = g

    ordered = [by_id[gid] for gid in selected_ids if gid in by_id]

    pos_parts = []
    neg_parts = []

    for g in ordered:
        pos = (g.get("positive") or "").strip()
        neg = (g.get("negative") or "").strip()
        prefix = expand_wildcards(g.get("prefix") or "", rng, vars)
        suffix = expand_wildcards(g.get("suffix") or "", rng, vars)
        weight = _safe_float(g.get("weight", 1.0), 1.0)

        if pos:
            text = f"{prefix}{expand_wildcards(pos, rng, vars)}{suffix}"
            # 展开为空（正文全是未填占位符等）不包权重、不产生空碎片/双分隔符
            if text and not ignore_weight and weight != 1.0:
                text = f"({text}:{weight:g})"
            if text:
                pos_parts.append(text)
        if neg:
            t = expand_wildcards(neg, rng, vars)
            if t:
                neg_parts.append(t)

    positive = _join(pos_parts, separator, expand_wildcards(prepend, rng, vars), expand_wildcards(append, rng, vars))
    negative = _join(neg_parts, separator, "", "")
    return (positive, negative)


def _join(parts, separator, prepend, append):
    body = separator.join(p for p in parts if p)
    pieces = []
    if prepend:
        pieces.append(prepend)
    if body:
        pieces.append(body)
    if append:
        pieces.append(append)
    result = separator.join(pieces) if separator != "\n" else "\n".join(pieces)
    return result.strip()
