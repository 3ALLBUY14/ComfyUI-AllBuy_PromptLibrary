// AllBuy-文本框：大文本提示词编辑面板
//   DOM widget 面板：多行文本（同步「文本」widget，防抖写入+入队前冲刷）、
//   主题开关「去空行」、「替换表」折叠编辑（每行 旧=新）、「入库」/「从库插入」
//   快速对接提示词库（/libraries + /library + /library/save），@素材名 实时统计
//   提示（→ image1..10）。样式沿用 .vpl-* 统一体系。
import { app } from "../../scripts/app.js";
import { installBypassSync, installExecutionLock } from "./panel_guard.js";

const NODE_NAME = "AllBuyTextBox";
const API = "/allbuy_promptlibrary";
const STACK_MIN_WIDTH = 460;
const STACK_MIN_TOTAL_H = 260;
const STACK_BOTTOM_GAP = 18;
const STACK_MAX_CHROME = 300;
const STACK_FALLBACK_CHROME = 96;

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name) || null;
}

function stopGraph(el) {
  el.classList.add("alora-control");
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
}

function stackChromeH(node) {
  const y = node?._atbWidget && typeof node._atbWidget.y === "number" ? node._atbWidget.y : 0;
  if (y <= 0) return STACK_FALLBACK_CHROME;
  return Math.min(y, STACK_MAX_CHROME);
}

function recalcHeight(node) {
  if (!node || typeof node.setSize !== "function" || node._atbHeightPending) return;
  node._atbHeightPending = true;
  requestAnimationFrame(() => {
    node._atbHeightPending = false;
    const panel = node?._atbContainer;
    if (!panel?.isConnected) return;
    const host = panel.parentElement || panel;
    const measured = Math.ceil(host.scrollHeight || host.offsetHeight || 0);
    const h = Math.max(STACK_MIN_TOTAL_H, measured + stackChromeH(node) + STACK_BOTTOM_GAP);
    node._atbCachedH = h;
    if (node.size?.[1] === h) return;
    node.setSize([node.size?.[0] || STACK_MIN_WIDTH, h]);
    app.graph?.setDirtyCanvas?.(true, true);
  });
}

function apiGet(path) {
  return fetch(API + path).then((r) => r.json().catch(() => ({ ok: false })));
}
function apiPost(path, body) {
  return fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({ ok: false })));
}

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function iconBtn(label, title, onClick, cls = "") {
  const b = el("button", "vpl-btn vpl-btn-sm " + cls, label);
  b.type = "button";
  b.title = title;
  stopGraph(b);
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(e); });
  return b;
}

// ---------------------------------------------------------------------------
// 入库 / 从库插入 弹窗（overlay 复用 .vpl-overlay 主题）
// ---------------------------------------------------------------------------
async function userLibraries() {
  const d = await apiGet("/libraries");
  const libs = (d && d.ok && Array.isArray(d.libraries)) ? d.libraries : [];
  return libs.filter((x) => x.locator && x.locator.source === "user");
}

function dialogShell(titleText, bodyBuild) {
  const overlay = el("div", "vpl-overlay");
  const dialog = el("div", "vpl-dialog atb-dialog");
  overlay.appendChild(dialog);
  const title = el("div", "vpl-dialog-title");
  const span = el("span", null, titleText);
  const closeBtn = iconBtn("✕", "关闭", () => close());
  title.append(span, closeBtn);
  dialog.appendChild(title);
  const body = el("div", "vpl-dialog-body");
  dialog.appendChild(body);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  bodyBuild(body, close);
  return { overlay, close };
}

