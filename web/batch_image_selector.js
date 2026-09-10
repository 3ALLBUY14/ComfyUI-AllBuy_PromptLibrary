// 批量选图节点前端：图↔提示词双向映射 GUI
import { app } from "../../scripts/app.js";
import { installBypassSync, installExecutionLock } from "./panel_guard.js";

const API = "/allbuy_promptlibrary";
const NODE_NAME = "BatchImagePromptSelector";
const NODE_WIDTH = 480;
const PLUGIN_VERSION = "bips3.10";
const MIN_THUMB = 88; // 缩略图最小尺寸下限（渲染/上传/持久化强制约束）

// ---------------------------------------------------------------------------
// 注入样式表（复用主插件的 style.css，追加 .bips-* 类）
// ---------------------------------------------------------------------------
(function injectStyle() {
  if (document.getElementById("bips-style-link")) return;
  const link = document.createElement("link");
  link.id = "bips-style-link";
  link.rel = "stylesheet";
  link.type = "text/css";
  try {
    link.href = new URL("./style.css?v=" + PLUGIN_VERSION, import.meta.url).href;
  } catch (e) {
    link.href = "/extensions/ComfyUI-AllBuy_PromptLibrary/style.css?v=" + PLUGIN_VERSION;
  }
  document.head.appendChild(link);
})();

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "html") el.innerHTML = v;
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children ?? []).flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.appendChild(
      typeof c === "string" || typeof c === "number"
        ? document.createTextNode(String(c))
        : c
    );
  }
  return el;
}

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  drag: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

function iconButton(svg, title, onClick, opts = {}) {
  const btn = h("button", {
    class: "bips-icon-btn" + (opts.danger ? " bips-danger" : "") + (opts.active ? " bips-btn-active" : ""),
    title,
    type: "button",
    onclick: (e) => { e.stopPropagation(); onClick?.(e); },
  });
  btn.innerHTML = svg;
  return btn;
}

