"""常量定义。"""
import os

EXTENSION_NAME = "ComfyUI-AllBuy_PromptLibrary"
EXTENSION_FOLDER = os.path.dirname(os.path.abspath(__file__))
BUILTIN_LIBRARIES_FOLDER = os.path.join(EXTENSION_FOLDER, "libraries")

# 插件版本（前端 videoprompt_library.js 的 PLUGIN_VERSION 必须与此一致；
# 前端通过 /allbuy_promptlibrary/version 接口对比，不一致说明后端未重启到新版）
PLUGIN_VERSION = "v3.62"

API_PREFIX = "/allbuy_promptlibrary"

DEFAULT_LIBRARY_NAME = "default"
DEFAULT_SEPARATOR = ", "

# 分隔符可选项（前端下拉用）
SEPARATOR_PRESETS = [
    {"label": "逗号 + 空格 (, )", "value": ", "},
    {"label": "换行 (\\n)", "value": "\n"},
    {"label": "句号 (. )", "value": ". "},
    {"label": "分号 (; )", "value": "; "},
    {"label": "空格 ( )", "value": " "},
]

DEFAULT_CATEGORY = "未分类"

# 新建库的初始数据
def make_empty_library(name="新建库"):
    return {
        "version": 1,
        "name": name,
        "groups": [],
    }
