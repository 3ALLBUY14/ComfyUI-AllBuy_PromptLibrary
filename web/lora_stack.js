// AllBuy-LoRA 堆栈面板（P2 · 修复重复面板）
//   顶栏：模型类型三段式（Checkpoint/UNET/GGUF）+ 模型选择 .vpl-dd + 分组管理按钮；
//         GGUF 时浮出高级参数折叠区（dequant/patch/patch_on_device）。
//   LoRA 列表：玻璃卡行 —— 拖拽排序把手 / 胶囊滑钮开关 / 收藏星 / 名称(树状选择器) /
//         权重滑杆+数值徽标 / ⚙(min/max+触发词) / 🗑。
//   选择器：自定义分组(我的收藏等) 分区 + 全部文件可折叠文件树；搜索按完整路径过滤。
//   底栏：启用计数 + 触发词实时汇总（截断、点击复制）。
//   状态机：node._stackEntries ↔ stack_json widget 单一事实源（防抖 120ms 写回）。
//
//   【防重复面板】nodeCreated / onNodeCreated / setup() / onConfigure 四个入口都可能
//   在节点创建瞬间并发触发 attach()；旧版 attach 先 await 再设置 _aloraWidget，守卫
//   失效导致同一节点挂载多个 DOM 面板（截图：一个节点出现 4 个重复面板）。
//   P2 修复：attach 开头同步设置 _aloraAttaching 标记（try/finally 保证异常也复位），
//   只有第一个调用真正执行挂载，其余直接 return。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installBypassSync, installExecutionLock } from "./panel_guard.js";

const NODE_NAME = "AllBuyLoRAStack";
// 版本日志：与 videoprompt_library.js/batch_image_selector.js 同款，用户贴控制台即可核对前端新旧
console.info("[AllBuy_PromptLibrary] LoRA 堆栈前端已加载 v3.83");
const API = "/allbuy_promptlibrary";
const STACK_MIN_WIDTH = 560;
const STACK_BOTTOM_GAP = 18; // 节点色底缝（测容器+18，与 videoprompt/batch/media 三兄弟一致）
const STACK_MAX_CHROME = 300;     // domWidget.y 异常钳制：正常 = 标题+输出槽，被撑大时按钳制值兜底
const STACK_FALLBACK_CHROME = 96; // 首帧 domWidget.y 未就绪时的兜底 chrome
const STACK_MIN_TOTAL_H = 200;    // 空态最小总高，防测量跑飞
const DEFAULT_WEIGHT = 1;
const DEFAULT_WEIGHT_MIN = -3;
const DEFAULT_WEIGHT_MAX = 3;
const WEIGHT_STEP = 0.01;
const WEIGHT_DIGITS = 2;
const STACK_WRITE_DELAY = 120;
const OPTIONS_TTL = 5000;
const FAV_GROUP = "我的收藏";
const HIDDEN_WIDGETS = [
  "模型类型", "ckpt_name", "unet_name", "gguf_name",
  "lora_picker", "stack_json",
  "weight_dtype", "gguf_dequant_dtype", "gguf_patch_dtype", "gguf_patch_on_device",
];

let cachedObjectInfo = null;
let cachedObjectInfoAt = 0;
let pendingObjectInfo = null;
let cachedGroups = { groups: [] };

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

function setWidget(widget, value) {
  if (!widget) return;
  widget.value = value;
  try {
    if (typeof widget.callback === "function") widget.callback(value, app.canvas, widget.node || null);
  } catch (_) {}
}

function hideAllWidgets(node) {
  for (const w of node.widgets || []) {
    if (!HIDDEN_WIDGETS.includes(w.name)) continue;
    w.options = w.options || {};
    w.options.hidden = true;
    w.options.collapsed = true;
    w.hidden = true;
    w.type = "converted-widget";
    w.computeSize = () => [0, -4];
    w.draw = () => {};
  }
  node.graph?.setDirtyCanvas?.(true, true);
  app?.canvas?.setDirty?.(true, true);
}