async function apiGet(path) {
  const r = await fetch(API + path);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

function imgUrl(abs, w) {
  let u = API + "/image?path=" + encodeURIComponent(abs || "");
  if (w && w > 0) u += "&w=" + w;
  return u;
}
function uid() {
  return "b" + Math.random().toString(36).slice(2, 10);
}

const GROUPBY_LABEL = { none: "不分组", category: "按分类", group: "按分组" };
const SORT_LABEL = { custom: "排序:自定义", name: "排序:名称", time: "排序:时间" };

// ===========================================================================
// 控制器
// ===========================================================================
function attachController(node) {
  const need = ["映射数据", "库数据"];
  const ready = () => node.widgets && need.every((n) => node.widgets.some((w) => w.name === n));
  if (ready()) { startController(node); return; }
  let tries = 0;
  const tick = () => {
    tries++;
    if (ready() || tries >= 60) startController(node);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function startController(node) {
  if (node._bipsAttached) return;
  node._bipsAttached = true;

  const wMapping = node.widgets?.find((w) => w.name === "映射数据");
  const wLibraryData = node.widgets?.find((w) => w.name === "库数据");
  const storage = [wMapping, wLibraryData].filter(Boolean);
  storage.forEach(hideWidget);
  if (node.widgets && storage.length) {
    node.widgets = node.widgets.filter((w) => !storage.includes(w));
  }

  node._bipsInputs = function () {
    return {
      映射数据: wMapping ? wMapping.value : "{}",
      库数据: wLibraryData ? wLibraryData.value : "",
    };
  };

  // ---- 状态 ----
  const state = {
    folder: "",
    images: [],          // [{file, abs, w, h, mtime, category, group, order}]
    links: [],           // [{abs, gid}]
    mode: "image_to_prompts", // 旧字段，仅随 mapping_json 写出保兼容；不再有模式切换
    libraryLocator: null,
    libraryGroups: [],   // [{id, name, positive, negative}]
    categories: [],      // 库内 group.category 去重枚举，供分类下拉
    groupNames: [],      // 库内 group.name 去重枚举，供分组下拉
    dlSeq: 0,            // datalist 唯一 id 计数器
    thumbnailSize: 96,
    view: "grid",        // grid | masonry（瀑布流）
    sortBy: "custom",    // custom（拖拽自定义）| name（名称）| time（时间，新→旧）
    groupBy: "none",     // none | category | group
    collapsed: new Set(),
    assocCollapsed: true, // 按组映射面板默认折叠（卡片上的组 chips 已可见）
    bulkMode: false,
    bulkSel: new Set(),
    search: "",
    dragAbs: null,
    root: "",
    recentFolders: [],   // v3.53.1：最近使用的目录（去重、新→旧，≤6 条，随 _bips 持久化）
  };

  const container = h("div", { class: "bips-node vpl-node" });
  container.style.setProperty("--bips-size", Math.max(MIN_THUMB, state.thumbnailSize || MIN_THUMB) + "px");
  const els = {};

  // ---- 工具栏（就地构建，handler 全部在闭包内可用）----
  // 注：不再有"图→提示词 / 提示词→图"模式切换——那只是同一份映射的两种视角，
  // 包装成"模式"造成了"数据互相串通"的误解。现在两个视角常驻同步。
  const toolbar = h("div", { class: "bips-toolbar" });
  els.folderInput = h("input", { class: "bips-folder-input", type: "text", placeholder: "图片目录（input 下相对路径或绝对路径）",
    onchange: (e) => applyFolder(e.target.value) });
  els.browseBtn = iconButton(ICONS.folder, "自由选择图片目录（可输入任意路径 / 最近使用 / input 子目录速选）", openFolderPicker);
  els.reloadBtn = h("button", { class: "bips-btn", type: "button", title: "重新扫描", onclick: () => loadImages() }, ["刷新"]);
  const sizeWrap = h("div", { class: "bips-size" }, [h("span", {}, ["缩略图"])]);
  els.thumbRange = h("input", { type: "range", min: String(MIN_THUMB), max: "256", step: "8", value: String(state.thumbnailSize),
    oninput: (e) => { state.thumbnailSize = Math.max(MIN_THUMB, parseInt(e.target.value, 10) || MIN_THUMB); els.thumbVal.textContent = state.thumbnailSize + "px"; container.style.setProperty("--bips-size", state.thumbnailSize + "px"); } });
  els.thumbVal = h("span", { class: "bips-size-val" }, [state.thumbnailSize + "px"]);
  sizeWrap.appendChild(els.thumbRange);
  sizeWrap.appendChild(els.thumbVal);
  els.libBtn = h("button", { class: "bips-btn", type: "button", title: "选择提示词库", onclick: openLibraryPicker }, ["提示词库"]);
  els.viewBtn = h("button", { class: "bips-btn", type: "button", title: "切换网格 / 瀑布流布局",
    onclick: () => { state.view = state.view === "masonry" ? "grid" : "masonry"; syncToolbar(); render(); } }, ["瀑布流"]);
  els.sortBtn = h("button", { class: "bips-btn", type: "button", title: "排序方式（自定义=拖拽排序，仅自定义下可拖）",
    onclick: () => { state.sortBy = state.sortBy === "custom" ? "name" : state.sortBy === "name" ? "time" : "custom"; syncToolbar(); render(); } },
    [SORT_LABEL.custom]);
  els.groupByBtn = h("button", { class: "bips-btn", type: "button", title: "分组方式", onclick: cycleGroupBy }, [GROUPBY_LABEL.none]);
  els.bulkBtn = h("button", { class: "bips-btn", type: "button", title: "批量勾选与归类", onclick: () => { state.bulkMode = !state.bulkMode; if (!state.bulkMode) state.bulkSel.clear(); syncToolbar(); render(); } }, ["批量"]);
  els.searchInput = h("input", { class: "bips-search", type: "text", placeholder: "搜索文件名/分类/组",
    oninput: (e) => { state.search = e.target.value.trim(); render(); } });
  toolbar.append(els.folderInput, els.browseBtn, els.reloadBtn, sizeWrap, els.libBtn, els.viewBtn, els.sortBtn, els.groupByBtn, els.bulkBtn, els.searchInput);
  container.appendChild(toolbar);

  els.bulkBar = h("div", { class: "bips-bulkbar", style: "display:none" });
  container.appendChild(els.bulkBar);

  // 把图片区、空态、关联面板统一包进可滚动体，限制整体高度，避免节点被无限撑长。
  els.body = h("div", { class: "bips-body" });
  els.empty = h("div", { class: "bips-empty", style: "display:none" }, ["未选择图片文件夹，或该文件夹无图片。点击上方 📁 自由选择目录：支持 ComfyUI input 相对路径或任意绝对路径。"]);
  els.grid = h("div", { class: "bips-grid" });
  els.assocPanel = h("div", { class: "bips-assoc", style: "display:none" });
  els.body.append(els.empty, els.grid);
  container.appendChild(els.body);
  // 关联面板放在可滚动体【之外】（图片区与状态栏之间，自带滚动）：
  // 放在 body 内会被多图挤到滚动区底部只剩一条缝，看起来"显示不全"
  container.appendChild(els.assocPanel);

  els.status = h("div", { class: "bips-status" });
  container.appendChild(els.status);

  // 滚轮拦截：节点内的图片区/关联区需要有自己的滚动条，
  // 但 ComfyUI 画布会在 DOM 面板上捕获 wheel 做缩放，导致无法在节点内滚动。
  // 在容器上 stopPropagation，让原生滚动生效、画布不再抢事件。
  container.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

  const domWidget = node.addDOMWidget("bips_ui", "BIPS_UI", container, {
    getValue() { return ""; },
    setValue() {},
    resize: false,
  });

  // v3.51：旁路视觉同步 + 执行期间锁定（共享模块 panel_guard.js）
  installBypassSync(node, container);
  installExecutionLock(node, container);
  // ---- 高度管理（缓存驱动，避免与 LiteGraph 尺寸调度打架）----
  //   测量与设高只在 recalcHeight（rAF + 防抖）里做一次；node.computeSize 只
  //   返回最近一次缓存的总高，绝不现场测量/reflow。LiteGraph 每帧把 computeSize
  //   当 minSize 收敛时拿到的是稳定值，不会再出现“往回缩 / 底部没包住”。
  try { domWidget.computeSize = function () { return [0, -4]; }; } catch (e) { /* ignore */ }
  try { domWidget.getMinHeight = function () { return 0; }; } catch (e) { /* ignore */ }

  const MIN_DOM_H = 160;   // 内容区空态最小高度（工具栏 + 状态栏 + 空提示）
  const MAX_DOM_H = 880;   // 仅防测量失控的安全上限；"提示词→图"模式峰值：
                           // 工具栏(~120) + 图片区(440) + 关联面板(240) + 状态栏 + gap ≈ 845
  const FALLBACK_CHROME = 96; // domWidget.y 未就绪时兜底：标题 30 + 4 个输出槽 ~56（实测 w.y=86）
  const BOTTOM_PAD = 18;   // v3.53：面板下方的节点色底缝（用户要求加宽，让节点色把面板包住；
                           // 想调缝宽只改这一个数）
  const MIN_TOTAL_H = 260; // 节点总高下限（保证标题 + 4 个输出槽 + 一行内容不被裁切）
  let _cachedTotalH = MIN_TOTAL_H; // 缓存：节点总高 = widget 顶部偏移 + 内容 + 底距

  // DOM widget 在节点内的顶部偏移：新版前端把它放在「标题 + 输出槽」之下，
  // 偏移量就记录在 domWidget.y（图坐标，随布局每帧更新）；读不到时用兜底值。
  function widgetChromeH() {
    const y = domWidget && typeof domWidget.y === "number" ? domWidget.y : 0;
    return y > 0 ? y : FALLBACK_CHROME;
  }

  // 真实内容高度：临时 height:auto + max-height:none + 强制 reflow 后读取，
  // 绕开父容器（LiteGraph DOM widget 区域）强加的高度污染；读完立即恢复。
  function measureContentH() {
    const prevH = container.style.height;
    const prevMax = container.style.maxHeight;
    container.style.height = "auto";
    container.style.maxHeight = "none";
    void container.offsetHeight; // 强制 reflow
    const h = container.scrollHeight || container.offsetHeight;
    container.style.height = prevH;
    container.style.maxHeight = prevMax;
    return Math.max(MIN_DOM_H, Math.min(h > 0 ? h : MIN_DOM_H, MAX_DOM_H));
  }

  // 只返回缓存值，不做任何测量（稳定，不与框架调度打架）
  try {
    node.computeSize = function (out) {
      out = out || [0, 0];
      out[0] = NODE_WIDTH;
      out[1] = _cachedTotalH;
      return out;
    };
  } catch (e) { /* ignore */ }
  function pruneStrayWidgets() {
    if (!node.widgets) return;
    const next = node.widgets.filter((w) => w === domWidget);
    if (next.length !== node.widgets.length) node.widgets = next;
  }
  [0, 200, 800, 1600, 3000].forEach((t) => setTimeout(pruneStrayWidgets, t));
  const ro = new ResizeObserver(() => { recalcHeight(); syncMasonryCols(); });
  ro.observe(container);
  // 瀑布流：容器宽度变化导致列数变化时重排（和 recalcHeight 一样走 rAF 节流）
  function syncMasonryCols() {
    if (state.view !== "masonry") return;
    requestAnimationFrame(() => {
      const wrap = els.grid.querySelector(".bips-cards");
      if (!wrap) return;
      const inner = Math.max(80, wrap.clientWidth - 20);
      const size = Math.max(MIN_THUMB, state.thumbnailSize);
      const target = Math.max(1, Math.floor((inner + 10) / (size + 10)));
      if (target !== wrap.querySelectorAll(".bips-mcol").length) renderGrid();
    });
  }
  let _recalcPending = false;
  function recalcHeight() {
    if (_recalcPending) return; // 防抖：ResizeObserver 与 rAF 可能同帧连跑
    _recalcPending = true;
    requestAnimationFrame(() => {
      _recalcPending = false;
      // 远缩放/节点离屏时前端会 display:none 隐藏 DOM 面板（容器高度归 0），
      // ResizeObserver 仍会触发本函数；此时测量值无意义，保持缓存高度不变，
      // 否则节点高度会被错误收缩且拉回近景后不恢复（“拉远后窗口尺寸不准”的根因）
      if (!container.isConnected || container.getBoundingClientRect().height === 0) return;
      const contentH = measureContentH();
      if (contentH <= 0) return;
      _cachedTotalH = Math.max(MIN_TOTAL_H, contentH + widgetChromeH() + BOTTOM_PAD);
      const w = node.size[0] && node.size[0] > 0 ? node.size[0] : NODE_WIDTH;
      node.setSize([w, _cachedTotalH]);
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
      if (app.canvas && typeof app.canvas.setDirty === "function") app.canvas.setDirty(true);
    });
  }

  // ---- 持久化 ----
  function save() {
    const mapping = {
      version: 1,
      folder: state.folder,
      recent_folders: (state.recentFolders || []).slice(0, 6),
      mode: state.mode,
      library_locator: state.libraryLocator,
      thumbnail_size: Math.max(MIN_THUMB, state.thumbnailSize),
      view: state.view === "masonry" ? "masonry" : "grid",
      sort_by: state.sortBy,
      images: state.images.map((im) => ({
        file: im.file, abs: im.abs, w: im.w, h: im.h, mtime: im.mtime || 0,
        category: im.category || "", group: im.group || "", order: im.order,
      })),
      links: state.links.slice(),
    };
    const json = JSON.stringify(mapping);
    if (wMapping) wMapping.value = json;
    node.properties = node.properties || {};
    node.properties._bips = json;
  }

  function loadFromSaved() {
    const saved = (node.properties && node.properties._bips) || (wMapping && wMapping.value) || "{}";
    let cfg;
    try { cfg = JSON.parse(saved); } catch { cfg = {}; }
    if (!cfg || typeof cfg !== "object") cfg = {};
    state.folder = cfg.folder || "";
    state.recentFolders = Array.isArray(cfg.recent_folders)
      ? cfg.recent_folders.filter((x) => typeof x === "string").slice(0, 6) : [];
    state.mode = cfg.mode === "prompt_to_images" ? "prompt_to_images" : "image_to_prompts";
    state.libraryLocator = cfg.library_locator || null;
    state.thumbnailSize = Math.max(MIN_THUMB, cfg.thumbnail_size || 96);
    state.view = cfg.view === "masonry" ? "masonry" : "grid";
    state.sortBy = ["name", "time"].includes(cfg.sort_by) ? cfg.sort_by : "custom";
    state.images = (cfg.images || []).map((im, i) => ({
      file: im.file, abs: im.abs, w: im.w || 0, h: im.h || 0, mtime: im.mtime || 0,
      category: im.category || "", group: im.group || "",
      order: im.order != null ? im.order : i,
    }));
    state.links = (cfg.links || []).filter((l) => l && l.abs && l.gid);
    state.groupBy = "none";
    state.collapsed = new Set();
    state.bulkSel = new Set();
    els.thumbRange.value = state.thumbnailSize;
    els.thumbVal.textContent = state.thumbnailSize + "px";
    els.folderInput.value = state.folder;
    syncToolbar();
    if (state.libraryLocator) loadLibrary(state.libraryLocator);
  }

  // ---- 数据加载 ----
  async function loadImages() {
    if (!state.folder) { render(); return; }
    try {
      const data = await apiGet("/images?folder=" + encodeURIComponent(state.folder));
      if (!data.ok) { render(); return; }
      state.root = data.root || "";
      const existing = new Map(state.images.map((im) => [im.abs, im]));
      state.images = data.images.map((im, i) => {
        const prev = existing.get(im.abs);
        return {
          file: im.name, abs: im.abs, w: im.w, h: im.h, mtime: im.mtime || 0,
          category: prev ? prev.category : "",
          group: prev ? prev.group : "",
          order: prev ? prev.order : i,
        };
      });
      const valid = new Set(state.images.map((im) => im.abs));
      state.links = state.links.filter((l) => valid.has(l.abs));
      render();
    } catch (e) {
      console.error("[BIPS] 加载图片失败", e);
      render();
    }
  }

  async function loadLibrary(locator) {
    state.libraryLocator = locator;
    if (!locator) { state.libraryGroups = []; render(); return; }
    try {
      const data = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(locator)));
      state.libraryGroups = (data.library && data.library.groups) || [];
      const _gs = state.libraryGroups;
      // v3.51：主库 v3.12 起分类是 categories 数组（编辑弹窗多选），旧字段 category 单字符串兜底
      state.categories = [...new Set(_gs.flatMap((g) => (Array.isArray(g.categories) && g.categories.length)
        ? g.categories
        : (g.category ? [g.category] : [])).filter(Boolean))];
      state.groupNames = [...new Set(_gs.map((g) => g.name).filter(Boolean))];
    } catch (e) {
      state.libraryGroups = [];
      state.categories = [];
      state.groupNames = [];
    }
    render();
  }

  // 统一入口：切换目录 + 记最近使用 + 重新扫描
  function applyFolder(f) {
    state.folder = (f || "").trim();
    els.folderInput.value = state.folder;
    state.images = [];
    state.links = [];
    // 最近使用：去重、当前置顶、最多 6 条
    state.recentFolders = [state.folder]
      .concat(state.recentFolders || [])
      .filter((x, i, arr) => typeof x === "string" && arr.indexOf(x) === i)
      .slice(0, 6);
    save();
    loadImages();
  }

  // v3.53.1：自由选目录——输入任意路径（input 相对路径或绝对路径），
  // 辅以「最近使用」与 input 子目录速选；不再是单纯的子目录菜单
  async function openFolderPicker(e) {
    let folders = [];
    try { const d = await apiGet("/folders"); folders = d.folders || []; } catch (err) {}
    const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
    const apply = (v) => { close(); applyFolder(v); };

    const overlay = h("div", { class: "bips-menu-overlay" });
    const menu = h("div", { class: "bips-menu bips-field-dialog bips-folder-dialog" });
    menu.appendChild(h("div", { class: "bips-menu-title" }, ["选择图片目录（自由路径）"]));

    const input = h("input", { class: "bips-dialog-input", type: "text",
      placeholder: "ComfyUI input 下相对路径，或任意绝对路径", value: state.folder || "", spellcheck: "false" });
    const confirmBtn = h("button", { class: "bips-btn", type: "button" }, ["确认"]);
    confirmBtn.onclick = () => apply(input.value);
    menu.appendChild(h("div", { class: "bips-dialog-input-row" }, [input, confirmBtn]));
    menu.appendChild(h("div", { class: "bips-menu-title" }, ["回车确认；路径不存在时回退到 input 根目录"]));

    const recents = (state.recentFolders || []).filter((x) => x !== (state.folder || "").trim());
    if (recents.length) {
      menu.appendChild(h("div", { class: "bips-menu-title" }, ["最近使用："]));
      recents.forEach((v) => menu.appendChild(
        h("div", { class: "bips-menu-item", onclick: () => apply(v) }, [v || "（input 根目录）"])));
    }
    if (folders.length) {
      menu.appendChild(h("div", { class: "bips-menu-title" }, ["input 子目录："]));
      const list = h("div", { class: "bips-folder-list" });
      folders.forEach((f) => list.appendChild(
        h("div", { class: "bips-menu-item", onclick: () => apply(f) }, [f])));
      menu.appendChild(list);
    }
    menu.appendChild(h("div", { class: "bips-menu-item bips-menu-clear",
      onclick: () => apply("") }, ["（留空 = input 根目录）"]));

    overlay.appendChild(menu);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); apply(input.value); }
      else if (ev.key === "Escape") close();
    });
    document.body.appendChild(overlay);
    // 子目录列表可能很长：视口居中 + 限高滚动
    menu.style.position = "fixed";
    menu.style.left = "50%";
    menu.style.top = "50%";
    menu.style.transform = "translate(-50%, -50%)";
    setTimeout(() => input.focus(), 0);
  }

  async function openLibraryPicker(e) {
    let libs = [];
    try { const d = await apiGet("/libraries"); libs = d.libraries || []; } catch (err) {}
    const items = libs.map((l) => ({
      label: (l.source === "builtin" ? "📦 " : "🗂 ") + (l.display_name || l.name) + `  (${l.count || 0})`,
      onClick: () => loadLibrary({ source: l.source, name: l.name }),
    }));
    if (!items.length) items.push({ label: "（无可用库）", onClick: () => {} });
    showMenu(items, { title: "选择提示词库", x: e && e.clientX, y: e && e.clientY });
  }

  function cycleGroupBy() {
    state.groupBy = state.groupBy === "none" ? "category" : state.groupBy === "category" ? "group" : "none";
    syncToolbar();
    render();
  }

  function syncToolbar() {
    els.groupByBtn.textContent = GROUPBY_LABEL[state.groupBy];
    els.bulkBtn.classList.toggle("bips-btn-active", state.bulkMode);
    els.viewBtn.classList.toggle("bips-btn-active", state.view === "masonry");
    els.sortBtn.textContent = SORT_LABEL[state.sortBy] || SORT_LABEL.custom;
    els.libBtn.classList.toggle("bips-btn-active", !!state.libraryLocator);
  }

  // ---- 渲染 ----
  function render() {
    renderBulkBar();
    renderGrid();
    renderAssocPanel();
    renderStatus();
    save();
    recalcHeight(); // 内部自带 rAF + 防抖（VideopromptLibrary 同款）
  }
  node._bipsRender = render;

  function renderStatus() {
    const total = state.images.length;
    // 已挂组图片数 = 链接 ∪ 分组字段（与面板/输出同一口径）
    const mapped = new Set(state.links.map((l) => l.abs));
    state.images.forEach((im) => { if ((im.group || "").trim()) mapped.add(im.abs); });
    const lib = state.libraryLocator ? (state.libraryLocator.name || "库") : "未选库";
    els.status.innerHTML = "";
    const seg = (icon, label, val) => {
      els.status.appendChild(h("span", {}, [icon + " ", h("b", {}, [String(val)]), " " + label]));
    };
    seg("🖼️", "张图", total);
    seg("🔗", "张已挂组", mapped.size);
    seg("🧩", "条挂载", state.links.length);
    seg("📚", "库", lib);
  }

  // Windows 资源管理器式自然排序：按数字块逐段比较（0.45.jpg < 0.6.jpg < 0.jpg < 1.jpg），
  // localeCompare 的 numeric collation 对扩展名里的数字会给出反直觉结果
  const natChunks = (s) => String(s).toLowerCase().match(/\d+|\D+/g) || [];
  const natCompare = (a, b) => {
    const ka = natChunks(a), kb = natChunks(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const x = ka[i], y = kb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const nx = /^\d/.test(x), ny = /^\d/.test(y);
      if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; }
      else if (nx !== ny) return nx ? -1 : 1; // 数字块排在字母块前（与资源管理器一致）
      else if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };

  function visibleImages() {
    let list = state.images.slice();
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter((im) => im.file.toLowerCase().includes(q) || (im.category || "").toLowerCase().includes(q) || (im.group || "").toLowerCase().includes(q));
    }
    if (state.sortBy === "name") {
      list.sort((a, b) => natCompare(a.file, b.file));
    } else if (state.sortBy === "time") {
      // 修改时间新→旧；无 mtime（旧后端）时退回名称序
      list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || natCompare(a.file, b.file));
    } else {
      list.sort((a, b) => a.order - b.order);
    }
    return list;
  }

  function groupKeys(list) {
    if (state.groupBy === "none") return [null];
    const key = state.groupBy === "category" ? "category" : "group";
    const set = new Set();
    list.forEach((im) => set.add((im[key] || "未分组").trim() || "未分组"));
    return Array.from(set).sort();
  }

  function renderGrid() {
    const list = visibleImages();
    els.empty.style.display = list.length ? "none" : "block";
    els.grid.innerHTML = "";
    if (!list.length) return;
    const keys = groupKeys(list);
    keys.forEach((key) => {
      const sectionImgs = key == null ? list : list.filter((im) => ((im[state.groupBy] || "未分组").trim() || "未分组") === key);
      if (!sectionImgs.length) return;
      const sec = h("div", { class: "bips-section" });
      if (key != null) {
        const collapsed = state.collapsed.has(key);
        const head = h("div", { class: "bips-sec-head" + (collapsed ? " bips-collapsed" : "") }, [
          iconButton(ICONS.chevron, "折叠/展开", () => toggleCollapse(key)),
          h("span", { class: "bips-sec-title" }, [key + "  (" + sectionImgs.length + ")"]),
        ]);
        sec.appendChild(head);
        if (collapsed) { els.grid.appendChild(sec); return; }
        makeSectionDropTarget(sec, key);
      }
      const wrap = h("div", { class: "bips-cards" + (state.view === "masonry" ? " bips-masonry" : "") });
      sec.appendChild(wrap);
      els.grid.appendChild(sec);
      if (state.view === "masonry") {
        // JS 显式分列（CSS 多列对 flex 卡片有碎片化 bug，会相互重叠）：
        // 先挂载拿到真实宽度 → 按列宽算列数 → 卡片轮转分配到各列（阅读顺序仍为左→右）
        const inner = Math.max(80, wrap.clientWidth - 20); // 减 wrap 自身 padding
        const size = Math.max(MIN_THUMB, state.thumbnailSize);
        const cols = Math.max(1, Math.floor((inner + 10) / (size + 10)));
        const colDivs = [];
        for (let i = 0; i < cols; i++) colDivs.push(h("div", { class: "bips-mcol" }));
        sectionImgs.forEach((im, i) => colDivs[i % cols].appendChild(renderCard(im)));
        colDivs.forEach((c) => wrap.appendChild(c));
      } else {
        sectionImgs.forEach((im) => wrap.appendChild(renderCard(im)));
      }
    });
  }

  function renderCard(im) {
    const size = Math.max(MIN_THUMB, state.thumbnailSize);
    const masonry = state.view === "masonry";
    const card = h("div", { class: "bips-card", "data-abs": im.abs, draggable: "true" });
    if (state.bulkSel.has(im.abs)) card.classList.add("bips-selected");

    // 网格：统一高度 cover 裁切；瀑布流：按原始宽高比占位（w/h 来自扫描元数据，
    // 不依赖图片加载，零布局抖动），比例精确时 cover 即完整显示不裁切
    const thumbStyle = masonry && im.w > 0 && im.h > 0
      ? `width:100%;aspect-ratio:${im.w} / ${im.h}`
      : "width:100%;height:var(--bips-size,96px)";
    const thumb = h("div", { class: "bips-thumb", style: thumbStyle }, [
      h("img", { src: imgUrl(im.abs, Math.min(Math.max(MIN_THUMB * 2, Math.round(size * 2)), 512)), loading: "lazy", draggable: "false",
        title: "点击查看大图", style: "cursor:zoom-in",
        onclick: (e) => {
          e.stopPropagation();
          openImagePreview(im, e.currentTarget, {
            presets: (f) => (f === "category" ? state.categories : state.groupNames),
            apply: (f, v) => { im[f] = v; reindex(); render(); },
          });
        },
        onerror: (e) => { e.target.style.display = "none"; } }),
    ]);

    const meta = h("div", { class: "bips-meta" }, [
      h("div", { class: "bips-fname", title: im.file }, [im.file]),
      h("div", { class: "bips-badges" }, [
        h("span", { class: "bips-badge bips-cat", onclick: (e) => { e.stopPropagation(); openFieldDialog(im, "category", e); } }, [im.category || "未分类"]),
        h("span", { class: "bips-badge bips-grp", onclick: (e) => { e.stopPropagation(); openFieldDialog(im, "group", e); } }, [im.group || "未分组"]),
      ]),
    ]);

    // 卡片上的提示词组链接（＋ 挂组 / 点 chip 移除）——映射的唯一交互入口，两种视角共用
    const gids = state.links.filter((l) => l.abs === im.abs).map((l) => l.gid);
    const chipsRow = h("div", { class: "bips-chips" }, [
      ...gids.map((gid) => {
        const g = state.libraryGroups.find((x) => x.id === gid);
        return h("span", { class: "bips-chip", title: "点击移除", onclick: (e) => { e.stopPropagation(); removeLink(im.abs, gid); } }, [(g ? g.name : gid).slice(0, 10) + " ✕"]);
      }),
      iconButton(ICONS.plus, "添加提示词组", (e) => { e.stopPropagation(); openGroupPicker(im.abs, e); }),
    ]);

    card.appendChild(thumb);
    card.appendChild(meta);
    card.appendChild(chipsRow);

    if (state.bulkMode) {
      const cb = h("input", { type: "checkbox", class: "bips-check",
        onclick: (e) => { e.stopPropagation(); toggleBulk(im.abs); } });
      if (state.bulkSel.has(im.abs)) cb.checked = true;
      card.appendChild(cb);
    }

    // 点选卡片：普通点击=单选（再点取消），Ctrl/⌘+点击或批量模式下点击=追加多选。
    // 缩略图/徽标/chip/按钮有自己的处理器并 stopPropagation，不会走到这里。
    card.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest(".bips-thumb, .bips-badge, .bips-chip, .bips-check, button, input")) return;
      const additive = state.bulkMode || e.ctrlKey || e.metaKey;
      if (additive) {
        if (state.bulkSel.has(im.abs)) state.bulkSel.delete(im.abs);
        else state.bulkSel.add(im.abs);
      } else {
        const onlyThis = state.bulkSel.size === 1 && state.bulkSel.has(im.abs);
        state.bulkSel.clear();
        if (!onlyThis) state.bulkSel.add(im.abs);
      }
      renderBulkBar();
      renderGrid();
    });

    // 拖拽排序
    card.addEventListener("dragstart", (e) => {
      // 点在可交互子元素（分类/分组徽标、提示词 chip、勾选框、按钮）上时，
      // 不启动卡片拖拽，确保它们的点击/弹窗正常触发
      if (e.target && e.target.closest && e.target.closest(".bips-badge, .bips-chip, .bips-check, button, input, .bips-icon-btn")) {
        e.preventDefault();
        return;
      }
      // 拖拽重排只对「自定义排序」有意义；名称/时间排序下 order 不参与显示
      if (state.sortBy !== "custom") {
        e.preventDefault();
        return;
      }
      state.dragAbs = im.abs;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", im.abs); } catch (_) {}
      card.classList.add("bips-dragging");
    });
    card.addEventListener("dragend", () => {
      state.dragAbs = null;
      card.classList.remove("bips-dragging");
      document.querySelectorAll(".bips-drop-before,.bips-drop-after").forEach((c) => c.classList.remove("bips-drop-before", "bips-drop-after"));
    });
    card.addEventListener("dragover", (e) => {
      if (!state.dragAbs || state.dragAbs === im.abs) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      // 网格按左右插入（横向行）；瀑布流按上下插入（纵向列）
      const before = masonry ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
      card.classList.toggle("bips-drop-before", before);
      card.classList.toggle("bips-drop-after", !before);
    });
    card.addEventListener("dragleave", () => card.classList.remove("bips-drop-before", "bips-drop-after"));
    card.addEventListener("drop", (e) => {
      if (!state.dragAbs || state.dragAbs === im.abs) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const before = masonry ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
      reorderTo(state.dragAbs, im.abs, before);
      card.classList.remove("bips-drop-before", "bips-drop-after");
    });

    return card;
  }

  // 每组的图片 = 链接(gid) ∪ 卡片「分组」字段匹配组名 —— 两套数据统一计算，
  // 用户在卡片上选的分组徽标、在面板里的拖拽/指派，底部面板与输出口径一致
  function groupAbsList(g) {
    const name = (g.name || "").trim();
    const seen = new Set();
    const list = [];
    state.links.filter((l) => l.gid === g.id).forEach((l) => {
      if (l.abs && !seen.has(l.abs)) { seen.add(l.abs); list.push(l.abs); }
    });
    if (name) state.images.forEach((im) => {
      if ((im.group || "").trim() === name && !seen.has(im.abs)) { seen.add(im.abs); list.push(im.abs); }
    });
    return list;
  }

  function renderAssocPanel() {
    els.assocPanel.innerHTML = "";
    // 常驻的「按组」视角（与卡片上的挂组 chips 同一份映射，实时同步）；可折叠
    els.assocPanel.style.display = "flex";
    if (!state.libraryGroups.length) {
      els.assocPanel.appendChild(h("div", { class: "bips-assoc-hint" }, ["点「提示词库」选择库后，这里列出各组；把图片拖入组内，或选中卡片后点「＋」整批指派。"]));
      return;
    }
    const totalMapped = new Set();
    state.libraryGroups.forEach((g) => groupAbsList(g).forEach((a) => totalMapped.add(a)));
    const head = h("div", { class: "bips-assoc-head" + (state.assocCollapsed ? " bips-collapsed" : ""), title: "点击折叠/展开",
      onclick: () => { state.assocCollapsed = !state.assocCollapsed; renderAssocPanel(); recalcHeight(); } }, [
      // v3.59 修复：展开/折叠改变面板高度，必须回收节点高度——此前直接调 renderAssocPanel
      // 绕过了 render() 里的 recalcHeight，节点高度停留在折叠态，展开内容溢出节点框。
      h("span", { class: "bips-assoc-title" }, ["提示词组映射（共 " + state.libraryGroups.length + " 组 / " + totalMapped.size + " 张已挂）"]),
      iconButton(ICONS.chevron, "折叠/展开", () => {}),
    ]);
    els.assocPanel.appendChild(head);
    if (state.assocCollapsed) return;
    state.libraryGroups.forEach((g) => {
      const absList = groupAbsList(g);
      const row = h("div", { class: "bips-grp-row", "data-gid": g.id }, [
        h("div", { class: "bips-grp-head" }, [
          h("span", { class: "bips-grp-name" }, [g.name || g.id]),
          h("span", { class: "bips-grp-count" }, [absList.length + " 张"]),
          iconButton(ICONS.plus, "把当前勾选图片指派到此组", (e) => { e.stopPropagation(); assignBulkToGroup(g); }),
        ]),
        h("div", { class: "bips-grp-chips" }, absList.map((abs) => {
          const im = state.images.find((x) => x.abs === abs);
          return h("span", { class: "bips-chip", title: "点击移除", onclick: (e) => { e.stopPropagation(); removeFromGroup(abs, g); } }, [(im ? im.file : abs).slice(0, 12) + " ✕"]);
        })),
      ]);
      makeGroupDropTarget(row, g);
      els.assocPanel.appendChild(row);
    });
  }

  // ---- 交互 ----
  function toggleCollapse(key) {
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    renderGrid();
  }

  function reorderTo(dragAbs, targetAbs, before) {
    const arr = state.images;
    const from = arr.findIndex((x) => x.abs === dragAbs);
    if (from < 0) return;
    const [moved] = arr.splice(from, 1);
    let to = arr.findIndex((x) => x.abs === targetAbs);
    if (to < 0) to = arr.length;
    arr.splice(before ? to : to + 1, 0, moved);
    reindex();
    render();
  }

  function reindex() { state.images.forEach((im, i) => (im.order = i)); }

  function makeSectionDropTarget(sec, key) {
    sec.addEventListener("dragover", (e) => { if (state.dragAbs) { e.preventDefault(); sec.classList.add("bips-sec-drop"); } });
    sec.addEventListener("dragleave", () => sec.classList.remove("bips-sec-drop"));
    sec.addEventListener("drop", (e) => {
      if (!state.dragAbs) return;
      e.preventDefault();
      sec.classList.remove("bips-sec-drop");
      const im = state.images.find((x) => x.abs === state.dragAbs);
      if (!im) return;
      if (state.groupBy === "category") im.category = key;
      else im.group = key;
      const arr = state.images;
      const idx = arr.findIndex((x) => x.abs === im.abs);
      arr.splice(idx, 1);
      const lastIdx = arr.reduce((acc, x, i) => (((x[state.groupBy] || "未分组").trim() || "未分组") === key ? i : acc), -1);
      arr.splice(lastIdx + 1, 0, im);
      reindex();
      render();
    });
  }

  function makeGroupDropTarget(row, g) {
    row.addEventListener("dragover", (e) => { if (state.dragAbs) { e.preventDefault(); row.classList.add("bips-grp-drop"); } });
    row.addEventListener("dragleave", () => row.classList.remove("bips-grp-drop"));
    row.addEventListener("drop", (e) => {
      if (!state.dragAbs) return;
      e.preventDefault();
      row.classList.remove("bips-grp-drop");
      assignToGroupField(state.dragAbs, g);
    });
  }

  // 面板指派/拖拽 = 写卡片的「分组」字段（徽标同步显示，面板与输出统一口径）
  function assignToGroupField(abs, g) {
    const im = state.images.find((x) => x.abs === abs);
    if (!im || !g.name) return;
    im.group = g.name.trim();
    render();
  }
  // 从组里移除：分组字段匹配则清字段，同时清理可能存在的旧链接
  function removeFromGroup(abs, g) {
    const im = state.images.find((x) => x.abs === abs);
    if (im && g.name && (im.group || "").trim() === g.name.trim()) im.group = "";
    state.links = state.links.filter((l) => !(l.abs === abs && l.gid === g.id));
    render();
  }
  function addLink(abs, gid) {
    if (!state.links.some((l) => l.abs === abs && l.gid === gid)) state.links.push({ abs, gid });
    render();
  }
  function removeLink(abs, gid) {
    state.links = state.links.filter((l) => !(l.abs === abs && l.gid === gid));
    render();
  }
  function assignBulkToGroup(g) {
    if (!state.bulkSel.size) return;
    state.bulkSel.forEach((abs) => assignToGroupField(abs, g));
    state.bulkSel.clear();
    state.bulkMode = false;
    syncToolbar();
    render();
  }

  function openGroupPicker(abs, e) {
    if (!state.libraryGroups.length) { window.alert("请先点击「提示词库」选择一个库"); return; }
    const items = state.libraryGroups.map((g) => ({ label: g.name || g.id, onClick: () => addLink(abs, g.id) }));
    showMenu(items, { title: "选择提示词组（可多次添加）", x: e && e.clientX, y: e && e.clientY });
  }

  function openFieldDialog(im, field, e) {
    const isCat = field === "category";
    const presets = (isCat ? state.categories : state.groupNames) || [];
    const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
    const apply = (v) => { im[field] = (v || "").trim(); reindex(); render(); close(); };

    const overlay = h("div", { class: "bips-menu-overlay" });
    const menu = h("div", { class: "bips-menu bips-field-dialog" });
    menu.appendChild(h("div", { class: "bips-menu-title" }, [isCat ? "选择分类（库内设置）" : "选择分组（库内设置）"]));

    const input = h("input", { class: "bips-dialog-input", type: "text",
      placeholder: isCat ? "输入或搜索分类名" : "输入或搜索组名", value: im[field] || "" });
    const confirmBtn = h("button", { class: "bips-btn", type: "button" }, ["确认"]);
    confirmBtn.onclick = () => apply(input.value);
    menu.appendChild(h("div", { class: "bips-dialog-input-row" }, [input, confirmBtn]));

    if (presets.length) {
      menu.appendChild(h("div", { class: "bips-menu-title" }, ["或选择已有："]));
      presets.forEach((v) => menu.appendChild(
        h("div", { class: "bips-menu-item", onclick: () => apply(v) }, [v])));
    }
    menu.appendChild(h("div", { class: "bips-menu-item bips-menu-clear",
      onclick: () => { im[field] = ""; reindex(); render(); close(); } }, ["（清除 / 留空）"]));

    overlay.appendChild(menu);
    overlay.addEventListener("click", (e2) => { if (e2.target === overlay) close(); });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") apply(input.value);
      else if (ev.key === "Escape") close();
    });
    document.body.appendChild(overlay);

    // 锚定到点击位置，并做视口边界防溢出
    if (e && e.clientX != null && e.clientY != null) {
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = e.clientX;
      let top = e.clientY;
      if (left + rect.width > vw - 8) left = vw - rect.width - 8;
      if (top + rect.height > vh - 8) top = vh - rect.height - 8;
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      menu.style.position = "absolute";
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    }
    setTimeout(() => input.focus(), 0);
  }

  function makeDatalist(id, opts) {
    const dl = h("datalist", { id });
    (opts || []).forEach((v) => dl.appendChild(h("option", { value: v })));
    return dl;
  }

  function toggleBulk(abs) {
    if (state.bulkSel.has(abs)) state.bulkSel.delete(abs);
    else state.bulkSel.add(abs);
    renderGrid();
  }

  function renderBulkBar() {
    els.bulkBar.innerHTML = "";
    // 批量模式（显示勾选框）或有任何选中卡片时都浮出操作条
    if (!state.bulkMode && !state.bulkSel.size) { els.bulkBar.style.display = "none"; return; }
    els.bulkBar.style.display = "flex";
    els.bulkBar.appendChild(h("span", { class: "bips-bulk-count" }, ["已选 " + state.bulkSel.size + " 张"]));
    els.bulkBar.appendChild(h("button", { class: "bips-btn", type: "button", title: "选中当前搜索结果下的全部图片",
      onclick: () => { state.bulkSel = new Set(visibleImages().map((im) => im.abs)); renderBulkBar(); renderGrid(); } }, ["全选"]));
    els.bulkBar.appendChild(h("button", { class: "bips-btn", type: "button", onclick: () => { state.bulkSel.clear(); renderBulkBar(); renderGrid(); } }, ["清空"]));
    const catId = "bips-dl-cat-" + (++state.dlSeq);
    const catInput = h("input", { class: "bips-inline-input", placeholder: "分类名（库内）", list: catId, type: "text" });
    els.bulkBar.appendChild(makeDatalist(catId, state.categories));
    els.bulkBar.appendChild(catInput);
    els.bulkBar.appendChild(h("button", { class: "bips-btn", type: "button", onclick: () => { const v = catInput.value.trim(); if (v) { state.bulkSel.forEach((a) => { const im = state.images.find((x) => x.abs === a); if (im) im.category = v; }); render(); } } }, ["批量归类"]));
    const grpId = "bips-dl-grp-" + (++state.dlSeq);
    const grpInput = h("input", { class: "bips-inline-input", placeholder: "组名（库内）", list: grpId, type: "text" });
    els.bulkBar.appendChild(makeDatalist(grpId, state.groupNames));
    els.bulkBar.appendChild(grpInput);
    els.bulkBar.appendChild(h("button", { class: "bips-btn", type: "button", onclick: () => { const v = grpInput.value.trim(); if (v) { state.bulkSel.forEach((a) => { const im = state.images.find((x) => x.abs === a); if (im) im.group = v; }); render(); } } }, ["批量分组"]));
  }

  // ---- 初始化 ----
  loadFromSaved();
  if (state.folder) loadImages();
  else render();

  node._bipsRefresh = () => { loadFromSaved(); if (state.folder) loadImages(); else render(); };
  if (node._bipsPendingConfigure) {
    node._bipsPendingConfigure = false;
    Promise.resolve().then(node._bipsRefresh);
  }
}

