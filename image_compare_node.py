"""AllBuy-A/B 图像对比节点：双图（含 batch）对比预览。

- OUTPUT_NODE：把 image_a / image_b 分别以固定前缀保存，回传 ui.a_images / ui.b_images
  供前端画布分割对比（batch 一次存 N 张，前端按页码翻页）
- auto_output=True 且图存在 → 透传原图；否则 ExecutionBlocker(None)（不阻断下游执行）
- 依赖（nodes.PreviewImage / ExecutionBlocker）惰性导入，无 ComfyUI 环境可单测纯逻辑
"""
from __future__ import annotations


def _preview_image_cls():
    from nodes import PreviewImage
    return PreviewImage


def _execution_blocker_cls():
    from comfy_execution.graph import ExecutionBlocker
    return ExecutionBlocker


class AllBuyABCompare:
    """AllBuy-A/B 图像对比：滑杆分割 + 尺寸徽标 + 批量翻页，透传输出。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "auto_output": (
                    "BOOLEAN",
                    {"default": True, "label_on": "on", "label_off": "off"},
                ),
                "image_a": ("IMAGE",),
                "image_b": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("图片A", "图片B")
    FUNCTION = "preview"
    OUTPUT_NODE = True
    CATEGORY = "AllBuy/图像工具"
    SEARCH_ALIASES = ["图像对比", "A/B对比", "ab对比", "image compare", "AB preview"]

    def preview(self, auto_output=True, image_a=None, image_b=None, prompt=None,
                extra_pnginfo=None):
        PreviewImage = _preview_image_cls()
        ExecutionBlocker = _execution_blocker_cls()
        saver = PreviewImage()
        result = {"a_images": [], "b_images": []}
        if image_a is not None:
            a_ui = saver.save_images(
                image_a, filename_prefix="AllBuyCompare_A", prompt=prompt,
                extra_pnginfo=extra_pnginfo)
            result["a_images"] = a_ui["ui"]["images"]
        if image_b is not None:
            b_ui = saver.save_images(
                image_b, filename_prefix="AllBuyCompare_B", prompt=prompt,
                extra_pnginfo=extra_pnginfo)
            result["b_images"] = b_ui["ui"]["images"]
        # auto_output 统一门控两路透传；任一为 None → 阻断符，不污染下游
        out_a = image_a if (auto_output and image_a is not None) else ExecutionBlocker(None)
        out_b = image_b if (auto_output and image_b is not None) else ExecutionBlocker(None)
        return {"ui": result, "result": (out_a, out_b)}


NODE_CLASS_MAPPINGS = {
    "AllBuyABCompare": AllBuyABCompare,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AllBuyABCompare": "AllBuy-A/B 图像对比",
}