function saveToLibrary(text, onDone) {
  dialogShell("入库到提示词库", async (body, close) => {
    const hint = el("div", "vpl-empty atb-hint", "当前文本将作为新提示词组加入所选用户库");
    const libSel = el("select", "vpl-input atb-select");
    libSel.appendChild(el("option", null, "加载用户库…")).value = "";
    const nameInput = el("input", "vpl-input");
    nameInput.type = "text";
    nameInput.placeholder = "新提示词组名称";
    stopGraph(libSel); stopGraph(nameInput);
    const label = (n) => el("label", "atb-field-label", n);
    const foot = el("div", "vpl-dialog-footer");
    const okBtn = iconBtn("入库", "保存到所选库", async () => {
      const lib = libSel.value;
      const gname = nameInput.value.trim();
      if (!lib || !gname) { okBtn.textContent = "✗ 需选库并填组名"; setTimeout(() => { okBtn.textContent = "入库"; }, 1200); return; }
      okBtn.disabled = true;
      try {
        const loc = { source: "user", name: lib };
        const d = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(loc)));
        const data = (d && d.ok && d.library) ? d.library : { version: 1, name: lib, groups: [] };
        data.groups = data.groups || [];
        if (data.groups.some((g) => (g.name || "").trim() === gname)) {
          okBtn.disabled = false;
          okBtn.textContent = "✗ 同名组已存在";
          setTimeout(() => { okBtn.textContent = "入库"; }, 1500);
          return;
        }
        data.groups.push({
          id: "atb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name: gname, category: "", positive: text, negative: "", note: "",
          color: "", weight: 1, prefix: "", suffix: "", tags: [], cover: "",
        });
        const saved = await apiPost("/library/save", { locator: loc, data });
        if (!saved || saved.ok !== true) throw new Error((saved && saved.error) || "保存失败");
        okBtn.textContent = "✓ 已入库";
        setTimeout(() => { close(); onDone && onDone(); }, 500);
      } catch (err) {
        okBtn.disabled = false;
        okBtn.textContent = "✗ " + (err.message || "失败");
        setTimeout(() => { okBtn.textContent = "入库"; }, 1800);
      }
    }, "vpl-btn-primary");
    foot.appendChild(okBtn);
    body.append(hint, label("用户库"), libSel, label("提示词组名称"), nameInput, foot);
    const libs = await userLibraries();
    libSel.innerHTML = "";
    if (!libs.length) {
      libSel.appendChild(el("option", null, "（无用户库）")).value = "";
      libSel.disabled = true;
      return;
    }
    for (const L of libs) {
      const opt = el("option", null, L.display || L.name || L.locator.name);
      opt.value = L.locator.name;
      libSel.appendChild(opt);
    }
    nameInput.focus();
  });
}

function insertFromLibrary(onInsert) {
  dialogShell("从提示词库插入", async (body) => {
    const libSel = el("select", "vpl-input atb-select");
    stopGraph(libSel);
    const list = el("div", "vpl-list atb-lib-list");
    const hint = el("div", "vpl-empty atb-hint", "选择库后点击组即可插入到光标处");
    body.append(hint, libSel, list);
    const libs = await userLibraries();
    libSel.innerHTML = "";
    if (!libs.length) {
      libSel.appendChild(el("option", null, "（无用户库）")).value = "";
      list.appendChild(el("div", "vpl-empty", "还没有用户库，先在提示词库面板创建"));
      return;
    }
    for (const L of libs) {
      const opt = el("option", null, L.display || L.name || L.locator.name);
      opt.value = L.locator.name;
      libSel.appendChild(opt);
    }
    const load = async () => {
      list.replaceChildren();
      list.appendChild(el("div", "vpl-empty", "加载中…"));
      const loc = { source: "user", name: libSel.value };
      const d = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(loc)));
      list.replaceChildren();
      const groups = (d && d.ok && d.library && Array.isArray(d.library.groups)) ? d.library.groups : [];
      if (!groups.length) { list.appendChild(el("div", "vpl-empty", "该库没有提示词组")); return; }
      for (const g of groups) {
        const row = el("div", "vpl-item atb-lib-item");
        stopGraph(row);
        const name = el("span", "vpl-item-name", g.name || "未命名");
        name.title = g.name || "";
        const preview = el("span", "vpl-item-cat atb-lib-prev",
          (g.positive || "").replace(/\s+/g, " ").slice(0, 40) || "（空）");
        row.append(name, preview);
        row.addEventListener("click", () => {
          onInsert((g.positive || "").trim());
          // 插入后不关弹窗：可连续插入多组；按 Esc/✕ 关闭
        });
        list.appendChild(row);
      }
    };
    libSel.addEventListener("change", load);
    await load();
  });
}