function stopGraph(el) {
  el.classList.add("alora-control");
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("touchstart", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---------------------------------------------------------------------------
// 选项与分组（/object_info + /lora_groups，TTL 缓存，失败静默保留旧值）
// ---------------------------------------------------------------------------
async function getObjectInfo() {
  const now = Date.now();
  if (cachedObjectInfo && now - cachedObjectInfoAt <= OPTIONS_TTL) return cachedObjectInfo;
  pendingObjectInfo = pendingObjectInfo || api.fetchApi(`/object_info/${NODE_NAME}`)
    .then(async (res) => {
      if (!res.ok) return null;
      const info = await res.json();
      return info?.[NODE_NAME] || null;
    })
    .finally(() => { pendingObjectInfo = null; });
  const fresh = await pendingObjectInfo;
  if (fresh) {
    cachedObjectInfo = fresh;
    cachedObjectInfoAt = Date.now();
  }
  return cachedObjectInfo;
}

function optionList(info, key) {
  const def = info?.input?.required?.[key] || info?.input?.optional?.[key];
  const arr = Array.isArray(def) && Array.isArray(def[0]) ? def[0] : null;
  return arr && arr.length ? arr : null;
}

async function getModelOptions(type) {
  const info = await getObjectInfo();
  const key = type === "Checkpoint" ? "ckpt_name"
    : type === "GGUF" ? "gguf_name" : "unet_name";
  return optionList(info, key) || ["None"];
}

async function getLoraOptions() {
  const info = await getObjectInfo();
  return optionList(info, "lora_picker") || ["None"];
}

async function loadGroups() {
  try {
    const res = await fetch(API + "/lora_groups");
    const d = await res.json();
    if (d && Array.isArray(d.groups)) cachedGroups = d;
  } catch (_) { /* 失败保留旧值 */ }
  return cachedGroups;
}

async function saveGroups(groups) {
  const res = await fetch(API + "/lora_groups/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { groups } }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.ok === false) throw new Error(d.error || "HTTP " + res.status);
  cachedGroups = d;
  return d;
}

function favGroup(groups) {
  return groups.find((g) => g.name === FAV_GROUP);
}

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------
function readStack(node) {
  try {
    const raw = findWidget(node, "stack_json")?.value || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeStack(node) {
  clearPendingStackWrite(node);
  const serializable = (node._stackEntries || []).map(({ _editingRange, ...rest }) => rest);
  setWidget(findWidget(node, "stack_json"), JSON.stringify(serializable));
}

function scheduleWriteStack(node, delay = STACK_WRITE_DELAY) {
  clearPendingStackWrite(node);
  node._stackWriteTimer = setTimeout(() => {
    node._stackWriteTimer = null;
    writeStack(node);
  }, delay);
}

function clearPendingStackWrite(node) {
  if (!node?._stackWriteTimer) return;
  clearTimeout(node._stackWriteTimer);
  node._stackWriteTimer = null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function roundedWeight(v) {
  const f = 10 ** WEIGHT_DIGITS;
  return Math.round(Number(v || 0) * f) / f;
}
function formatWeight(v) { return Number(v || 0).toFixed(WEIGHT_DIGITS); }
function shortLoraName(name) {
  if (!name || name === "None") return name || "None";
  const file = String(name).split(/[\\/]/).pop() || String(name);
  return file.replace(/\.(safetensors|ckpt|pt|pth|gguf)$/i, "");
}
function loraDir(name) {
  const idx = String(name).lastIndexOf("/");
  return idx > 0 ? String(name).slice(0, idx) : "";
}

function uid() { return "a-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function defaultEntry() {
  return {
    id: uid(),
    name: "None",
    weight: DEFAULT_WEIGHT,
    min: DEFAULT_WEIGHT_MIN,
    max: DEFAULT_WEIGHT_MAX,
    enabled: true,
    trigger: "",
  };
}

// ---------------------------------------------------------------------------
// 选择器：树状分级 + 自定义分组
// ---------------------------------------------------------------------------
function buildTree(loras) {
  const root = { dirs: {}, files: [] };
  for (const name of loras) {
    const parts = name.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      node = node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] };
    }
    node.files.push(name);
  }
  return root;
}

function renderTreeNode(container, node, depth, expandedMap, onPick) {
  const dirNames = Object.keys(node.dirs).sort();
  for (const dirName of dirNames) {
    const row = document.createElement("div");
    row.className = "alora-node alora-dir";
    row.style.paddingLeft = (10 + depth * 16) + "px";
    stopGraph(row);
    const chevron = document.createElement("span");
    chevron.className = "alora-chevron";
    chevron.textContent = expandedMap.has(dirName) ? "▾" : "▸";
    const label = document.createElement("span");
    label.className = "alora-dir-name";
    label.textContent = dirName;
    const count = document.createElement("span");
    count.className = "alora-path";
    row.append(chevron, label, count);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expandedMap.has(dirName)) expandedMap.delete(dirName);
      else expandedMap.add(dirName);
      container.replaceChildren();
      renderTreeNode(container, node, depth, expandedMap, onPick);
    });
    container.appendChild(row);
    if (expandedMap.has(dirName)) {
      const child = document.createElement("div");
      child.className = "alora-tree-children";
      container.appendChild(child);
      renderTreeNode(child, node.dirs[dirName], depth + 1, expandedMap, onPick);
    }
  }
  const files = node.files.sort();
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "alora-node alora-file";
    row.style.paddingLeft = (10 + depth * 16) + "px";
    stopGraph(row);
    const dot = document.createElement("span");
    dot.className = "alora-dot";
    const label = document.createElement("span");
    label.className = "alora-file-name";
    label.textContent = shortLoraName(file);
    label.title = file;
    const path = document.createElement("span");
    path.className = "alora-path";
    path.textContent = loraDir(file) || "LoRA 根目录";
    row.append(dot, label, path);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(file);
    });
    container.appendChild(row);
  }
}