// ---------------------------------------------------------------------------
// 图片大图预览（点击卡片缩略图打开，带缩略图→全屏的飞入过渡；
// 顶栏含醒目的文件名/分辨率 + 可点击的分类/分组徽标快速切换）
// ctx: { presets(field) → string[], apply(field, value) } 由调用方（节点闭包）注入
// ---------------------------------------------------------------------------
function openImagePreview(im, originEl, ctx) {
  if (!im || !im.abs) return;
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let closing = false;

  // 编辑后卡片会被 render 重建，按 data-abs 找新卡片里的缩略图，保持关闭飞回可用
  const liveOrigin = () => {
    if (originEl && originEl.isConnected) return originEl;
    const card = document.querySelector('.bips-card[data-abs="' + CSS.escape(im.abs) + '"] img');
    return card || null;
  };

  const close = () => {
    if (closing) return;
    closing = true;
    document.removeEventListener("keydown", onKey, true);
    // 关闭过渡：已加载的大图飞回缩略图原位；原图未加载/卡片不在视口时仅淡出
    const r1 = img.getBoundingClientRect();
    const origin = liveOrigin();
    const r0 = origin ? origin.getBoundingClientRect() : null;
    let flyEl = null;
    if (!reduceMotion && r0 && r0.width > 4 && r1.width > 4) {
      flyEl = img.cloneNode();
      flyEl.className = "bips-lightbox-ghost";
      flyEl.style.opacity = "1"; // 大图未揭示完就关闭时，克隆不能继承 opacity:0
      flyEl.style.left = r1.left + "px";
      flyEl.style.top = r1.top + "px";
      flyEl.style.width = r1.width + "px";
      flyEl.style.height = r1.height + "px";
      flyEl.style.objectFit = "contain";
      document.body.appendChild(flyEl);
      flyEl.animate([
        { left: r1.left + "px", top: r1.top + "px", width: r1.width + "px", height: r1.height + "px" },
        { left: r0.left + "px", top: r0.top + "px", width: r0.width + "px", height: r0.height + "px" },
      ], { duration: 200, easing: "cubic-bezier(.4,0,.7,1)" });
    }
    overlay.classList.add("bips-closing");
    setTimeout(() => {
      overlay.remove();
      if (flyEl) flyEl.remove();
    }, 190);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    // 分类/分组切换面板开着时，Esc 先关面板，不关预览
    if (document.querySelector(".bips-pick-panel")) return;
    e.stopPropagation();
    close();
  };

  // ---- 顶栏：文件名 + 分辨率（醒目） + 分类/分组徽标（点击快速切换） ----
  const badgesWrap = h("div", { class: "bips-lightbox-badges" });
  function renderBadges() {
    badgesWrap.innerHTML = "";
    badgesWrap.appendChild(h("button", {
      class: "bips-badge bips-cat", type: "button", title: "点击快速切换分类",
      onclick: (e) => { e.stopPropagation(); openPreviewFieldPicker(im, "category", e.currentTarget, ctx, renderBadges); },
    }, [im.category || "未分类"]));
    badgesWrap.appendChild(h("button", {
      class: "bips-badge bips-grp", type: "button", title: "点击快速切换分组",
      onclick: (e) => { e.stopPropagation(); openPreviewFieldPicker(im, "group", e.currentTarget, ctx, renderBadges); },
    }, [im.group || "未分组"]));
  }
  renderBadges();

  const dim = [];
  if (im.w > 0) dim.push(im.w + "×" + (im.h > 0 ? im.h : "?"));
  // alt 必须留空：alt 放文件名时，原图加载期间会把文件名渲染在屏幕中央、
  // 加载完成后消失（即“标题闪一下”）；顶栏用绝对定位固定在顶部，不随图片加载跳动
  // 预览用服务端预缩放图（长边 3200；屏幕显示上限 ~1400 CSS px，2x DPI 也足够）：
  // 原图动辄数千万像素，解码+首次绘制会长时间卡住主线程，把过渡动画冻在半透明帧
  const img = h("img", { class: "bips-lightbox-img", src: imgUrl(im.abs, 3200), alt: "" });
  img.style.opacity = "0"; // 大图加载完成后，与幽灵帧同帧切换显示
  const loading = h("div", { class: "bips-lightbox-loading" }, ["加载中…"]);
  const overlay = h("div", { class: "bips-menu-overlay bips-lightbox",
    onclick: (e) => { if (e.target === overlay) close(); } }, [
    h("div", { class: "bips-lightbox-bar" }, [
      h("span", { class: "bips-lightbox-name", title: im.file }, [im.file]),
      dim.length ? h("span", { class: "bips-lightbox-dim" }, [dim.join(" · ")]) : null,
      badgesWrap,
      h("button", { class: "bips-btn", type: "button", onclick: close }, ["关闭"]),
    ]),
    loading,
    img,
  ]);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey, true);

  // ---- 等【大图加载+解码完成】后，再从缩略图原位飞出清晰大图 ----
  // 好处：飞行元素就是最终显示的清晰图，不存在“模糊→清晰”的中间切换，
  // 也不会有加载/解码 jank 卡住过渡动画的问题（动画开始时像素已就绪）。
  const withCap = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(res, ms))]);
  const ready = new Promise((res) => {
    const done = () => {
      // onload ≠ 可绘制：等 decode() 真正完成（像素就绪）才开始动画
      if (typeof img.decode === "function") img.decode().then(() => res(true), () => res(false));
      else res(true);
    };
    if (img.complete && img.naturalWidth > 0) done();
    else { img.onload = done; img.onerror = () => res(false); }
  });
  withCap(ready, 20000).then((ok) => {
    if (closing) return;
    loading.remove();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!ok || nw <= 0) { img.style.opacity = "1"; return; } // 加载失败：显示空态

    const vw = window.innerWidth, vh = window.innerHeight;
    const maxW = Math.min(vw * 0.92, 1400), maxH = vh - 32;
    const s = Math.min(maxW / nw, maxH / nh);
    const fw = Math.max(1, Math.round(nw * s)), fh = Math.max(1, Math.round(nh * s));
    const fx = Math.round((vw - fw) / 2), fy = Math.round((vh - fh) / 2);

    const r0 = liveOrigin() ? liveOrigin().getBoundingClientRect() : null;
    if (reduceMotion || !r0 || r0.width <= 4 || r0.height <= 4) {
      img.style.opacity = "1"; // 无动画条件：直接显示
      return;
    }
    // 幽灵帧 = 清晰大图的克隆（已解码，瞬时可见），从缩略图原位飞向最终位置
    const ghost = img.cloneNode();
    ghost.className = "bips-lightbox-ghost";
    ghost.style.opacity = "1"; // cloneNode 会拷贝 img 的 inline opacity:0，必须覆盖
    ghost.style.left = r0.left + "px";
    ghost.style.top = r0.top + "px";
    ghost.style.width = r0.width + "px";
    ghost.style.height = r0.height + "px";
    overlay.appendChild(ghost);
    const fly = ghost.animate([
      { left: r0.left + "px", top: r0.top + "px", width: r0.width + "px", height: r0.height + "px", borderRadius: "var(--vpl-r-sm)" },
      { left: fx + "px", top: fy + "px", width: fw + "px", height: fh + "px", borderRadius: "var(--vpl-r-md)" },
    ], { duration: 240, easing: "cubic-bezier(.2,.7,.3,1)" });
    // onfinish 在窗口被遮挡/合成器节流时可能不触发，必须带超时兜底
    const finish = () => {
      if (done || closing) { ghost.remove(); return; }
      done = true;
      // 幽灵帧落点 = 大图最终位置（同一张图、同一尺寸），同帧移除并显示，无任何中间态
      img.style.transition = "none";
      img.style.opacity = "1";
      ghost.remove();
    };
    let done = false;
    fly.onfinish = finish;
    setTimeout(finish, 450);
  });
}

