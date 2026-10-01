# ComfyUI-AllBuy_PromptLibrary

ComfyUI 提示词与素材管理全家桶：7 个配套节点，覆盖**提示词库勾选合并、随机抽卡、批量选图映射、图/音/视频素材加载、LoRA 堆栈、A/B 图像对比、大段文本编辑**。全部节点使用统一的自绘面板，支持执行锁定、旁路变暗、调色隔离。

## 节点总览

| 节点 | 输出 | 用途 |
|---|---|---|
| **AllBuy-提示词库** | 正/负提示词 | 把提示词存为卡片，勾选即生效，多组按顺序合并输出 |
| **AllBuy-随机抽卡** | 正/负提示词 | 从库随机抽 N 张合并，seed 可复现，适合找组合灵感 |
| **AllBuy-批量选图** | 图片 / 正/负提示词 / 映射 JSON | 图片 ↔ 提示词组双向映射，输出图片 batch 与对应提示词 |
| **AllBuy-素材加载（图/音/视频）** | 图片 / 遮罩 / 视频帧 / 视频音频 / 帧率 / 帧计数 / 视频信息 / 音频 | 拖入即持久化的素材库：图片裁剪与遮罩编辑、视频选区抽帧、音频波形裁剪 |
| **AllBuy-LoRA 堆栈** | 模型 / CLIP / VAE / 触发词 | 一个节点完成底模加载（Checkpoint/UNET/GGUF）+ 多 LoRA 堆栈 |
| **AllBuy-A/B 图像对比** | 图片 A / 图片 B | 拖分割线对比两图，批量输入可翻页，选中侧直接输出 |
| **AllBuy-文本框** | 提示词 / 提示词行（列表） | 大段提示词编辑：替换表、去空行、撤销重做、与提示词库互转入库 |

## 安装

方式一：克隆到 ComfyUI 的 `custom_nodes/` 目录后重启：

```
ComfyUI/custom_nodes/ComfyUI-AllBuy_PromptLibrary/
```

方式二：ComfyUI-Manager → Install via Git URL 填入本仓库地址。

## 快速上手

1. 双击画布，搜索节点中文名（如「提示词库」「LoRA 堆栈」）添加节点。
2. **提示词库**：点「＋ 新建提示词组」录入内容 → 勾选卡片即生效，拖 ⋮⋮ 调整合并顺序 → 正/负提示词接到文本编码节点。
3. **素材加载**：拖文件进面板（或 Ctrl+V）即入库 `input/allbuy_media/`；图片可多选排 batch，视频/音频在 ⚙ 里选区。
4. **LoRA 堆栈**：选底模类型与模型 → 添加 LoRA 行，选文件、调权重、填触发词 → 「模型/CLIP/VAE」三口接下游。

## 提示词库核心机制

以下机制适用于提示词库 / 随机抽卡 / 批量选图 / 文本框插入。

**三种库来源**

- 📦 内置库（插件自带示例，只读）
- 🗂 用户库（`ComfyUI/user/allbuy_promptlibrary/`，全局共享，可增删改）
- 📎 内嵌库（JSON 导入，数据随工作流保存，便于分发）

**合并规则**

1. 勾选卡片按已选顺序排列；
2. 每段拼成 `prefix + 正文 + suffix`，权重 ≠ 1 时包裹 `(text:w)`；
3. 用分隔符连接（逗号+空格 / 换行 / 句号 / 分号 / 自定义）；
4. 前置文本 + 合并结果 + 后置文本；
5. 负向提示词走同样流程（不附加前置/后置）。

**通配符 `{a|b|c}`**

卡片正文 / 前后缀 / 前置后置文本均支持，每次执行随机选一项，支持嵌套（如 `{small {red|blue}|big}`）。主节点每次出队重新抽取；需要可复现结果用**随机抽卡**（seed 固定 = 结果固定），或 footer 🎲 固定种子。

**库文件格式**（用户库 JSON，可手编，保存时自动 `.backup`）

```json
{
  "version": 1,
  "name": "我的库",
  "groups": [
    {
      "id": "g-xxxx",
      "name": "电影感慢推镜头",
      "category": "镜头运动",
      "positive": "Cinematic slow dolly-in, 35mm anamorphic lens ...",
      "negative": "shaky cam, fast cuts ...",
      "note": "备注",
      "color": "#4A90D9",
      "weight": 1.0,
      "prefix": "",
      "suffix": "",
      "tags": ["电影感", "推镜"],
      "cover": ""
    }
  ]
}
```