function showLoraPicker(node, anchor, entry) {
  const pop = document.createElement("div");
  pop.className = "alora-pop";
  document.body.appendChild(pop);

  const search = document.createElement("input");
  search.className = "alora-pop-search";
  search.placeholder = "搜索 LoRA 名称或路径…";
  search.type = "text";
  stopGraph(search);
  pop.appendChild(search);

  const list = document.createElement("div");
  list.className = "alora-pop-list";
  pop.appendChild(list);

  const render = () => {
    list.replaceChildren();
    const query = (search.value || "").trim().toLowerCase();
    const groups = cachedGroups.groups || [];
    const allLoras = node._loraOptions || [];

    const pick = (name) => {
      entry.name = name;
      writeStack(node);
      renderStack(node);
      close();
    };

    if (!query) {
      for (const g of groups) {
        const members = g.loras || [];
        if (!members.length) continue;
        const head = document.createElement("div");
        head.className = "alora-grp-head";
        head.textContent = (g.name === FAV_GROUP ? "★ " : "📁 ") + g.name;
        head.title = g.name;
        list.appendChild(head);
        for (const name of members) {
          if (!allLoras.includes(name)) continue;
          const row = document.createElement("div");
          row.className = "alora-node alora-file";
          stopGraph(row);
          const dot = document.createElement("span");
          dot.className = "alora-dot fav";
          const label = document.createElement("span");
          label.className = "alora-file-name";
          label.textContent = shortLoraName(name);
          label.title = name;
          const path = document.createElement("span");
          path.className = "alora-path";
          path.textContent = loraDir(name) || "LoRA 根目录";
          row.append(dot, label, path);
          row.addEventListener("click", (e) => { e.stopPropagation(); pick(name); });
          list.appendChild(row);
        }
      }
      // 已被任意分组（含收藏）收录的文件不再重复进下方树：分组区已列出，重复只添噪
      const grouped = new Set();
      for (const g of groups) for (const n of (g.loras || [])) grouped.add(n);
      const free = allLoras.filter((n) => !grouped.has(n));
      if (free.length) {
        const headAll = document.createElement("div");
        headAll.className = "alora-grp-head";
        headAll.textContent = groups.some((g) => (g.loras || []).length) ? "🗂 未分组文件" : "🗂 全部文件";
        list.appendChild(headAll);
        const treeBox = document.createElement("div");
        list.appendChild(treeBox);
        renderTreeNode(treeBox, buildTree(free), 0, new Set(), pick);
      }
    } else {
      const hits = allLoras.filter((n) => n.toLowerCase().includes(query));
      if (!hits.length) {
        const empty = document.createElement("div");
        empty.className = "alora-pop-empty";
        empty.textContent = "未找到匹配的 LoRA";
        list.appendChild(empty);
      } else {
        for (const name of hits.slice(0, 200)) {
          const row = document.createElement("div");
          row.className = "alora-node alora-file";
          stopGraph(row);
          const dot = document.createElement("span");
          dot.className = "alora-dot";
          const label = document.createElement("span");
          label.className = "alora-file-name";
          label.textContent = shortLoraName(name);
          label.title = name;
          const path = document.createElement("span");
          path.className = "alora-path";
          path.textContent = loraDir(name) || "LoRA 根目录";
          row.append(dot, label, path);
          row.addEventListener("click", (e) => { e.stopPropagation(); pick(name); });
          list.appendChild(row);
        }
      }
    }
  };

  const position = () => {
    const r = anchor.getBoundingClientRect();
    const w = Math.max(420, Math.min(520, window.innerWidth - 16));
    pop.style.left = Math.min(r.left, window.innerWidth - w - 8) + "px";
    pop.style.top = (r.bottom + 4) + "px";
    pop.style.width = w + "px";
  };

  const close = () => {
    document.removeEventListener("mousedown", onDocDown);
    document.removeEventListener("keydown", onKey, true);
    pop.remove();
    node._aloraPickerClose = null;
    node._aloraPickerAnchor = null;
  };
  const onDocDown = (e) => {
    if (!pop.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  render();
  position();
  requestAnimationFrame(position);
  // 关闭监听必须挂冒泡阶段：挂捕获会在"再点一次名称按钮"时先于按钮触发（先关旧弹层、
  // click 又立刻开新的），表现为菜单永远收不起来；行内元素的 stopGraph 拦冒泡正好保护弹层内点击
  document.addEventListener("mousedown", onDocDown);
  document.addEventListener("keydown", onKey, true);
  node._aloraPickerClose = close;
  node._aloraPickerAnchor = anchor;
  search.focus();
}

// ---------------------------------------------------------------------------
// 面板渲染
// ---------------------------------------------------------------------------
function makeBtn(label, title, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title || label;
  b.className = "vpl-btn " + cls;
  stopGraph(b);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function makeIconBtn(html, title, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  b.className = "vpl-icon-btn " + cls;
  b.innerHTML = html;
  stopGraph(b);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function createDropdown(options, current, onChange, cls = "") {
  const wrap = document.createElement("div");
  wrap.className = "vpl-dd " + cls;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "vpl-dd-trigger";
  const label = document.createElement("span");
  label.className = "vpl-dd-label";
  const arrow = document.createElement("span");
  arrow.className = "vpl-dd-arrow";
  arrow.textContent = "▾";
  trigger.append(label, arrow);
  const panel = document.createElement("div");
  panel.className = "vpl-dd-panel";
  wrap.append(trigger, panel);
  stopGraph(wrap);

  const refresh = (opts, cur) => {
    label.textContent = cur || "请选择";
    label.title = cur || "";
    panel.replaceChildren();
    for (const opt of opts) {
      const item = document.createElement("div");
      item.className = "vpl-dd-item" + (opt === cur ? " vpl-dd-item-active" : "");
      const main = document.createElement("span");
      main.className = "vpl-dd-item-main";
      main.textContent = opt;
      main.title = opt;
      item.appendChild(main);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        // 选中后刷新按钮文字与高亮项，否则看起来"选了没生效"
        label.textContent = opt;
        label.title = opt;
        panel.querySelectorAll(".vpl-dd-item-active").forEach((n) => n.classList.remove("vpl-dd-item-active"));
        item.classList.add("vpl-dd-item-active");
        onChange(opt);
      });
      panel.appendChild(item);
    }
  };

  // 开合必须显式改 display：.vpl-dd-panel 基态 display:none，只切 class 列表永远出不来
  //（videoprompt_library.js 同款组件的 open() 就是这么做的）
  const setOpen = (open) => {
    wrap.classList.toggle("vpl-dd-open", open);
    if (open) {
      panel.style.display = "block";
      requestAnimationFrame(() => panel.classList.add("vpl-dd-panel-visible"));
    } else {
      panel.classList.remove("vpl-dd-panel-visible");
      setTimeout(() => { if (!wrap.classList.contains("vpl-dd-open")) panel.style.display = "none"; }, 160);
    }
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!wrap.classList.contains("vpl-dd-open"));
  });
  const onDocDown = (e) => {
    if (!wrap.contains(e.target)) setOpen(false);
  };
  document.addEventListener("mousedown", onDocDown);

  refresh(options || [], current);
  // destroy：节点删除时由 onRemoved 调用。document 级监听不摘会随节点数累积，
  // 且闭包经 wrap→onChange 强持有整棵面板 DOM 与 node 本体（showLoraPicker 同款配对移除）
  return { el: wrap, refresh, destroy: () => document.removeEventListener("mousedown", onDocDown) };
}