// ---------------------------------------------------------------------------
// 预览内快速切换分类/分组：徽标下方弹出选项面板（预设 chip + 手输 + 清除）
// ---------------------------------------------------------------------------
function openPreviewFieldPicker(im, field, anchorEl, ctx, onChanged) {
  // 已有同 field 面板则先关掉（分类/分组面板互斥）
  document.querySelectorAll(".bips-pick-panel").forEach((p) => p.remove());
  const isCat = field === "category";
  const presets = (ctx && ctx.presets ? ctx.presets(field) : []) || [];
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    if (panel.parentNode) panel.remove();
  };
  const apply = (v) => {
    if (ctx && ctx.apply) ctx.apply(field, v);
    if (onChanged) onChanged();
    close();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const onOutside = (e) => { if (!panel.contains(e.target)) close(); };

  const panel = h("div", { class: "bips-pick-panel" });
  panel.appendChild(h("div", { class: "bips-pick-title" }, [isCat ? "切换分类" : "切换分组"]));

  // 手输行
  const input = h("input", { class: "bips-dialog-input", type: "text",
    placeholder: isCat ? "输入分类名" : "输入组名", value: im[field] || "" });
  const confirmBtn = h("button", { class: "bips-btn", type: "button", onclick: () => { const v = input.value.trim(); if (v) apply(v); } }, ["确认"]);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { const v = input.value.trim(); if (v) apply(v); }
    ev.stopPropagation(); // 防止 Esc/Enter 冒泡关掉预览
  });
  panel.appendChild(h("div", { class: "bips-dialog-input-row" }, [input, confirmBtn]));

  // 预设 chips（当前值高亮）
  const grid = h("div", { class: "bips-pick-grid" });
  const cur = (im[field] || "").trim();
  if (presets.length) {
    presets.forEach((v) => {
      const chip = h("button", { class: "bips-pick-chip" + (v === cur ? " bips-pick-cur" : ""), type: "button",
        title: v, onclick: () => apply(v) }, [v]);
      grid.appendChild(chip);
    });
  } else {
    grid.appendChild(h("div", { class: "bips-pick-empty" }, ["库内暂无预设，可直接在上方输入"]));
  }
  panel.appendChild(grid);

  // 清除
  panel.appendChild(h("button", { class: "bips-pick-chip bips-pick-clear", type: "button",
    onclick: () => apply("") }, [isCat ? "（清除分类）" : "（清除分组）"]));

  document.body.appendChild(panel);
  // 锚定到徽标下方，视口边界防溢出
  const r = anchorEl.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 6;
  if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
  if (top + pr.height > window.innerHeight - 8) top = r.top - pr.height - 6;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  panel.style.left = left + "px";
  panel.style.top = top + "px";
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onOutside, true);
  setTimeout(() => input.focus(), 0);
}

