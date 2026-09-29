"""AllBuy-文本框：大文本提示词编辑节点（后端执行逻辑，纯文本管线）。

特性：
- 双输出：「提示词」整段 STRING；「提示词行」按换行分段（每行一项的 STRING 列表，
  下游按批消费）；两者都基于同一套处理管线
- 去空行开关：只删纯空白行，不动行内内容
- 替换表：每行「旧=新」（首个 = 分割，空行忽略），按顺序应用；先替换再去空行，
  替换产生的空行也会被清掉
- @素材：纯文本标记——文本中的 @素材名 按首次出现顺序映射为 image1..image10
  写进提示词（供识别 imageN 占位符的模型/下游使用，图片本体由素材加载节点提供）；
  超过 10 个的 @标记保留原样

处理顺序：替换表 → 去空行 → @素材替换（@替换不产生空行）。
节点输出是输入文本的纯函数（不读任何文件），ComfyUI 原生输入缓存即够，
无需自定义 IS_CHANGED。
"""
import re

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


def resolve_at_names(text):
    """文本里按首次出现顺序去重的 @素材名（最多 _MAX_IMAGES 个参与映射）。"""
    seen = []
    for name in _AT_TOKEN.findall(text or ""):
        if name and name not in seen:
            seen.append(name)
    return seen


def apply_at_tokens(text):
    """@素材名 → image1..imageN（按首次出现顺序，前 _MAX_IMAGES 个），返回替换后文本。"""
    names = resolve_at_names(text)[:_MAX_IMAGES]
    slot = {name: f"image{i + 1}" for i, name in enumerate(names)}
    return _AT_TOKEN.sub(lambda m: slot.get(m.group(1), m.group(0)), text)


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

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("提示词", "提示词行")
    CATEGORY = "AllBuy/提示词库"
    FUNCTION = "execute"
    SEARCH_ALIASES = ["文本框", "提示词框", "大文本", "textbox"]

    def execute(self, 文本="", 替换表="", 去空行=True, **kwargs):
        base = apply_replacements_and_blank(文本 or "", 替换表 or "", bool(去空行))
        full = apply_at_tokens(base)
        lines = full.splitlines() if full else []
        names = resolve_at_names(base)[:_MAX_IMAGES]
        return {
            "ui": {"images_used": [{"slot": f"image{i + 1}", "name": n} for i, n in enumerate(names)]},
            "result": (full, lines),
        }


NODE_CLASS_MAPPINGS = {
    "AllBuyTextBox": AllBuyTextBox,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AllBuyTextBox": "AllBuy-文本框",
}
