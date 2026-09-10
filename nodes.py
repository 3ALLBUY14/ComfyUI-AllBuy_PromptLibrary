"""ComfyUI 节点定义。"""
import json
import os
import random
import secrets

from . import library_store, merger, constants, random_draw

DEFAULT_LOCATOR = json.dumps({"source": "user", "name": constants.DEFAULT_LIBRARY_NAME})

# 随机抽卡节点：seed 的最大值（与 ComfyUI 常规 seed widget 保持一致）
_MAX_SEED = 0xFFFFFFFFFFFFFFFF


def _library_content_sig(locator):
    """库文件内容签名（mtime_ns:size），纳入 IS_CHANGED 缓存键。

    面板里编辑/保存提示词组只改磁盘上的库 JSON，不改动任何 widget 输入值；
    缓存键若只有输入值，ComfyUI 会一直复用旧输出（表现为改了组不生效，
    复制副本重新勾选才生效——selected_ids 变了才换键）。
    文件不存在/解析失败返回固定串，与 execute 读到的空库保持键稳定。
    """
    try:
        path, _readonly = library_store.resolve(locator)
        st = os.stat(path)
        return f"{st.st_mtime_ns}:{st.st_size}"
    except Exception:
        return "missing"


class PromptLibrary:
    """提示词库：勾选多组提示词卡片，按顺序合并输出 positive / negative 字符串。

    v3.47 由 VideoPromptLibrary 改名（生图同样可用）；旧类名在 NODE_CLASS_MAPPINGS
    里保留别名，老工作流仍可正常加载执行。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 以下三个 widget 由前端自定义 UI 接管并隐藏原生输入框
                "库": ("STRING", {"default": DEFAULT_LOCATOR}),
                "选中卡片": ("STRING", {"default": "[]"}),
                "分隔符": ("STRING", {"default": constants.DEFAULT_SEPARATOR}),
            },
            "optional": {
                "前缀": ("STRING", {"default": ""}),
                "后缀": ("STRING", {"default": ""}),
                # v3.3：忽略权重开关——生视频的提示词通常不需要 (text:w) 包裹
                "忽略权重": ("BOOLEAN", {"default": False,
                                       "tooltip": "生视频提示词不需要权重；勾选后合并输出不带 (text:w) 包裹"}),
                # 当 library locator 的 source 为 "inline" 时，库数据内嵌于此（工作流自包含）
                "库数据": ("STRING", {"default": ""}),
                # v3.34：命名槽取值 {"性别":"女人"}——组文本里的 {名称:选项1|选项2} 由前端面板固定取值
                "变量取值": ("STRING", {"default": "{}"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("正提示词", "负提示词")
    CATEGORY = "AllBuy/提示词库"
    FUNCTION = "execute"
    # v3.51：双击画布搜索节点时支持中文（前端 1.16+ 读取 search_aliases）
    SEARCH_ALIASES = ["提示词库", "视频提示词库", "prompt library", "video prompt"]

    @staticmethod
    def _parse_selected(selected_ids):
        try:
            sel = json.loads(selected_ids) if selected_ids else []
            if not isinstance(sel, list):
                sel = []
        except Exception:
            sel = []
        return sel

    @classmethod
    def _load_groups(cls, library, library_data):
        locator = library_store.parse_locator(library)
        if locator.get("source") == "inline" and library_data:
            try:
                data = json.loads(library_data)
            except Exception:
                data = constants.make_empty_library()
        else:
            data = library_store.load_library(locator)
        return data.get("groups", []) if isinstance(data, dict) else []

    @staticmethod
    def _parse_vars(var_values):
        """命名槽取值 JSON → dict（非法输入静默回退空 dict）。"""
        try:
            vars = json.loads(var_values) if var_values else {}
        except Exception:
            return {}
        return vars if isinstance(vars, dict) else {}

    @classmethod
    def IS_CHANGED(cls, 库, 选中卡片, 分隔符, 前缀="", 后缀="", 库数据="", 忽略权重=False, 变量取值="{}",
                   通配符固定=False, 通配符种子=0, **kwargs):
        locator = library_store.parse_locator(库)
        if locator.get("source") == "inline" and 库数据:
            lib_sig = "inline"  # inline 库数据本身是输入值 库数据，变化自然换键
        else:
            lib_sig = _library_content_sig(locator)
        inputs = (lib_sig, 选中卡片, 分隔符, 前缀, 后缀, 库数据, 忽略权重, 变量取值)
        # v3.51：通配符固定种子开关（前端 footer 🎲 按钮驱动）。
        #   默认（False）键与 v3.50 完全一致，行为不变；仅开启固定时在键尾追加种子标记，
        #   同种子含通配符也可缓存复现，关闭即恢复「每次随机重抽」。
        if 通配符固定:
            inputs = inputs + ("fixed", 通配符种子)
        # 选中卡片或前后置文本含通配符时：
        #   通配符固定=False（默认）→ 每次出队都重新抽取（返回随机 token，不可缓存）
        #   通配符固定=True → 种子已入键，相同种子可复现，正常缓存
        # 注意：不能直接检查库数据字符串——合法 JSON 必然含 "{"，会误判成永远变化
        try:
            groups = cls._load_groups(库, 库数据)
            sel = cls._parse_selected(选中卡片)
            by_id = {g.get("id"): g for g in groups if isinstance(g, dict)}
            has_wc = merger.has_wildcards(前缀, 后缀)
            for gid in sel:
                g = by_id.get(gid)
                if g and merger.has_wildcards(
                    g.get("positive") or "", g.get("negative") or "",
                    g.get("prefix") or "", g.get("suffix") or "",
                ):
                    has_wc = True
            if has_wc and not 通配符固定:
                return ("wildcard", inputs, secrets.token_hex(8))
        except Exception:
            pass
        return inputs

    def execute(self, 库, 选中卡片, 分隔符, 前缀="", 后缀="", 库数据="", 忽略权重=False, 变量取值="{}",
                通配符固定=False, 通配符种子=0, **kwargs):
        groups = self._load_groups(库, 库数据)
        sel = self._parse_selected(选中卡片)

        # v3.51：通配符固定开关（前端 footer 🎲 按钮驱动，经 graphToPrompt 注入）
        #   关（默认）= 每次执行重新抽取；开 = random.Random(种子)，同种子结果可复现
        rng = random.Random(通配符种子) if 通配符固定 else random.Random()
        pos, neg = merger.merge_groups(
            groups,
            sel,
            separator=分隔符 or constants.DEFAULT_SEPARATOR,
            prepend=前缀 or "",
            append=后缀 or "",
            rng=rng,
            ignore_weight=bool(忽略权重),
            vars=self._parse_vars(变量取值),
        )
        return (pos, neg)


class PromptRandomDraw:
    """随机抽卡：从指定库中随机抽 N 张卡片合并输出（按 seed 可复现，适合批量出图找灵感）。

    前端已由自定义 DOM 面板接管（库/分类下拉、数量步进、种子+🎲、分隔符、前后缀、卡片网格实时预览），
    原生 widget 被隐藏并由面板驱动，执行参数经 graphToPrompt 注入后端。抽卡逻辑共用 random_draw.draw。
    v3.47 由 VideoPromptRandomDraw 改名；旧类名在 NODE_CLASS_MAPPINGS 里保留别名。
    """

    @classmethod
    def INPUT_TYPES(cls):
        libs = []
        try:
            for l in library_store.list_libraries():
                libs.append(f"{l['source']}:{l['name']}")
        except Exception:
            pass
        if not libs:
            libs = [f"user:{constants.DEFAULT_LIBRARY_NAME}"]
        return {
            "required": {
                "库": (libs, {"default": libs[0], "tooltip": "user:库名 = 用户库，builtin:库名 = 内置库"}),
                "数量": ("INT", {"default": 1, "min": 0, "max": 100, "tooltip": "随机抽取的卡片数量（0–100）；面板中锁定的卡片必含、不占名额"}),
                "随机种子": ("INT", {"default": 0, "min": 0, "max": _MAX_SEED,
                                  "control_after_generate": True, "tooltip": "相同种子抽卡结果可复现；每次执行后自动变化"}),
                "分隔符": ("STRING", {"default": constants.DEFAULT_SEPARATOR, "tooltip": "多张卡片合并时使用的连接符"}),
                "分类筛选": ("STRING", {"default": "[]", "tooltip": "分类组合 JSON 数组 [\"分类\"]，命中任一分类的卡参与抽卡；[] = 全部分类（兼容旧单分类字符串）"}),
            },
            "optional": {
                "前缀": ("STRING", {"default": "", "tooltip": "合并后整体前置的固定文本，支持 {a|b} 通配符"}),
                "后缀": ("STRING", {"default": "", "tooltip": "合并后整体后置的固定文本，支持 {a|b} 通配符"}),
                # v3.43：两个参数由前端面板驱动（graphToPrompt 注入），widget 隐藏
                "变量取值": ("STRING", {"default": "{}",
                                     "tooltip": "命名槽/属性标签取值 {\"名称\":\"值\"}，抽中卡片里的 #名称# 与 {名称:选项} 固定替换"}),
                "锁定卡片": ("STRING", {"default": "[]",
                                     "tooltip": "锁定的卡片 id 列表：锁定卡必含，其余名额从未锁定候选中随机抽取"}),
                # v3.45：标签筛选由前端面板驱动（graphToPrompt 注入），widget 隐藏
                "标签筛选": ("STRING", {"default": "[]",
                                        "tooltip": "标签筛选 JSON 数组 [\"标签\"]，命中任一标签的卡参与抽卡；[] = 全部"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("正提示词", "负提示词")
    CATEGORY = "AllBuy/提示词库"
    FUNCTION = "execute"
    SEARCH_ALIASES = ["随机抽卡", "抽卡", "random draw"]

    @classmethod
    def IS_CHANGED(cls, 库, 数量, 随机种子, 分隔符, 分类筛选="[]", 前缀="", 后缀="",
                   变量取值="{}", 锁定卡片="[]", 标签筛选="[]", **kwargs):
        # 库/数量/种子/分类组合/标签筛选/分隔符/锁定集/变量取值均为确定值，相同输入可缓存复用；
        # 仅前后缀含通配符 {a|b} 时需每次执行重新抽取
        try:
            if merger.has_wildcards(前缀 or "", 后缀 or ""):
                return ("wildcard", secrets.token_hex(8))
        except Exception:
            pass
        # 库内容签名纳入键：固定 seed 复用上次种子时，改了库里的组也要重新抽（v3.32 教训）
        return (_library_content_sig(random_draw.resolve_locator(库)),
                数量, 随机种子, 分隔符, 分类筛选, 前缀, 后缀, 变量取值, 锁定卡片, 标签筛选)

    @staticmethod
    def _parse_json(s, default):
        """容错解析前端注入的 JSON 字符串（锁定集 / 变量取值），失败返回默认值。"""
        if isinstance(s, (list, dict)):
            return s
        try:
            v = json.loads(s if s else default)
            return v if isinstance(v, type(default)) else default
        except Exception:
            return default

    def execute(self, 库, 数量, 随机种子, 分隔符, 分类筛选="[]", 前缀="", 后缀="",
                变量取值="{}", 锁定卡片="[]", 标签筛选="[]", **kwargs):
        # 抽卡逻辑统一走 random_draw.draw，节点执行与前端 /draw 预览共用，保证预览 = 执行
        res = random_draw.draw(
            库, 数量, 随机种子, 分隔符, 分类筛选, 前缀, 后缀,
            locked_ids=self._parse_json(锁定卡片, []),
            vars=self._parse_json(变量取值, {}),
            filter_tags=标签筛选,
        )
        return (res["positive"], res["negative"])


NODE_CLASS_MAPPINGS = {
    "PromptLibrary": PromptLibrary,
    "PromptRandomDraw": PromptRandomDraw,
    # v3.47 旧类名别名：老工作流按原名反序列化，保留映射才能加载执行（菜单里不重复展示，
    # 因为显示名相同会被 ComfyUI 去重/覆盖——保留 display 映射仅为旧工作流标题不丢）
    "VideoPromptLibrary": PromptLibrary,
    "VideoPromptRandomDraw": PromptRandomDraw,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptLibrary": "提示词库",
    "PromptRandomDraw": "随机抽卡",
    "VideoPromptLibrary": "提示词库",
    "VideoPromptRandomDraw": "随机抽卡",
}