// ---------------------------------------------------------------------------
// 弹层菜单
// ---------------------------------------------------------------------------
function showMenu(items, opts = {}) {
  const overlay = h("div", { class: "bips-menu-overlay" });
  const menu = h("div", { class: "bips-menu" });
  if (opts.title) menu.appendChild(h("div", { class: "bips-menu-title" }, [opts.title]));
  items.forEach((it) => menu.appendChild(h("div", { class: "bips-menu-item", onclick: () => { document.body.removeChild(overlay); it.onClick && it.onClick(); } }, [it.label])));
  overlay.appendChild(menu);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
  document.body.appendChild(overlay);

  // 若提供了点击坐标，就把菜单锚定到点击位置，并做视口边界防溢出
  if (opts.x != null && opts.y != null) {
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = opts.x;
    let top = opts.y;
    if (left + rect.width > vw - 8) left = vw - rect.width - 8;
    if (top + rect.height > vh - 8) top = vh - rect.height - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    menu.style.position = "absolute";
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
}

// ===========================================================================
// 扩展注册
// ===========================================================================
let _bipsHooked = false;
function installBipsGraphToPromptHook() {
  if (_bipsHooked) return;
  const orig = app.graphToPrompt?.bind(app);
  if (typeof orig !== "function") return;
  _bipsHooked = true;
  app.graphToPrompt = async function () {
    const res = await orig();
    try {
      const nodes = (app.graph && (app.graph._nodes || app.graph.nodes)) || [];
      for (const node of nodes) {
        if (node && node.type === NODE_NAME && typeof node._bipsInputs === "function") {
          const id = String(node.id);
          if (res.output && res.output[id] && res.output[id].inputs) {
            Object.assign(res.output[id].inputs, node._bipsInputs());
          }
        }
      }
    } catch (e) {
      console.error("[BIPS] 注入执行参数失败：", e);
    }
    return res;
  };
}

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.visible = false;
  if (w.options) w.options.hidden = true;
  try { w.computeSize = function () { return [0, -4]; }; } catch (e) {}
  try { w.computeLayoutSize = function () { return { minHeight: 0, minWidth: 0, maxHeight: 0, maxWidth: 0, height: 0, width: 0 }; }; } catch (e) {}
  try { w.getMinHeight = function () { return 0; }; } catch (e) {}
  try { w.getMaxHeight = function () { return 0; }; } catch (e) {}
}