// ---------------------------------------------------------------------------
// 节点挂载
// ---------------------------------------------------------------------------
function hideNativeWidget(w) {
  if (!w) return;
  w.options = w.options || {};
  w.options.hidden = true;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
}

function attach(node) {
  if (node._atbContainer) return;
  const wText = findWidget(node, "文本");
  const wRep = findWidget(node, "替换表");
  const wDrop = findWidget(node, "去空行");
  hideNativeWidget(wText);
  hideNativeWidget(wRep);
  hideNativeWidget(wDrop);

  const container = document.createElement("div");
  container.className = "vpl-node atb-node";
  container.style.cssText = "pointer-events:none;";
  installBypassSync(node, container);
  installExecutionLock(node, container);
  requestAnimationFrame(() => {
    container.querySelector(".vpl-exec-bar")?.classList.add("alora-control");
  });

  const panel = el("div", "atb-panel");
  node._atbContainer = panel;

  // ---- 顶栏 ----
  // 去空行主题开关（须先于 tbar.append 声明，TDZ）
  const dropSwitch = el("div", "atb-switch" + ((wDrop ? wDrop.value !== false : true) ? " on" : ""));
  dropSwitch.title = "输出前删除空行";
  stopGraph(dropSwitch);
  dropSwitch.addEventListener("click", () => {
    const on = !dropSwitch.classList.contains("on");
    dropSwitch.classList.toggle("on", on);
    if (wDrop) wDrop.value = on;
    updateBadge();
    node.setDirtyCanvas?.(true, true);
  });

  const tbar = el("div", "atb-tbar");
  const libBtn = iconBtn("入库", "把当前文本存为新提示词组（用户库）", () => {
    const t = area.value.trim();
    if (!t) return;
    saveToLibrary(t, () => {
      libBtn.textContent = "✓ 已入库";
      setTimeout(() => { libBtn.textContent = "入库"; }, 1200);
    });
  }, "vpl-btn-primary");
  const insBtn = iconBtn("从库插入", "从提示词库选择组插入文本", () => {
    insertFromLibrary((text) => {
      insertAtCursor(area, text);
      scheduleSave();
      insBtn.textContent = "✓ 已插入";
      setTimeout(() => { insBtn.textContent = "从库插入"; }, 1200);
    });
  });
  const repBtn = iconBtn("替换", "展开/收起替换表（每行 旧=新）", () => {
    repWrap.style.display = repWrap.style.display === "none" ? "" : "none";
    recalcHeight(node);
  });
  tbar.append(libBtn, insBtn, repBtn, dropSwitch);
  panel.appendChild(tbar);

  // ---- 文本区 ----
  const area = el("textarea", "vpl-input atb-area");
  area.value = (wText && wText.value) || "";
  area.placeholder = "输入提示词，每行一段；@素材名 引用素材库图片（映射为 image1..10）";
  stopGraph(area);
  panel.appendChild(area);

  // ---- 状态徽标行 ----
  const badge = el("div", "atb-badge");
  panel.appendChild(badge);

  // ---- 替换表折叠区 ----
  const repWrap = el("div", "atb-repwrap");
  repWrap.style.display = "none";
  const repLabel = el("div", "atb-field-label", "替换表（每行一条：旧=新，按顺序应用）");
  const repArea = el("textarea", "vpl-input atb-area atb-reparea");
  repArea.value = (wRep && wRep.value) || "";
  repArea.placeholder = "示例：\n杰作=masterpiece\n人物=girl";
  stopGraph(repArea);
  repWrap.append(repLabel, repArea);
  panel.appendChild(repWrap);

  container.appendChild(panel);

  // ---- 同步（防抖写入 widget，入队/关页前冲刷） ----
  let timer = 0;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (wText) wText.value = area.value;
    if (wRep) wRep.value = repArea.value;
    node.setDirtyCanvas?.(true, true);
  };
  const scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
    updateBadge();
  };
  area.addEventListener("input", scheduleSave);
  repArea.addEventListener("input", scheduleSave);

  const insertAtCursor = (ta, text) => {
    if (!text) return;
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    const pre = ta.value.slice(0, s);
    const post = ta.value.slice(e);
    const glue = pre && !pre.endsWith("\n") && !pre.endsWith(" ") ? "\n" : "";
    ta.value = pre + glue + text + post;
    const pos = (pre + glue + text).length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  };

  // 状态徽标：行数/去空行/@素材
  function updateBadge() {
    const drop = wDrop ? wDrop.value !== false : true;
    const lines = area.value.split("\n");
    const nonBlank = lines.filter((l) => l.trim()).length;
    const ats = [];
    for (const m of area.value.matchAll(/@([^\s@，。,.：:；;！!？?（）()【】\[\]、]+)/g)) {
      if (m[1] && !ats.includes(m[1])) ats.push(m[1]);
    }
    const atText = ats.length
      ? ` · @素材 ${ats.length}${ats.length > 10 ? "（前 10 个生效）" : ""}`
      : "";
    badge.textContent = `${nonBlank} 行${drop ? "（去空行）" : ""}${atText}`;
  }
  updateBadge();
  node._atbFlush = flush; // 入队/关页冲刷用（直接写穿，不走防抖）
  node._atbBadgeRefresh = updateBadge;

  // ---- DOM widget 与高度管理（兄弟节点同款配方） ----
  const domWidget = node.addDOMWidget("textbox_ui", "ATB_UI", container, {
    getValue() { return ""; },
    setValue() {},
    resize: false,
  });
  node._atbWidget = domWidget;
  domWidget.computeSize = () => [0, -4];

  [60, 250, 600].forEach((t) => setTimeout(() => recalcHeight(node), t));
  const ro = new ResizeObserver(() => recalcHeight(node));
  ro.observe(container);
  const _origOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    _origOnRemoved?.apply(this, arguments);
    ro.disconnect();
  };
  node._atbRecalc = () => recalcHeight(node);
}

