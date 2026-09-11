// ComfyUI-AllBuy_PromptLibrary 主前端逻辑
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { openEditor, uid } from "./editor_dialog.js";
import { previewGroup, previewMerged } from "./preview_dialog.js";
import { installBypassSync, installExecutionLock } from "./panel_guard.js";

const PLUGIN_VERSION = "v3.63"; // 改样式/逻辑时递增，用于强制浏览器刷新缓存（与后端 constants.PLUGIN_VERSION 一致）

// ---------------------------------------------------------------------------
// 注入样式表（ComfyUI 不会自动加载 WEB_DIRECTORY 下的 CSS，必须手动注入 link）
// ---------------------------------------------------------------------------
(function injectStyle() {
  if (document.getElementById("vpl-style-link")) return;

  // 兜底样式：只保留“SVG 不会失控变大”这一条救命规则。
  // 必须插在正式 CSS link 之前，确保 style.css 同特异性规则永远覆盖兜底。
  const fb = document.createElement("style");
  fb.id = "vpl-style-fallback";
  fb.textContent = `.vpl-node svg{max-width:16px;max-height:16px}`;
  document.head.appendChild(fb);

  const link = document.createElement("link");
  link.id = "vpl-style-link";
  link.rel = "stylesheet";
  link.type = "text/css";
  try {
    link.href = new URL("./style.css?v=" + PLUGIN_VERSION, import.meta.url).href;
  } catch (e) {
    link.href = "/extensions/ComfyUI-AllBuy_PromptLibrary/style.css?v=" + PLUGIN_VERSION;
  }
  document.head.appendChild(link);

  console.log("%c[AllBuy_PromptLibrary] " + PLUGIN_VERSION + " 前端已加载",
    "color:#6366f1;font-weight:bold");
})();

const API = "/allbuy_promptlibrary";
// v3.47 节点改名去掉 Video；旧名仍由后端别名注册（老工作流加载用），前端两类名都要接管
const NODE_NAME = "PromptLibrary";
const NODE_NAME_RANDOM = "PromptRandomDraw";
const NODE_NAME_LEGACY = "VideoPromptLibrary";
const NODE_NAME_RANDOM_LEGACY = "VideoPromptRandomDraw";
const NODE_NAME_MEDIA = "MediaAssetLoader"; // v3.54：素材加载节点，同样经此注入执行参数
const NODE_WIDTH = 380;
const LIST_MAX_HEIGHT = 180;

const DEFAULT_SEPARATORS = [
  { label: "逗号 + 空格 (, )", value: ", " },
  { label: "换行 (\\n)", value: "\n" },
  { label: "句号 (. )", value: ". " },
  { label: "分号 (; )", value: "; " },
  { label: "空格 ( )", value: " " },
];

// 线性图标（feather 风格），currentColor 跟随文字色
const ICONS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  drag: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/></svg>',
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  // v3.45：合并结果弹窗预览按钮
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
};

// v3.43：命名槽/属性标签解析（原在主面板闭包内，抽卡节点变量行也要用，提升到模块级）
const SLOT_RE = /\{([^{}]*)\}/g;
const TAG_RE = /#([^#\s{}:|]{1,24})#/g; // v3.35：属性标签 #名称#
function parseSlotContent(content) {
  // 与后端 merger.split_named_slot / is_bare_placeholder 对齐
  const ci = content.indexOf(":");
  if (ci > 0) {
    const head = content.slice(0, ci).trim();
    if (head && !head.includes("|") && !/^\d+$/.test(head) && head.length <= 24) {
      return { name: head, options: content.slice(ci + 1).split("|").map((s) => s.trim()).filter(Boolean) };
    }
    return null;
  }
  const bare = content.trim();
  if (bare && !bare.includes("|") && !/^\d+$/.test(bare) && bare.length <= 24) {
    return { name: bare, options: [] };
  }
  return null;
}

function iconButton(svg, title, onClick, opts = {}) {
  const btn = h("button", {
    class: "vpl-icon-btn" + (opts.danger ? " vpl-icon-danger" : "") + (opts.active ? " vpl-btn-active" : ""),
    title,
    disabled: opts.disabled ? "disabled" : null,
    onclick: (e) => { e.stopPropagation(); onClick?.(e); },
  });
  btn.innerHTML = svg;
  return btn;
}

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

// ---------------------------------------------------------------------------
// 自定义下拉组件 v3.1
// 浏览器原生 <select> 弹出层永远不可跨平台重写样式，必须自建。
// API：const dd = createDropdown({ placeholder, className })
//      dd.trigger / dd.panel / dd.root
//      dd.setLabel(text)             —— 改按钮显示文字
//      dd.setItems([{label, value, badge?, group?, onClick?}]) —— 重建面板
//      dd.open() / dd.close()
//      dd.addEventListener("change", cb) —— 兼容 select 风格（cb 收 value）
//      dd.value                       —— 当前 value
// ---------------------------------------------------------------------------
function createDropdown(opts = {}) {
  const { placeholder = "请选择…", className = "", multi = false } = opts;
  const trigger = h("button", {
    type: "button",
    class: `vpl-dd-trigger ${className}`,
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
  });
  const labelEl = h("span", { class: "vpl-dd-label" }, placeholder);
  const arrowEl = h("span", { class: "vpl-dd-arrow", html: "▾" });
  trigger.append(labelEl, arrowEl);

  const panel = h("div", { class: "vpl-dd-panel" });
  panel.setAttribute("role", "listbox");

  const root = h("div", { class: "vpl-dd" }, [trigger, panel]);

  let _value = multi ? [] : "";
  const _sel = multi ? new Set() : null;
  let _listeners = [];
  let _open = false;

  function fire(val) {
    _value = val;
    for (const cb of _listeners) {
      try { cb(val); } catch (e) { console.error(e); }
    }
  }

  // 点击外部 / ESC 关闭：监听只在 open 期间挂载、close 时卸载——
  // 节点面板上有多个下拉，常驻 document 监听在节点删除后既泄漏又白跑（v3.58）
  function onDocClick(e) {
    if (!root.contains(e.target)) close();
  }
  function onDocKey(e) {
    if (e.key === "Escape") close();
  }

  function open() {
    if (_open) return;
    _open = true;
    trigger.setAttribute("aria-expanded", "true");
    root.classList.add("vpl-dd-open");
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKey);
    // 面板紧贴 trigger 下方显示（绝对定位在 root 上）
    panel.style.display = "block";
    // 下一帧再加 visible class，触发过渡动画
    requestAnimationFrame(() => panel.classList.add("vpl-dd-panel-visible"));
  }
  function close() {
    if (!_open) return;
    _open = false;
    trigger.setAttribute("aria-expanded", "false");
    root.classList.remove("vpl-dd-open");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onDocKey);
    panel.classList.remove("vpl-dd-panel-visible");
    setTimeout(() => { if (!_open) panel.style.display = "none"; }, 160);
  }
  function toggle() { _open ? close() : open(); }
  function updateLabel() {
    if (multi) labelEl.textContent = _value.length ? `已选 ${_value.length} 项` : placeholder;
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  return {
    root, trigger, panel,
    open, close, toggle,
    setLabel(text) { labelEl.textContent = text; },
    setValueSilent(val) {
      if (multi) { _sel.clear(); (val || []).forEach((x) => _sel.add(x)); _value = [..._sel]; updateLabel(); }
      else _value = val;
    },
    addEventListener(_evt, cb) {
      // 兼容 select 风格：只支持 "change"
      if (_evt === "change") _listeners.push(cb);
    },
    get value() { return _value; },
    set value(v) {
      if (multi) { _sel.clear(); (v || []).forEach((x) => _sel.add(x)); _value = [..._sel]; updateLabel(); }
      else _value = v;
    },
    setItems(items) {
      panel.innerHTML = "";
      let lastGroup = null;
      for (const it of items) {
        if (it.group && it.group !== lastGroup) {
          lastGroup = it.group;
          panel.appendChild(h("div", { class: "vpl-dd-group" }, it.group));
        }
        const active = multi ? _sel.has(it.value) : (it.value === _value);
        const row = h("div", {
          class: `vpl-dd-item ${active ? "vpl-dd-item-active" : ""} ${it.disabled ? "vpl-dd-item-disabled" : ""} ${multi ? "vpl-dd-item-multi" : ""}`,
          role: multi ? "checkbox" : "option",
          "data-value": it.value,
        });
        if (multi) row.appendChild(h("span", { class: "vpl-dd-check", html: "✓" }));
        const main = h("span", { class: "vpl-dd-item-main" }, it.label);
        row.appendChild(main);
        if (it.badge) {
          row.appendChild(h("span", { class: "vpl-dd-badge" }, it.badge));
        }
        if (!it.disabled) {
          row.addEventListener("click", (e) => {
            e.stopPropagation();
            if (multi) {
              if (it.value === "__clear__") { _sel.clear(); _value = []; }
              else if (_sel.has(it.value)) { _sel.delete(it.value); _value = [..._sel]; }
              else { _sel.add(it.value); _value = [..._sel]; }
              panel.querySelectorAll(".vpl-dd-item").forEach((n) => {
                const v = n.getAttribute("data-value");
                const on = v === "__clear__" ? _sel.size === 0 : _sel.has(v);
                n.classList.toggle("vpl-dd-item-active", on);
              });
              updateLabel();
              if (it.onClick) it.onClick(_value);
              fire(_value);
            } else {
              labelEl.textContent = it.label;
              panel.querySelectorAll(".vpl-dd-item-active")
                .forEach((n) => n.classList.remove("vpl-dd-item-active"));
              row.classList.add("vpl-dd-item-active");
              close();
              if (it.onClick) it.onClick(it.value);
              fire(it.value);
            }
          });
        }
        panel.appendChild(row);
      }
    },
  };
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
  const d = await r.json().catch(() => ({}));
  // v3.61：ok:false 抛错（对齐 media 面板同款语义）——写库失败必须让调用方 catch 弹窗，
  // 静默返回响应会让用户以为已保存，关页后编辑丢失
  if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
  return d;
}

function hideWidget(w) {
  if (!w) return;
  // 标记隐藏（新旧前端都会读取的标志）
  w.hidden = true;
  w.visible = false;
  if (w.options) w.options.hidden = true;
  // 注意：不改 w.type —— 新版前端对非标准 type 可能反而渲染成空占位行。
  // 经典 LiteGraph：computeSize 返回负值抵消行间距
  try { w.computeSize = function () { return [0, -4]; }; } catch (e) { /* ignore */ }
  // 新版前端布局 API（存在则覆盖，不存在则忽略）
  try {
    w.computeLayoutSize = function () {
      return { minHeight: 0, minWidth: 0, maxHeight: 0, maxWidth: 0, height: 0, width: 0 };
    };
  } catch (e) { /* ignore */ }
  try { w.getMinHeight = function () { return 0; }; } catch (e) { /* ignore */ }
  try { w.getMaxHeight = function () { return 0; }; } catch (e) { /* ignore */ }
}

// 合法库定位：必须是带 source 的非数组对象。
// 新版前端偶发把其它字段的默认值（如 selected_ids 的 "[]"）错位赋给 library，
// 解析后是空数组 []——空数组是 truthy，需显式排除，否则兜底逻辑会被绕过。
function isValidLocator(loc) {
  return !!loc && typeof loc === "object" && !Array.isArray(loc) && !!loc.source;
}

function locatorLabel(loc, libs) {
  if (!loc) return "未选择";
  if (loc.source === "inline") return "📎 " + (loc.name || "内嵌库");
  if (loc.source === "custom") return "📄 " + (loc.path || "外部文件");
  const found = (libs || []).find((l) => l.source === loc.source && l.name === loc.name);
  const prefix = loc.source === "builtin" ? "📦 " : "🗂 ";
  return prefix + (found ? found.display_name : loc.name);
}