function renderStack(node) {
  const list = node._stackList;
  if (!list) return;
  list.replaceChildren();
  const entries = node._stackEntries || [];
  const options = node._loraOptions || [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.id) entry.id = uid();
    if (entry.min == null) entry.min = DEFAULT_WEIGHT_MIN;
    if (entry.max == null) entry.max = DEFAULT_WEIGHT_MAX;
    if (entry.weight == null) entry.weight = 0;
    if (entry.enabled == null) entry.enabled = true;
    if (entry.trigger == null) entry.trigger = "";
    entry.weight = clamp(roundedWeight(entry.weight), Number(entry.min), Number(entry.max));

    const row = document.createElement("div");
    row.className = "alora-row" + (entry.enabled ? "" : " off");
    row.dataset.id = entry.id;
    const isFav = favGroup(cachedGroups.groups)?.loras?.includes(entry.name) || false;

    // 拖拽把手
    const handle = document.createElement("div");
    handle.className = "vpl-drag-handle";
    handle.textContent = "⋮⋮";
    handle.title = "拖动排序";
    handle.draggable = true;
    stopGraph(handle);
    row.appendChild(handle);

    // 胶囊开关
    const toggle = document.createElement("div");
    toggle.className = "alora-toggle" + (entry.enabled ? "" : " off");
    toggle.title = entry.enabled ? "点击停用" : "点击启用";
    stopGraph(toggle);
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      entry.enabled = !entry.enabled;
      writeStack(node);
      renderStack(node);
    });
    row.appendChild(toggle);

    // 收藏星
    const star = makeIconBtn(
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="' + (isFav ? "currentColor" : "none") +
      '" stroke="currentColor" stroke-width="2"><path d="M12 2.5l2.9 6.2 6.6.8-4.9 4.5 1.3 6.5L12 17.3 6.1 20.5l1.3-6.5L2.5 9.5l6.6-.8z"/></svg>',
      isFav ? "从「我的收藏」移除" : "加入「我的收藏」",
      async () => {
        if (!entry.name || entry.name === "None") return;
        const groups = cachedGroups.groups || [];
        const fav = favGroup(groups) || { id: "_fav", name: FAV_GROUP, loras: [] };
        if (!groups.includes(fav)) groups.unshift(fav);
        fav.loras = (fav.loras || []).filter((n) => n !== entry.name);
        if (!isFav) fav.loras.push(entry.name);
        try { await saveGroups(groups); } catch (_) {}
        renderStack(node);
      },
      isFav ? "alora-star on" : "alora-star",
    );
    row.appendChild(star);

    // 名称（点击弹树状选择器）
    const nameWrap = document.createElement("div");
    nameWrap.className = "alora-namewrap";
    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "alora-name-btn";
    nameBtn.textContent = shortLoraName(entry.name);
    nameBtn.title = entry.name === "None" ? "点击选择 LoRA" : entry.name;
    stopGraph(nameBtn);
    nameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!node._loraOptions?.length) return;
      // 开着时再点=开合切换：同一行收起，另一行换锚点重开（点按钮收不起来的根治）
      if (node._aloraPickerClose) {
        const sameRow = node._aloraPickerAnchor === nameBtn;
        node._aloraPickerClose();
        if (sameRow) return;
      }
      showLoraPicker(node, nameBtn, entry);
    });
    nameWrap.appendChild(nameBtn);
    row.appendChild(nameWrap);

    // 权重滑杆 + 数值
    const sliderWrap = document.createElement("div");
    sliderWrap.className = "alora-slider";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(entry.min);
    slider.max = String(entry.max);
    slider.step = String(WEIGHT_STEP);
    slider.value = String(entry.weight);
    slider.disabled = !entry.enabled;
    stopGraph(slider);
    const val = document.createElement("span");
    val.className = "alora-val";
    val.textContent = formatWeight(entry.weight);
    // 强度微调钮：±0.05 步进（滑块拖动难停在 0.05 档位上，按钮点得准）
    const nudgeWeight = (d) => {
      entry.weight = clamp(roundedWeight(entry.weight + d), Number(entry.min), Number(entry.max));
      slider.value = String(entry.weight);
      val.textContent = formatWeight(entry.weight);
      writeStack(node);
    };
    const minusBtn = makeIconBtn(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 12h14"/></svg>',
      "强度 −0.05", () => nudgeWeight(-0.05), "alora-nudge",
    );
    const plusBtn = makeIconBtn(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M12 5v14M5 12h14"/></svg>',
      "强度 +0.05", () => nudgeWeight(0.05), "alora-nudge",
    );
    minusBtn.disabled = plusBtn.disabled = !entry.enabled;
    slider.addEventListener("input", () => {
      entry.weight = roundedWeight(slider.value);
      val.textContent = formatWeight(entry.weight);
      scheduleWriteStack(node);
    });
    slider.addEventListener("change", () => writeStack(node));
    sliderWrap.append(slider, minusBtn, val, plusBtn);
    row.appendChild(sliderWrap);

    // ⚙ / 🗑
    const acts = document.createElement("div");
    acts.className = "alora-rowacts";
    const gear = makeIconBtn(
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 14.6H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6h.1a2 2 0 1 1 4 0h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 .3 1.8 1.6 1.6 0 0 0 1.8.3h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.1 2.7z"/></svg>',
      entry._editingRange ? "收起范围/触发词" : "展开范围/触发词",
      () => {
        entry._editingRange = !entry._editingRange;
        for (const it of entries) if (it !== entry) it._editingRange = false;
        writeStack(node);
        renderStack(node);
      },
      entry._editingRange ? "alora-gear on" : "alora-gear",
    );
    const del = makeIconBtn(
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
      "删除该 LoRA",
      () => {
        const idx = entries.findIndex((x) => x.id === entry.id);
        if (idx >= 0) entries.splice(idx, 1);
        writeStack(node);
        renderStack(node);
      },
      "vpl-icon-danger",
    );
    acts.append(gear, del);
    row.appendChild(acts);

    list.appendChild(row);

    // 展开行：min/max + 触发词
    if (entry._editingRange) {
      const rangeRow = document.createElement("div");
      rangeRow.className = "alora-range-row";
      const mkNum = (val, title, onInput) => {
        const input = document.createElement("input");
        input.type = "number";
        input.step = String(WEIGHT_STEP);
        input.value = formatWeight(val);
        input.title = title;
        input.className = "vpl-input alora-num";
        stopGraph(input);
        input.addEventListener("change", () => onInput(Number(input.value)));
        return input;
      };
      const minInput = mkNum(entry.min, "权重最小值", (v) => {
        if (!Number.isFinite(v)) return;
        entry.min = roundedWeight(v);
        if (entry.max <= entry.min) entry.max = roundedWeight(entry.min + 0.01);
        entry.weight = clamp(entry.weight, entry.min, entry.max);
        writeStack(node);
        renderStack(node);
      });
      const maxInput = mkNum(entry.max, "权重最大值", (v) => {
        if (!Number.isFinite(v) || v <= entry.min) return;
        entry.max = roundedWeight(v);
        entry.weight = clamp(entry.weight, entry.min, entry.max);
        writeStack(node);
        renderStack(node);
      });
      const trig = document.createElement("input");
      trig.type = "text";
      trig.className = "vpl-input alora-trigger";
      trig.value = entry.trigger || "";
      trig.placeholder = "触发词（输出到「触发词」口）";
      trig.title = "触发词";
      stopGraph(trig);
      trig.addEventListener("input", () => {
        entry.trigger = trig.value;
        scheduleWriteStack(node);
        updateFooter(node);
      });
      trig.addEventListener("change", () => {
        entry.trigger = trig.value.trim();
        trig.value = entry.trigger;
        writeStack(node);
        updateFooter(node);
      });
      // 粘贴按钮：读剪贴板直接填入；读不到（权限/空剪贴板）时聚焦输入框退化成手动 Ctrl+V
      const pasteSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 10v7"/><path d="m8.5 13.5 3.5 3.5 3.5-3.5"/></svg>';
      const trigPaste = makeIconBtn(pasteSvg, "粘贴触发词", async () => {
        let text = null;
        try { text = await navigator.clipboard.readText(); } catch (_) {}
        if (text && text.trim()) {
          entry.trigger = text.trim();
          trig.value = entry.trigger;
          writeStack(node);
          updateFooter(node);
          trigPaste.innerHTML = "✓";
          setTimeout(() => { trigPaste.innerHTML = pasteSvg; }, 1200);
        } else {
          trig.focus();
        }
      }, "alora-trig-paste");
      const minL = document.createElement("span");
      minL.className = "alora-range-label";
      minL.textContent = "最小";
      const maxL = document.createElement("span");
      maxL.className = "alora-range-label";
      maxL.textContent = "最大";
      rangeRow.append(minL, minInput, maxL, maxInput, trig, trigPaste);
      list.appendChild(rangeRow);
    }
  }
  updateFooter(node);
  recalcStackHeight(node);
}

