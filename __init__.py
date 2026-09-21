"""ComfyUI-AllBuy_PromptLibrary 入口。"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .batch_image_node import NODE_CLASS_MAPPINGS as BATCH_NODE_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as BATCH_DISPLAY_MAPPINGS
from .media_asset import NODE_CLASS_MAPPINGS as MEDIA_NODE_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as MEDIA_DISPLAY_MAPPINGS
from .lora_stack_node import NODE_CLASS_MAPPINGS as LORA_NODE_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as LORA_DISPLAY_MAPPINGS
from .image_compare_node import NODE_CLASS_MAPPINGS as COMPARE_NODE_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as COMPARE_DISPLAY_MAPPINGS
from . import constants, library_store, api  # noqa: F401  导入 api 即注册 HTTP 路由

WEB_DIRECTORY = "./web"

# 合并批量选图节点映射
NODE_CLASS_MAPPINGS.update(BATCH_NODE_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(BATCH_DISPLAY_MAPPINGS)

# 合并素材加载节点映射（v3.54）
NODE_CLASS_MAPPINGS.update(MEDIA_NODE_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(MEDIA_DISPLAY_MAPPINGS)

# 合并 LoRA 堆栈节点映射（新增节点，未提升 PLUGIN_VERSION：不改动 videoprompt_library.js）
NODE_CLASS_MAPPINGS.update(LORA_NODE_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(LORA_DISPLAY_MAPPINGS)

# 合并 A/B 图像对比节点映射（新增节点，未提升 PLUGIN_VERSION）
NODE_CLASS_MAPPINGS.update(COMPARE_NODE_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(COMPARE_DISPLAY_MAPPINGS)

# 启动时确保用户库目录存在，并在首次启动时复制内置示例库到用户目录
try:
    library_store.get_user_libraries_folder()
    library_store.ensure_default_library()
    print("[AllBuy_PromptLibrary] 已加载，用户库目录："
          + library_store.get_user_libraries_folder())
except Exception as e:  # noqa: BLE001
    print(f"[AllBuy_PromptLibrary] 初始化用户库失败：{e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