console.info("[BIPS] 批量选图前端已加载 v" + PLUGIN_VERSION);

app.registerExtension({
  name: "BatchImagePromptSelector",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    installBipsGraphToPromptHook();
    // bips3.10：隐藏「映射JSON」输出口（用户用不上）。只动前端显示——后端仍返回第 4 个
    // 结果（多余项被忽略）；被移除口的悬空连线随口移除（与媒体节点 reconcileOutputs 同款）。
    function pruneMappingOutput(node) {
      try {
        if (!Array.isArray(node.outputs)) return;
        const gone = node.outputs.filter((o) => o && (o.name === "映射JSON" || o.name === "mapping_json"));
        if (!gone.length) return;
        node.outputs = node.outputs.filter((o) => !gone.includes(o));
        for (const o of gone) {
          for (const lid of o.links || []) {
            try { app.graph.removeLink(lid); } catch (e) { /* ignore */ }
          }
        }
        node.setDirtyCanvas?.(true, true);
      } catch (e) { /* ignore */ }
    }
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      pruneMappingOutput(this);
      attachController(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      setTimeout(() => pruneMappingOutput(this), 0); // 工作流恢复的 outputs 带旧口，configure 后补剪
      if (this._bipsRefresh) this._bipsRefresh();
      else this._bipsPendingConfigure = true;
    };
  },
});