function updateFooter(node) {
  if (!node._stackFooterCount) return;
  const entries = node._stackEntries || [];
  const enabled = entries.filter((e) => e.enabled).length;
  node._stackFooterCount.textContent = `${enabled} 个 LoRA 已启用`;
  const words = entries
    .filter((e) => e.enabled && e.trigger && e.trigger.trim())
    .map((e) => e.trigger.trim());
  const dedupe = [];
  const seen = new Set();
  for (const w of words) {
    const k = w.toLocaleLowerCase();
    if (!seen.has(k)) { seen.add(k); dedupe.push(w); }
  }
  const text = dedupe.join(", ");
  node._stackFooterTrig.textContent = text || "（未填写触发词）";
  node._stackFooterTrig.title = text || "未填写触发词";
}

// ---------------------------------------------------------------------------
// 分组管理弹窗
// ---------------------------------------------------------------------------
function showGroupManager(node) {
  const overlay = document.createElement("div");
  overlay.className = "vpl-overlay alora-grp-overlay";
  document.body.appendChild(overlay);

  const dialog = document.createElement("div");
  dialog.className = "vpl-dialog";
  dialog.style.maxWidth = "680px";
  overlay.appendChild(dialog);

  const title = document.createElement("div");
  title.className = "vpl-dialog-title";
  title.innerHTML = "<span>LoRA 自定义分组</span>";
  const closeBtn = makeIconBtn("✕", "关闭", () => overlay.remove());
  title.appendChild(closeBtn);
  dialog.appendChild(title);

  const body = document.createElement("div");
  body.className = "vpl-dialog-body";
  dialog.appendChild(body);

  const groups = (cachedGroups.groups || []).map((g) => ({ ...g, loras: [...(g.loras || [])] }));
  let activeId = groups[0]?.id || null;
  const rowById = new Map(); // 分组卡片行：选中态/计数原地更新，不重建列表（防点击闪烁、保滚动位置）

  const groupList = document.createElement("div");
  groupList.className = "vpl-list alora-grp-list";

  const memberArea = document.createElement("div");
  memberArea.className = "alora-grp-members";
  body.append(groupList, memberArea);

  const renderMembers = (group) => {
    memberArea.replaceChildren();
    if (!group) {
      const hint = document.createElement("div");
      hint.className = "vpl-empty";
      hint.textContent = "选择左侧分组以编辑成员";
      memberArea.appendChild(hint);
      return;
    }
    const head = document.createElement("div");
    head.className = "alora-grp-member-head";
    head.textContent = group.name + "（" + group.loras.length + "）";
    memberArea.appendChild(head);

    const search = document.createElement("input");
    search.type = "text";
    search.className = "vpl-input";
    search.placeholder = "搜索 LoRA 加入分组…";
    search.style.marginBottom = "6px";
    stopGraph(search);
    memberArea.appendChild(search);

    const chips = document.createElement("div");
    chips.className = "vpl-chip-list";
    memberArea.appendChild(chips);
    const renderChips = () => {
      chips.replaceChildren();
      const q = (search.value || "").toLowerCase();
      // 与选择器文件树同约定：已被其他分组（含收藏）收录的文件不再列为候选，
      // 防止同一文件进多个组；但本组成员即便与其他组重复（旧版/收藏星/API 产生的
      // 跨组数据）也照常显示、可点击移出，否则它会在所有组视图里消失成死角
      const inOther = new Set();
      for (const g of groups) {
        if (g.id === group.id) continue;
        for (const n of (g.loras || [])) inOther.add(n);
      }
      const all = (node._loraOptions || []).filter(
        (n) => n.toLowerCase().includes(q) && (!inOther.has(n) || group.loras.includes(n)),
      );
      for (const name of all.slice(0, 120)) {
        const inGroup = group.loras.includes(name);
        const chip = document.createElement("span");
        chip.className = "vpl-chip vpl-chip-click" + (inGroup ? " vpl-chip-on" : "");
        chip.textContent = shortLoraName(name);
        chip.title = name;
        stopGraph(chip);
        chip.addEventListener("click", () => {
          // 原地更新：不重建列表/芯片网格（防点击闪烁、保滚动位置）。
          // 例外：移出后若仍属其他分组（跨组旧数据），按过滤口径它不再是本组候选，须从视图消失
          if (inGroup) {
            group.loras = group.loras.filter((n) => n !== name);
            if (inOther.has(name)) chip.remove();
            else chip.classList.remove("vpl-chip-on");
          } else {
            group.loras.push(name);
            chip.classList.add("vpl-chip-on");
          }
          const cnt = rowById.get(group.id)?.querySelector(".vpl-item-cat");
          if (cnt) cnt.textContent = String(group.loras.length);
          head.textContent = group.name + "（" + group.loras.length + "）";
        });
        chips.appendChild(chip);
      }
    };
    search.addEventListener("input", renderChips);
    renderChips();
  };

  const renderList = () => {
    groupList.replaceChildren();
    rowById.clear();
    for (const g of groups) {
      const row = document.createElement("div");
      row.className = "vpl-item" + (g.id === activeId ? " vpl-item-selected" : "");
      stopGraph(row);
      const name = document.createElement("span");
      name.className = "vpl-item-name";
      name.textContent = (g.name === FAV_GROUP ? "★ " : "") + g.name;
      name.title = g.name;
      const count = document.createElement("span");
      count.className = "vpl-item-cat";
      count.textContent = String(g.loras.length);
      const actions = document.createElement("span");
      actions.className = "vpl-item-actions";
      if (g.name !== FAV_GROUP) {
        const rename = makeIconBtn(
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
          "重命名",
          () => {
            const nn = window.prompt("新分组名", g.name);
            if (nn && nn.trim()) {
              g.name = nn.trim();
              saveGroups(groups).then(() => { renderList(); renderMembers(g); });
            }
          },
        );
        const del = makeIconBtn(
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
          "删除分组",
          () => {
            const idx = groups.findIndex((x) => x.id === g.id);
            if (idx >= 0) groups.splice(idx, 1);
            if (activeId === g.id) activeId = groups[0]?.id || null;
            saveGroups(groups).then(() => {
              renderList();
              renderMembers(groups.find((x) => x.id === activeId) || null);
            });
          },
          "vpl-icon-danger",
        );
        actions.append(rename, del);
      }
      row.append(name, count, actions);
      rowById.set(g.id, row);
      row.addEventListener("click", () => {
        if (activeId === g.id) return; // 重复点击已选组：短路，保住成员区已输入的搜索词
        activeId = g.id;
        // 原地切换选中类：不重建列表（防闪、保滚动位置，过渡在既有元素上平滑播放）
        for (const [id, el] of rowById) el.classList.toggle("vpl-item-selected", id === activeId);
        renderMembers(g);
      });
      groupList.appendChild(row);
    }
    const addBtn = makeBtn("＋ 新建分组", "新建分组", async () => {
      const nn = window.prompt("分组名", "");
      if (nn && nn.trim()) {
        groups.push({ id: uid(), name: nn.trim(), loras: [] });
        activeId = groups[groups.length - 1].id;
        await saveGroups(groups);
        renderList();
        renderMembers(groups.find((x) => x.id === activeId) || null);
      }
    }, "vpl-new-group");
    groupList.appendChild(addBtn);
  };

  const footer = document.createElement("div");
  footer.className = "vpl-dialog-footer";
  const doneBtn = makeBtn("完成", "保存并关闭", async () => {
    try { await saveGroups(groups); } catch (_) {}
    overlay.remove();
    renderStack(node);
  }, "vpl-btn-primary");
  footer.appendChild(doneBtn);
  dialog.appendChild(footer);

  renderList();
  renderMembers(groups.find((g) => g.id === activeId) || groups[0] || null);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ---------------------------------------------------------------------------
// 节点挂载
// ---------------------------------------------------------------------------
function stackPanelHeight(node) {
  // 量外层容器（.vpl-node，含自身 22px 上下 padding 与执行锁条）而非内层 panel，
  // 否则节点总高比 DOM 实际所需短一个 padding——三个兄弟节点均测容器（同款配方）
  const panel = node?._stackContainer;
  const host = panel?.parentElement || panel;
  const measured = Math.ceil(host?.scrollHeight || host?.offsetHeight || 0);
  return measured || 120;
}

// ---- 高度管理（media_asset_loader 同款三件套：缓存驱动，双向收缩）----
// DOM widget computeSize 已让位为 [0,-4]，节点高度完全由 _aloraCachedH 决定：
// rAF 合并实测面板内容高 → 写缓存 → setSize 跟随（放大且缩小，相等即跳过防循环）。
function stackChromeH(node) {
  const y = node?._aloraWidget && typeof node._aloraWidget.y === "number" ? node._aloraWidget.y : 0;
  if (y <= 0) return STACK_FALLBACK_CHROME;
  return Math.min(y, STACK_MAX_CHROME);
}

function recalcStackHeight(node) {
  if (!node || typeof node.setSize !== "function" || node._aloraHeightPending) return;
  node._aloraHeightPending = true;
  requestAnimationFrame(() => {
    node._aloraHeightPending = false;
    const panel = node?._stackContainer;
    if (!panel?.isConnected) return;
    // 测量用 height:auto（wrapper 被 [0,-4] 归零后 h-full 会把容器连带压成 0，
    // rect/scrollHeight 全读不到——media_asset_loader L1495 同款"先 auto 测再写回 px"）
    // 面板显式高度必须写【面板自身】的自然高：写容器实测值会把容器 22px 上下
    // padding 也灌进面板，面板比内容高 22px，恰好顶穿 18px 底缝（用户报的"底部撑出边界"）
    const prevH = panel.style.height;
    panel.style.height = "auto";
    // 开着的下拉浮层是绝对定位、会计入 scrollHeight，测量前先临时藏掉（同步完成，不产生可见闪烁）
    const pops = panel.querySelectorAll(".vpl-dd-panel");
    const savedDisplay = [];
    for (const p of pops) { savedDisplay.push(p.style.display); if (p.style.display === "block") p.style.display = "none"; }
    const panelH = Math.ceil(panel.scrollHeight);
    const contentH = stackPanelHeight(node); // 容器实测（含 12+10 padding），节点总高按它算
    panel.style.height = panelH > 0 ? panelH + "px" : prevH;
    for (let i = 0; i < pops.length; i++) pops[i].style.display = savedDisplay[i];
    if (contentH <= 0) return;
    node._aloraCachedH = Math.max(STACK_MIN_TOTAL_H, contentH + stackChromeH(node) + STACK_BOTTOM_GAP);
    const width = node.size?.[0] > 0 ? node.size[0] : STACK_MIN_WIDTH;
    if (node.size?.[1] === node._aloraCachedH) return;
    node.setSize([width, node._aloraCachedH]);
    node.graph?.setDirtyCanvas?.(true, true);
    app?.canvas?.setDirty?.(true, true);
  });
}

async function attach(node) {
  // 【防重复面板】同步抢占：多个入口并发调用时只有第一个真正挂载
  if (node._aloraWidget) return;
  if (node._aloraAttaching) return;
  node._aloraAttaching = true;
  try {
    hideAllWidgets(node);
    node._stackEntries = readStack(node);
    node._modelType = findWidget(node, "模型类型")?.value || "UNET";
    node._loraOptions = await getLoraOptions();

    const container = document.createElement("div");
    container.className = "vpl-node alora-node";
    container.style.cssText = "pointer-events:none;";
    installBypassSync(node, container);
    installExecutionLock(node, container);
    // 容器事件穿透后，panel_guard 的「解锁编辑」条需单独恢复交互
    requestAnimationFrame(() => {
      container.querySelector(".vpl-exec-bar")?.classList.add("alora-control");
    });

    const panel = document.createElement("div");
    panel.className = "alora-panel";
    node._stackContainer = panel;

    // ---- 顶栏 ----
    const tbar = document.createElement("div");
    tbar.className = "alora-tbar";

    const seg = document.createElement("div");
    seg.className = "alora-seg";
    const currentModelName = () => {
      const key = node._modelType === "Checkpoint" ? "ckpt_name"
        : node._modelType === "GGUF" ? "gguf_name" : "unet_name";
      return findWidget(node, key)?.value || "None";
    };
    ["Checkpoint", "UNET", "GGUF"].forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t;
      b.dataset.t = t;
      b.className = t === node._modelType ? "on" : "";
      stopGraph(b);
      b.addEventListener("click", async () => {
        if (node._modelType === t) return;
        node._modelType = t;
        setWidget(findWidget(node, "模型类型"), t);
        seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.t === t));
        modelDD.refresh(await getModelOptions(t), currentModelName());
        advWrap.style.display = t === "GGUF" ? "" : "none";
        renderStack(node);
      });
      seg.appendChild(b);
    });
    tbar.appendChild(seg);

    // 本节点创建的全部下拉（模型 1 枚 + GGUF 参数 2 枚）：onRemoved 时逐个 destroy
    const dropdowns = [];
    let modelDD = null;
    modelDD = createDropdown(await getModelOptions(node._modelType), currentModelName(),
      async (opt) => {
        const key = node._modelType === "Checkpoint" ? "ckpt_name"
          : node._modelType === "GGUF" ? "gguf_name" : "unet_name";
        setWidget(findWidget(node, key), opt);
      }, "alora-model-dd");
    dropdowns.push(modelDD);
    tbar.appendChild(modelDD.el);

    const grpBtn = makeIconBtn(
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
      "LoRA 分组管理",
      () => showGroupManager(node),
      "alora-groups-btn",
    );
    tbar.appendChild(grpBtn);
    panel.appendChild(tbar);

    // ---- GGUF 高级参数折叠区 ----
    const advWrap = document.createElement("div");
    advWrap.className = "vpl-advanced alora-adv";
    advWrap.style.display = node._modelType === "GGUF" ? "" : "none";
    const advHead = document.createElement("div");
    advHead.className = "alora-adv-head";
    advHead.textContent = "GGUF 高级参数";
    const advBody = document.createElement("div");
    advBody.className = "alora-adv-body";
    const ggufKeys = [
      ["gguf_dequant_dtype", "反量化类型"],
      ["gguf_patch_dtype", "补丁类型"],
    ];
    for (const [key, label] of ggufKeys) {
      const w = findWidget(node, key);
      const opts = w?.options?.values || ["default"];
      const dd = createDropdown(opts, w?.value || "default", (v) => setWidget(w, v));
      dropdowns.push(dd);
      const cell = document.createElement("div");
      cell.className = "alora-adv-cell";
      const lbl = document.createElement("span");
      lbl.className = "alora-range-label";
      lbl.textContent = label;
      cell.append(lbl, dd.el);
      advBody.appendChild(cell);
    }
    const pod = findWidget(node, "gguf_patch_on_device");
    const podLabel = document.createElement("label");
    podLabel.className = "vpl-check-row";
    podLabel.style.margin = "0";
    const podCheck = document.createElement("input");
    podCheck.type = "checkbox";
    podCheck.className = "vpl-checkbox";
    podCheck.checked = Boolean(pod?.value);
    stopGraph(podCheck);
    podCheck.addEventListener("change", () => setWidget(pod, podCheck.checked));
    podLabel.append(podCheck, document.createTextNode("补丁就地执行（patch_on_device）"));
    advBody.appendChild(podLabel);
    advWrap.append(advHead, advBody);
    panel.appendChild(advWrap);

    // ---- LoRA 列表 + 操作行 ----
    const listHead = document.createElement("div");
    listHead.className = "alora-list-head";
    const listTitle = document.createElement("span");
    listTitle.className = "alora-list-title";
    listTitle.textContent = "LoRA 堆栈";
    const addBtn = makeBtn("＋ 添加 LoRA", "添加一条 LoRA", () => {
      node._stackEntries.push(defaultEntry());
      writeStack(node);
      renderStack(node);
    }, "vpl-btn-primary alora-add");
    const invertBtn = makeBtn("全部反选", "反转所有 LoRA 启用状态", () => {
      for (const e of node._stackEntries || []) e.enabled = !e.enabled;
      writeStack(node);
      renderStack(node);
    });
    listHead.append(listTitle, invertBtn, addBtn);
    panel.appendChild(listHead);

    const list = document.createElement("div");
    list.className = "alora-list";
    // 容器须恢复交互：面板链路 pointer-events:none 做画布穿透，列表本体不标记
    // 则其滚动条拖不动（滚轮靠行冒泡能滚、滑块点击穿透到画布）
    stopGraph(list);
    node._stackList = list;
    panel.appendChild(list);

    // 拖拽排序（事件委托）
    list.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".alora-row");
      if (!row) return;
      node._stackDraggingId = row.dataset.id;
      row.classList.add("alora-dragging");
      e.dataTransfer.setData("text/plain", row.dataset.id);
      e.dataTransfer.effectAllowed = "move";
    });
    list.addEventListener("dragend", (e) => {
      e.target.closest(".alora-row")?.classList.remove("alora-dragging");
      list.querySelectorAll(".alora-drop-before,.alora-drop-after").forEach((r) => r.classList.remove("alora-drop-before", "alora-drop-after"));
      node._stackDraggingId = null;
    });
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      const row = e.target.closest(".alora-row");
      if (!row || row.dataset.id === node._stackDraggingId) return;
      list.querySelectorAll(".alora-drop-before,.alora-drop-after").forEach((r) => r.classList.remove("alora-drop-before", "alora-drop-after"));
      const rect = row.getBoundingClientRect();
      row.classList.add(e.clientY < rect.top + rect.height / 2 ? "alora-drop-before" : "alora-drop-after");
      node._dropTarget = { id: row.dataset.id, after: e.clientY >= rect.top + rect.height / 2 };
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData("text/plain");
      const entries = node._stackEntries;
      const from = entries.findIndex((x) => x.id === fromId);
      const target = node._dropTarget;
      if (from < 0 || !target) return;
      let to = entries.findIndex((x) => x.id === target.id);
      const [moved] = entries.splice(from, 1);
      if (from < to) to -= 1;
      if (target.after) to += 1;
      if (from === to) { entries.splice(from, 0, moved); }
      else entries.splice(to, 0, moved);
      writeStack(node);
      renderStack(node);
    });

    // ---- 底栏 ----
    const foot = document.createElement("div");
    foot.className = "vpl-footer alora-foot";
    const count = document.createElement("span");
    count.className = "vpl-count";
    node._stackFooterCount = count;
    const trig = document.createElement("span");
    trig.className = "alora-trig-summary";
    trig.title = "点击复制触发词";
    node._stackFooterTrig = trig;
    stopGraph(trig);
    // 文字点击与右侧复制按钮共用一条复制链路（空态占位开头是"（"、
    // 反馈窗口内自身文案"✓ 已复制"均忽略，防连点把反馈写进剪贴板/钉死底栏）
    const copyTrig = async () => {
      const text = trig.textContent;
      if (!text || text.startsWith("（") || text === "✓ 已复制") return;
      try {
        await navigator.clipboard.writeText(text);
        // 还原用进入时捕获的 text：await 挂起期间重读可能拿到刚设的反馈文案
        trig.textContent = "✓ 已复制";
        setTimeout(() => { trig.textContent = text; }, 1200);
      } catch (_) {}
    };
    trig.addEventListener("click", (e) => {
      e.stopPropagation();
      copyTrig();
    });
    const trigCopyBtn = makeIconBtn(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
      "复制触发词",
      () => copyTrig(),
      "alora-trig-copy",
    );
    foot.append(count, trig, trigCopyBtn);
    panel.appendChild(foot);

    container.appendChild(panel);

    const widget = node.addDOMWidget("alora_panel", "stack", container, {
      serialize: false,
      hideOnZoom: false,
      getMinWidth: () => 0,
      getMinHeight: () => 0,
    });
    node._aloraWidget = widget;
    widget.minWidth = 0;
    // media_asset_loader 同款三件套之一：DOM widget 让位（[0,-4] 不占高度），
    // 节点高度改由下方 node.computeSize 返回 _aloraCachedH 缓存 + recalcStackHeight 主动 setSize
    widget.computeSize = () => [0, -4];
    if (!node._aloraCachedH) node._aloraCachedH = STACK_MIN_TOTAL_H;
    node.computeSize = function (out) {
      out = out || [0, 0];
      // 固定最小宽度，不引用 node.size[0]：否则拉宽后这里的 minWidth 同步变大，
      // resize 手柄向左拖窄会被前端逐帧钳回（videoprompt_library.js v3.26 同款教训）
      out[0] = STACK_MIN_WIDTH;
      out[1] = node._aloraCachedH;
      return out;
    };
    // 挂载初期布局未稳（字体/滚动条/前端补算），多时点收敛；内容变化再由 ResizeObserver 兜底
    [60, 250, 600].forEach((t) => setTimeout(() => recalcStackHeight(node), t));
    const ro = new ResizeObserver(() => recalcStackHeight(node));
    ro.observe(container);
    node._aloraRO = ro; // onRemoved 时 disconnect，observe 滞留会钉住容器 DOM
    node._aloraDropdowns = dropdowns;
    // 离屏/后台页挂载时 widget.y 未就绪，chrome 只能固化兜底值 96；首次被画布绘制后
    // y 落定 → 在此触发重算修正（对齐 media_asset_loader 的绘制钩子写法）
    const _prevDrawBG = node.onDrawBackground;
    node.onDrawBackground = function () {
      const r = _prevDrawBG ? _prevDrawBG.apply(this, arguments) : undefined;
      if (node.flags && node.flags.collapsed) return r;
      if (widget.y !== node._aloraLastY) {
        node._aloraLastY = widget.y;
        recalcStackHeight(node);
      }
      return r;
    };
    const markWrapper = () => {
      const wrapper = container.closest(".dom-widget");
      if (!wrapper) return;
      wrapper.classList.add("alora-fit-widget");
      if (wrapper.style.width === "100%") wrapper.style.width = "";
      if (wrapper.style.maxWidth === "100%") wrapper.style.maxWidth = "";
      wrapper.style.boxSizing = "border-box";
      // 不设 overflow:hidden：wrapper 高度被前端归 0（computeSize [0,-4]），面板内容
      // 靠自身显式高度从这里自然溢出呈现，hidden 会把整个面板裁没（media 同款不加）
    };
    markWrapper();
    requestAnimationFrame(markWrapper);

    renderStack(node);
    loadGroups().then(() => renderStack(node));
  } finally {
    node._aloraAttaching = false;
  }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