// 入队/关页前冲刷防抖（丢尾防护，与 LoRA 堆栈同款；直接调 flush 写穿）
app.addEventListener?.("queue", () => {
  for (const n of app?.graph?._nodes || []) {
    if (n?.type === NODE_NAME && typeof n?._atbFlush === "function") n._atbFlush();
  }
});
window.addEventListener("beforeunload", () => {
  for (const n of app?.graph?._nodes || []) {
    if (n?.type === NODE_NAME && typeof n?._atbFlush === "function") n._atbFlush();
  }
});

app.registerExtension({
  name: "AllBuy.TextBox",
  async setup() {
    setTimeout(() => {
      for (const node of app?.graph?._nodes || []) {
        if (node?.type === NODE_NAME || node?.comfyClass === NODE_NAME) attach(node);
      }
    }, 500);
  },
  async nodeCreated(node) {
    if (node?.type !== NODE_NAME && node?.comfyClass !== NODE_NAME) return;
    attach(node);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      if (onConfigure) onConfigure.apply(this, arguments);
      setTimeout(() => {
        if (!this._atbContainer) attach(this);
        // 工作流恢复：widget 值回填面板
        const panel = this._atbContainer;
        if (panel) {
          const area = panel.querySelector(".atb-area");
          const rep = panel.querySelector(".atb-reparea");
          const wt = findWidget(this, "文本");
          const wr = findWidget(this, "替换表");
          if (area && wt && area.value !== (wt.value || "")) area.value = wt.value || "";
          if (rep && wr && rep.value !== (wr.value || "")) rep.value = wr.value || "";
          this._atbBadgeRefresh?.();
        }
      }, 0);
    };
  },
});

console.info("[AllBuy_PromptLibrary] 文本框前端已加载 v3.103");