## 各节点要点

**素材加载**：四种入料（拖入 / 文件选择 / 文件夹 / Ctrl+V），持久化到 `input/allbuy_media/`；图片/音频/视频三 Tab 浏览。图片 ⚙ 框选裁剪 + 画笔遮罩（遮罩口与 batch 逐张对齐）；视频 ⚙ 选区抽帧（目标帧率/帧上限实时预览）；音频 ⚙ 波形选区裁剪；支持导出 PNG / MP4 / WAV。

**LoRA 堆栈**：Checkpoint / UNET / GGUF 三种底模（GGUF 需装 ComfyUI-GGUF，带反量化等高级参数）。每行 LoRA 可调权重范围、微调钮、触发词（底栏实时汇总一键复制）、启用开关、拖拽排序。支持自定义分组（我的收藏 ★ 等，分组管理与整组导入导出），选择器按目录树浏览、记住上次位置；堆栈预设可导入导出 JSON。

**A/B 图像对比**：拖分割线对比，悬停跟随模式可免按住；批量输入按页翻看（单侧批量自动前后帧配对）；「自动输出」关闭时可手动选侧再输出。

**批量选图**：文件夹/图片多选映射到提示词组，挂组管理；输出图片 batch + 按图合并的提示词 + 映射 JSON，适合 LoRA 训练集或成套出图。

**文本框**：大段文本编辑（宽软换行、行数统计）；每行 `旧=新` 的替换表按序应用；去空行开关；@素材名 转为 image1..10 文本标记；入库/从库插入（记住上次库与组）；撤销/重做/历史快照。

## 通用面板特性

- **执行锁定**：队列执行期间面板只读并显示状态条，可手动解锁；
- **旁路同步**：节点静音/旁路（Ctrl+M）时面板同步变暗标注；
- **调色隔离**：右键调色只影响节点框，不染内部 UI；
- **高度自适应**：面板随节点拖高填充、拖矮钳回内容下限；
- **版本握手**：footer 显示版本号，前后端版本不一致时控制台与 footer 提示（后端改完记得重启）。

## 开发

```
ComfyUI-AllBuy_PromptLibrary/
├── __init__.py               # 入口、节点注册
├── nodes.py                  # 提示词库/随机抽卡节点
├── random_draw.py            # 抽卡逻辑
├── batch_image_node.py       # 批量选图节点
├── media_asset.py            # 素材加载节点
├── lora_stack_node.py        # LoRA 堆栈节点
├── image_compare_node.py     # A/B 对比节点
├── textbox_node.py           # 文本框节点
├── library_store.py          # 库文件 CRUD
├── lora_groups_store.py      # LoRA 分组存储
├── merger.py                 # 合并逻辑（纯函数）
├── api.py                    # HTTP API
├── cover.py / constants.py
├── libraries/                # 内置示例库
├── examples/                 # 4 条示例工作流
├── tests/                    # pytest 测试套件
└── web/                      # 前端（原生 ESM，无构建）
    ├── videoprompt_library.js    # 主库面板
    ├── batch_image_selector.js   # 批量选图面板
    ├── media_asset_loader.js     # 素材加载面板
    ├── lora_stack.js             # LoRA 堆栈面板
    ├── image_compare.js          # A/B 对比
    ├── textbox_node.js           # 文本框面板
    ├── editor_dialog.js          # 卡片编辑弹窗
    ├── preview_dialog.js         # 预览弹窗
    ├── panel_guard.js            # 共享：锁定/旁路/填充高度
    └── style.css
```

跑测试（在插件根目录）：

```
python -m pytest tests/
```

改 `web/*.js` 前端逻辑时需同步递增 `constants.py` 与 `videoprompt_library.js` 的 `PLUGIN_VERSION` 强刷浏览器缓存；改 Python 后需重启 ComfyUI。

## 版本

当前 **v3.127**。完整变更见[提交历史](https://github.com/3ALLBUY14/ComfyUI-AllBuy_PromptLibrary/commits/main)。

## 许可

MIT