// ---------------------------------------------------------------------------
// 节点控制器
// ---------------------------------------------------------------------------
function attachController(node) {
  // 不同前端版本下，onNodeCreated 触发时 INPUT_TYPES 对应的存储 widget 可能尚未创建。
  // 等待它们就绪后再启动，避免 find 返回 undefined 导致隐藏失效、初始化中断。
  const need = ["库", "选中卡片", "分隔符"];
  const ready = () => node.widgets && need.every((n) => node.widgets.some((w) => w.name === n));
  if (ready()) {
    startController(node);
    return;
  }
  let tries = 0;
  const tick = () => {
    tries++;
    if (ready() || tries >= 60) {
      startController(node);
    } else {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

function startController(node) {
  if (node._vplAttached) return;
  node._vplAttached = true;

  const wLibrary = node.widgets?.find((w) => w.name === "库");
  const wSelected = node.widgets?.find((w) => w.name === "选中卡片");
  const wSeparator = node.widgets?.find((w) => w.name === "分隔符");
  const wPrepend = node.widgets?.find((w) => w.name === "前缀");
  const wAppend = node.widgets?.find((w) => w.name === "后缀");
  const wIgnoreWeight = node.widgets?.find((w) => w.name === "忽略权重");
  const wLibraryData = node.widgets?.find((w) => w.name === "库数据");
  const wVarValues = node.widgets?.find((w) => w.name === "变量取值");

  // 关键：把存储用 widget 从 node.widgets 物理移除。
  // 新版前端源码会“丢弃已从 node.widgets 移除的 widget”，旧版遍历也看不到，
  // 因此节点上只剩 DOM 面板，彻底消除顶部占位黑块。widget 对象仍保留引用用于读写值，
  // 执行时由 installGraphToPromptHook() 把值注入回后端。
  const storageWidgets = [wLibrary, wSelected, wSeparator, wPrepend, wAppend, wIgnoreWeight, wLibraryData, wVarValues]
    .filter(Boolean);
  storageWidgets.forEach(hideWidget);
  if (node.widgets && storageWidgets.length) {
    node.widgets = node.widgets.filter((w) => !storageWidgets.includes(w));
  }

  // 暴露给 graphToPrompt 钩子：返回需要注入后端的 inputs
  // v3.51：移除冗余注入（unselected_ids/view 后端从不消费）；新增通配符固定种子两键
  node._vplInputs = function () {
    return {
      库: wLibrary ? wLibrary.value : JSON.stringify({ source: "user", name: "default" }),
      选中卡片: wSelected ? wSelected.value : "[]",
      分隔符: wSeparator ? wSeparator.value : ", ",
      前缀: wPrepend ? wPrepend.value : "",
      后缀: wAppend ? wAppend.value : "",
      忽略权重: wIgnoreWeight ? wIgnoreWeight.value : false,
      库数据: wLibraryData ? wLibraryData.value : "",
      变量取值: wVarValues ? wVarValues.value : "{}", // v3.34：命名槽取值
      通配符固定: !!state.wcFixed, // v3.51：true = random.Random(种子) 可复现；false = 每次随机
      通配符种子: Math.floor(state.wcSeed) || 0, // 不可用 |0：种子可达 2^53，按位或会截断成 32 位
    };
  };

  console.log(
    "%c[VPL " + PLUGIN_VERSION + "] 已移除存储 widget，节点剩余 widget：",
    "color:#27ae60",
    (node.widgets || []).map((w) => w.name)
  );

  const state = {
    libraries: [],
    separators: DEFAULT_SEPARATORS,
    locator: null,
    libraryData: null, // {name, groups:[]}
    selectedIds: [],
    unselectedIds: [], // v3.22：全量显示顺序（含已选组），拖拽即改序；已选输出顺序由它推导，持久化于 properties._vpl
    search: "",
    categories: [],
    tagsFilter: [],
    customSep: false,
    showAdvanced: false,
    view: "list", // v3.20：主列表显示方式 list(行式) / card(卡片)，持久化于 properties._vpl.view
    // v3.28：整理增强状态（会话态，不持久化）
    bulkMode: false,        // 批量整理模式开关
    bulkSelection: new Set(), // 批量选中的组 id 集合
    groupBy: "none",        // 列表组织方式：none（单一流）| category（按分类分区）
    collapsedCats: new Set(), // 分区视图下折叠的分类名
    collapsedStar: false,   // 收藏置顶区是否折叠
    vars: {},               // v3.34：命名槽取值 {名称: 值}，持久化于 properties._vpl.var_values
    wcFixed: false,         // v3.51：通配符固定种子开关（false=每次随机，默认与旧版一致）
    wcSeed: 0,              // v3.51：固定种子值，持久化于 properties._vpl
    backendVersion: "", // 后端通过 /version 上报；为空或与前端不一致 = 后端没重启到新版
    get readonly() {
      if (!this.locator) return true;
      return this.locator.source === "builtin" || this.locator.source === "custom";
    },
    get inline() {
      return this.locator && this.locator.source === "inline";
    },
  };

  const els = {};
  let dragId = null;
  let loadSeq = 0; // 加载序号，防止异步加载竞态（工作流恢复时）

  // 从 widget / properties 读取状态（widget 已移除，工作流恢复主要靠 properties._vpl）
  // v3.50：兼容读中文键——v3.48/v3.49 期间保存的工作流 properties._vpl 里是中文键
  //（当时 syncWidgets 误把注入用的 _vplInputs 直接当持久化格式），这里双语兜底救回
  function readWidgets() {
    const saved = (node.properties && node.properties._vpl) || null;
    const libVal = saved?.library ?? saved?.库 ?? wLibrary?.value ?? "null";
    const selVal = saved?.selected_ids ?? saved?.选中卡片 ?? wSelected?.value ?? "[]";
    try {
      const parsed = JSON.parse(libVal || "null");
      state.locator = isValidLocator(parsed) ? parsed : null;
    } catch { state.locator = null; }
    try { state.selectedIds = JSON.parse(selVal || "[]"); } catch { state.selectedIds = []; }
    if (!Array.isArray(state.selectedIds)) state.selectedIds = [];
    const unsVal = saved?.unselected_ids ?? "[]";
    try { state.unselectedIds = JSON.parse(unsVal || "[]"); } catch { state.unselectedIds = []; }
    if (!Array.isArray(state.unselectedIds)) state.unselectedIds = [];
    // v3.20：恢复主列表显示方式（list / card）
    if (saved?.view === "card") state.view = "card"; else state.view = "list";
    // v3.34：恢复命名槽取值
    try { state.vars = JSON.parse(saved?.var_values || saved?.变量取值 || wVarValues?.value || "{}") || {}; } catch { state.vars = {}; }
    if (typeof state.vars !== "object" || Array.isArray(state.vars)) state.vars = {};
    if (wVarValues) wVarValues.value = JSON.stringify(state.vars);
    // v3.51：恢复通配符固定种子
    state.wcFixed = !!(saved?.wc_fixed);
    state.wcSeed = parseInt(saved?.wc_seed, 10) || 0;
    // 恢复到 widget 引用，供后续 _vplInputs 使用
    if (saved) {
      const sepV = saved.separator ?? saved.分隔符;
      const preV = saved.prepend ?? saved.前缀;
      const appV = saved.append ?? saved.后缀;
      const iwV = saved.ignore_weight ?? saved.忽略权重;
      const ldV = saved.library_data ?? saved.库数据;
      if (wLibrary) wLibrary.value = libVal;
      if (wSelected) wSelected.value = selVal;
      if (wSeparator && sepV != null) wSeparator.value = sepV;
      if (wPrepend && preV != null) wPrepend.value = preV;
      if (wAppend && appV != null) wAppend.value = appV;
      if (wIgnoreWeight && iwV != null) wIgnoreWeight.value = iwV;
      if (wLibraryData) wLibraryData.value = ldV || "";
    }
    const ldVal = wLibraryData?.value || saved?.library_data || saved?.库数据 || "";
    // 仅当定位是 inline（用户主动导入的内嵌库）时，libraryData 才用 widget.value。
    // 其他源（user/builtin/custom）一律从后端读，不允许 widget.value 覆盖——否则 ComfyUI
    // 反序列化节点时把 widget.value 设为工作流里的旧字符串，会把刚加载好的库清成 0 张卡。
    if (ldVal && state.locator && state.locator.source === "inline") {
      try { state.libraryData = JSON.parse(ldVal); } catch { state.libraryData = null; }
    } else {
      state.libraryData = null;
    }
  }

  function syncWidgets() {
    if (wLibrary) wLibrary.value = JSON.stringify(state.locator || { source: "user", name: "default" });
    if (wSelected) wSelected.value = JSON.stringify(state.selectedIds);
    if (wLibraryData) {
      wLibraryData.value = state.inline && state.libraryData
        ? JSON.stringify(state.libraryData)
        : "";
    }
    if (wVarValues) wVarValues.value = JSON.stringify(state.vars || {}); // v3.34：命名槽取值
    // widget 已从 node.widgets 移除，工作流持久化依赖 properties。
    // v3.50：持久化格式与注入格式解耦——_vplInputs 的键是后端接口名（v3.48 起中文），
    // properties._vpl 必须保持英文内部键（readWidgets 的读取契约 + 老工作流兼容），
    // 不能再把 _vplInputs() 直接赋给 properties._vpl
    node.properties = node.properties || {};
    node.properties._vpl = {
      library: wLibrary ? wLibrary.value : JSON.stringify({ source: "user", name: "default" }),
      selected_ids: wSelected ? wSelected.value : "[]",
      unselected_ids: JSON.stringify(state.unselectedIds),
      separator: wSeparator ? wSeparator.value : ", ",
      prepend: wPrepend ? wPrepend.value : "",
      append: wAppend ? wAppend.value : "",
      ignore_weight: wIgnoreWeight ? wIgnoreWeight.value : false,
      library_data: wLibraryData ? wLibraryData.value : "",
      var_values: wVarValues ? wVarValues.value : "{}",
      view: state.view,
      wc_fixed: !!state.wcFixed, // v3.51：通配符固定种子（前端开关，仅影响执行注入）
      wc_seed: Math.floor(state.wcSeed) || 0,
    };
    node.setDirtyCanvas?.(true, true);
  }

  // -------------------------------------------------------------------------
  // 数据加载
  // -------------------------------------------------------------------------
  async function checkBackendVersion() {
    // 版本握手：后端未重启到新版时（旧 Python 仍在跑），/version 会 404 或返回旧版本号。
    // 这是"前端已是新版但后端行为还是旧的"这类灵异问题的唯一可靠判据。
    try {
      const r = await fetch(API + "/version");
      if (!r.ok) {
        state.backendVersion = "未知(" + r.status + ")";
      } else {
        const res = await r.json();
        state.backendVersion = res.version || "未知";
      }
    } catch (e) {
      state.backendVersion = "无法连接";
    }
    if (state.backendVersion !== PLUGIN_VERSION) {
      console.warn(
        "%c[VPL ⚠] 前后端版本不一致！前端 " + PLUGIN_VERSION + " / 后端 " + state.backendVersion
        + " ——后端很可能没有重启到新版，请完全停止 ComfyUI 服务后重启（只刷新网页无效）",
        "color:#e67e22;font-weight:bold;font-size:14px"
      );
    }
    return state.backendVersion;
  }

  async function loadLibraries() {
    try {
      const res = await apiGet("/libraries");
      if (res.ok) {
        state.libraries = res.libraries || [];
      } else {
        console.warn("[VPL] /libraries 返回失败：", res);
        state.libraries = [];
      }
    } catch (e) {
      console.error("[VPL] 无法请求 /libraries（后端路由可能未注册）：", e);
      state.libraries = [];
    }
    try {
      const res = await apiGet("/separators");
      if (res.ok && res.separators) state.separators = res.separators;
    } catch (e) { /* 用默认 */ }
  }

  async function loadLibraryContent() {
    const mySeq = ++loadSeq;
    if (state.inline) {
      // inline 数据已在 state.libraryData
      if (!state.libraryData) state.libraryData = { name: state.locator.name, groups: [] };
      return;
    }
    if (!isValidLocator(state.locator)) {
      // 即使被竞态取代，仍要保证下次 render 看到一致状态
      state.libraryData = { name: "", groups: [] };
      return;
    }
    let data;
    try {
      const res = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(state.locator)));
      data = res.ok ? (res.library || { name: "", groups: [] }) : { name: "", groups: [] };
      if (!res.ok) console.warn("[VPL] /library 返回失败，locator:", JSON.stringify(state.locator), "resp:", res);
    } catch (e) {
      console.error("[VPL] /library 请求失败，locator:", JSON.stringify(state.locator), "err:", e);
      data = { name: "", groups: [] };
    }
    // 过期响应只落地 libraryData 兜底显示（不卡死在 null），但不得修剪选中集——
    // 陈旧库的 id 集合会误删新库的有效勾选（与抽卡节点 loadLibraryContent 同口径）
    const stale = mySeq !== loadSeq;
    state.libraryData = data;
    if (stale) return;
    // 过滤掉已不存在的 id
    const ids = new Set((data.groups || []).map((g) => g.id));
    state.selectedIds = state.selectedIds.filter((id) => ids.has(id));
    // v3.22：全量显示顺序——保留已持久化顺序，补齐缺漏（含已选组与新增组），剔除失效 id
    const prev = state.unselectedIds.filter((id) => ids.has(id));
    const missing = (data.groups || []).map((g) => g.id).filter((id) => !prev.includes(id));
    state.unselectedIds = [...prev, ...missing];
    // 双保险：用户 default 库为空时，回退到内置示例库（内置有 5 张示例卡）
    if (!(data.groups || []).length
        && state.locator.source === "user"
        && state.locator.name === "default"
        && state.libraries.some((l) => l.source === "builtin" && l.name === "default")) {
      console.log("[VPL] 用户 default 库为空，回退到内置示例库");
      state.locator = { source: "builtin", name: "default" };
      syncWidgets();
      return loadLibraryContent();
    }
  }

  async function saveLibrary() {
    if (state.readonly) return;
    if (state.inline) {
      syncWidgets(); // inline 数据直接写入 widget
      return;
    }
    try {
      await apiPost("/library/save", { locator: state.locator, data: state.libraryData });
    } catch (e) {
      alert("保存失败：" + e.message);
    }
  }

  // -------------------------------------------------------------------------
  // UI 构建
  // -------------------------------------------------------------------------
  const container = h("div", { class: "vpl-node" });

  // v3.47 迷你模式：节点区域过窄（宽 < MINI_WIDTH）时面板收成一个按钮，
  // 点击把 panelBody 摘到 body 上的浮壳里完整展示（.vpl-node 画布无背景，
  // 浮壳用 --vpl-pop-bg 补底），关闭时放回容器。
  const panelBody = h("div", { class: "vpl-panel-body" });
  const MINI_WIDTH = 300;
  let _mini = false;
  let miniOpen = false;
  let miniShell = null;
  const miniBtn = h("button", {
    class: "vpl-mini-btn",
    title: "打开提示词库面板",
    html: ICONS.list,
  });
  miniBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (miniOpen) closeMiniFloat(); else openMiniFloat();
  });

  // 库选择行：v3.1 改用自定义玻璃下拉（浏览器原生 select 弹出层无法跨平台重写样式）
  const libDD = createDropdown();
  els.libSelect = libDD.trigger;        // 保留旧接口名，下游可继续用 .value
  els.libPanel = libDD.panel;
  libDD.addEventListener("change", (v) => onLibraryChange(v));
  const libRow = h("div", { class: "vpl-row" }, [
    libDD.root,
  ]);

  // 搜索 + 分类
  els.searchInput = h("input", {
    type: "text", class: "vpl-input vpl-search",
    placeholder: "搜索名称 / 正文 / 标签",
  });
  let _searchTimer = null;
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value.trim().toLowerCase();
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(renderList, 140); // v3.27：搜索防抖，组多时避免每次按键全量重建 DOM
  });
  const searchIcon = h("span", { class: "vpl-search-icon", html: ICONS.search });
  const searchWrap = h("div", { class: "vpl-search-wrap" }, [searchIcon, els.searchInput]);
  // v3.7：分类下拉改玻璃风自定义 dropdown（原生 <select> 弹出层不可跨平台重写）
  // v3.12：分类下拉升级为多选
  const catDD = createDropdown({ className: "vpl-cat-dd", multi: true });
  els.catSelect = catDD.root;
  catDD.addEventListener("change", (v) => {
    state.categories = v || [];
    renderList();
  });
  // v3.12：标签筛选下拉（多选，与分类并列）
  const tagDD = createDropdown({ className: "vpl-tag-dd", multi: true });
  els.tagSelect = tagDD.root;
  tagDD.addEventListener("change", (v) => {
    state.tagsFilter = v || [];
    renderList();
  });
  // v3.20：主列表显示方式切换（列表行式 / 卡片网格），偏好随 properties._vpl 持久化
  function setViewMode(m) {
    if (state.view === m) return;
    state.view = m;
    els.viewListBtn.classList.toggle("vpl-btn-active", m === "list");
    els.viewCardBtn.classList.toggle("vpl-btn-active", m === "card");
    renderList();
    syncWidgets(); // 写回 properties._vpl.view，工作流保存后重开仍保持该视图
  }
  const viewToggle = h("div", { class: "vpl-view-toggle" });
  els.viewListBtn = iconButton(ICONS.list, "列表视图", () => setViewMode("list"), { active: state.view === "list" });
  els.viewCardBtn = iconButton(ICONS.grid, "卡片视图", () => setViewMode("card"), { active: state.view === "card" });
  viewToggle.append(els.viewListBtn, els.viewCardBtn);
  // v3.28：批量整理模式按钮（进入后卡片/行单击=切换批量选中，底部浮出操作条）
  els.bulkBtn = iconButton(ICONS.check, "批量整理", () => toggleBulkMode(), {});
  // v3.28：分类分区视图按钮（按分类分组、可折叠；组内拖拽/跨组拖=改分类）
  els.groupBtn = iconButton(ICONS.stack, "分类分区", () => toggleGroupBy(), {});

  const searchRow = h("div", { class: "vpl-row" }, [searchWrap]);
  const filtersRow = h("div", { class: "vpl-row vpl-filters-row" }, [catDD.root, tagDD.root, viewToggle, els.bulkBtn, els.groupBtn]);
  // v3.28：批量整理操作条容器（bulkMode 时显示，底部浮出批量加分类/加标签等）
  els.bulkBar = h("div", { class: "vpl-bulk-bar" });
  els.bulkBar.style.display = "none";

  // 列表
  els.list = h("div", { class: "vpl-list" });
  // v3.34：命名槽取值行（勾选的组含 {名称:选项} 时显示，位于筛选行与列表之间）
  els.varsBar = h("div", { class: "vpl-vars-bar" });
  els.varsBar.style.display = "none";
  // 空列表诊断/切库容器（独立于 list，不受 list 高度限制）
  els.emptyDiag = h("div", { class: "vpl-empty-diag" });

  // 新建卡片按钮
  els.newGroupBtn = h("button", {
    class: "vpl-btn vpl-new-group",
    onclick: () => newGroup(),
  }, [h("span", { class: "vpl-btn-icon", html: ICONS.plus }), "新建提示词组"]);

  // 底部栏
  els.countLabel = h("span", { class: "vpl-count" }, "已激活 0 组 · " + PLUGIN_VERSION);
  els.previewBtn = h("button", {
    class: "vpl-btn vpl-btn-sm vpl-preview-btn",
    onclick: () => {
      if (!state.libraryData) return;
      previewMerged({
        groups: state.libraryData.groups || [],
        selectedIds: state.selectedIds,
        separator: wSeparator.value || ", ",
        prepend: wPrepend.value || "",
        append: wAppend.value || "",
        ignoreWeight: !!(wIgnoreWeight && wIgnoreWeight.value),
        vars: { ...(state.vars || {}) }, // v3.34：预览与执行用同一套命名槽取值
      });
    },
  }, [h("span", { class: "vpl-btn-icon", html: ICONS.eye }), "预览合并"]);
  // v3.7：分隔符下拉改玻璃风自定义 dropdown（与库下拉同一套机制）
  const sepDD = createDropdown({ className: "vpl-sep-dd" });
  els.sepSelect = sepDD.root;
  sepDD.addEventListener("change", (v) => {
    if (v === "__custom__") {
      state.customSep = true;
      const val = prompt("输入自定义分隔符（\\n 表示换行）：", wSeparator.value || ", ");
      if (val) wSeparator.value = val.replace(/\\n/g, "\n");
    } else {
      state.customSep = false;
      wSeparator.value = v;
    }
    syncWidgets();
    renderSepSelect();
  });
  els.advBtn = iconButton(ICONS.settings, "高级设置", () => {
    state.showAdvanced = !state.showAdvanced;
    renderAdvanced();
    recalcHeight();
  });

  // v3.51：通配符固定种子开关（footer 🎲 按钮 + 弹出小面板）。
  // 默认「每次随机」= 旧版行为；开启后 random.Random(种子) 可复现，需要取消随时关掉。
  els.wcBtn = iconButton(ICONS.dice, "通配符：每次随机（点击可固定种子，复现抽取结果）", () => toggleWcPanel());
  function syncWcBtn() {
    els.wcBtn.classList.toggle("vpl-btn-active", state.wcFixed);
    els.wcBtn.title = state.wcFixed
      ? "通配符：固定种子 " + state.wcSeed + "（点击修改或取消固定）"
      : "通配符：每次随机（点击可固定种子，复现抽取结果）";
  }
  let wcPanel = null;
  function closeWcPanel() {
    if (!wcPanel) return;
    if (wcPanel._docHandler) document.removeEventListener("click", wcPanel._docHandler);
    if (wcPanel._keyHandler) document.removeEventListener("keydown", wcPanel._keyHandler);
    if (wcPanel._rafId) cancelAnimationFrame(wcPanel._rafId);
    wcPanel.remove();
    wcPanel = null;
  }
  function toggleWcPanel() {
    if (wcPanel) { closeWcPanel(); return; }
    const panel = h("div", { class: "vpl-quickpanel vpl-wcpanel" });
    panel.appendChild(h("div", { class: "vpl-quickpanel-title" }, "通配符随机策略"));

    const chk = h("input", { type: "checkbox", class: "vpl-checkbox" });
    chk.checked = state.wcFixed;
    chk.addEventListener("change", () => {
      state.wcFixed = chk.checked;
      syncWidgets(); syncWcBtn();
    });
    panel.appendChild(h("label", { class: "vpl-check-row" }, [
      chk, h("span", {}, "固定通配符（同种子结果可复现）"),
    ]));

    const seedInput = h("input", { type: "text", class: "vpl-input", inputmode: "numeric", spellcheck: "false" });
    seedInput.value = String(state.wcSeed);
    seedInput.addEventListener("input", () => {
      const v = parseInt((seedInput.value || "").replace(/[^0-9]/g, ""), 10);
      state.wcSeed = isNaN(v) ? 0 : v;
      syncWidgets(); syncWcBtn();
    });
    const dice = iconButton(ICONS.dice, "换一个种子", () => {
      state.wcSeed = Math.floor(Math.random() * 9007199254740991);
      seedInput.value = String(state.wcSeed);
      state.wcFixed = true; chk.checked = true;
      syncWidgets(); syncWcBtn();
    });
    const seedRow = h("div", { class: "vpl-wcpanel-seedrow" }, [seedInput, dice]);
    panel.appendChild(seedRow);
    panel.appendChild(h("div", { class: "vpl-hint" },
      "关闭 = 每次执行重新抽取（默认）；开启后相同种子输出相同结果，可随工作流保存"));

    document.body.appendChild(panel);
    wcPanel = panel;
    // 定位：贴按钮、四边界安全；rAF 每帧校正（画布平移/缩放时 fixed 弹窗不会自动跟随）
    const anchorRect = els.wcBtn.getBoundingClientRect();
    const getRect = () => els.wcBtn.isConnected ? els.wcBtn.getBoundingClientRect() : anchorRect;
    const place = () => {
      const r = getRect();
      const w = panel.offsetWidth || 240, ph = panel.offsetHeight || 160;
      const gap = 6, vw = window.innerWidth, vh = window.innerHeight;
      let left = Math.min(Math.max(8, r.left), vw - w - 8);
      let top = r.bottom + gap;
      if (top + ph > vh - 8) top = Math.max(8, r.top - ph - gap);
      panel.style.position = "fixed";
      panel.style.zIndex = "100000";
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    };
    place();
    const follow = () => {
      if (wcPanel !== panel) return;
      place();
      panel._rafId = requestAnimationFrame(follow);
    };
    panel._rafId = requestAnimationFrame(follow);
    panel._docHandler = (e) => { if (!panel.contains(e.target) && e.target !== els.wcBtn) closeWcPanel(); };
    panel._keyHandler = (e) => { if (e.key === "Escape") closeWcPanel(); };
    setTimeout(() => {
      document.addEventListener("click", panel._docHandler);
      document.addEventListener("keydown", panel._keyHandler);
    }, 0);
    syncWcBtn();
  }

  const footer = h("div", { class: "vpl-footer" }, [
    els.countLabel, els.previewBtn, els.sepSelect, els.wcBtn, els.advBtn,
  ]);

  // 高级设置
  els.prependInput = h("input", {
    type: "text", class: "vpl-input", placeholder: "全局前置文本（可选）",
  });
  els.appendInput = h("input", {
    type: "text", class: "vpl-input", placeholder: "全局后置文本（可选）",
  });
  els.prependInput.addEventListener("input", () => { wPrepend.value = els.prependInput.value; syncWidgets(); });
  els.appendInput.addEventListener("input", () => { wAppend.value = els.appendInput.value; syncWidgets(); });

  els.exportBtn = h("button", { class: "vpl-btn vpl-btn-sm", onclick: exportLibrary }, "导出 JSON");
  els.saveAsBtn = h("button", { class: "vpl-btn vpl-btn-sm", onclick: saveAsUserLibrary }, "另存为用户库");
  els.readonlyHint = h("div", { class: "vpl-hint vpl-readonly-hint" }, "当前库为只读，可编辑后「另存为用户库」或导出。");

  els.ignoreWeightChk = h("input", { type: "checkbox", class: "vpl-checkbox" });
  els.ignoreWeightChk.addEventListener("change", () => {
    if (wIgnoreWeight) wIgnoreWeight.value = els.ignoreWeightChk.checked;
    syncWidgets();
  });

  els.advanced = h("div", { class: "vpl-advanced" }, [
    h("div", { class: "vpl-field-label" }, "前置文本"),
    els.prependInput,
    h("div", { class: "vpl-field-label" }, "后置文本"),
    els.appendInput,
    h("label", { class: "vpl-check-row" }, [
      els.ignoreWeightChk,
      h("span", {}, "忽略权重（生视频提示词不需要 (text:w) 包裹）"),
    ]),
    h("div", { class: "vpl-row vpl-adv-actions" }, [els.exportBtn, els.saveAsBtn]),
    els.readonlyHint,
  ]);

  panelBody.appendChild(libRow);
  panelBody.appendChild(searchRow);
  panelBody.appendChild(filtersRow);
  panelBody.appendChild(els.varsBar);
  panelBody.appendChild(els.bulkBar);
  panelBody.appendChild(els.list);
  panelBody.appendChild(els.emptyDiag);
  panelBody.appendChild(els.newGroupBtn);
  panelBody.appendChild(footer);
  panelBody.appendChild(els.advanced);
  container.appendChild(miniBtn);
  container.appendChild(panelBody);

  // 迷你模式：进入/退出只切 class；浮壳的显隐初值即最终态（无过渡，防动画冻结假象）
  function updateMiniMode() {
    // 远缩放/离屏时容器被 display:none 剔除（宽高为 0），测量无意义，跳过
    const w = container.clientWidth;
    if (w === 0) return;
    const should = w < MINI_WIDTH;
    if (should === _mini) return;
    _mini = should;
    container.classList.toggle("vpl-mini", _mini);
    if (!_mini) closeMiniFloat();
    recalcHeight();
  }

  function placeMiniFloat() {
    if (!miniShell || !miniOpen) return;
    const r = miniBtn.getBoundingClientRect();
    const pw = miniShell.offsetWidth || NODE_WIDTH;
    const ph = miniShell.offsetHeight || 320;
    let left = r.right + 8;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 8);
    let top = Math.max(8, Math.min(r.top, window.innerHeight - ph - 8));
    miniShell.style.left = left + "px";
    miniShell.style.top = top + "px";
  }

  function openMiniFloat() {
    if (miniOpen || miniShell) return;
    miniOpen = true;
    miniShell = h("div", { class: "vpl-node vpl-mini-float" }, [panelBody]);
    // 初值即最终态：先定尺寸再入文档，避免首帧错位
    document.body.appendChild(miniShell);
    placeMiniFloat();
    window.addEventListener("resize", placeMiniFloat);
    // 外点关闭 + Esc；setTimeout(0) 避免把触发本次 open 的 click 当成外点
    setTimeout(() => {
      if (!miniShell) return;
      miniShell._docHandler = (e) => {
        if (miniBtn.contains(e.target)) return; // 按钮自身交给 toggle
        if (!miniShell.contains(e.target)) closeMiniFloat();
      };
      miniShell._keyHandler = (e) => { if (e.key === "Escape") closeMiniFloat(); };
      document.addEventListener("click", miniShell._docHandler, true);
      document.addEventListener("keydown", miniShell._keyHandler);
    }, 0);
  }

  function closeMiniFloat() {
    if (!miniOpen) return;
    miniOpen = false;
    if (miniShell) {
      if (miniShell._docHandler) document.removeEventListener("click", miniShell._docHandler, true);
      if (miniShell._keyHandler) document.removeEventListener("keydown", miniShell._keyHandler);
      window.removeEventListener("resize", placeMiniFloat);
      miniBtn.after(panelBody); // 放回容器
      miniShell.remove();
      miniShell = null;
    }
    recalcHeight();
  }

  // 节点删除时若浮壳/浮层还开着，一并回收（rAF 循环与 document 监听随闭包释放）
  const _origOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    _origOnRemoved?.apply(this, arguments);
    closeMiniFloat();
    closeQuickEdit();
    closeWcPanel();
  };

  // DOM widget
  //   resize:false —— 禁用节点缩放手柄，避免 LiteGraph 把节点拉宽后 chrome
  //     重新分配导致 DOM widget 区域位置漂移。
  //
  // 关键修复（v2.16）：前 v2.11→v2.15 都没解决「DOM widget 区域被 LiteGraph
  //   多分配 ~380px 高度」的真因。LiteGraph 给节点加了 6 个 input slots 占位
  //   （即使 widget 已物理移除，每个 slot ~35px），加上 DOM widget 区域用
  //   `container.scrollHeight` 测量，而 scrollHeight 在父容器高度 > 内容时
  //   报告父容器高度（不是内容真实高度），导致节点被反复拉高。
  //   修法：
  //     1. `realContentH()` —— 临时把容器设成 height:auto 量出真实内容高
  //     2. 接管 `node.computeSize` —— 直接返回「真实内容高 + chrome buffer」
  //     3. `resize:false` 保留 —— 节点宽不可拖
  //     4. CSS `.vpl-node { height:auto; align-self:flex-start }` —— 不被父拉伸
  const domWidget = node.addDOMWidget("vpl_ui", "VPL_UI", container, {
    getValue() { return ""; },
    setValue() {},
    resize: false,
  });

  // v3.51：旁路视觉同步 + 执行期间锁定（共享模块 panel_guard.js）
  installBypassSync(node, container);
  installExecutionLock(node, container);
  syncWcBtn(); // 恢复持久化的通配符固定状态后刷新按钮提示

  // 真实内容高度（绕过父容器强加高度的关键）
  //   - 先把 container 临时设成 height:auto + max-height:none
  //   - 强制 reflow 后读 scrollHeight（这时 scrollHeight = offsetHeight = 内容真实高度）
  //   - 恢复原 inline style
  let _lastGoodH = 460;
  function realContentH() {
    // 远缩放/节点离屏时前端会 display:none 隐藏 DOM 面板（容器高度归 0），
    // ResizeObserver / computeSize 仍会调到本函数；此时测量值无意义，
    // 返回上次可见时的缓存高度，防止节点高度被错误改写（拉远再拉回后尺寸不准的根因）
    if (!container.isConnected || container.getBoundingClientRect().height === 0) return _lastGoodH;
    const prevH = container.style.height;
    const prevMax = container.style.maxHeight;
    container.style.height = "auto";
    container.style.maxHeight = "none";
    void container.offsetHeight; // 强制 reflow
    const h = container.scrollHeight;
    container.style.height = prevH;
    container.style.maxHeight = prevMax;
    if (h > 0) _lastGoodH = h;
    return h > 0 ? h : 460;
  }

  // 接管 node.computeSize（v2.11/v2.14 试过但当时 scrollHeight 被父容器污染）
  //   返回 [width, contentH + chrome 高 + 底缝]
  //   v3.52：chrome 高改读实际 domWidget.y（标题+输出槽区）——写死 50 会随输出槽数量
  //   错位（2 输出实测 y≈58）。
  //   v3.53：底部留 18px 节点色底缝（与左右 10px 节点色边框呼应，把面板包住）；
  //   想调缝宽只改 BOTTOM_GAP 一个数。
  const BOTTOM_GAP = 18;
  function chromeH() {
    const y = domWidget && typeof domWidget.y === "number" ? domWidget.y : 0;
    return y > 0 ? y : 50;
  }
  try {
    node.computeSize = function (out) {
      out = out || [0, 0];
      const contentH = realContentH();
      out[0] = NODE_WIDTH; // v3.26：固定最小宽度，不再引用 node.size[0]，否则拉大后 computeSize 返回的 minWidth 同步变大、resize 手柄无法缩回
      out[1] = contentH + chromeH() + BOTTOM_GAP;
      return out;
    };
  } catch (e) { /* 旧版前端可能不可写，忽略 */ }

  // 存储 widget 已在前面物理移除，DOM 面板是节点上唯一 widget，自然紧跟标题。
  // 若前端稍后又按定义补建了同名存储 widget，再次移除以防黑块复发。
  function pruneStrayWidgets() {
    if (!node.widgets) return;
    const next = node.widgets.filter((w) => w === domWidget);
    if (next.length !== node.widgets.length) {
      console.warn("[VPL] 检测到存储 widget 复发，已再次移除：",
        node.widgets.map((w) => w.name));
      node.widgets = next;
    }
  }
  // 新版前端可能在节点创建/工作流加载/重排等多个时点补建 widget，
  // 拉长观察窗口，覆盖工作流恢复（onConfigure 通常在几百 ms 内）的场景
  [0, 200, 800, 1600, 3000].forEach((t) => setTimeout(pruneStrayWidgets, t));

  // 监听容器尺寸变化（v3.47：同时驱动迷你模式进出判定）
  const ro = new ResizeObserver(() => { updateMiniMode(); recalcHeight(); });
  ro.observe(container);
  updateMiniMode();

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  function renderLibSelect() {
    // v3.1: 自定义 dropdown 替代原生 <select>（弹出层跨平台重写限制）
    const groups = { builtin: [], user: [] };
    state.libraries.forEach((l) => {
      if (groups[l.source]) groups[l.source].push(l);
    });
    for (const src of ["builtin", "user"]) {
      groups[src].sort((a, b) => {
        const ac = a.count || 0, bc = b.count || 0;
        if ((bc > 0) !== (ac > 0)) return bc > 0 ? 1 : -1;
        if (ac !== bc) return bc - ac;
        return (a.display_name || "").localeCompare(b.display_name || "", "zh");
      });
    }
    // v3.1 去重：用户目录下已存在同名（如 default）时，隐藏内置同名项，避免视觉重复
    const userNames = new Set(groups.user.map((l) => l.name));
    const visibleBuiltin = groups.builtin.filter((l) => !userNames.has(l.name));
    const hiddenBuiltinCount = groups.builtin.length - visibleBuiltin.length;

    // 构造 items 列表
    const items = [];
    // 当前 locator（如果是非 builtin/user 源，如 inline/custom）放在最前
    if (state.locator && (state.locator.source === "inline" || state.locator.source === "custom")) {
      const curLabel = locatorLabel(state.locator);
      items.push({
        group: "当前",
        label: curLabel,
        value: JSON.stringify(state.locator),
      });
    }
    if (groups.user.length) {
      groups.user.forEach((l) => {
        const cnt = l.count || 0;
        const tag = cnt > 0 ? ` · ${cnt} 张` : " · (空)";
        items.push({
          group: "用户库",
          label: l.display_name + tag,
          value: JSON.stringify({ source: l.source, name: l.name }),
          badge: "我的",
        });
      });
    }
    if (visibleBuiltin.length) {
      visibleBuiltin.forEach((l) => {
        const cnt = l.count || 0;
        const tag = cnt > 0 ? ` · ${cnt} 张` : " · (空)";
        items.push({
          group: "内置库（只读）",
          label: l.display_name + tag,
          value: JSON.stringify({ source: l.source, name: l.name }),
          badge: "只读",
        });
      });
    }
    if (hiddenBuiltinCount > 0) {
      items.push({
        group: "内置库（只读）",
        label: `（${hiddenBuiltinCount} 个内置库因用户已有同名副本而隐藏）`,
        value: "__hidden_builtin__",
        disabled: true,
      });
    }
    // 操作项
    items.push({ group: "操作", label: "＋ 新建用户库…", value: "__create__" });
    items.push({ group: "操作", label: "📥 导入文件（内嵌）…", value: "__import__" });
    items.push({ group: "操作", label: "📄 引用外部文件路径…", value: "__custom__" });

    libDD.setItems(items);

    // 同步按钮显示文字为当前选中项
    if (state.locator) {
      const curVal = JSON.stringify(state.locator);
      const cur = items.find((it) => it.value === curVal);
      libDD.setLabel(cur ? cur.label : locatorLabel(state.locator));
    } else {
      libDD.setLabel("未选择");
    }
  }

  // v3.15：点击卡片上的分类/标签 chip → 就地编辑该卡片的分类/标签（非筛选，筛选在顶部）
  let quickEditPanel = null;
  function closeQuickEdit() {
    if (!quickEditPanel) return;
    if (quickEditPanel._rafId) cancelAnimationFrame(quickEditPanel._rafId);
    if (quickEditPanel._docHandler) document.removeEventListener("click", quickEditPanel._docHandler);
    if (quickEditPanel._keyHandler) document.removeEventListener("keydown", quickEditPanel._keyHandler);
    if (quickEditPanel._place) {
      window.removeEventListener("resize", quickEditPanel._place);
      const sc = quickEditPanel._scrollHost;
      if (sc) sc.removeEventListener("scroll", quickEditPanel._place, true);
    }
    quickEditPanel.remove();
    quickEditPanel = null;
  }
  function quickEditFor(g, kind, anchor) {
    closeQuickEdit();
    const isCat = kind === "cat";
    const curSet = new Set(isCat ? groupCats(g) : (g.tags || []));
    const panel = h("div", { class: "vpl-quickpanel" });
    panel.appendChild(h("div", { class: "vpl-quickpanel-title" }, isCat ? "编辑分类 · 点选切换" : "编辑标签 · 点选切换"));

    // 自定义新值输入：回车即加入并保存
    const input = h("input", { type: "text", class: "vpl-input vpl-quickpanel-input", placeholder: isCat ? "新增分类后回车…" : "新增标签后回车…" });
    const commitInput = () => {
      const v = input.value.trim();
      if (!v || curSet.has(v)) { input.value = ""; return; }
      curSet.add(v);
      applyAndRebuild();
      input.value = "";
      input.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commitInput(); }
    });
    panel.appendChild(input);

    const grid = h("div", { class: "vpl-qp-grid" });
    function applyAndRebuild() {
      if (isCat) { g.categories = [...curSet]; delete g.category; }
      else { g.tags = [...curSet]; }
      saveLibrary();
      renderList();
      rebuild();
    }
    function rebuild() {
      grid.innerHTML = "";
      const items = (isCat ? existingCategories() : allTagsList()).slice();
      const seen = new Set();
      const ordered = [];
      [...curSet].forEach((v) => { if (!seen.has(v)) { seen.add(v); ordered.push(v); } }); // 已选排前
      items.forEach((v) => { if (!seen.has(v)) { seen.add(v); ordered.push(v); } });
      if (!ordered.length) {
        grid.appendChild(h("div", { class: "vpl-quickpanel-empty" }, "暂无已有项，输入新增"));
        return;
      }
      ordered.forEach((v) => {
        const on = curSet.has(v);
        const chip = h("button", { class: "vpl-qp-chip" + (on ? " vpl-qp-on" : ""), type: "button" }, v);
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          if (curSet.has(v)) curSet.delete(v); else curSet.add(v);
          applyAndRebuild();
        });
        grid.appendChild(chip);
      });
    }
    panel.appendChild(grid);

    const foot = h("div", { class: "vpl-quickpanel-foot" });
    const clearBtn = h("button", { class: "vpl-btn vpl-btn-ghost", type: "button" }, "清空");
    clearBtn.addEventListener("click", (e) => { e.stopPropagation(); curSet.clear(); applyAndRebuild(); });
    const doneBtn = h("button", { class: "vpl-btn vpl-btn-primary", type: "button" }, "完成");
    doneBtn.addEventListener("click", (e) => { e.stopPropagation(); closeQuickEdit(); });
    foot.append(clearBtn, doneBtn);
    panel.appendChild(foot);

    document.body.appendChild(panel);
    quickEditPanel = panel; // 关键：记录当前浮层引用，否则 closeQuickEdit 因 quickEditPanel 为 null 直接返回、无法关闭
    rebuild(); // 关键：打开时立即填充初始可选分类/标签，否则 grid 为空（v3.17 重写时漏掉此调用导致浮层看不到可选项）
    // 定位：贴 chip、四边界安全；用打开时快照坐标，避免点选触发 renderList 重建 chip 后定位跳变
    const anchorRect = anchor.getBoundingClientRect();
    const getRect = () => (anchor && anchor.isConnected) ? anchor.getBoundingClientRect() : anchorRect;
    const place = () => {
      const r = getRect();
      const w = panel.offsetWidth || 260;
      const ph = panel.offsetHeight || 200;
      const gap = 6, vw = window.innerWidth, vh = window.innerHeight;
      let left = r.left;
      if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
      if (left < 8) left = 8;
      let top = r.bottom + gap;
      if (top + ph > vh - 8) {
        top = r.top - ph - gap;            // 底部放不下 → 弹到芯片上方
        if (top < 8) top = Math.max(8, vh - ph - 8);
      }
      panel.style.position = "fixed";
      panel.style.zIndex = "100000";
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    };
    place();
    panel._place = place;
    // v3.19：用 rAF 每帧重定位，使弹窗在画布平移/缩放/列表滚动时始终贴合芯片
    // （ComfyUI 画布 #graph 带 transform，fixed 弹窗不会自动跟随，须手动每帧校正）
    const follow = () => {
      if (quickEditPanel !== panel) return;
      place();
      panel._rafId = requestAnimationFrame(follow);
    };
    panel._rafId = requestAnimationFrame(follow);
    window.addEventListener("resize", place);
    // 外部点击 / ESC 关闭
    panel._docHandler = (e) => { if (!panel.contains(e.target)) closeQuickEdit(); };
    panel._keyHandler = (e) => { if (e.key === "Escape") closeQuickEdit(); };
    setTimeout(() => {
      document.addEventListener("click", panel._docHandler);
      document.addEventListener("keydown", panel._keyHandler);
    }, 0);
    input.focus();
  }

  // v3.12：分类 + 标签 两个多选筛选下拉，随库内容刷新
  function renderFilters() {
    const cats = new Set();
    (state.libraryData?.groups || []).forEach((g) => groupCats(g).forEach((c) => cats.add(c)));
    const catItems = [{ label: "• 清除分类筛选", value: "__clear__" }];
    [...cats].sort().forEach((c) => catItems.push({ label: c, value: c }));
    catDD.setValueSilent(state.categories);
    catDD.setItems(catItems);

    const tags = new Set();
    (state.libraryData?.groups || []).forEach((g) => (g.tags || []).forEach((t) => t && tags.add(t)));
    const tagItems = [{ label: "• 清除标签筛选", value: "__clear__" }];
    [...tags].sort().forEach((t) => tagItems.push({ label: t, value: t }));
    tagDD.setValueSilent(state.tagsFilter);
    tagDD.setItems(tagItems);
  }

  function renderSepSelect() {
    const items = state.separators.map((s) => ({ label: s.label, value: s.value }));
    items.push({ label: "自定义…", value: "__custom__" });
    const cur = wSeparator.value || ", ";
    const known = state.separators.some((s) => s.value === cur);
    const knownLabel = known ? (state.separators.find((s) => s.value === cur)?.label || cur) : "自定义…";
    sepDD.setValueSilent(known ? cur : "__custom__");
    sepDD.setItems(items);
    sepDD.setLabel(knownLabel);
  }

  // 空状态插画：kind = "library"（库空）| "filter"（过滤无匹配）
  function emptyIllustration(kind) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "vpl-empty-svg");
    svg.setAttribute("viewBox", "0 0 120 90");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (kind === "filter") {
      // 放大镜 + 斜杠：无匹配
      svg.innerHTML =
        '<circle cx="50" cy="40" r="25" stroke="currentColor" stroke-width="3"/>' +
        '<line x1="38" y1="40" x2="62" y2="40" stroke="currentColor" stroke-width="3" opacity=".5"/>' +
        '<line x1="69" y1="59" x2="94" y2="84" stroke="currentColor" stroke-width="3"/>';
    } else {
      // 空卡堆叠：空库
      svg.innerHTML =
        '<rect x="28" y="32" width="58" height="42" rx="8" stroke="currentColor" stroke-width="3" opacity=".4"/>' +
        '<rect x="37" y="24" width="58" height="42" rx="8" stroke="currentColor" stroke-width="3" opacity=".7"/>' +
        '<rect x="46" y="16" width="58" height="42" rx="8" stroke="currentColor" stroke-width="3"/>' +
        '<line x1="58" y1="32" x2="92" y2="32" stroke="currentColor" stroke-width="3" opacity=".6"/>' +
        '<line x1="58" y1="42" x2="86" y2="42" stroke="currentColor" stroke-width="3" opacity=".4"/>' +
        '<line x1="58" y1="52" x2="80" y2="52" stroke="currentColor" stroke-width="3" opacity=".25"/>';
    }
    return svg;
  }

  // 列表过滤的唯一口径：分类/标签筛选 + 搜索关键词。renderList 与批量模式
  // 「全选」共用，保证“全选”选中的就是当前能看到的那批组（v3.58 修正口径分叉）
  function groupMatchesFilters(g) {
    const cats = groupCats(g);
    if (state.categories.length && !state.categories.some((c) => cats.includes(c))) return false;
    if (state.tagsFilter.length && !(g.tags || []).some((t) => state.tagsFilter.includes(t))) return false;
    if (!state.search) return true;
    return [g.name, cats.join(","), g.positive, g.negative, g.note, (g.tags || []).join(",")]
      .filter(Boolean).some((t) => t.toLowerCase().includes(state.search));
  }

  function renderList() {
    const list = els.list;
    list.innerHTML = "";
    list.classList.toggle("vpl-list-cards", state.view === "card"); // v3.20：卡片视图切 grid 布局
    els.emptyDiag.innerHTML = "";
    const groups = state.libraryData?.groups || [];
    // 诊断：每次进入 renderList 时记录，便于排竞态 / 覆盖 bug
    if (!groups.length) {
      console.warn("[VPL] renderList 第 N 次，库空：", {
        N: (window.__vplRenderCount = (window.__vplRenderCount || 0) + 1),
        locator: JSON.stringify(state.locator),
        libraryData: state.libraryData ? JSON.stringify(state.libraryData).slice(0, 80) : "null",
        backendVersion: state.backendVersion,
        libraries: state.libraries.length,
      });
    }

    const filtered = groups.filter(groupMatchesFilters);

    // v3.22：全量显示顺序（含已选组）作为基础顺序，拖拽即改序
    const ordered = [];
    const seen = new Set();
    for (const id of state.unselectedIds) {
      const g = groups.find((x) => x.id === id);
      if (g && filtered.includes(g)) { ordered.push(g); seen.add(g.id); }
    }
    // 补齐未排入顺序数组的（新增/副本/旧数据迁移），按库顺序排在末尾
    for (const g of filtered) {
      if (!seen.has(g.id)) { ordered.push(g); seen.add(g.id); }
    }

    // v3.28：渲染单组（激活态 + 批量选中态）
    const renderOne = (g) => list.appendChild(renderItem(g, state.selectedIds.includes(g.id), list));

    // v3.28：收藏置顶区（star 组始终在前，可折叠）
    const starred = ordered.filter((g) => g.star);
    const rest = ordered.filter((g) => !g.star);
    if (starred.length) {
      const collapsed = state.collapsedStar;
      const hdr = h("div", { class: "vpl-sec-header vpl-star-header" + (collapsed ? " vpl-collapsed" : "") }, [
        h("span", { class: "vpl-sec-title" }, `★ 收藏 ${starred.length}${collapsed ? "（已折叠）" : ""}`),
        h("button", { class: "vpl-sec-toggle", title: collapsed ? "展开" : "折叠", onclick: () => { state.collapsedStar = !state.collapsedStar; renderList(); } }, collapsed ? "▸" : "▾"),
      ]);
      list.appendChild(hdr);
      if (!collapsed) starred.forEach(renderOne);
    }

    // v3.28：主体——分类分区视图 or 单一流
    if (state.groupBy === "category") {
      const catOrder = existingCategories();
      const byCat = new Map();
      const uncat = [];
      rest.forEach((g) => {
        const cs = groupCats(g);
        if (!cs.length) { uncat.push(g); return; }
        cs.forEach((c) => { if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(g); });
      });
      const renderCat = (cat, items, isUncat) => {
        const collapsed = !isUncat && state.collapsedCats.has(cat);
        const hdr = h("div", { class: "vpl-sec-header vpl-cat-header" + (collapsed ? " vpl-collapsed" : "") }, [
          h("span", { class: "vpl-sec-title" }, `${collapsed ? "▸" : "▾"} ${isUncat ? "（无分类）" : cat} ${items.length}`),
        ]);
        if (!isUncat) hdr.addEventListener("click", () => {
          if (collapsed) state.collapsedCats.delete(cat); else state.collapsedCats.add(cat);
          renderList();
        });
        list.appendChild(hdr);
        if (!collapsed) items.forEach(renderOne);
      };
      catOrder.forEach((c) => { if (byCat.has(c)) renderCat(c, byCat.get(c), false); });
      for (const [c, items] of byCat) if (!catOrder.includes(c)) renderCat(c, items, false);
      if (uncat.length) renderCat("（无分类）", uncat, true);
    } else {
      if (rest.length) {
        list.appendChild(h("div", { class: "vpl-section-label" },
          `共 ${rest.length} 组（拖拽排序）· 已激活 ${state.selectedIds.length}`));
        rest.forEach(renderOne);
      }
    }
    if (!filtered.length) {
      let msg;
      if (!groups.length && (!state.libraries || !state.libraries.length)) {
        msg = "⚠ 无法从后端加载库。请确认已重启 ComfyUI 服务（不是只刷新网页），"
            + "并查看终端是否有 [AllBuy_PromptLibrary] 已加载 日志。";
      } else if (groups.length) {
        msg = "没有匹配的提示词组";
      } else {
        msg = "📭 当前库为空，点下方「新建提示词组」或换库试试。";
      }
      const host = els.emptyDiag;
      host.appendChild(emptyIllustration(groups.length ? "filter" : "library"));
      host.appendChild(h("div", { class: "vpl-empty" }, msg));
      // 空库时提供一键切到内置示例库的入口，避免用户卡在自建空库
      if (!groups.length) {
        const builtin = (state.libraries || []).find(
          (l) => l.source === "builtin" && l.name === "default"
        );
        const onBuiltin =
          state.locator && state.locator.source === "builtin" && state.locator.name === "default";
        if (builtin && !onBuiltin) {
          const btn = h(
            "button",
            {
              class: "vpl-empty-action",
              onclick: () => switchLibrary({ source: "builtin", name: "default" }, null),
            },
            "打开内置示例库（5 张卡）"
          );
          host.appendChild(btn);
        }
        // v2.10：当前用户空库时，给一个「删除该空库」红色次按钮。
        // 严格限制 user 源 + 有 name，防止误删 builtin，也防 builtin 报错。
        if (state.locator && state.locator.source === "user" && state.locator.name) {
          const userName = state.locator.name;
          const delBtn = h(
            "button",
            {
              class: "vpl-empty-action vpl-danger",
              onclick: async () => {
                if (!confirm(`确定删除用户库「${userName}」吗？\n\n该操作不可撤销。`)) return;
                try {
                  const res = await apiPost("/library/delete", { name: userName });
                  if (res && res.ok) {
                    console.log(`[VPL] 已删除空库 user/${userName}`);
                    // 重新拉库列表，按「非空优先」自动落到下一个非空库
                    await loadLibraries();
                    const next = state.libraries.find((l) => l.source === "user" && (l.count || 0) > 0)
                      || state.libraries.find((l) => l.source === "user" && l.name !== userName)
                      || state.libraries.find((l) => l.source === "user")
                      || state.libraries.find((l) => l.source === "builtin");
                    if (next) {
                      await switchLibrary({ source: next.source, name: next.name }, null);
                    } else {
                      renderAll();
                    }
                  } else {
                    alert("删除失败：" + ((res && res.error) || "未知错误"));
                  }
                } catch (e) {
                  alert("删除出错：" + (e && e.message || e));
                }
              },
            },
            "🗑 删除当前空库「" + userName + "」"
          );
          host.appendChild(delBtn);
        }
        const diag = {
          后端版本: state.backendVersion || "未取得",
          库列表数: (state.libraries || []).length,
          定位: state.locator ? JSON.stringify(state.locator) : "无",
          库数据: state.libraryData ? `${(state.libraryData.groups || []).length} 组` : "null",
        };
        console.warn("[VPL] 空列表诊断：", diag);
        const dt = h("details", { class: "vpl-diag" }, [
          h("summary", {}, "📋 诊断信息（点击展开）"),
          h("pre", { class: "vpl-diag-pre" }, JSON.stringify(diag, null, 2)),
        ]);
        host.appendChild(dt);
      }
    }

    const verSuffix = state.backendVersion && state.backendVersion !== PLUGIN_VERSION
      ? `${PLUGIN_VERSION} / 后端${state.backendVersion} ⚠`
      : PLUGIN_VERSION;
    els.countLabel.textContent = state.bulkMode
      ? `批量模式 · 已选 ${state.bulkSelection.size} 组`
      : `已激活 ${state.selectedIds.length} 组 · ${verSuffix}`;
    renderVars(); // v3.34：命名槽取值行随选择/库变化刷新
    requestAnimationFrame(recalcHeight);
  }

  // -------------------------------------------------------------------------
  // v3.34：命名槽取值行 —— 组文本里写 {名称:选项1|选项2}，此处固定取值；留空=按选项随机
  // （SLOT_RE / TAG_RE / parseSlotContent 已提升到模块级，v3.43 抽卡节点变量行共用）
  // -------------------------------------------------------------------------
  function collectSelectedSlots() {
    // 仅扫描已勾选组的 positive/negative/prefix/suffix，返回 Map(name -> Set(选项))
    // 兼容三种写法：{名称:选项|选项} 命名槽 / {名称} 占位符 / #名称# 属性标签（v3.35）
    const slots = new Map();
    const addSlot = (name, opts) => {
      if (!slots.has(name)) slots.set(name, new Set());
      (opts || []).forEach((o) => slots.get(name).add(o));
    };
    (state.libraryData?.groups || []).forEach((g) => {
      if (!state.selectedIds.includes(g.id)) return;
      [g.positive, g.negative, g.prefix, g.suffix].forEach((raw) => {
        if (!raw) return;
        const t = raw.replace(/＃/g, "#"); // 全角＃兼容
        if (t.includes("{")) {
          SLOT_RE.lastIndex = 0;
          let m;
          while ((m = SLOT_RE.exec(t))) {
            const info = parseSlotContent(m[1]);
            if (info) addSlot(info.name, info.options);
          }
        }
        if (t.includes("#")) {
          TAG_RE.lastIndex = 0;
          let m;
          while ((m = TAG_RE.exec(t))) addSlot(m[1], []);
        }
      });
    });
    return slots;
  }

  function renderVars() {
    if (!els.varsBar) return;
    const slots = collectSelectedSlots();
    const names = [...slots.keys()];
    if (!names.length) {
      els.varsBar.style.display = "none";
      els.varsBar.innerHTML = "";
      els._varsSig = "";
      return;
    }
    // 清掉已不存在的槽取值，保持 widget JSON 干净
    for (const k of Object.keys(state.vars)) if (!slots.has(k)) delete state.vars[k];
    const sig = names.map((n) => n + "=" + [...slots.get(n)].join("/")).join(";");
    const rebuild = sig !== els._varsSig; // 选项集没变就不重建 DOM，避免弹窗输入中丢焦点
    els._varsSig = sig;
    els.varsBar.style.display = "flex";
    if (!rebuild) {
      // 只同步 chip 文案与高亮（值可能在弹窗里刚改过）；data-slot 缺失则强制重建
      let stale = false;
      els.varsBar.querySelectorAll(".vpl-var-chip").forEach((chip) => {
        const name = chip.dataset.slot;
        if (!name) { stale = true; return; }
        const val = state.vars[name] || "";
        chip.classList.toggle("vpl-var-chip-filled", !!val);
        chip.textContent = val ? `${name}＝${val.length > 8 ? val.slice(0, 8) + "…" : val}` : name;
      });
      if (!stale) return;
    }
    els.varsBar.innerHTML = "";
    els._varsSig = sig;
    els.varsBar.appendChild(h("span", {
      class: "vpl-vars-title",
      title: "组文本里写 #名称# 或 {名称:选项1|选项2} 即出现此变量行；点击标签弹出输入框填值",
    }, `变量 · ${names.length} 项`));
    names.forEach((name) => {
      const val = state.vars[name] || "";
      const chip = h("span", {
        class: "vpl-var-chip" + (val ? " vpl-var-chip-filled" : ""),
        title: val ? `「${name}」＝${val}（点击修改）` : `「${name}」未填（点击输入）`,
        onclick: (e) => { e.stopPropagation(); openVarEditor(name, [...slots.get(name)], e.currentTarget); },
      }, val ? `${name}＝${val.length > 8 ? val.slice(0, 8) + "…" : val}` : name);
      chip.dataset.slot = name; // 直接赋 DOM 属性；h() 的 props 遍历不支持 dataset 对象写法
      els.varsBar.appendChild(chip);
    });
  }

  // v3.38：点击变量 chip 弹出就地输入浮层（复用 quickpanel 机制与关闭逻辑）
  function openVarEditor(name, opts, anchor) {
    closeQuickEdit();
    const panel = h("div", { class: "vpl-quickpanel" });
    panel.appendChild(h("div", { class: "vpl-quickpanel-title" }, `设置变量「${name}」`));
    const hint = h("div", { class: "vpl-hint" },
      opts.length ? `候选：${opts.join(" / ")}；留空＝按候选随机` : `留空＝保留 #${name}# 原样`);
    hint.style.marginBottom = "8px";
    panel.appendChild(hint);

    const input = h("input", {
      type: "text", class: "vpl-input vpl-quickpanel-input",
      placeholder: opts.length ? `随机(${opts.join("/")})` : "输入替换值…",
      value: state.vars[name] || "",
    });
    if (opts.length) {
      const dlId = "vpl-var-dl-" + name;
      input.setAttribute("list", dlId);
      panel.appendChild(h("datalist", { id: dlId }, opts.map((o) => h("option", { value: o }))));
    }
    panel.appendChild(input);

    const commit = () => {
      const v = input.value.trim();
      if (v) state.vars[name] = v;
      else delete state.vars[name];
      syncWidgets();
      closeQuickEdit();
      renderVars();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
      if (e.key === "Escape") { e.stopPropagation(); closeQuickEdit(); }
    });

    const foot = h("div", { class: "vpl-quickpanel-foot" });
    foot.appendChild(h("button", {
      class: "vpl-btn vpl-btn-sm", type: "button", title: "清空取值（恢复随机/原名）",
      onclick: (e) => { e.stopPropagation(); delete state.vars[name]; syncWidgets(); closeQuickEdit(); renderVars(); },
    }, "清除"));
    foot.appendChild(h("button", {
      class: "vpl-btn vpl-btn-sm", type: "button",
      onclick: (e) => { e.stopPropagation(); closeQuickEdit(); },
    }, "取消"));
    foot.appendChild(h("button", {
      class: "vpl-btn vpl-btn-sm vpl-btn-primary", type: "button",
      onclick: (e) => { e.stopPropagation(); commit(); },
    }, "确定"));
    panel.appendChild(foot);

    document.body.appendChild(panel);
    quickEditPanel = panel; // 必须记录引用，closeQuickEdit 才能关掉它
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 260, ph = panel.offsetHeight || 160;
    panel.style.position = "fixed";
    panel.style.zIndex = "100000";
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
    panel.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - ph - 8)) + "px";
    panel._docHandler = (e) => { if (!panel.contains(e.target)) closeQuickEdit(); };
    panel._keyHandler = (e) => { if (e.key === "Escape") closeQuickEdit(); };
    document.addEventListener("keydown", panel._keyHandler);
    setTimeout(() => document.addEventListener("click", panel._docHandler), 0);
    setTimeout(() => input.focus(), 30);
  }

  function renderItem(g, isSelected, list) {
    // v3.28：批量模式下单击=切换批量选中；否则单击=切换激活
    const inBulk = state.bulkMode;
    const isBulk = inBulk && state.bulkSelection.has(g.id);
    const toggle = () => {
      if (inBulk) {
        if (state.bulkSelection.has(g.id)) state.bulkSelection.delete(g.id);
        else state.bulkSelection.add(g.id);
        renderList();   // 重渲更新高亮 + 计数
        renderBulkBar(); // 更新操作条
        return;
      }
      toggleSelect(g.id, !state.selectedIds.includes(g.id));
    };

    // v3.28：收藏星按钮（toggleStar 持久化 g.star）
    const starBtn = iconButton(ICONS.star, g.star ? "取消收藏" : "收藏", () => toggleStar(g.id), {});
    starBtn.classList.toggle("vpl-star-on", !!g.star);

    // 颜色标记：有值渲染竖向渐变色条，无值渲染虚线「无颜色」指示
    const dot = g.color
      ? h("span", {
          class: "vpl-dot",
          style: `color:${g.color};background:linear-gradient(180deg, ${g.color}, color-mix(in srgb, ${g.color} 58%, #ffffff))`,
          title: g.color,
        })
      : h("span", { class: "vpl-dot vpl-dot-none", title: "无颜色" });
    const name = h("span", {
      class: "vpl-item-name",
      title: inBulk ? (g.name || "未命名") + "（单击批量选中）" : (g.name || "未命名") + "（单击切换激活）",
    }, g.name || "未命名");
    name.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    const cats = groupCats(g);
    const catChips = cats.length ? cats.slice(0, 2).map((c) => {
      const chip = h("span", {
        class: "vpl-item-cat",
        title: "点击编辑分类：" + c,
      }, c);
      chip.addEventListener("click", (e) => { e.stopPropagation(); quickEditFor(g, "cat", chip); });
      return chip;
    }) : [];
    if (cats.length > 2) {
      const more = h("span", {
        class: "vpl-item-cat vpl-item-cat-more",
        title: "点击编辑全部 " + cats.length + " 个分类",
      }, `+${cats.length - 2}`);
      more.addEventListener("click", (e) => { e.stopPropagation(); quickEditFor(g, "cat", more); });
      catChips.push(more);
    }
    const tagChips = (g.tags || []).slice(0, 3).map((t) => {
      const chip = h("span", {
        class: "vpl-item-tag",
        title: "点击编辑标签：" + t,
      }, t);
      chip.addEventListener("click", (e) => { e.stopPropagation(); quickEditFor(g, "tag", chip); });
      return chip;
    });
    const meta = h("div", { class: "vpl-item-meta" }, [...catChips, ...tagChips]);
    const body = h("div", {
      class: "vpl-item-body",
      title: isSelected ? "双击编辑" : "双击预览",
      ondblclick: () => { if (isSelected) editGroup(g.id); else previewGroup(g); },
    }, [name, meta]);

    const actions = h("span", { class: "vpl-item-actions" }, [
      starBtn,
      iconButton(ICONS.eye, "预览", () => previewGroup(g)),
      iconButton(ICONS.edit, "编辑", () => editGroup(g.id), { disabled: state.readonly }),
      iconButton(ICONS.copy, "复制", () => duplicateGroup(g.id), { disabled: state.readonly }),
      iconButton(ICONS.trash, "删除", () => deleteGroup(g.id), { disabled: state.readonly, danger: true }),
    ]);

    const dragHandle = h("span", {
      class: "vpl-drag-handle",
      title: "拖拽排序",
      html: ICONS.drag,
    });

    const bulkCls = isBulk ? " vpl-item-bulk" : "";
    let item;
    if (state.view === "card") {
      // v3.20 卡片视图：竖向卡片（左侧色条 + 名称行 + 内容摘要 + 分类/标签 chips）
      const bar = g.color
        ? h("span", {
            class: "vpl-card-bar",
            style: `background:linear-gradient(180deg, ${g.color}, color-mix(in srgb, ${g.color} 58%, #ffffff))`,
            title: g.color,
          })
        : null;
      const snippet = h("div", {
        class: "vpl-card-snippet",
        title: g.positive || g.note || "",
      }, g.positive || g.note || "（暂无提示词内容）");
      snippet.addEventListener("click", (e) => { e.stopPropagation(); toggle(); }); // 单击摘要区也可切换激活/批量选中
      // v3.23：名称单独一行、快捷操作单独一行（避免 4 图标挤在名称行右端压窄名称）
      const top = h("div", { class: "vpl-card-top" }, [name]);
      item = h("div", {
        class: "vpl-item vpl-item-card" + (isSelected ? " vpl-item-selected" : "") + bulkCls,
        draggable: "true",
        "data-id": g.id,
        title: isSelected ? "双击编辑" : "双击预览",
      }, [bar, top, actions, snippet, meta].filter(Boolean));
      item.addEventListener("dblclick", () => { if (isSelected) editGroup(g.id); else previewGroup(g); });
    } else {
      item = h("div", {
        class: "vpl-item" + (isSelected ? " vpl-item-selected" : "") + bulkCls,
        draggable: "true",
        "data-id": g.id,
      }, [dragHandle, dot, body, actions]);
    }

    item.addEventListener("dragstart", (e) => {
      dragId = g.id;
      item.classList.add("vpl-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => {
      dragId = null;
      item.classList.remove("vpl-dragging");
      list.querySelectorAll(".vpl-dragover").forEach((el) => el.classList.remove("vpl-dragover"));
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    item.addEventListener("dragenter", () => item.classList.add("vpl-dragover"));
    item.addEventListener("dragleave", () => item.classList.remove("vpl-dragover"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("vpl-dragover");
      if (!dragId || dragId === g.id) return;
      // v3.28：分组视图下跨组拖=改该组分类；同组或单一流=局部重排
      if (state.groupBy === "category") {
        const fromG = (state.libraryData?.groups || []).find((x) => x.id === dragId);
        const fromCats = fromG ? groupCats(fromG) : [];
        const toCats = groupCats(g);
        const cross = !fromCats.length || !toCats.length || !fromCats.some((c) => toCats.includes(c));
        if (cross) { moveCrossGroup(dragId, g.id); return; }
      }
      moveItem(dragId, g.id);
    });

    return item;
  }

  function renderAdvanced() {
    els.advanced.style.display = state.showAdvanced ? "block" : "none";
    els.advBtn.classList.toggle("vpl-btn-active", state.showAdvanced);
    els.readonlyHint.style.display = state.readonly ? "block" : "none";
    if (state.showAdvanced) {
      els.prependInput.value = wPrepend.value || "";
      els.appendInput.value = wAppend.value || "";
      els.ignoreWeightChk.checked = !!(wIgnoreWeight && wIgnoreWeight.value);
    }
  }

  // 关键修复（v2.11→v2.16）：高度强制贴内容；
  // v3.25：宽度不再在此处用 Math.max 兜底重设（会记忆放大、与 resize 手柄竞争导致拉不回），
  //   改为沿用 node.size[0]（用户当前宽度），保底 NODE_WIDTH 交给 node.computeSize。
  //   v2.16：realContentH() 临时 height:auto 绕过父容器高度污染，
  //     读出真实内容高度，再 node.setSize(...)。
  //   v3.53：高度公式与 node.computeSize 对齐 = contentH + chromeH(实际 domWidget.y) +
  //     BOTTOM_GAP(18px 节点色底缝)——旧的写死 +50 正是“提示词库/随机抽卡底缝没变宽”的原因
  let _recalcPending = false;
  function recalcHeight() {
    if (_recalcPending) return;
    _recalcPending = true;
    requestAnimationFrame(() => {
      _recalcPending = false;
      const h = realContentH();
      if (h <= 0) return;
      // v3.25 修复「节点拉大后拉不回」：宽度沿用用户当前 node.size[0]（不记忆放大），
      // 保底 NODE_WIDTH 由 node.computeSize 负责；不再每帧用 Math.max 重设宽度，
      // 避免 ResizeObserver 反馈与 resize 手柄竞争导致缩小拖拽失效。
      const w = node.size[0] && node.size[0] > 0 ? node.size[0] : NODE_WIDTH;
      node.setSize([w, h + chromeH() + BOTTOM_GAP]);
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
    });
  }

  function renderAll() {
    renderLibSelect();
    renderFilters();
    renderSepSelect();
    renderList();
    renderAdvanced();
    // v3.20：readWidgets 恢复 state.view 晚于按钮构建，每次全量渲染同步一次高亮
    els.viewListBtn.classList.toggle("vpl-btn-active", state.view === "list");
    els.viewCardBtn.classList.toggle("vpl-btn-active", state.view === "card");
    els.newGroupBtn.disabled = state.readonly;
    els.newGroupBtn.classList.toggle("vpl-btn-disabled", state.readonly);
    recalcHeight();
    // v2.16 诊断：节点高度相关真实值（首次 render 时打一次）
    if (!node._vplDiagOnce) {
      node._vplDiagOnce = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const nodeH = node.size?.[1] || 0;
        const nodeW = node.size?.[0] || 0;
        const realH = realContentH();
        const containerH = container.offsetHeight;
        const containerSH = container.scrollHeight;
        const domEl = domWidget.element;
        const domH = domEl ? domEl.offsetHeight : 0;
        console.log(
          "[VPL v2.16 诊断]",
          `\n  节点尺寸: [${nodeW}, ${nodeH}]`,
          `\n  容器 offsetHeight: ${containerH}`,
          `\n  容器 scrollHeight: ${containerSH}`,
          `\n  真实内容高 realContentH(): ${realH}`,
          `\n  DOM widget 元素高: ${domH}`,
          `\n  期望节点高 = 真实内容 + 50 chrome = ${realH + 50}`,
        );
      }));
    }
  }

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------
  // v3.28：批量整理模式开关
  function toggleBulkMode() {
    state.bulkMode = !state.bulkMode;
    if (!state.bulkMode) state.bulkSelection.clear();
    els.bulkBtn.classList.toggle("vpl-btn-active", state.bulkMode);
    renderBulkBar();
    renderList();
  }

  // v3.28：分类分区视图开关
  function toggleGroupBy() {
    state.groupBy = state.groupBy === "category" ? "none" : "category";
    els.groupBtn.classList.toggle("vpl-btn-active", state.groupBy === "category");
    renderList();
  }

  // v3.28：切换收藏（持久化 g.star 到库 JSON）
  async function toggleStar(id) {
    const g = (state.libraryData?.groups || []).find((x) => x.id === id);
    if (!g) return;
    g.star = !g.star;
    await saveLibrary();
    renderList();
  }

  // v3.28：分组视图下跨组拖=把该组归入目标分类（自动归类）+ 重排顺序
  async function moveCrossGroup(fromId, toId) {
    const groups = state.libraryData?.groups || [];
    const fromG = groups.find((x) => x.id === fromId);
    const toG = groups.find((x) => x.id === toId);
    if (!fromG || !toG) return;
    const toCats = groupCats(toG);
    if (toCats.length) fromG.categories = [...toCats];
    else { fromG.categories = []; delete fromG.category; }
    const from = state.unselectedIds.indexOf(fromId);
    if (from !== -1) state.unselectedIds.splice(from, 1);
    const to = state.unselectedIds.indexOf(toId);
    state.unselectedIds.splice(to, 0, fromId);
    state.selectedIds = state.unselectedIds.filter((oid) => state.selectedIds.includes(oid));
    await saveLibrary();
    syncWidgets();
    renderList();
  }

  // v3.28：批量操作条渲染（bulkMode 时显示已选数 + 操作按钮）
  function renderBulkBar() {
    if (!els.bulkBar) return;
    if (!state.bulkMode) { els.bulkBar.style.display = "none"; els.bulkBar.innerHTML = ""; return; }
    els.bulkBar.style.display = "flex";
    els.bulkBar.innerHTML = "";
    const info = h("span", { class: "vpl-bulk-info" }, `已选 ${state.bulkSelection.size} 组`);
    const act = (label, title, fn) => h("button", { class: "vpl-btn vpl-btn-sm", title, onclick: fn }, label);
    const allBtn = act("全选", "选中当前筛选下全部组", bulkSelectAll);
    const catBtn = act("加分类", "给选中组追加同一分类", () => bulkPick("cat"));
    const tagBtn = act("加标签", "给选中组追加同一标签", () => bulkPick("tag"));
    const clrCatBtn = act("清分类", "清空选中组的分类", () => bulkClearCat());
    const rmTagBtn = act("移除标签", "从选中组移除指定标签", () => bulkPickRemoveTag());
    const exitBtn = act("退出", "退出批量模式", toggleBulkMode);
    els.bulkBar.append(info, allBtn, catBtn, tagBtn, clrCatBtn, rmTagBtn, exitBtn);
  }

  // v3.28：批量选中当前筛选下全部组（与列表同一过滤口径，v3.58 起名副其实）
  function bulkSelectAll() {
    (state.libraryData?.groups || []).forEach((g) => { if (groupMatchesFilters(g)) state.bulkSelection.add(g.id); });
    renderList();
    renderBulkBar();
  }

  // v3.28：批量加分类/标签——弹出可选值网格，选一个即应用到所有选中组
  function bulkPick(kind) {
    if (!state.bulkSelection.size) { alert("请先选中至少一个组"); return; }
    closeQuickEdit();
    const isCat = kind === "cat";
    const panel = h("div", { class: "vpl-quickpanel" });
    panel.appendChild(h("div", { class: "vpl-quickpanel-title" }, isCat ? "批量加分类 · 点选应用" : "批量加标签 · 点选应用"));
    const grid = h("div", { class: "vpl-qp-grid" });
    const items = (isCat ? existingCategories() : allTagsList()).slice().sort();
    if (!items.length) grid.appendChild(h("div", { class: "vpl-quickpanel-empty" }, "暂无已有项"));
    items.forEach((v) => {
      const chip = h("button", { class: "vpl-qp-chip", type: "button" }, v);
      chip.addEventListener("click", (e) => { e.stopPropagation(); applyBulk(kind, v); closeQuickEdit(); });
      grid.appendChild(chip);
    });
    panel.appendChild(grid);
    const foot = h("div", { class: "vpl-quickpanel-foot" });
    const doneBtn = h("button", { class: "vpl-btn vpl-btn-primary", type: "button" }, "关闭");
    doneBtn.addEventListener("click", (e) => { e.stopPropagation(); closeQuickEdit(); });
    foot.append(doneBtn);
    panel.appendChild(foot);
    document.body.appendChild(panel);
    quickEditPanel = panel;
    const r = els.bulkBar.getBoundingClientRect();
    const pw = panel.offsetWidth || 260, ph = panel.offsetHeight || 200;
    panel.style.position = "fixed";
    panel.style.zIndex = "100000";
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
    panel.style.top = Math.max(8, r.top - ph - 6) + "px";
    panel._docHandler = (e) => { if (!panel.contains(e.target)) closeQuickEdit(); };
    panel._keyHandler = (e) => { if (e.key === "Escape") closeQuickEdit(); };
    document.addEventListener("keydown", panel._keyHandler);
    setTimeout(() => document.addEventListener("click", panel._docHandler), 0);
  }

  // v3.28：批量加分类/标签到选中组
  async function applyBulk(kind, v) {
    for (const g of (state.libraryData?.groups || [])) {
      if (!state.bulkSelection.has(g.id)) continue;
      if (kind === "cat") {
        const cs = groupCats(g);
        if (!cs.includes(v)) g.categories = [...cs, v];
      } else {
        const ts = g.tags || [];
        if (!ts.includes(v)) g.tags = [...ts, v];
      }
    }
    await saveLibrary();
    renderList();
    renderBulkBar();
  }

  // v3.28：清空选中组的分类
  async function bulkClearCat() {
    if (!state.bulkSelection.size) { alert("请先选中至少一个组"); return; }
    for (const g of (state.libraryData?.groups || [])) if (state.bulkSelection.has(g.id)) { g.categories = []; delete g.category; }
    await saveLibrary();
    renderList();
    renderBulkBar();
  }

  // v3.28：从选中组批量移除指定标签
  function bulkPickRemoveTag() {
    if (!state.bulkSelection.size) { alert("请先选中至少一个组"); return; }
    const used = new Set();
    (state.libraryData?.groups || []).forEach((g) => {
      if (state.bulkSelection.has(g.id)) (g.tags || []).forEach((t) => used.add(t));
    });
    closeQuickEdit();
    const panel = h("div", { class: "vpl-quickpanel" });
    panel.appendChild(h("div", { class: "vpl-quickpanel-title" }, "批量移除标签 · 点选"));
    const grid = h("div", { class: "vpl-qp-grid" });
    [...used].sort().forEach((v) => {
      const chip = h("button", { class: "vpl-qp-chip vpl-qp-on", type: "button" }, v);
      chip.addEventListener("click", (e) => { e.stopPropagation(); removeTagBulk(v); closeQuickEdit(); });
      grid.appendChild(chip);
    });
    if (!used.size) grid.appendChild(h("div", { class: "vpl-quickpanel-empty" }, "选中组无标签"));
    panel.appendChild(grid);
    document.body.appendChild(panel);
    quickEditPanel = panel;
    const r = els.bulkBar.getBoundingClientRect();
    const pw = panel.offsetWidth || 260, ph = panel.offsetHeight || 200;
    panel.style.position = "fixed"; panel.style.zIndex = "100000";
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
    panel.style.top = Math.max(8, r.top - ph - 6) + "px";
    panel._docHandler = (e) => { if (!panel.contains(e.target)) closeQuickEdit(); };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeQuickEdit(); });
    setTimeout(() => document.addEventListener("click", panel._docHandler), 0);
  }

  async function removeTagBulk(v) {
    for (const g of (state.libraryData?.groups || [])) if (state.bulkSelection.has(g.id) && g.tags) g.tags = g.tags.filter((t) => t !== v);
    await saveLibrary();
    renderList();
    renderBulkBar();
  }

  // v3.22：单击切换激活。unselectedIds 语义升级为「全量显示顺序」（含已选），
  // 已选输出顺序 = 显示顺序（按顺序数组重排 selectedIds），拖拽改序即改输出序。
  function toggleSelect(id, on) {
    const i = state.selectedIds.indexOf(id);
    if (on && i === -1) state.selectedIds.push(id);
    if (!on && i !== -1) state.selectedIds.splice(i, 1);
    state.selectedIds = state.unselectedIds.filter((oid) => state.selectedIds.includes(oid));
    syncWidgets();
    renderList();
  }

  // v3.22：单一列表拖拽重排（原 moveSelected/moveUnselected 合并，操作全量顺序数组）
  function moveItem(fromId, toId) {
    const from = state.unselectedIds.indexOf(fromId);
    const to = state.unselectedIds.indexOf(toId);
    if (from === -1 || to === -1) return;
    state.unselectedIds.splice(from, 1);
    state.unselectedIds.splice(to, 0, fromId);
    state.selectedIds = state.unselectedIds.filter((oid) => state.selectedIds.includes(oid));
    syncWidgets();
    renderList();
  }

  function groupCats(g) {
    if (Array.isArray(g.categories) && g.categories.length) return g.categories;
    if (typeof g.category === "string" && g.category) return [g.category];
    return [];
  }
  function existingCategories() {
    const s = new Set();
    (state.libraryData?.groups || []).forEach((g) => groupCats(g).forEach((c) => s.add(c)));
    return [...s];
  }
  function allTagsList() {
    const s = new Set();
    const meta = (state.libraryData && state.libraryData.meta) || {};
    (meta.tags || []).forEach((t) => t && s.add(t));
    (state.libraryData?.groups || []).forEach((g) => (g.tags || []).forEach((t) => t && s.add(t)));
    return [...s];
  }

  // 自定义调色板：库 meta 与“库里已出现过的分类/颜色/标签”合并，作为编辑弹窗的建议来源
  function buildPalette() {
    const meta = (state.libraryData && state.libraryData.meta) || {};
    const groups = state.libraryData?.groups || [];
    const colors = new Set(meta.colors || []);
    const tags = new Set(meta.tags || []);
    const attributes = new Set(meta.attributes || []); // v3.35：库级属性标签建议
    groups.forEach((g) => {
      if (g.color) colors.add(g.color);
      (g.tags || []).forEach((t) => t && tags.add(t));
      [g.positive, g.negative, g.prefix, g.suffix].forEach((t) => {
        if (!t) return;
        if (t.includes("#")) {
          TAG_RE.lastIndex = 0;
          let m;
          while ((m = TAG_RE.exec(t))) attributes.add(m[1]);
        }
        if (t.includes("{")) {
          SLOT_RE.lastIndex = 0;
          let m;
          while ((m = SLOT_RE.exec(t))) {
            const info = parseSlotContent(m[1]);
            if (info) attributes.add(info.name);
          }
        }
      });
    });
    return {
      categories: [...new Set([...(meta.categories || []), ...existingCategories()])],
      colors: [...colors],
      tags: [...tags],
      attributes: [...attributes],
    };
  }

  function ensureMeta() {
    if (!state.libraryData) state.libraryData = { name: "", groups: [] };
    if (!state.libraryData.meta) state.libraryData.meta = { categories: [], colors: [], tags: [] };
    return state.libraryData.meta;
  }

  async function newGroup() {
    if (state.readonly) return;
    try {
      if (!state.libraryData || !Array.isArray(state.libraryData.groups)) {
        alert("库数据尚未加载完成，无法新建。请截图浏览器控制台里 [VPL] 开头的日志反馈。");
        return;
      }
      // 新建组配色改由编辑器真随机生成（openEditor 内 randomColor），相邻组不再循环预设色
      const res = await openEditor(null, { isNew: true, categories: existingCategories(), palette: buildPalette() });
      if (!res) return;
      const g = res.group;
      state.libraryData.groups.push(g);
      state.selectedIds.push(g.id);
      // v3.31：新组必须同步进「全量显示顺序」数组。否则 toggleSelect 末尾的
      // selectedIds=unselectedIds.filter(...) 会把它踢出、reorder 的 indexOf 返回 -1 误删末位 → 新建后无法选择/拖拽
      state.unselectedIds.push(g.id);
      if (res.meta) Object.assign(ensureMeta(), res.meta);
      await saveLibrary();
      syncWidgets();
      renderAll();
    } catch (e) {
      console.error("[VPL] 新建提示词组失败：", e);
      alert("新建提示词组出错：" + ((e && e.message) || e)
        + "\n\n请把浏览器控制台（F12）里红色的错误信息一并截图反馈。");
    }
  }

  async function editGroup(id) {
    if (state.readonly) return;
    try {
      const g = state.libraryData?.groups?.find((x) => x.id === id);
      if (!g) return;
      const res = await openEditor(g, { categories: existingCategories(), palette: buildPalette() });
      if (!res) return;
      Object.assign(g, res.group);
      if (res.meta) Object.assign(ensureMeta(), res.meta);
      await saveLibrary();
      renderAll();
    } catch (e) {
      console.error("[VPL] 编辑提示词组失败：", e);
      alert("编辑提示词组出错：" + ((e && e.message) || e));
    }
  }

  async function duplicateGroup(id) {
    if (state.readonly) return;
    const g = state.libraryData.groups.find((x) => x.id === id);
    if (!g) return;
    const copy = JSON.parse(JSON.stringify(g));
    copy.id = uid();
    copy.name = (g.name || "未命名") + " 副本";
    const idx = state.libraryData.groups.indexOf(g);
    state.libraryData.groups.splice(idx + 1, 0, copy);
    // v3.22：副本插入全量顺序，紧跟原卡之后（列表单区，无需区分原卡激活态）
    const oi = state.unselectedIds.indexOf(g.id);
    if (oi !== -1) state.unselectedIds.splice(oi + 1, 0, copy.id);
    else state.unselectedIds.push(copy.id);
    await saveLibrary();
    renderAll();
  }

  async function deleteGroup(id) {
    if (state.readonly) return;
    const g = state.libraryData.groups.find((x) => x.id === id);
    if (!g) return;
    if (!confirm(`确定删除「${g.name || "未命名"}」？`)) return;
    state.libraryData.groups = state.libraryData.groups.filter((x) => x.id !== id);
    state.selectedIds = state.selectedIds.filter((x) => x !== id);
    state.unselectedIds = state.unselectedIds.filter((x) => x !== id);
    await saveLibrary();
    syncWidgets();
    renderAll();
  }

  async function switchLibrary(locator, inlineData) {
    state.locator = locator;
    state.libraryData = inlineData || null;
    state.selectedIds = [];
    state.unselectedIds = [];
    await loadLibraryContent();
    syncWidgets();
    renderAll();
  }

  async function onLibraryChange(val) {
    if (val === "__create__") return createLibrary();
    if (val === "__import__") return importFile();
    if (val === "__custom__") return referenceCustom();
    if (val === "__hidden_builtin__") { renderLibSelect(); return; }
    try {
      const loc = JSON.parse(val);
      await switchLibrary(loc, null);
    } catch (e) { /* ignore */ }
  }

  async function createLibrary() {
    const name = prompt("新库名称：");
    if (!name) return;
    try {
      const res = await apiPost("/library/create", { name: name.trim() });
      if (res.ok) {
        await loadLibraries();
        await switchLibrary(res.locator, null);
      } else {
        alert("创建失败：" + (res.error || "未知错误"));
      }
    } catch (e) {
      alert("创建失败：" + e.message);
    }
  }

  function importFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data.groups || !Array.isArray(data.groups)) {
            alert("JSON 格式不正确：缺少 groups 数组");
            return;
          }
          await switchLibrary({ source: "inline", name: file.name.replace(/\.json$/i, "") }, data);
        } catch (e) {
          alert("JSON 解析失败：" + e.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  async function referenceCustom() {
    const p = prompt("输入库 JSON 文件的绝对路径（如 D:\\prompts\\my.json）：");
    if (!p) return;
    const loc = { source: "custom", path: p.trim() };
    // 先试读
    const res = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(loc)));
    if (!res.ok) { alert("加载失败：" + (res.error || "文件不存在或格式错误")); return; }
    await switchLibrary(loc, null);
  }

  function exportLibrary() {
    if (!state.libraryData) return;
    const blob = new Blob([JSON.stringify(state.libraryData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.libraryData.name || "prompt-library") + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveAsUserLibrary() {
    if (!state.libraryData) return;
    const name = prompt("保存为用户库，名称：", state.libraryData.name || "");
    if (!name) return;
  try {
    const res = await apiPost("/library/create", { name: name.trim() });
    await apiPost("/library/save", { locator: res.locator, data: state.libraryData });
      await loadLibraries();
      await switchLibrary(res.locator, null);
    } catch (e) {
      alert("保存失败：" + e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 初始化 / 工作流恢复
  // -------------------------------------------------------------------------
  async function init() {
    try {
      readWidgets();
      await checkBackendVersion();
      await loadLibraries();
      // onConfigure 可能在 await 期间已用工作流数据覆盖 widget，重新读取一次
      readWidgets();
      // 默认库兜底（空数组等无效定位也会被 isValidLocator 拦截）
      if (!isValidLocator(state.locator)) {
        const def = state.libraries.find((l) => l.source === "user" && l.name === "default")
          || state.libraries.find((l) => l.source === "builtin" && l.name === "default");
        state.locator = def ? { source: def.source, name: def.name } : null;
        if (def) console.log("[VPL] 定位无效，已兜底到默认库：", JSON.stringify(state.locator));
      }
      await loadLibraryContent();
      syncWidgets();
      console.log(
        "%c[VPL] 数据加载完成",
        "color:#27ae60",
        "前端:", PLUGIN_VERSION,
        "后端:", state.backendVersion,
        "库列表:", state.libraries.length,
        "当前定位:", JSON.stringify(state.locator),
        "卡片数:", (state.libraryData && state.libraryData.groups || []).length
      );
      renderAll();
      // 多次延迟重算高度，应对 DOM widget 定位/字体加载后的尺寸变化
      [60, 250, 600].forEach((t) => setTimeout(recalcHeight, t));
    } catch (e) {
      console.error("[AllBuy_PromptLibrary] 初始化失败：", e);
      els.list.innerHTML = "";
      els.list.appendChild(h("div", { class: "vpl-empty" },
        "初始化失败：" + ((e && e.message) || e) + "。请刷新节点或查看浏览器控制台。"));
      recalcHeight();
    }
  }

  function refreshFromWidgets() {
    // 工作流加载完成后，widget 值已被覆盖，重新读取并刷新
    readWidgets();
    pruneStrayWidgets(); // 工作流恢复是 widget 复发的高危时点，补一次清理
    loadLibraries().then(async () => {
      try {
        await loadLibraryContent();
        syncWidgets();
        renderAll();
        [60, 250].forEach((t) => setTimeout(() => { recalcHeight(); pruneStrayWidgets(); }, t));
      } catch (e) {
        console.error("[AllBuy_PromptLibrary] 刷新失败：", e);
      }
    });
  }

  node._vplRefresh = refreshFromWidgets;
  // 若 onConfigure 在控制器就绪前已触发，补一次刷新——
  // 推迟到下一个 microtask，必须让 init() 先把 state.libraryData 落地，避免
  // refreshFromWidgets 内的 readWidgets 抢占未加载状态。
  if (node._vplPendingConfigure) {
    node._vplPendingConfigure = false;
    Promise.resolve().then(refreshFromWidgets);
  }

  init();
}

// ---------------------------------------------------------------------------
// 执行参数注入：存储 widget 已从 node.widgets 移除，队列 prompt 时把值补回 inputs
// ---------------------------------------------------------------------------
let _vplHooked = false;
function installGraphToPromptHook() {
  if (_vplHooked) return;
  const orig = app.graphToPrompt?.bind(app);
  if (typeof orig !== "function") return;
  _vplHooked = true;
  app.graphToPrompt = async function () {
    const res = await orig();
    try {
      const nodes = (app.graph && (app.graph._nodes || app.graph.nodes)) || [];
      for (const node of nodes) {
        // v3.49：旧类名（老工作流里的 VideoPromptLibrary/VideoPromptRandomDraw）同样要注入，
        // 只认新名会导致面板挂上了、值却没补回 inputs → 后端校验「Required input is missing」
        if (node && (node.type === NODE_NAME || node.type === NODE_NAME_LEGACY) && typeof node._vplInputs === "function") {
          const id = String(node.id);
          if (res.output && res.output[id] && res.output[id].inputs) {
            Object.assign(res.output[id].inputs, node._vplInputs());
          }
        } else if (node && (node.type === NODE_NAME_RANDOM || node.type === NODE_NAME_RANDOM_LEGACY) && typeof node._vplRdInputs === "function") {
          const id = String(node.id);
          if (res.output && res.output[id] && res.output[id].inputs) {
            Object.assign(res.output[id].inputs, node._vplRdInputs());
          }
        } else if (node && node.type === NODE_NAME_MEDIA) {
          // v3.59：素材清单注入兜底链——面板挂载失败等异常下 _mediaInputs 不存在时，
          // 退回 properties._media，再不行注 "{}"（后端空清单可跑），绝不再因缺参拒队。
          const id = String(node.id);
          if (res.output && res.output[id] && res.output[id].inputs) {
            const json = typeof node._mediaInputs === "function"
              ? node._mediaInputs().素材清单
              : (node.properties && node.properties._media) || "{}";
            res.output[id].inputs["素材清单"] = json || "{}";
          }
        }
      }
    } catch (e) {
      console.error("[VPL] 注入执行参数失败：", e);
    }
    return res;
  };
  console.log("%c[VPL] graphToPrompt 注入钩子已安装", "color:#27ae60");
}

// ===========================================================================
// 随机抽卡节点（PromptRandomDraw）自定义 DOM 面板
//   把纯文本/数字 widget 换成可视化面板：库下拉、筛选行（搜索 + 分类组合/标签筛选多选，
//   v3.45 与主面板同口径）、数量步进、种子 + 🎲 + 执行后自动换种子开关、分隔符下拉、
//   前后缀输入；卡片网格实时预览抽中高亮（紫色描边，被动）+ 锁定（v3.44：点卡片切换，
//   唯一主动交互，锁定卡必含、不占数量名额）+ 变量行（命名槽/属性标签）+ 合并结果
//   弹窗预览（v3.45：状态行 👁 按钮唤起，挂 body）。原生
//   INPUT_TYPES widget 全部隐藏并由面板驱动，执行参数经
//   graphToPrompt 注入后端（v3.43 起只读 state 单一真值源）。抽卡预览走 POST /draw，
//   与节点 execute 共用 random_draw.draw，预览 = 执行（相同 seed 可复现）。
// ===========================================================================
function attachRandomController(node) {
  const need = ["库", "数量", "随机种子", "分隔符", "分类筛选", "前缀", "后缀", "变量取值", "锁定卡片"];
  const ready = () => node.widgets && need.every((n) => node.widgets.some((w) => w.name === n));
  if (ready()) { startRandomController(node); return; }
  let tries = 0;
  const tick = () => {
    tries++;
    if (ready() || tries >= 60) startRandomController(node);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function startRandomController(node) {
  if (node._vplRdAttached) return;
  node._vplRdAttached = true;

  const need = ["库", "数量", "随机种子", "分隔符", "分类筛选", "前缀", "后缀", "变量取值", "锁定卡片"];
  const wLib = node.widgets?.find((w) => w.name === "库");
  const wCount = node.widgets?.find((w) => w.name === "数量");
  const wSeed = node.widgets?.find((w) => w.name === "随机种子");
  const wSep = node.widgets?.find((w) => w.name === "分隔符");
  const wCat = node.widgets?.find((w) => w.name === "分类筛选");
  const wTag = node.widgets?.find((w) => w.name === "标签筛选");   // v3.45：旧后端可能暂无此 widget，允许为空
  const wPre = node.widgets?.find((w) => w.name === "前缀");
  const wApp = node.widgets?.find((w) => w.name === "后缀");
  const wVars = node.widgets?.find((w) => w.name === "变量取值");
  const wLocked = node.widgets?.find((w) => w.name === "锁定卡片");

  const storageWidgets = [wLib, wCount, wSeed, wSep, wCat, wPre, wApp, wVars, wLocked, wTag].filter(Boolean);
  storageWidgets.forEach(hideWidget);
  if (node.widgets && storageWidgets.length) {
    node.widgets = node.widgets.filter((w) => !storageWidgets.includes(w));
  }

  const state = {
    libraries: [],
    separators: DEFAULT_SEPARATORS,
    locator: null,
    libraryData: null,
    categories: [],
    filterCategories: [],   // v3.45：分类组合（多选并集，命中任一分类即入池）
    filterTags: [],         // v3.45：标签筛选（多选并集，与分类组合叠加）
    search: "",             // v3.45：网格内搜索（仅前端显示过滤，不影响抽卡池）
    count: 1,
    seed: 0,
    separator: ", ",
    prepend: "",
    append: "",
    lockedIds: new Set(),   // v3.43：锁定卡（必含、不占数量名额）
    vars: {},               // v3.43：命名槽/属性标签取值（与主节点 state.vars 同语义）
    autoSeed: true,         // v3.43：每次队列执行后自动换种子（找回 control_after_generate 语义）
    drawnIds: new Set(),
    drawnCards: [],         // v3.43：/draw 返回的抽中卡片详情（含 prefix/suffix/categories），供变量行扫描
    drawnPos: "",
    drawnNeg: "",
    backendVersion: "",
    loadSeq: 0,
    previewSeq: 0,
  };

  // v3.43：执行参数注入改为只读 state（单一真值源）。state 由 readWidgets/syncWidgets
  // 与 properties._vplrd 双向同步；widget 对象只是存储介质，已移出 node.widgets，
  // 其残留 value 不可信（v2.7 教训），绝不再从这里读执行参数。
  node._vplRdInputs = function () {
    return {
      库: state.locator ? (state.locator.source + ":" + state.locator.name) : "user:default",
      数量: state.count,
      随机种子: state.seed,
      分隔符: state.separator,
      分类筛选: JSON.stringify(state.filterCategories || []),
      标签筛选: JSON.stringify(state.filterTags || []),
      前缀: state.prepend,
      后缀: state.append,
      变量取值: JSON.stringify(state.vars || {}),
      锁定卡片: JSON.stringify([...(state.lockedIds || [])]),
    };
  };

  console.log("%c[VPL-RD " + PLUGIN_VERSION + "] 已移除存储 widget，节点剩余 widget：",
    "color:#27ae60", (node.widgets || []).map((w) => w.name));

  // ---- 工具 ----
  function parseLocatorStr(s) {
    s = (s || "").trim();
    const i = s.indexOf(":");
    if (i > 0) {
      const src = s.slice(0, i), name = s.slice(i + 1);
      if (["user", "builtin", "custom"].includes(src)) return { source: src, name };
    }
    return { source: "user", name: s || "default" };
  }
  function groupCategories(g) {
    let cats = g.categories;
    if (!cats) { const c = g.category; cats = c ? [c] : []; }
    if (typeof cats === "string") cats = [cats];
    return (cats || []).filter(Boolean);
  }
  function allCategoriesFrontend(groups) {
    const seen = [];
    for (const g of groups || []) {
      for (const c of groupCategories(g)) if (!seen.includes(c)) seen.push(c);
    }
    return seen.sort();
  }

  // ---- 读/写 widget 与 properties._vplrd ----
  function parseJsonSafe(s, fallback) {
    try { const v = JSON.parse(s); return v ?? fallback; } catch (e) { return fallback; }
  }
  // v3.45：筛选条件容错归一（与后端 random_draw._as_str_list 同语义）：
  // 数组 / JSON 数组字符串 / 旧单字符串 → 字符串数组
  function asStrList(v) {
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim());
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return [];
      if (s.startsWith("[")) {
        try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim()) : []; }
        catch (e) { return [s]; }
      }
      return [s];
    }
    return [];
  }
  function readWidgets() {
    const saved = (node.properties && node.properties._vplrd) || null;
    const libVal = saved?.library ?? wLib?.value ?? "user:default";
    state.locator = parseLocatorStr(libVal);
    // v3.45：分类组合 / 标签筛选（saved 优先；旧存档 filter_category 单字符串自动迁移为单元素数组）
    state.filterCategories = asStrList(saved
      ? (saved.filter_categories ?? saved.filter_category ?? wCat?.value ?? [])
      : (wCat?.value ?? []));
    state.filterTags = asStrList(saved ? (saved.filter_tags ?? []) : (wTag?.value ?? []));
    state.count = Number(saved?.count ?? wCount?.value ?? 1) || 1;
    state.seed = Number(saved?.seed ?? wSeed?.value ?? 0) || 0;
    state.separator = saved?.separator ?? wSep?.value ?? ", ";
    state.prepend = saved?.prepend ?? wPre?.value ?? "";
    state.append = saved?.append ?? wApp?.value ?? "";
    // v3.43：锁定集 / 变量 / 自动换种子（旧存档无 _vplrd 时回退 widget 值，此后 widget 只作介质）
    const lockedArr = saved ? (saved.locked_ids || []) : parseJsonSafe(wLocked?.value, []);
    state.lockedIds = new Set(Array.isArray(lockedArr) ? lockedArr.filter(Boolean) : []);
    const varsObj = saved ? (saved.var_values || {}) : parseJsonSafe(wVars?.value, {});
    state.vars = (varsObj && typeof varsObj === "object" && !Array.isArray(varsObj)) ? varsObj : {};
    state.autoSeed = saved ? (saved.auto_seed !== false) : true;
    if (wLib) wLib.value = state.locator ? (state.locator.source + ":" + state.locator.name) : "user:default";
    if (wCount) wCount.value = state.count;
    if (wSeed) wSeed.value = state.seed;
    if (wSep) wSep.value = state.separator;
    if (wCat) wCat.value = JSON.stringify(state.filterCategories);
    if (wTag) wTag.value = JSON.stringify(state.filterTags);
    if (wPre) wPre.value = state.prepend;
    if (wApp) wApp.value = state.append;
    if (wVars) wVars.value = JSON.stringify(state.vars);
    if (wLocked) wLocked.value = JSON.stringify([...state.lockedIds]);
  }
  function syncWidgets() {
    if (wLib) wLib.value = state.locator ? (state.locator.source + ":" + state.locator.name) : "user:default";
    if (wCount) wCount.value = state.count;
    if (wSeed) wSeed.value = state.seed;
    if (wSep) wSep.value = state.separator;
    if (wCat) wCat.value = JSON.stringify(state.filterCategories);
    if (wTag) wTag.value = JSON.stringify(state.filterTags);
    if (wPre) wPre.value = state.prepend;
    if (wApp) wApp.value = state.append;
    if (wVars) wVars.value = JSON.stringify(state.vars);
    if (wLocked) wLocked.value = JSON.stringify([...state.lockedIds]);
    node.properties = node.properties || {};
    node.properties._vplrd = {
      library: state.locator ? (state.locator.source + ":" + state.locator.name) : "user:default",
      filter_categories: state.filterCategories,
      filter_tags: state.filterTags,
      count: state.count,
      seed: state.seed,
      separator: state.separator,
      prepend: state.prepend,
      append: state.append,
      locked_ids: [...state.lockedIds],
      var_values: state.vars,
      auto_seed: state.autoSeed,
    };
    node.setDirtyCanvas?.(true, true);
  }

  // ---- 数据加载 ----
  async function checkBackendVersionRD() {
    try {
      const r = await fetch(API + "/version");
      if (!r.ok) state.backendVersion = "未知(" + r.status + ")";
      else { const res = await r.json(); state.backendVersion = res.version || "未知"; }
    } catch (e) { state.backendVersion = "无法连接"; }
    if (state.backendVersion !== PLUGIN_VERSION) {
      console.warn("%c[VPL-RD ⚠] 前后端版本不一致！前端 " + PLUGIN_VERSION + " / 后端 " + state.backendVersion,
        "color:#e67e22;font-weight:bold");
    }
  }
  async function loadLibrariesRD() {
    try { const res = await apiGet("/libraries"); state.libraries = res.ok ? (res.libraries || []) : []; }
    catch (e) { state.libraries = []; console.error("[VPL-RD] /libraries 失败：", e); }
    try { const res = await apiGet("/separators"); if (res.ok && res.separators) state.separators = res.separators; }
    catch (e) { /* 用默认 */ }
  }
  async function loadLibraryContent() {
    const mySeq = ++state.loadSeq;
    if (!isValidLocator(state.locator)) { state.libraryData = { name: "", groups: [] }; state.categories = []; return; }
    try {
      const res = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(state.locator)));
      const data = res.ok ? (res.library || { name: "", groups: [] }) : { name: "", groups: [] };
      if (mySeq !== state.loadSeq) return;
      state.libraryData = data;
      state.categories = allCategoriesFrontend(data.groups || []);
    } catch (e) {
      console.error("[VPL-RD] /library 失败：", e);
      if (mySeq !== state.loadSeq) return; // 过期失败不得覆盖新一次加载（v3.58 与主面板口径对齐）
      state.libraryData = { name: "", groups: [] };
    }
  }

  // ---- 实时预览（抽卡）----
  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 150);
  }
  async function runPreview() {
    const mySeq = ++state.previewSeq;
    if (!isValidLocator(state.locator)) { renderList(); return; }
    try {
      const res = await apiPost("/draw", {
        library: state.locator.source + ":" + state.locator.name,
        count: state.count,
        seed: state.seed,
        separator: state.separator,
        filter_category: state.filterCategories,
      filter_tags: state.filterTags,
        prepend: state.prepend,
        append: state.append,
        locked_ids: [...state.lockedIds],
        vars: state.vars,
      });
      if (mySeq !== state.previewSeq) return;
      if (res && res.ok) {
        state.drawnIds = new Set((res.drawn || []).map((d) => d.id));
        state.drawnCards = res.drawn || [];
        state.drawnPos = res.positive || "";
        state.drawnNeg = res.negative || "";
      } else {
        state.drawnIds = new Set();
        state.drawnCards = [];
        state.drawnPos = ""; state.drawnNeg = "";
      }
    } catch (e) {
      console.error("[VPL-RD] /draw 失败：", e);
    }
    renderList();
    renderResult();
    renderVarsRD();
  }

  // ---- DOM 构建 ----
  const container = h("div", { class: "vpl-node vpl-rd-node" });

  const libDD = createDropdown({ placeholder: "选择库…" });
  libDD.addEventListener("change", (val) => {
    state.locator = parseLocatorStr(val);
    syncWidgets();
    loadLibraryContent().then(() => { renderAll(); schedulePreview(); });
  });
  // v3.45：分类组合 + 标签筛选（多选并集，命中任一即入池；与主面板筛选同语义）
  const catDD = createDropdown({ placeholder: "分类组合", multi: true });
  catDD.addEventListener("change", (val) => {
    state.filterCategories = val || [];
    syncWidgets();
    renderList();
    schedulePreview();
  });
  const tagDD = createDropdown({ placeholder: "标签筛选", multi: true });
  tagDD.addEventListener("change", (val) => {
    state.filterTags = val || [];
    syncWidgets();
    renderList();
    schedulePreview();
  });
  // v3.45：网格内搜索（仅前端显示过滤，不影响抽卡池；防抖同主面板）
  const rdSearchInput = h("input", { type: "text", class: "vpl-input vpl-search vpl-rd-search",
    placeholder: "搜索名称 / 正文 / 标签", spellcheck: "false" });
  let _rdSearchTimer = null;
  rdSearchInput.addEventListener("input", () => {
    clearTimeout(_rdSearchTimer);
    _rdSearchTimer = setTimeout(() => {
      state.search = rdSearchInput.value.trim().toLowerCase();
      renderList();
    }, 140);
  });
  const rdSearchWrap = h("div", { class: "vpl-search-wrap" }, [h("span", { class: "vpl-search-icon", html: ICONS.search }), rdSearchInput]);
  const filtersRow = h("div", { class: "vpl-rd-filters" }, [rdSearchWrap, catDD.root, tagDD.root]);
  const toolbar = h("div", { class: "vpl-rd-toolbar" }, [libDD.root, filtersRow]);

  const countVal = h("span", { class: "vpl-rd-count-val" }, "1");
  const btnMinus = h("button", { class: "vpl-rd-step", title: "减少数量", type: "button",
    onclick: () => { state.count = Math.max(0, state.count - 1); syncWidgets(); schedulePreview(); } }, "−");
  const btnPlus = h("button", { class: "vpl-rd-step", title: "增加数量", type: "button",
    onclick: () => { state.count = Math.min(100, state.count + 1); syncWidgets(); schedulePreview(); } }, "+");
  const stepper = h("div", { class: "vpl-rd-stepper" }, [btnMinus, countVal, btnPlus]);

  const seedInput = h("input", { class: "vpl-rd-seed", type: "text", inputmode: "numeric", spellcheck: "false" });
  seedInput.addEventListener("input", () => {
    const v = parseInt((seedInput.value || "").replace(/[^0-9]/g, ""), 10);
    state.seed = isNaN(v) ? 0 : v;
    syncWidgets();
    schedulePreview();
  });
  const diceBtn = iconButton(ICONS.dice, "随机种子：换个种子重新抽", () => {
    state.seed = Math.floor(Math.random() * 9007199254740991); // 2^53 内安全整数
    seedInput.value = String(state.seed);
    syncWidgets();
    schedulePreview();
  });
  // v3.43：原生 control_after_generate 因种子 widget 被移除而失效（每次队列结果相同），
  // 改由前端监听执行事件模拟「每次生成后随机」。开关默认开，关闭 = 固定种子连跑。
  const autoSeedBtn = iconButton(ICONS.loop, "每次执行后自动换种子（当前：开）", () => {
    state.autoSeed = !state.autoSeed;
    syncWidgets();
    syncAutoSeedBtn();
  });
  function syncAutoSeedBtn() {
    autoSeedBtn.classList.toggle("vpl-btn-active", state.autoSeed);
    autoSeedBtn.title = "每次执行后自动换种子（当前：" + (state.autoSeed ? "开" : "关，固定种子") + "）";
  }
  function bumpSeedAfterRun() {
    if (!state.autoSeed) return;
    state.seed = Math.floor(Math.random() * 9007199254740991);
    if (wSeed) wSeed.value = String(state.seed);
    seedInput.value = String(state.seed);
    syncWidgets();
    schedulePreview();
  }
  let seedCleanup = null;
  try {
    const onExecuted = (e) => { if (e?.detail?.node === node.id) bumpSeedAfterRun(); };
    const onCached = (e) => {
      const ns = e?.detail?.nodes;
      if (Array.isArray(ns) && ns.includes(node.id)) bumpSeedAfterRun();
    };
    api.addEventListener("executed", onExecuted);
    api.addEventListener("execution_cached", onCached);
    // v3.61：节点删除时摘掉监听（同 panel_guard v3.58 政策）——残留监听在节点 id
    // 复用后会误命中新节点、并随节点增删不断累积
    seedCleanup = () => {
      api.removeEventListener("executed", onExecuted);
      api.removeEventListener("execution_cached", onCached);
    };
  } catch (e) { console.warn("[VPL-RD] 执行事件监听不可用：", e); }
  const seedRow = h("div", { class: "vpl-rd-seedrow" }, [seedInput, diceBtn, autoSeedBtn]);

  const sepDD = createDropdown({ placeholder: "分隔符" });
  sepDD.addEventListener("change", (val) => {
    state.separator = val;
    syncWidgets();
    schedulePreview();
  });

  const controls = h("div", { class: "vpl-rd-controls" }, [
    h("div", { class: "vpl-rd-field" }, [h("label", { class: "vpl-rd-label" }, "数量"), stepper]),
    h("div", { class: "vpl-rd-field vpl-rd-field-grow" }, [h("label", { class: "vpl-rd-label" }, "种子"), seedRow]),
    h("div", { class: "vpl-rd-field" }, [h("label", { class: "vpl-rd-label" }, "分隔符"), sepDD.root]),
  ]);

  const preInput = h("input", { class: "vpl-rd-text", type: "text", placeholder: "前缀（支持 {a|b} 通配符）", spellcheck: "false" });
  preInput.addEventListener("input", () => { state.prepend = preInput.value; syncWidgets(); schedulePreview(); });
  const appInput = h("input", { class: "vpl-rd-text", type: "text", placeholder: "后缀（支持 {a|b} 通配符）", spellcheck: "false" });
  appInput.addEventListener("input", () => { state.append = appInput.value; syncWidgets(); schedulePreview(); });
  const adv = h("div", { class: "vpl-rd-adv" }, [preInput, appInput]);

  const statusEl = h("div", { class: "vpl-rd-status" }, "—");
  const grid = h("div", { class: "vpl-rd-grid" });
  // v3.43：变量行（复用主面板 .vpl-vars-bar 样式）——抽中卡片文本含 #名称# / {名称:选项} 时浮出
  const varsBar = h("div", { class: "vpl-vars-bar" });
  varsBar.style.display = "none";
  let _varsSig = "";
  let rdQuickEditPanel = null;
  function closeRdQuickEdit() {
    if (!rdQuickEditPanel) return;
    if (rdQuickEditPanel._docHandler) document.removeEventListener("click", rdQuickEditPanel._docHandler);
    if (rdQuickEditPanel._keyHandler) document.removeEventListener("keydown", rdQuickEditPanel._keyHandler);
    rdQuickEditPanel.remove();
    rdQuickEditPanel = null;
  }

  // v3.45：合并结果改弹窗预览——面板内只留状态行右侧的 👁 按钮（hover 浮现），
  // 弹窗挂 document.body（脱离 DOM widget 的 transform 缩放/裁剪），正/负各带复制
  const posArea = h("textarea", { class: "vpl-rd-result", readonly: true, placeholder: "正提示词预览", spellcheck: "false" });
  const negArea = h("textarea", { class: "vpl-rd-result vpl-rd-result-neg", readonly: true, placeholder: "负提示词预览", spellcheck: "false" });
  const copyPosBtn = iconButton(ICONS.copy, "复制正提示词", async () => {
    try { await navigator.clipboard.writeText(state.drawnPos || ""); } catch (e) { /* ignore */ }
  });
  const copyNegBtn = iconButton(ICONS.copy, "复制负提示词", async () => {
    try { await navigator.clipboard.writeText(state.drawnNeg || ""); } catch (e) { /* ignore */ }
  });
  const resultPop = h("div", { class: "vpl-rd-resultpop" }, [
    h("div", { class: "vpl-rd-result-head" }, [
      h("span", {}, "合并结果预览"),
      h("span", { class: "vpl-rd-pop-actions" }, [copyPosBtn, copyNegBtn]),
    ]),
    posArea, negArea,
  ]);
  resultPop.style.display = "none";
  document.body.appendChild(resultPop);
  let _resultPopOpen = false;
  let _resultPopRaf = 0;
  function placeResultPop() {
    if (!_resultPopOpen) return;
    const r = statusRow.getBoundingClientRect();
    const w = resultPop.offsetWidth || 480;
    const ph = resultPop.offsetHeight || 280;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = r.right - w;                       // 右对齐状态行
    if (left < 8) left = 8;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    let top = r.bottom + 6;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
    resultPop.style.left = left + "px";
    resultPop.style.top = top + "px";
  }
  function closeResultPop() {
    if (!_resultPopOpen) return;
    _resultPopOpen = false;
    cancelAnimationFrame(_resultPopRaf);
    resultPop.style.display = "none";
    document.removeEventListener("click", resultPop._docHandler);
    document.removeEventListener("keydown", resultPop._keyHandler);
  }
  function openResultPop() {
    _resultPopOpen = true;
    resultPop.style.display = "flex";
    autosizeResultAreas();
    placeResultPop();
    // rAF 跟随：画布平移/缩放时弹窗始终贴合状态行（fixed 不随 #graph transform 移动）
    const follow = () => {
      if (!_resultPopOpen) return;
      placeResultPop();
      _resultPopRaf = requestAnimationFrame(follow);
    };
    _resultPopRaf = requestAnimationFrame(follow);
    resultPop._docHandler = (e) => {
      if (!resultPop.contains(e.target) && !statusRow.contains(e.target)) closeResultPop();
    };
    resultPop._keyHandler = (e) => { if (e.key === "Escape") closeResultPop(); };
    setTimeout(() => {
      document.addEventListener("click", resultPop._docHandler);
      document.addEventListener("keydown", resultPop._keyHandler);
    }, 0);
  }
  // v3.46：👁+「预览」chip（与主面板底栏预览按钮同款）；状态行过窄时 RO 隐藏文字只留图标
  const resultBtn = h("button", {
    class: "vpl-btn vpl-btn-sm vpl-rd-preview-btn", type: "button",
    title: "预览合并结果（正/负提示词）",
    onclick: () => (_resultPopOpen ? closeResultPop() : openResultPop()),
  }, [h("span", { class: "vpl-btn-icon", html: ICONS.eye }), h("span", { class: "vpl-rd-preview-text" }, "预览")]);

  const footer = h("div", { class: "vpl-rd-footer" }, "随机抽卡 · " + PLUGIN_VERSION);

  const statusRow = h("div", { class: "vpl-rd-statusrow" }, [statusEl, resultBtn]);
  container.appendChild(toolbar);
  container.appendChild(controls);
  container.appendChild(adv);
  container.appendChild(varsBar);
  container.appendChild(statusRow);
  container.appendChild(grid);
  container.appendChild(footer);

  const domWidget = node.addDOMWidget("vpl_rd_ui", "VPL_RD_UI", container, {
    getValue() { return ""; },
    setValue() {},
    resize: false,
  });

  // v3.51：旁路视觉同步 + 执行期间锁定（共享模块 panel_guard.js）
  installBypassSync(node, container);
  installExecutionLock(node, container);

  // ---- 高度接管（复用主节点 v3.26 修复：固定最小宽度）----
  let _lastGoodH = 460;
  // v3.52：chrome 高读实际 domWidget.y（同主节点，写死 50 会随输出槽数量错位）
  // v3.53：底部留 18px 节点色底缝（同主节点 BOTTOM_GAP，把面板包住）
  const BOTTOM_GAP = 18;
  function chromeH() {
    const y = domWidget && typeof domWidget.y === "number" ? domWidget.y : 0;
    return y > 0 ? y : 50;
  }
  function realContentH() {
    // 远缩放/节点离屏时前端会 display:none 隐藏 DOM 面板（容器高度归 0），
    // 此时测量值无意义：返回上次可见时的缓存高度，防止节点高度被错误改写
    if (!container.isConnected || container.getBoundingClientRect().height === 0) return _lastGoodH;
    const prevH = container.style.height;
    const prevMax = container.style.maxHeight;
    container.style.height = "auto";
    container.style.maxHeight = "none";
    void container.offsetHeight;
    const hh = container.scrollHeight;
    container.style.height = prevH;
    container.style.maxHeight = prevMax;
    if (hh > 0) _lastGoodH = hh;
    return hh > 0 ? hh : 460;
  }
  try {
    node.computeSize = function (out) {
      out = out || [0, 0];
      out[0] = NODE_WIDTH;
      out[1] = realContentH() + chromeH() + BOTTOM_GAP;
      return out;
    };
  } catch (e) { /* 旧版前端可能不可写 */ }

  let _recalcPending = false;
  function recalcHeight() {
    if (_recalcPending) return;
    _recalcPending = true;
    requestAnimationFrame(() => {
      _recalcPending = false;
      const hh = realContentH();
      if (hh <= 0) return;
      const w = node.size[0] && node.size[0] > 0 ? node.size[0] : NODE_WIDTH;
      // v3.53：与 computeSize 对齐（chromeH 实测 + BOTTOM_GAP 底缝），旧 +50 导致底缝没变宽
      node.setSize([w, hh + chromeH() + BOTTOM_GAP]);
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
    });
  }

  function pruneStrayWidgets() {
    if (!node.widgets) return;
    const next = node.widgets.filter((w) => w === domWidget);
    if (next.length !== node.widgets.length) {
      console.warn("[VPL-RD] 检测到存储 widget 复发，已再次移除：", node.widgets.map((w) => w.name));
      node.widgets = next;
    }
  }
  [0, 200, 800, 1600, 3000].forEach((t) => setTimeout(pruneStrayWidgets, t));

  const ro = new ResizeObserver(() => recalcHeight());
  ro.observe(container);
  // v3.46：状态行过窄时隐藏「预览」文字只留图标（RO 只切换 class，不改尺寸，无反馈回路）
  const roStatus = new ResizeObserver(() => {
    statusRow.classList.toggle("vpl-rd-narrow", statusRow.clientWidth < 250);
  });
  roStatus.observe(statusRow);

  // ---- 渲染 ----
  function renderToolbar() {
    const items = (state.libraries || []).map((l) => ({
      label: locatorLabel({ source: l.source, name: l.name }, state.libraries),
      value: l.source + ":" + l.name,
      group: l.source === "builtin" ? "内置库" : "我的库",
    }));
    libDD.setItems(items);
    const cur = state.locator ? (state.locator.source + ":" + state.locator.name) : "";
    libDD.setValueSilent(cur);
    libDD.setLabel(cur ? locatorLabel(state.locator, state.libraries) : "选择库…");

    // v3.45：分类组合 + 标签筛选（多选，随库内容刷新）
    const catItems = [{ label: "• 清除分类筛选", value: "__clear__" }].concat(
      state.categories.map((c) => ({ label: c, value: c }))
    );
    catDD.setItems(catItems);
    catDD.setValueSilent(state.filterCategories);
    catDD.setLabel(state.filterCategories.length ? `已选 ${state.filterCategories.length} 项` : "分类组合");

    const rdTags = new Set();
    (state.libraryData?.groups || []).forEach((g) => (g.tags || []).forEach((t) => t && rdTags.add(t)));
    const tagItems = [{ label: "• 清除标签筛选", value: "__clear__" }].concat(
      [...rdTags].sort().map((t) => ({ label: t, value: t }))
    );
    tagDD.setItems(tagItems);
    tagDD.setValueSilent(state.filterTags);
    tagDD.setLabel(state.filterTags.length ? `已选 ${state.filterTags.length} 项` : "标签筛选");
  }
  function renderControls() {
    countVal.textContent = String(state.count);
    seedInput.value = String(state.seed);
    const sepItems = (state.separators || []).map((s) => ({ label: s.label, value: s.value }));
    sepDD.setItems(sepItems);
    sepDD.setValueSilent(state.separator);
    const found = (state.separators || []).find((s) => s.value === state.separator);
    sepDD.setLabel(found ? found.label : (state.separator || "分隔符"));
    preInput.value = state.prepend;
    appInput.value = state.append;
  }
  // v3.43：锁定/解锁一张卡（锁定卡必含；集合变化会影响抽取结果 → 重新预览）
  // v3.44：点卡片任意位置即切换锁定，锁是卡片唯一的主动交互
  function toggleLock(id) {
    if (state.lockedIds.has(id)) state.lockedIds.delete(id);
    else state.lockedIds.add(id);
    syncWidgets();
    renderList();      // 先即时反馈高亮，随后 /draw 刷新抽中集合
    schedulePreview();
  }

  // v3.43：卡片网格改增量渲染——卡内容没变（sig 相同）只切换 drawn/locked 类，
  // 不再全量 innerHTML 重建（大库 + 频繁换种子时 DOM 抖动明显）
  // v3.44：去掉 ✓「抽中」角标（不可交互、与锁概念冗余）；紫色描边保留为「当前种子
  // 将抽中」的被动预览，锁定（accent 描边 + 常显锁图标）是唯一主动交互
  let _gridSig = "";
  const _gridCards = new Map(); // id -> { card, lockInd }
  const _noMatchTip = h("div", { class: "vpl-rd-empty" }, "无匹配卡片"); // v3.45：搜索无结果提示
  function renderList() {
    const groups = (state.libraryData && state.libraryData.groups) || [];
    // v3.45：抽卡池 = 分类组合 ∪ 标签筛选（各自多选并集，两类之间取交集），与后端 draw 同口径
    const hasFilter = state.filterCategories.length > 0 || state.filterTags.length > 0;
    const pool = groups.filter((g) => {
      if (state.filterCategories.length) {
        const cats = groupCategories(g);
        if (!state.filterCategories.some((c) => cats.includes(c))) return false;
      }
      if (state.filterTags.length && !(g.tags || []).some((t) => state.filterTags.includes(t))) return false;
      return true;
    });
    if (!pool.length) {
      grid.innerHTML = "";
      _gridSig = "";
      _gridCards.clear();
      grid.appendChild(h("div", { class: "vpl-rd-empty" }, hasFilter ? "该筛选组合下没有卡片" : "库为空"));
      statusEl.textContent = "共 0 张";
      return;
    }
    const sig = pool.map((g) => [g.id, g.name || "", groupCategories(g).join("/"), g.positive || ""].join("\u0001")).join("\u0002");
    if (sig !== _gridSig) {
      grid.innerHTML = "";
      _gridCards.clear();
      _gridSig = sig;
      for (const g of pool) {
        const cats = groupCategories(g);
        const lockInd = h("span", { class: "vpl-rd-lockind", html: ICONS.lock });
        const card = h("div", { class: "vpl-rd-card",
          title: "点击锁定/解锁：锁定卡重抽时必含、不占数量名额" }, [
          h("div", { class: "vpl-rd-card-name" }, g.name || "(未命名)"),
          cats.length ? h("span", { class: "vpl-rd-card-cat", title: cats.join(" / ") }, cats.join(" / ")) : null,
          g.positive ? h("div", { class: "vpl-rd-card-snip" }, g.positive) : null,
        ]);
        card.appendChild(lockInd);
        card.addEventListener("click", () => toggleLock(g.id));
        grid.appendChild(card);
        _gridCards.set(g.id, { card, lockInd });
      }
    }
    let drawnN = 0;
    let shownN = 0;
    for (const g of pool) {
      const ref = _gridCards.get(g.id);
      if (!ref) continue;
      const locked = state.lockedIds.has(g.id);
      const drawn = state.drawnIds.has(g.id);
      if (drawn) drawnN++;
      ref.card.classList.toggle("vpl-rd-card-drawn", drawn && !locked);
      ref.card.classList.toggle("vpl-rd-card-locked", locked);
      ref.lockInd.classList.toggle("vpl-rd-lockind-on", locked);
      // v3.45：搜索仅前端显示过滤（与主面板同字段：名称/分类/正文/标签）
      const hay = [g.name, groupCategories(g).join(","), g.positive, g.negative, (g.tags || []).join(",")]
        .join("\n").toLowerCase();
      const matched = !state.search || hay.includes(state.search);
      ref.card.style.display = matched ? "" : "none";
      if (matched) shownN++;
    }
    if (state.search && !shownN) grid.appendChild(_noMatchTip);
    else _noMatchTip.remove();
    // v3.46：锁定卡被分类组合/标签筛掉或不存在时会静默失效（与后端同口径），显式提示避免“锁了却没抽中”困惑
    let invalidLock = 0;
    if (state.lockedIds.size) {
      const poolIds = new Set(pool.map((g) => g.id));
      for (const id of state.lockedIds) if (!poolIds.has(id)) invalidLock++;
    }
    statusEl.textContent = "抽中 " + drawnN + " / 候选 " + pool.length + " 张"
      + (state.search ? " · 匹配 " + shownN : "")
      + " · 锁定 " + state.lockedIds.size + (invalidLock ? "（失效 " + invalidLock + "）" : "")
      + " · 种子 " + state.seed;
  }

  // ---- v3.43：抽卡节点变量行（扫描抽中卡片的命名槽/属性标签；值持久化 state.vars）----
  function collectDrawnSlots() {
    const slots = new Map();
    const addSlot = (name, opts) => {
      if (!slots.has(name)) slots.set(name, new Set());
      (opts || []).forEach((o) => slots.get(name).add(o));
    };
    for (const g of state.drawnCards || []) {
      [g.positive, g.negative, g.prefix, g.suffix].forEach((raw) => {
        if (!raw) return;
        const t = String(raw).replace(/＃/g, "#"); // 全角＃兼容（与后端一致）
        if (t.includes("{")) {
          SLOT_RE.lastIndex = 0;
          let m;
          while ((m = SLOT_RE.exec(t))) {
            const info = parseSlotContent(m[1]);
            if (info) addSlot(info.name, info.options);
          }
        }
        if (t.includes("#")) {
          TAG_RE.lastIndex = 0;
          let m;
          while ((m = TAG_RE.exec(t))) addSlot(m[1], []);
        }
      });
    }
    return slots;
  }
  function renderVarsRD() {
    const slots = collectDrawnSlots();
    const names = [...slots.keys()];
    if (!names.length) {
      varsBar.style.display = "none";
      varsBar.innerHTML = "";
      _varsSig = "";
      return;
    }
    // 只显示当前抽中卡涉及的槽；值不删（换种子后槽可能暂时消失，值保留以便回抽恢复）
    const sig = names.map((n) => n + "=" + [...slots.get(n)].join("/")).join(";");
    const rebuild = sig !== _varsSig;
    _varsSig = sig;
    varsBar.style.display = "flex";
    if (!rebuild) {
      let stale = false;
      varsBar.querySelectorAll(".vpl-var-chip").forEach((chip) => {
        const name = chip.dataset.slot;
        if (!name) { stale = true; return; }
        const val = state.vars[name] || "";
        chip.classList.toggle("vpl-var-chip-filled", !!val);
        chip.textContent = val ? `${name}＝${val.length > 8 ? val.slice(0, 8) + "…" : val}` : name;
      });
      if (!stale) return;
    }
    varsBar.innerHTML = "";
    _varsSig = sig;
    varsBar.appendChild(h("span", {
      class: "vpl-vars-title",
      title: "抽中的卡片文本里写 #名称# 或 {名称:选项1|选项2} 即出现此变量行；点击标签弹出输入框填值",
    }, `变量 · ${names.length} 项`));
    names.forEach((name) => {
      const val = state.vars[name] || "";
      const chip = h("span", {
        class: "vpl-var-chip" + (val ? " vpl-var-chip-filled" : ""),
        title: val ? `「${name}」＝${val}（点击修改）` : `「${name}」未填（点击输入）`,
        onclick: (e) => { e.stopPropagation(); openRdVarEditor(name, [...slots.get(name)], e.currentTarget); },
      }, val ? `${name}＝${val.length > 8 ? val.slice(0, 8) + "…" : val}` : name);
      chip.dataset.slot = name; // h() 的 props 遍历不支持 dataset 对象写法，直接赋 DOM 属性
      varsBar.appendChild(chip);
    });
  }
  // 抽卡节点自己的变量填值浮层（与主面板 openVarEditor 同款交互，但取值读写 state.vars 并刷新抽卡预览）
  function openRdVarEditor(name, opts, anchor) {
    closeRdQuickEdit();
    const panel = h("div", { class: "vpl-quickpanel" });
    panel.appendChild(h("div", { class: "vpl-quickpanel-title" }, `设置变量「${name}」`));
    const hint = h("div", { class: "vpl-hint" },
      opts.length ? `候选：${opts.join(" / ")}；留空＝按候选随机` : `留空＝保留 #${name}# 原样`);
    hint.style.marginBottom = "8px";
    panel.appendChild(hint);
    const input = h("input", {
      type: "text", class: "vpl-input vpl-quickpanel-input",
      placeholder: opts.length ? `随机(${opts.join("/")})` : "输入替换值…",
      value: state.vars[name] || "",
    });
    if (opts.length) {
      const dlId = "vpl-rd-var-dl-" + name;
      input.setAttribute("list", dlId);
      panel.appendChild(h("datalist", { id: dlId }, opts.map((o) => h("option", { value: o }))));
    }
    panel.appendChild(input);
    const commit = () => {
      const v = input.value.trim();
      if (v) state.vars[name] = v;
      else delete state.vars[name];
      syncWidgets();
      closeRdQuickEdit();
      renderVarsRD();
      schedulePreview();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
      if (e.key === "Escape") { e.stopPropagation(); closeRdQuickEdit(); }
    });
    const foot = h("div", { class: "vpl-quickpanel-foot" });
    foot.appendChild(h("button", {
      class: "vpl-btn vpl-btn-sm", type: "button", title: "清空取值（恢复随机/原名）",
      onclick: (e) => { e.stopPropagation(); delete state.vars[name]; syncWidgets(); closeRdQuickEdit(); renderVarsRD(); schedulePreview(); },
    }, "清除"));
    foot.appendChild(h("button", {
      class: "vpl-btn vpl-btn-sm", type: "button",
      onclick: (e) => { e.stopPropagation(); closeRdQuickEdit(); },
    }, "取消"));
    foot.appendChild(h("button", {
      class: "vpl-btn vpl-btn-sm vpl-btn-primary", type: "button",
      onclick: (e) => { e.stopPropagation(); commit(); },
    }, "确定"));
    panel.appendChild(foot);

    document.body.appendChild(panel);
    rdQuickEditPanel = panel;
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 260, ph = panel.offsetHeight || 160;
    panel.style.position = "fixed";
    panel.style.zIndex = "100000";
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
    panel.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - ph - 8)) + "px";
    panel._docHandler = (e) => { if (!panel.contains(e.target)) closeRdQuickEdit(); };
    panel._keyHandler = (e) => { if (e.key === "Escape") closeRdQuickEdit(); };
    document.addEventListener("keydown", panel._keyHandler);
    setTimeout(() => document.addEventListener("click", panel._docHandler), 0);
    setTimeout(() => input.focus(), 30);
  }
  // v3.46：预览框按内容自适应高度（上限约 1/3 视口），长提示词不再挤在小框里滚动
  function autosizeResultAreas() {
    if (!_resultPopOpen) return;
    const maxH = Math.max(110, Math.floor(window.innerHeight * 0.32));
    for (const el of [posArea, negArea]) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, maxH) + "px";
    }
  }
  function renderResult() {
    posArea.value = state.drawnPos || "";
    negArea.value = state.drawnNeg || "";
    autosizeResultAreas();
  }
  // v3.46：前后端版本不一致直接显示在页脚（与主面板页脚同款）——旧后端收不到分类组合会筛成空池
  function renderFooter() {
    const mismatch = state.backendVersion && state.backendVersion !== PLUGIN_VERSION;
    footer.textContent = "随机抽卡 · " + PLUGIN_VERSION + (mismatch ? ` / 后端${state.backendVersion} ⚠` : "");
    footer.title = mismatch
      ? "后端未重启到新版：抽卡预览不可信（分类组合/标签筛选会被旧后端筛成空池），请重启 ComfyUI 后端"
      : "";
    footer.classList.toggle("vpl-rd-footer-warn", mismatch);
  }
  function renderAll() {
    renderToolbar();
    renderControls();
    renderList();
    renderResult();
    renderVarsRD();
    recalcHeight();
  }

  // ---- 初始化 ----
  async function init() {
    try {
      readWidgets();
      await checkBackendVersionRD();
      renderFooter();
      await loadLibrariesRD();
      readWidgets();
      if (!isValidLocator(state.locator)) {
        const def = state.libraries.find((l) => l.source === "user" && l.name === "default")
          || state.libraries.find((l) => l.source === "builtin" && l.name === "default");
        state.locator = def ? { source: def.source, name: def.name } : null;
      }
      await loadLibraryContent();
      syncWidgets();
      syncAutoSeedBtn();
      renderAll();
      schedulePreview();
      [60, 250, 600].forEach((t) => setTimeout(recalcHeight, t));
    } catch (e) {
      console.error("[VPL-RD] 初始化失败：", e);
      grid.innerHTML = "";
      grid.appendChild(h("div", { class: "vpl-empty" }, "初始化失败：" + ((e && e.message) || e)));
      recalcHeight();
    }
  }

  function refreshFromWidgets() {
    readWidgets();
    pruneStrayWidgets();
    loadLibrariesRD().then(async () => {
      try {
        await loadLibraryContent();
        syncWidgets();
        renderAll();
        schedulePreview();
        [60, 250].forEach((t) => setTimeout(() => { recalcHeight(); pruneStrayWidgets(); }, t));
      } catch (e) { console.error("[VPL-RD] 刷新失败：", e); }
    });
  }
  node._vplRdRefresh = refreshFromWidgets;
  // 节点删除时回收浮层（变量编辑浮层与合并结果弹窗挂 document.body，rAF/监听须手动停）
  const _origOnRemovedRd = node.onRemoved;
  node.onRemoved = function () {
    _origOnRemovedRd?.apply(this, arguments);
    seedCleanup?.();
    closeRdQuickEdit();
    closeResultPop();
    resultPop.remove(); // v3.61：弹层挂 body，closeResultPop 只隐藏；节点删除必须连 DOM 一起回收
  };
  if (node._vplRdPendingConfigure) {
    node._vplRdPendingConfigure = false;
    Promise.resolve().then(refreshFromWidgets);
  }

  init();
}

// ---------------------------------------------------------------------------
// ComfyUI 扩展注册
// ---------------------------------------------------------------------------
app.registerExtension({
  name: "ComfyUI-AllBuy_PromptLibrary",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_NAME || nodeData.name === NODE_NAME_LEGACY) {
      installGraphToPromptHook();
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        onNodeCreated?.apply(this, arguments);
        attachController(this);
      };
      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        onConfigure?.apply(this, arguments);
        if (this._vplRefresh) this._vplRefresh();
        else this._vplPendingConfigure = true;
      };
    } else if (nodeData.name === NODE_NAME_RANDOM || nodeData.name === NODE_NAME_RANDOM_LEGACY) {
      installGraphToPromptHook();
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        onNodeCreated?.apply(this, arguments);
        attachRandomController(this);
      };
      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        onConfigure?.apply(this, arguments);
        if (this._vplRdRefresh) this._vplRdRefresh();
        else this._vplRdPendingConfigure = true;
      };
    }
  },
});