app.registerExtension({
  name: "AllBuy.LoRAStack",
  async setup() {
    setTimeout(() => {
      for (const node of app?.graph?._nodes || []) {
        if (node?.type === NODE_NAME || node?.comfyClass === NODE_NAME) {
          hideAllWidgets(node);
          attach(node);
        }
      }
    }, 500);
  },
  async nodeCreated(node) {
    if (node?.type !== NODE_NAME && node?.comfyClass !== NODE_NAME) return;
    hideAllWidgets(node);
    attach(node);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      if (onCreated) onCreated.apply(this, arguments);
      hideAllWidgets(this);
      attach(this);
      setTimeout(() => hideAllWidgets(this), 0);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      if (onConfigure) onConfigure.apply(this, arguments);
      setTimeout(() => {
        hideAllWidgets(this);
        if (!this._aloraWidget && !this._aloraAttaching) attach(this);
        this._stackEntries = readStack(this);
        renderStack(this);
        hideAllWidgets(this);
      }, 0);
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      clearPendingStackWrite(this);
      try { this._aloraPickerClose?.(); } catch (_) {}
      // 摘掉各下拉的 document mousedown 监听与高度 ResizeObserver：
      // 否则节点删除后监听/观察器仍强持有整棵面板 DOM，长驻页面反复增删节点逐次泄漏
      for (const dd of this._aloraDropdowns || []) { try { dd.destroy?.(); } catch (_) {} }
      this._aloraDropdowns = null;
      try { this._aloraRO?.disconnect(); } catch (_) {}
      this._aloraRO = null;
      if (onRemoved) onRemoved.apply(this, arguments);
    };
  },
});
