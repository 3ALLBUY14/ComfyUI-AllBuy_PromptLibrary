// 素材加载节点前端：图片/音频/视频统一入料与选择面板（P1）
//   入料：＋添加（文件/文件夹）、节点拖入、Ctrl+V（悬停时接管 paste），
//         全部走 ComfyUI 原生 /upload/image 端点（subfolder=allbuy_media），XHR 带进度。
//   面板：图片/音频/视频三 Tab + JS 显式分列瀑布流（避开 CSS columns 碎片化）；
//         图片多选（点选即生效，序号徽标 = batch 顺序，可拖拽改序）；音/视频单选。
//   高度：照抄 bips 方案——domWidget.computeSize=[0,-4] + 缓存驱动 node.computeSize，
//         recalcHeight 里 measure + chrome(domWidget.y) + BOTTOM_PAD(18px 节点色底缝)。
//   顶部槽位带：onDrawBackground 画 图片/视频/音频 三联预览卡，消除 8 输出口的留白区；
//         预览卡底板与卡片都在右侧接口标签保留区（HERO_PORT_ZONE）前停住，绝不进入。
import { app } from "../../scripts/app.js";
import { installBypassSync, installExecutionLock } from "./panel_guard.js";

const API = "/allbuy_promptlibrary";
const NODE_NAME = "MediaAssetLoader";
const NODE_WIDTH = 470;
const MEDIA_VERSION = "v1.32"; // 面板右下角版本号 + CSS/JS 缓存戳，随迭代递增（v1.1、v1.2…）
const MEDIA_DIR = "allbuy_media";

(function injectStyle() {
  if (document.getElementById("media-style-link")) return;
  const link = document.createElement("link");
  link.id = "media-style-link";
  link.rel = "stylesheet";
  link.type = "text/css";
  try {
    link.href = new URL("./style.css?v=" + MEDIA_VERSION, import.meta.url).href;
  } catch (e) {
    link.href = "/extensions/ComfyUI-AllBuy_PromptLibrary/style.css?v=" + MEDIA_VERSION;
  }
  document.head.appendChild(link);
})();

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children || []) {
    if (c == null) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function uid() { return "a-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function apiGet(url) {
  const res = await fetch(API + url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(API + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.ok === false) throw new Error(d.error || "HTTP " + res.status);
  return d;
}

// 存储 widget 隐藏（照抄 VPL 验证可用的完整配方：Vue 前端布局必须挂 computeLayoutSize）
function hideStorageWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.visible = false;
  if (w.options) w.options.hidden = true;
  try { w.computeSize = function () { return [0, -4]; }; } catch (e) { /* ignore */ }
  try {
    w.computeLayoutSize = function () {
      return { minHeight: 0, minWidth: 0, maxHeight: 0, maxWidth: 0, height: 0, width: 0 };
    };
  } catch (e) { /* ignore */ }
  try { w.getMinHeight = function () { return 0; }; } catch (e) { /* ignore */ }
  try { w.getMaxHeight = function () { return 0; }; } catch (e) { /* ignore */ }
}

const TYPE_LABEL = { image: "图片", audio: "音频", video: "视频" };
const SORT_LABEL = { custom: "排序:自定义", name: "排序:名称", time: "排序:时间", size: "排序:大小" };

function extType(name) {
  const e = (name.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"].includes(e)) return "image";
  if (["wav", "mp3", "ogg", "m4a", "flac", "aac"].includes(e)) return "audio";
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg"].includes(e)) return "video";
  return "";
}

function fmtSize(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + "B";
  if (n < 1048576) return (n / 1024).toFixed(0) + "KB";
  return (n / 1048576).toFixed(1) + "MB";
}
function fmtDur(s) {
  s = Math.round(s || 0);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// 前端元数据探测（P1）：图片尺寸 / 音视频时长，失败静默
function probeLocal(file, type) {
  return new Promise((resolve) => {
    const meta = { w: 0, h: 0, duration: 0, fps: 0 };
    const url = URL.createObjectURL(file);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    setTimeout(done, 5000); // 个别封装 metadata 事件不来：兜底放行，别卡住整批导入
    try {
      if (type === "image") {
        const im = new Image();
        im.onload = () => { meta.w = im.naturalWidth; meta.h = im.naturalHeight; done(); };
        im.onerror = done;
        im.src = url;
      } else if (type === "audio") {
        const a = document.createElement("audio");
        a.preload = "metadata";
        a.onloadedmetadata = () => { meta.duration = a.duration || 0; done(); };
        a.onerror = done;
        a.src = url;
      } else if (type === "video") {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => {
          meta.duration = v.duration || 0; meta.w = v.videoWidth || 0; meta.h = v.videoHeight || 0; done();
        };
        v.onerror = done;
        v.src = url;
      } else done();
    } catch (e) { done(); }
  });
}

// 原生 /upload/image 上传（VHS 同款 XHR 带进度），成功返回 {name, abs}
function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("image", file);
    fd.append("subfolder", MEDIA_DIR);
    fd.append("type", "input");
    fd.append("overwrite", "false");
    const req = new XMLHttpRequest();
    req.open("POST", "/upload/image");
    req.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });
    req.addEventListener("load", () => {
      try {
        const res = JSON.parse(req.responseText);
        if (req.status !== 200 || res.error) { reject(new Error(res.error || ("HTTP " + req.status))); return; }
        const sub = res.subfolder ? res.subfolder + "/" : "";
        resolve({ name: res.name, rel: sub + res.name, type: res.type || "input" });
      } catch (e) { reject(e); }
    });
    req.addEventListener("error", () => reject(new Error("网络错误")));
    req.send(fd);
  });
}

function startMediaPanel(node, container, wManifest) {
  const state = {
    assets: [],            // [{id, file(相对 input), name, type, label, size, mtime, w, h, duration, fps}]
    selected: { image: [], audio: null, video: null },
    scale: { mode: "none", value: 1024, multiple: 0 },
    videoParams: { start: 0, end: 0, fps: 0, max_frames: 0 },
    audioParams: { start: 0, duration: 0 },
    probing: new Set(), // 正在 probe 的素材名，防重复请求
    tab: "image",
    search: "",
    sortBy: "custom",      // custom | name | time | size
    thumbW: 120,           // 缩略图目标卡宽（120–360，默认 120=3 列小图；列数随面板宽自适应）
    hover: false,          // Ctrl+V 接管标志
    dragId: null,
    uploadSeq: 0,
  };
  const els = {};

  // ---- 持久化：widget.value（ComfyUI 序列化直读）+ properties._media ----
  function manifestText() {
    return JSON.stringify({
      version: 1,
      assets: state.assets,
      selected: state.selected,
      scale: state.scale,
      video_params: state.videoParams,
      audio_params: state.audioParams,
      thumbW: state.thumbW,
    });
  }
  function save() {
    const json = manifestText();
    // 写入所有同名存储 widget（前端若重建过副本，旧引用会失效，逐个写保证序列化正确）
    for (const w of node.widgets || []) {
      if (w && w.name === "素材清单") w.value = json;
    }
    node.properties = node.properties || {};
    node.properties._media = json;
    // 执行注入钩子用：值由 state 单一真值源回注，不依赖 widget 引用
    node._mediaInputs = function () { return { 素材清单: json }; };
    node.setDirtyCanvas?.(true, true);
  }
  function loadFromSaved() {
    const saved = (node.properties && node.properties._media) || (wManifest && wManifest.value) || "{}";
    let cfg;
    try { cfg = JSON.parse(saved); } catch { cfg = {}; }
    if (!cfg || typeof cfg !== "object") cfg = {};
    state.assets = Array.isArray(cfg.assets) ? cfg.assets : [];
    const sel = cfg.selected || {};
    state.selected = {
      image: Array.isArray(sel.image) ? sel.image.filter((x) => typeof x === "string") : [],
      audio: typeof sel.audio === "string" ? sel.audio : null,
      video: typeof sel.video === "string" ? sel.video : null,
    };
    const sc = cfg.scale || {};
    state.scale = {
      mode: ["none", "longest", "shortest", "width", "height"].includes(sc.mode) ? sc.mode : "none",
      value: Math.max(0, parseInt(sc.value, 10) || 1024),
      multiple: [0, 8, 16, 32, 64].includes(sc.multiple) ? sc.multiple : 0,
    };
    const vp = cfg.video_params || {};
    state.videoParams = {
      start: Math.max(0, parseFloat(vp.start) || 0),
      end: Math.max(0, parseFloat(vp.end) || 0),
      fps: Math.max(0, parseFloat(vp.fps) || 0),
      max_frames: Math.max(0, parseInt(vp.max_frames, 10) || 0),
    };
    const ap = cfg.audio_params || {};
    state.audioParams = {
      start: Math.max(0, parseFloat(ap.start) || 0),
      duration: Math.max(0, parseFloat(ap.duration) || 0),
    };
    state.thumbW = Math.min(360, Math.max(120, parseInt(cfg.thumbW, 10) || 120));
  }

  // ---- 清单操作 ----
  function byId(id) { return state.assets.find((a) => a.id === id); }
  function assetsOf(type) { return state.assets.filter((a) => a.type === type); }
  function assetFileName(a) { return a.name || (a.file || "").split("/").pop(); }

  // 后端探测补全（fps 前端拿不到）：导入音/视频后异步调用，按 name 去重；
  // 失败不再重试（probeFailed），否则 render→probe→render 死循环
  const probeFailed = new Set();
  async function probeAssetMeta(a) {
    const fname = assetFileName(a);
    if (!fname || state.probing.has(fname) || probeFailed.has(fname)) return;
    state.probing.add(fname);
    try {
      const d = await apiGet("/media/probe?name=" + encodeURIComponent(fname));
      let touched = false;
      if (d && d.ok) {
        if (d.fps > 0 && !a.fps) { a.fps = Math.round(d.fps * 100) / 100; touched = true; }
        if (d.duration > 0 && !a.duration) { a.duration = d.duration; touched = true; }
        if (d.w > 0 && !a.w) { a.w = d.w; a.h = d.h; touched = true; }
      }
      if (touched) { save(); renderGrid(); }
      else probeFailed.add(fname);
    } catch (e) { probeFailed.add(fname); }
    finally { state.probing.delete(fname); }
  }

  function addFiles(files) {
    const list = [...files];
    const accepted = [];
    for (const f of list) {
      const t = extType(f.name);
      if (!t) continue;
      accepted.push({ file: f, type: t });
    }
    const rejected = list.length - accepted.length;
    if (!accepted.length) {
      if (rejected) alert("没有可识别的素材文件（支持图片/音频/视频）");
      return;
    }
    const seq = ++state.uploadSeq;
    showProgress(`正在导入 0/${accepted.length} …`);
    let done = 0;
    (async () => {
      for (const { file, type } of accepted) {
        try {
          const up = await uploadOne(file, (p) =>
            showProgress(`正在导入 ${done + 1}/${accepted.length}：${file.name}（${Math.round(p * 100)}%）`));
          const meta = await probeLocal(file, type);
          if (state.assets.some((a) => a.file === up.rel)) {
            // 本分发 ComfyUI 对重名上传 overwrite=false 是静默保留原文件（返回原名不改名）：
            // 同 rel 再入清单只会多一张指向旧内容的卡，跳过并提示
            toast(`「${up.name}」已存在（同名保留原文件），已跳过`);
          } else {
            state.assets.push({
              id: uid(), file: up.rel, name: up.name, type,
              label: up.name, size: file.size, mtime: file.lastModified / 1000 || Date.now() / 1000,
              w: meta.w, h: meta.h, duration: meta.duration, fps: meta.fps,
            });
            if (type !== "image") probeAssetMeta(state.assets[state.assets.length - 1]);
          }
        } catch (e) {
          console.warn("[MediaAsset] 上传失败：", file.name, e);
        }
        done++;
        showProgress(`正在导入 ${done}/${accepted.length} …`);
      }
      if (state.uploadSeq === seq) hideProgress();
      save();
      render();
    })();
  }

  function removeAsset(id) {
    const a = byId(id);
    if (!a) return;
    state.assets = state.assets.filter((x) => x.id !== id);
    state.selected.image = state.selected.image.filter((x) => x !== id);
    if (state.selected.audio === id) state.selected.audio = null;
    if (state.selected.video === id) state.selected.video = null;
    save();
    render();
  }

  function toggleSelect(a) {
    if (a.type === "image") {
      const i = state.selected.image.indexOf(a.id);
      if (i >= 0) state.selected.image.splice(i, 1);
      else state.selected.image.push(a.id); // 追加到尾部 = batch 顺序
    } else {
      state.selected[a.type] = state.selected[a.type] === a.id ? null : a.id; // 单选切换
    }
    save();
    render();
  }

  // 拖拽排序（图片 Tab，仅 custom）：重排 assets，并同步 selected.image 的相对顺序
  function reorderImages(dragId, targetId) {
    const imgs = assetsOf("image");
    const from = imgs.findIndex((a) => a.id === dragId);
    let to = imgs.findIndex((a) => a.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = imgs.splice(from, 1);
    imgs.splice(to, 0, moved);
    const order = new Map(imgs.map((a, i) => [a.id, i]));
    state.assets = state.assets.filter((a) => a.type !== "image").concat(imgs);
    state.selected.image.sort((x, y) => (order.get(x) ?? 1e9) - (order.get(y) ?? 1e9));
    save();
    render();
  }

  // ---- UI 构建 ----
  els.progress = h("div", { class: "media-progress", style: "display:none" });
  els.progressText = h("span", {}, "");
  els.progressBar = h("i");
  els.progress.append(els.progressBar, els.progressText);
  container.appendChild(els.progress);
  function showProgress(text) {
    els.progress.style.display = "flex";
    els.progressText.textContent = text;
  }
  function hideProgress() { els.progress.style.display = "none"; }

  els.addMenu = null;
  function closeAddMenu() {
    if (els.addMenu) { els.addMenu.remove(); els.addMenu = null; }
  }
  function openAddMenu() {
    closeAddMenu();
    const menu = h("div", { class: "media-addmenu" });
    const mk = (label, fn) => {
      const it = h("div", { class: "media-addmenu-item" }, [label]);
      it.addEventListener("click", () => { closeAddMenu(); fn(); });
      return it;
    };
    menu.appendChild(mk("📄 选择文件（图片/音频/视频）", () => fileInput.click()));
    menu.appendChild(mk("📂 选择文件夹（递归导入）", () => folderInput.click()));
    menu.appendChild(mk("📋 粘贴剪贴板（Ctrl+V）", () => toast("鼠标悬停在本面板上按 Ctrl+V 即可粘贴")));
    menu.appendChild(h("div", { class: "media-addmenu-sep" }));
    menu.appendChild(h("div", { class: "media-addmenu-hint" },
      ["也可直接拖文件 / 文件夹到节点，或悬停时按 ", h("b", {}, "Ctrl+V")]));
    container.appendChild(menu);
    els.addMenu = menu;
    setTimeout(() => {
      const off = (e) => {
        if (els.addMenu && !els.addMenu.contains(e.target) && e.target !== els.addBtn) { closeAddMenu(); document.removeEventListener("click", off); }
      };
      document.addEventListener("click", off);
    }, 0);
  }
  function toast(text) { showProgress(text); setTimeout(hideProgress, 2200); }

  const fileInput = h("input", { type: "file", multiple: "", accept: "image/*,audio/*,video/*", style: "display:none" });
  fileInput.addEventListener("change", () => { if (fileInput.files?.length) addFiles(fileInput.files); fileInput.value = ""; });
  const folderInput = h("input", { type: "file", multiple: "", webkitdirectory: "", style: "display:none" });
  folderInput.addEventListener("change", () => { if (folderInput.files?.length) addFiles(folderInput.files); folderInput.value = ""; });
  container.append(fileInput, folderInput);

  els.addBtn = h("button", { class: "media-btn pri", type: "button", onclick: openAddMenu }, ["＋ 添加"]);
  els.search = h("input", { class: "media-search", type: "text", placeholder: "搜索文件名", spellcheck: "false" });
  els.search.addEventListener("input", () => { state.search = els.search.value.trim().toLowerCase(); renderGrid(); });
  els.sortBtn = h("button", { class: "media-btn", type: "button", title: "排序方式（自定义=可拖拽）", onclick: () => {
    const order = ["custom", "name", "time", "size"];
    state.sortBy = order[(order.indexOf(state.sortBy) + 1) % order.length];
    els.sortBtn.textContent = SORT_LABEL[state.sortBy];
    renderGrid();
  } }, [SORT_LABEL.custom]);
  // 「尺寸」chip + 弹层滑条（v1.28）：调缩略图目标卡宽，列数随面板宽自适应
  els.sizeBtn = h("button", { class: "media-btn", type: "button", title: "缩略图大小（列数随面板宽度自适应）" });
  els.sizeVal = h("span", { class: "media-szpop-val" });
  els.sizeRange = h("input", { type: "range", min: "120", max: "360", step: "10" });
  els.sizeHint = h("div", { class: "media-szpop-hint" });
  els.sizePop = h("div", { class: "media-szpop", style: "display:none" }, [
    h("div", { class: "media-szpop-hd" }, [h("b", {}, ["缩略图大小"]), els.sizeVal]),
    els.sizeRange,
    h("div", { class: "media-szpop-ticks" }, [h("span", {}, ["小 · 默认"]), h("span", {}, ["中"]), h("span", {}, ["大 · 单列"])]),
    els.sizeHint,
  ]);
  function syncSizeChip() { els.sizeBtn.textContent = "尺寸:" + state.thumbW; }
  function syncSizePop() {
    els.sizeVal.textContent = state.thumbW + " px";
    els.sizeRange.value = String(state.thumbW);
    els.sizeHint.textContent = `列数随面板宽度自适应：当前 ${_lastCols} 列。把节点拉宽会自动增列；设置随清单记忆。`;
  }
  els.sizeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const show = els.sizePop.style.display === "none";
    els.sizePop.style.display = show ? "block" : "none";
    if (show) syncSizePop();
  });
  els.sizeRange.addEventListener("input", () => {
    state.thumbW = parseInt(els.sizeRange.value, 10) || 120;
    save();
    syncSizeChip();
    syncSizePop();
    renderGrid();
  });
  // 点弹层外面关闭
  const onDocPointerClose = (e) => {
    if (els.sizePop.style.display === "none") return;
    if (els.sizePop.contains(e.target) || els.sizeBtn.contains(e.target)) return;
    els.sizePop.style.display = "none";
  };
  document.addEventListener("pointerdown", onDocPointerClose, true);
  // 「清空」chip：移除清单里全部素材（不删已上传文件），破坏性操作走确认弹窗
  els.clearBtn = h("button", {
    class: "media-btn clear", type: "button", title: "清空全部素材（不删除已上传的文件）",
    onclick: () => {
      const total = state.assets.length;
      if (!total) return;
      openConfirm("清空全部素材", `共 ${total} 个素材将从清单移除；已上传到 input/allbuy_media 的文件不会被删除。`, "清空", () => {
        state.assets = [];
        state.selected = { image: [], audio: null, video: null };
        save();
        render();
      });
    },
  }, ["清空"]);
  const tbar = h("div", { class: "media-tbar" }, [els.addBtn, els.search, els.sortBtn, els.sizeBtn, els.clearBtn]);

  els.tabs = h("div", { class: "media-tabs" });
  els.tabs.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (!t) return;
    state.tab = t.dataset.tab;
    renderTabs();
    renderGrid();
  });

  els.grid = h("div", { class: "media-grid" });
  els.grid.addEventListener("scroll", () => updateGridFade(), { passive: true });
  els.gridFade = h("div", { class: "media-grid-fade off" });
  els.gridWrap = h("div", { class: "media-grid-wrap" }, [els.grid, els.gridFade]);
  els.empty = h("div", { class: "media-empty", style: "display:none" },
    ["暂无素材。点「＋ 添加」选择文件 / 文件夹，直接拖文件 / 文件夹到节点，或悬停面板按 Ctrl+V 粘贴截图与文件。"]);
  els.count = h("span", {}, "");
  els.footer = h("div", { class: "media-footer" }, [
    els.count, h("span", { class: "media-footer-sp" }),
    // 版本行经 ::after/attr() 渲染：纯文本节点会被中文翻译插件的词典替换弄乱
    h("span", { class: "media-footer-ver", "data-ver": "MediaAssetLoader " + MEDIA_VERSION, translate: "no" }),
  ]);

  const panel = h("div", { class: "media-panel" }, [tbar, els.tabs, els.gridWrap, els.empty, els.sizePop]);
  container.append(panel, els.footer);

  // 通用确认弹窗（清空等破坏性操作）：复用 .media-overlay/.media-dialog，点遮罩=取消
  let confirmDlg = null;
  function openConfirm(title, text, okLabel, onOk) {
    if (confirmDlg) { confirmDlg.remove(); confirmDlg = null; }
    const dlg = h("div", { class: "media-overlay" });
    const box = h("div", { class: "media-dialog" });
    box.appendChild(h("div", { class: "media-dialog-hd" }, [title]));
    const cancel = h("button", { class: "media-btn", type: "button", onclick: () => { dlg.remove(); confirmDlg = null; } }, ["取消"]);
    const ok = h("button", { class: "media-btn danger", type: "button", onclick: () => { dlg.remove(); confirmDlg = null; onOk(); } }, [okLabel]);
    box.append(h("div", { class: "media-dialog-bd media-dialog-text" }, [text]), h("div", { class: "media-dialog-ft" }, [cancel, ok]));
    dlg.appendChild(box);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) { dlg.remove(); confirmDlg = null; } });
    document.body.appendChild(dlg);
    confirmDlg = dlg;
  }

  function renderTabs() {
    els.tabs.innerHTML = "";
    for (const t of ["image", "audio", "video"]) {
      const n = assetsOf(t).length;
      els.tabs.appendChild(h("div", {
        class: "media-tab" + (state.tab === t ? " on" : ""),
        "data-tab": t,
      }, [TYPE_LABEL[t], h("span", { class: "media-tab-n" }, String(n))]));
    }
  }

  function visibleAssets() {
    let list = assetsOf(state.tab);
    if (state.search) list = list.filter((a) => (a.label || a.name || "").toLowerCase().includes(state.search));
    if (state.sortBy !== "custom") {
      const key = state.sortBy === "name" ? (a) => (a.label || "").toLowerCase()
        : state.sortBy === "time" ? (a) => -(a.mtime || 0) : (a) => -(a.size || 0);
      list = [...list].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
    }
    return list;
  }

  function fmtSec(s) { return (Math.round((s || 0) * 100) / 100) + "s"; }

  function metaText(a) {
    if (a.type === "image") return a.w ? `${a.w}×${a.h}` : fmtSize(a.size);
    if (a.type === "audio") {
      const ap = state.audioParams;
      const trimmed = state.selected.audio === a.id && (ap.start > 0 || ap.duration > 0);
      if (trimmed) return `选区 ${fmtSec(ap.start)}起 · ${fmtSec(ap.duration || Math.max(0, (a.duration || 0) - ap.start))}`;
      return (a.duration ? fmtDur(a.duration) : "音频") + (a.size ? " · " + fmtSize(a.size) : "");
    }
    // 视频：带选区/帧率时显示「选区 → N帧@fps」
    const vp = state.videoParams;
    const trimmed = state.selected.video === a.id && (vp.start > 0 || vp.end > 0 || vp.fps > 0 || vp.max_frames > 0);
    if (trimmed) {
      const end = vp.end > 0 ? vp.end : (a.duration || 0);
      const fps = vp.fps > 0 ? vp.fps : (a.fps || 0);
      const est = end > vp.start && fps > 0 ? Math.round((end - vp.start) * fps) : 0;
      const cap = vp.max_frames > 0 && est > vp.max_frames ? `≤${vp.max_frames}` : "";
      return `选区 ${fmtSec(vp.start)}–${fmtSec(end)} → ${est ? est + (cap ? `(≤${vp.max_frames})` : "") + "帧" : "帧"}${fps ? "@" + fps + "fps" : ""}`;
    }
    return (a.duration ? fmtDur(a.duration) : "视频") + (a.fps ? ` · ${a.fps}fps` : "") + (a.w ? ` · ${a.w}×${a.h}` : "");
  }

  const ICONS = {
    eye: "👁", gear: "⚙", del: "✕", play: "▶",
    audio: "🎵", video: "🎬",
  };

  // 波形峰值缓存（文件名 → {peaks, duration}），卡片与弹窗共用
  const waveCache = new Map();
  const wavePending = new Set();
  const waveFailed = new Set(); // 解码失败的文件不再重试（否则 fetch→render→fetch 死循环拖死 UI）
  function fetchWave(fname, onDone) {
    if (wavePending.has(fname) || waveFailed.has(fname)) return;
    wavePending.add(fname);
    apiGet("/media/wave?name=" + encodeURIComponent(fname) + "&buckets=240")
      .then((d) => {
        if (d?.ok && d.peaks?.length) waveCache.set(fname, { peaks: d.peaks, duration: d.duration || 0 });
      })
      .catch(() => {})
      .finally(() => {
        wavePending.delete(fname);
        if (!waveCache.has(fname)) waveFailed.add(fname); // 失败不重试，卡片显示占位提示
        onDone?.();
      });
  }
  function buildWaveSvg(a, wave, height) {
    // 波形用 Canvas 2D 绘制（SVG innerHTML 在部分前端环境下渲染不稳定）
    const peaks = wave?.peaks || [];
    const maxV = peaks.length ? Math.max(...peaks) : 0;
    const wrap = h("div", { class: "media-awave" });
    if (!peaks.length || maxV <= 0.0001) {
      wrap.classList.add("media-awave-empty");
      wrap.textContent = "无波形数据";
      return wrap;
    }
    const W = 480, H = height;
    const cv = document.createElement("canvas");
    cv.width = W * 2; cv.height = H * 2; // 2x 抗锯齿
    cv.style.cssText = "width:100%;height:" + H + "px;display:block";
    const ctx = cv.getContext("2d");
    ctx.scale(2, 2);
    ctx.fillStyle = "#6b7690";
    const bw = W / peaks.length;
    const mid = H / 2;
    peaks.forEach((v, i) => {
      const bh = Math.max(1.5, v * (mid - 1.5));
      ctx.fillRect(i * bw, mid - bh, Math.max(1, bw - 0.4), bh * 2);
    });
    // 选中卡叠加裁剪选区
    const ap = state.audioParams;
    const dur = wave.duration || a.duration || 0;
    if (state.selected.audio === a.id && dur > 0 && (ap.start > 0 || ap.duration > 0)) {
      const s = Math.min(ap.start, dur);
      const e = ap.duration > 0 ? Math.min(ap.start + ap.duration, dur) : dur;
      ctx.fillStyle = "rgba(99,102,241,.32)";
      ctx.fillRect((s / dur) * W, 0, Math.max(2, ((e - s) / dur) * W), H);
    }
    wrap.appendChild(cv);
    return wrap;
  }
  function buildCard(a, idx) {
    const selectedIdx = state.selected.image.indexOf(a.id);
    const isSelected = a.type === "image" ? selectedIdx >= 0 : state.selected[a.type] === a.id;
    const card = h("div", {
      class: "media-card" + (isSelected ? " sel" : ""),
      "data-id": a.id, draggable: state.tab === "image" && state.sortBy === "custom" ? "true" : "false",
    });
    if (a.type === "image") {
      const th = h("img", { class: "media-thumb", loading: "lazy", alt: a.label || a.name });
      // /media/thumb 不应用裁剪，宽高比恒等于原图 → 解码前按元数据占位，测高不偏短
      if (a.w > 0 && a.h > 0) th.style.aspectRatio = a.w + " / " + a.h;
      th.src = `${API}/media/thumb?name=${encodeURIComponent(a.name || a.file.split("/").pop())}&w=180`;
      card.appendChild(th);
    } else if (a.type === "video") {
      // 视频抽帧缩略图（/media/vthumb），加载失败回退图标占位
      const fname = assetFileName(a);
      const t = a.duration > 2 ? 1.0 : 0;
      const th = h("img", { class: "media-thumb media-vthumb", loading: "lazy", alt: a.label || a.name });
      if (a.w > 0 && a.h > 0) th.style.aspectRatio = a.w + " / " + a.h;
      th.src = `${API}/media/vthumb?name=${encodeURIComponent(fname)}&w=180&t=${t}`;
      th.addEventListener("error", () => {
        const ph = h("div", { class: "media-ph" }, ["🎬"]);
        th.replaceWith(ph);
      });
      card.appendChild(th);
    } else {
      // 音频卡：小波形（峰值来自 /media/wave，选中的卡高亮裁剪选区）
      const fname = assetFileName(a);
      const wave = waveCache.get(fname);
      if (wave) {
        card.appendChild(buildWaveSvg(a, wave, 44));
      } else if (waveFailed.has(fname)) {
        card.appendChild(h("div", { class: "media-awave media-awave-empty" }, ["无波形数据"]));
      } else {
        const ph = h("div", { class: "media-ph media-ph-sm" }, ["🎵"]);
        card.appendChild(ph);
        fetchWave(fname, () => { if (waveCache.has(fname)) renderGrid(); }); // 失败不触发重渲染
      }
    }
    if (a.type === "video") card.appendChild(h("span", { class: "media-dur" }, [fmtDur(a.duration)]));
    if (isSelected && a.type === "image") card.appendChild(h("span", { class: "media-badge" }, [String(selectedIdx + 1)]));
    if (isSelected && a.type !== "image") card.appendChild(h("span", { class: "media-badge" }, ["生效"]));

    const icons = h("div", { class: "media-icons" });
    if (a.type === "image") {
      const eye = h("span", { title: "预览大图" }, [ICONS.eye]);
      eye.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(a); });
      icons.appendChild(eye);
    }
    const gear = h("span", { title: a.type === "image" ? "编辑（裁剪 / 遮罩 / 缩放）" : a.type === "video" ? "视频参数与裁剪" : "音频裁剪" }, [ICONS.gear]);
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      if (a.type === "image") openImageDialog(a);
      else if (a.type === "video") openVideoDialog(a);
      else openAudioDialog(a);
    });
    icons.appendChild(gear);
    const del = h("span", { title: "从清单移除" }, [ICONS.del]);
    del.addEventListener("click", (e) => { e.stopPropagation(); removeAsset(a.id); });
    icons.appendChild(del);
    card.appendChild(icons);

    const meta = h("div", { class: "media-meta" },
      [h("span", { class: "media-nm" }, [a.label || a.name]), h("span", {}, [metaText(a)])]);
    card.appendChild(meta);

    card.addEventListener("click", () => toggleSelect(a));
    if (card.draggable === "true" || card.getAttribute("draggable") === "true") {
      card.addEventListener("dragstart", (e) => { state.dragId = a.id; e.dataTransfer.setData("text/plain", a.id); });
      card.addEventListener("dragover", (e) => { if (state.dragId && state.dragId !== a.id) e.preventDefault(); });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        if (state.dragId && state.dragId !== a.id) reorderImages(state.dragId, a.id);
        state.dragId = null;
      });
      card.addEventListener("dragend", () => { state.dragId = null; });
    }
    return card;
  }

  // 列数 = clamp(面板内宽 ÷ 目标卡宽 四舍五入, 1, 4)——边界上宁可多一列稍挤，
  // 也别少一列让卡片翻倍宽（floor 会让 200 档在 470 默认节点上直接变单列）；
  // 容器 display:none 时用上一次宽度兜底
  let _lastGridW = 0;
  let _lastCols = 3;
  function calcCols() {
    const w = els.grid.clientWidth;
    if (w > 40) _lastGridW = w;
    const base = w > 40 ? w : (_lastGridW || NODE_WIDTH - 58);
    return Math.max(1, Math.min(4, Math.round(base / state.thumbW)));
  }
  // 网格底部渐隐：还有更多内容时提示可滚，到底自动消失
  function updateGridFade() {
    const g = els.grid;
    const more = g.clientHeight > 0 && g.scrollHeight - g.scrollTop - g.clientHeight > 24;
    els.gridFade.classList.toggle("off", !more);
  }
  function renderGrid() {
    els.grid.innerHTML = "";
    const list = visibleAssets();
    els.empty.style.display = list.length ? "none" : "flex";
    // 音视频缺 fps/时长的（工作流恢复的旧数据），后台补探测
    list.forEach((a) => { if (a.type !== "image" && (!a.fps || !a.duration)) probeAssetMeta(a); });
    if (!list.length) { updateGridFade(); recalcHeight(); return; }
    // JS 显式分列瀑布流：逐列放卡（列数由「尺寸」目标卡宽 + 面板宽度决定，1–4 列）
    _lastCols = calcCols();
    const cols = [];
    for (let i = 0; i < _lastCols; i++) cols.push(h("div", { class: "media-mcol" }));
    list.forEach((a, i) => {
      const card = buildCard(a, i);
      let target = 0;
      for (let c = 1; c < _lastCols; c++) if (cols[c].children.length < cols[target].children.length) target = c;
      cols[target].appendChild(card);
    });
    cols.forEach((c) => els.grid.appendChild(c));
    updateGridFade();
    recalcHeight();
  }

  function renderTabsAndCount() {
    renderTabs();
    const n = state.selected.image.length;
    const parts = [];
    if (n) parts.push(`已选 ${n} 图`);
    if (state.selected.audio) parts.push("已选 1 音频");
    if (state.selected.video) parts.push("已选 1 视频");
    els.count.textContent = parts.length ? parts.join(" · ") + " · 共 " + state.assets.length : "共 " + state.assets.length + " 素材";
  }
  function render() { renderTabsAndCount(); renderGrid(); }

  // ---- 图片编辑弹窗：预览台 + 框选裁剪 + 画笔遮罩 + 缩放设置 ----
  let imageDlg = null;
  function openImageDialog(a) {
    if (imageDlg) { imageDlg.remove(); imageDlg = null; }
    let crop = a.crop && Array.isArray(a.crop) && a.crop.length === 4 ? [...a.crop] : null;
    let tool = "crop";           // crop | mask | erase
    let brush = 36;              // 遮罩画笔直径（显示像素）
    let maskDirty = false, clearedMask = false;
    let drag = null;             // 裁剪框拖拽态
    let painting = null;         // 遮罩笔画 {x,y}

    const dlg = h("div", { class: "media-overlay" });
    const box = h("div", { class: "media-dialog" });
    box.appendChild(h("div", { class: "media-dialog-hd" }, [
      `🖼 ${a.label || a.name}`,
      h("span", { class: "media-dialog-sub" }, [a.w ? `${a.w}×${a.h}` : ""]),
    ]));
    const body = h("div", { class: "media-dialog-bd" });

    // —— 工具行 ——
    const toolCrop = h("button", { class: "media-btn", type: "button", title: "在预览图上拖出裁剪区域" }, ["▭ 框选裁剪"]);
    const toolMask = h("button", { class: "media-btn", type: "button", title: "按住左键涂抹遮罩（白色=生效区域）" }, ["🖌 画笔遮罩"]);
    const toolErase = h("button", { class: "media-btn", type: "button", title: "擦除已涂的遮罩" }, ["⌫ 橡皮"]);
    const brushWrap = h("span", { class: "media-brushrow" }, [
      h("label", {}, ["笔刷"]), h("input", { type: "range", min: "8", max: "120", step: "2", value: String(brush) }),
    ]);
    const brushRange = brushWrap.querySelector("input");
    brushRange.addEventListener("input", () => { brush = parseInt(brushRange.value, 10) || 36; });
    const clearCropBtn = h("button", { class: "media-btn", type: "button" }, ["清除裁剪"]);
    const clearMaskBtn = h("button", { class: "media-btn", type: "button" }, ["清除遮罩"]);
    const tools = [toolCrop, toolMask, toolErase];
    function syncTools() {
      tools.forEach((b) => b.classList.remove("on"));
      ({ crop: toolCrop, mask: toolMask, erase: toolErase })[tool].classList.add("on");
      brushWrap.style.display = tool === "crop" ? "none" : "";
      uiC.style.cursor = tool === "crop" ? "crosshair" : "cell";
    }
    toolCrop.addEventListener("click", () => { tool = "crop"; syncTools(); });
    toolMask.addEventListener("click", () => { tool = "mask"; syncTools(); });
    toolErase.addEventListener("click", () => { tool = "erase"; syncTools(); });
    clearCropBtn.addEventListener("click", () => { setCrop(null); drawUI(); });
    clearMaskBtn.addEventListener("click", () => {
      mctx.clearRect(0, 0, maskC.width, maskC.height);
      maskDirty = false; clearedMask = true;
    });
    const toolRow = h("div", { class: "media-tbar" },
      [toolCrop, toolMask, toolErase, brushWrap, clearCropBtn, clearMaskBtn]);

    // —— 预览台：底图 + 遮罩画布 + 交互画布 ——
    const stage = h("div", { class: "media-stage" });
    const baseImg = h("img", { class: "media-stage-img", alt: "", draggable: "false" });
    const maskC = document.createElement("canvas");
    const uiC = document.createElement("canvas");
    maskC.className = "media-stage-cv"; uiC.className = "media-stage-cv";
    stage.append(baseImg, maskC, uiC);
    const mctx = maskC.getContext("2d");
    const uictx = uiC.getContext("2d");
    let viewW = 0, viewH = 0;

    function setCrop(c) {
      if (c && c[2] - c[0] > 0.01 && c[3] - c[1] > 0.01) crop = c;
      else crop = null;
    }

    function drawUI() {
      if (!uiC.width) return;
      uictx.clearRect(0, 0, uiC.width, uiC.height);
      if (crop) {
        const x0 = crop[0] * viewW, y0 = crop[1] * viewH, x1 = crop[2] * viewW, y1 = crop[3] * viewH;
        uictx.fillStyle = "rgba(0,0,0,.45)";
        uictx.beginPath();
        uictx.rect(0, 0, viewW, viewH);
        uictx.rect(x0, y0, x1 - x0, y1 - y0);
        uictx.fill("evenodd");
        uictx.strokeStyle = "#6366f1";
        uictx.lineWidth = 2;
        uictx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        uictx.fillStyle = "#6366f1";
        for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
          uictx.fillRect(cx - 5, cy - 5, 10, 10);
        }
      }
    }

    const pt = (e) => {
      const r = uiC.getBoundingClientRect();
      return [Math.max(0, Math.min(e.clientX - r.left, r.width)),
              Math.max(0, Math.min(e.clientY - r.top, r.height))];
    };
    function startCropDrag(x, y) {
      if (crop) {
        const xs = [crop[0] * viewW, crop[2] * viewW], ys = [crop[1] * viewH, crop[3] * viewH];
        for (let ci = 0; ci < 2; ci++) for (let cj = 0; cj < 2; cj++) {
          if (Math.abs(x - xs[ci]) < 14 && Math.abs(y - ys[cj]) < 14) {
            drag = { mode: "resize", ci, cj, sx: x, sy: y, orig: [...crop] }; return;
          }
        }
        if (x > xs[0] && x < xs[1] && y > ys[0] && y < ys[1]) {
          drag = { mode: "move", sx: x, sy: y, orig: [...crop] }; return;
        }
      }
      drag = { mode: "new", sx: x, sy: y };
      setCrop([x / viewW, y / viewH, x / viewW, y / viewH]);
      drawUI();
    }
    function moveCropDrag(x, y) {
      if (drag.mode === "new") {
        setCrop([Math.min(drag.sx, x) / viewW, Math.min(drag.sy, y) / viewH,
                 Math.max(drag.sx, x) / viewW, Math.max(drag.sy, y) / viewH]);
      } else if (drag.mode === "move") {
        const dx = (x - drag.sx) / viewW, dy = (y - drag.sy) / viewH;
        const w0 = drag.orig[2] - drag.orig[0], h0 = drag.orig[3] - drag.orig[1];
        let nx0 = drag.orig[0] + dx, ny0 = drag.orig[1] + dy;
        nx0 = Math.max(0, Math.min(nx0, 1 - w0)); ny0 = Math.max(0, Math.min(ny0, 1 - h0));
        setCrop([nx0, ny0, nx0 + w0, ny0 + h0]);
      } else if (drag.mode === "resize") {
        const c = [...drag.orig];
        if (drag.ci === 0) c[0] = x / viewW; else c[2] = x / viewW;
        if (drag.cj === 0) c[1] = y / viewH; else c[3] = y / viewH;
        setCrop(c);
      }
      drawUI();
    }
    function paintStroke(x, y) {
      mctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
      mctx.strokeStyle = "#ffffff";
      mctx.lineWidth = brush;
      mctx.lineCap = "round"; mctx.lineJoin = "round";
      mctx.beginPath();
      mctx.moveTo(painting ? painting.x : x, painting ? painting.y : y);
      mctx.lineTo(x, y);
      mctx.stroke();
      mctx.globalCompositeOperation = "source-over";
      maskDirty = true;
    }
    // Pointer Events + setPointerCapture：拖动出画布不丢轨迹，兼容性最好
    uiC.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { uiC.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const [x, y] = pt(e);
      if (tool === "crop") {
        startCropDrag(x, y);
      } else {
        painting = { x, y };
        paintStroke(x, y);
      }
    });
    uiC.addEventListener("pointermove", (e) => {
      const [x, y] = pt(e);
      if (tool === "crop" && drag) {
        moveCropDrag(x, y);
      } else if ((tool === "mask" || tool === "erase") && painting) {
        paintStroke(x, y);
        painting = { x, y };
      }
    });
    const endPointer = () => { drag = null; painting = null; };
    uiC.addEventListener("pointerup", endPointer);
    uiC.addEventListener("pointercancel", endPointer);

    // 载入底图（缩略图端点 w=1024 保清晰）；已有遮罩回显
    baseImg.addEventListener("load", () => {
      const maxW = Math.min(780, window.innerWidth - 120), maxH = 460;
      const sc = Math.min(maxW / (baseImg.naturalWidth || 1), maxH / (baseImg.naturalHeight || 1), 1);
      viewW = Math.max(200, Math.round((baseImg.naturalWidth || 1) * sc));
      viewH = Math.max(150, Math.round((baseImg.naturalHeight || 1) * sc));
      stage.style.width = viewW + "px"; stage.style.height = viewH + "px";
      maskC.width = uiC.width = viewW; maskC.height = uiC.height = viewH;
      drawUI();
      if (a.mask) {
        const mi = new Image();
        mi.onload = () => {
          // 遮罩 PNG 是黑底白笔：直接画会盖住底图。把灰度亮度转成 alpha
          // （白=遮罩可见，黑=透明露底图），与画笔的白色半透明叠加语义一致。
          const t = document.createElement("canvas");
          t.width = viewW; t.height = viewH;
          const tc = t.getContext("2d");
          tc.drawImage(mi, 0, 0, viewW, viewH);
          const d = tc.getImageData(0, 0, viewW, viewH);
          for (let i = 0; i < d.data.length; i += 4) {
            const v = d.data[i]; // 灰度值（保存时已转 L）
            d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
            d.data[i + 3] = v;
          }
          tc.putImageData(d, 0, 0);
          mctx.drawImage(t, 0, 0);
        };
        mi.src = `${API}/media/mask?key=${encodeURIComponent(a.mask)}`;
      }
    });
    baseImg.src = `${API}/media/thumb?name=${encodeURIComponent(assetFileName(a))}&w=1024`;

    // —— 缩放设置（沿用 LayerStyle v2 参数制）——
    const modeSel = h("select", { class: "media-select" });
    for (const [v, label] of [["none", "不缩放"], ["longest", "最长边"], ["shortest", "最短边"], ["width", "宽度"], ["height", "高度"]]) {
      modeSel.appendChild(h("option", { value: v }, [label]));
    }
    modeSel.value = state.scale.mode;
    const valInp = h("input", { class: "media-input", type: "text", inputmode: "numeric", value: String(state.scale.value) });
    const multSel = h("select", { class: "media-select" });
    for (const m of [0, 8, 16, 32, 64]) multSel.appendChild(h("option", { value: String(m) }, [m === 0 ? "不对齐" : m + " 的倍数"]));
    multSel.value = String(state.scale.multiple);
    const calc = h("div", { class: "media-calc" }, [""]);
    function recalc() {
      const mode = modeSel.value, value = parseInt(valInp.value, 10) || 0, mult = parseInt(multSel.value, 10) || 0;
      let w = a.w || 0, hh = a.h || 0;
      if (crop) { w = Math.max(1, Math.round(w * (crop[2] - crop[0]))); hh = Math.max(1, Math.round(hh * (crop[3] - crop[1]))); }
      let nw = w, nh = hh;
      if (mode !== "none" && value > 0 && w > 0 && hh > 0) {
        if (mode === "width") { nw = value; nh = Math.max(1, Math.round(hh * value / w)); }
        else if (mode === "height") { nw = Math.max(1, Math.round(w * value / hh)); nh = value; }
        else if ((mode === "longest") === (w >= hh)) { nw = value; nh = Math.max(1, Math.round(hh * value / w)); }
        else { nw = Math.max(1, Math.round(w * value / hh)); nh = value; }
        if (mult) { nw = Math.max(mult, Math.round(nw / mult) * mult); nh = Math.max(mult, Math.round(nh / mult) * mult); }
      }
      calc.textContent = `本卡输出：${a.w}×${a.h}${crop ? " → 裁剪 " + w + "×" + hh : ""} → 缩放 ${nw}×${nh}${a.mask ? " · 含遮罩" : ""}`;
    }
    [modeSel, valInp, multSel].forEach((el) => el.addEventListener("change", recalc));
    valInp.addEventListener("input", recalc);
    const scaleRow = h("div", { class: "media-row3" },
      [h("div", {}, [h("label", {}, ["缩放模式（节点级）"]), modeSel]),
       h("div", {}, [h("label", {}, ["目标值"]), valInp]),
       h("div", {}, [h("label", {}, ["对齐倍数"]), multSel])]);
    body.append(toolRow, stage, scaleRow, calc);

    const ok = h("button", { class: "media-btn pri", type: "button" }, ["保存"]);
    const cancel = h("button", { class: "media-btn", type: "button" }, ["取消"]);
    // 完成编辑 = 保存并关闭（工具行内的主按钮，操作完立刻有明确反馈）
    const commit = async () => {
      state.scale = {
        mode: modeSel.value,
        value: Math.max(0, parseInt(valInp.value, 10) || 0),
        multiple: parseInt(multSel.value, 10) || 0,
      };
      if (crop) a.crop = [...crop]; else delete a.crop;
      try {
        if (clearedMask && !maskDirty) a.mask = null;
        if (maskDirty) {
          const out = document.createElement("canvas");
          out.width = maskC.width; out.height = maskC.height;
          const octx = out.getContext("2d");
          octx.fillStyle = "#000"; octx.fillRect(0, 0, out.width, out.height);
          octx.drawImage(maskC, 0, 0);
          const res = await apiPost("/media/mask", {
            name: assetFileName(a), data: out.toDataURL("image/png"),
          });
          a.mask = res.mask;
        }
      } catch (err) { toast("遮罩保存失败：" + (err.message || err)); }
      save(); render();
      dlg.remove(); imageDlg = null;
    };
    const doneBtn = h("button", { class: "media-btn pri", type: "button",
      title: "保存裁剪与遮罩并关闭编辑" }, ["✓ 完成编辑"]);
    doneBtn.addEventListener("click", commit);
    ok.addEventListener("click", commit);
    cancel.addEventListener("click", () => { dlg.remove(); imageDlg = null; });
    const exportBtn = h("button", { class: "media-btn", type: "button",
      title: "按当前裁剪框与缩放设置导出 PNG 文件" }, ["⬇ 导出 PNG"]);
    exportBtn.addEventListener("click", () => {
      const c = crop || [0, 0, 1, 1];
      const url = `${API}/media/export/image?name=${encodeURIComponent(assetFileName(a))}`
        + `&x0=${c[0]}&y0=${c[1]}&x1=${c[2]}&y1=${c[3]}`
        + `&scale_mode=${state.scale.mode}&scale_value=${state.scale.value}&scale_multiple=${state.scale.multiple}`;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "";
      anchor.click();
    });
    const ft = h("div", { class: "media-dialog-ft" }, [cancel, exportBtn, ok]);
    box.append(body, ft);
    dlg.appendChild(box);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) { dlg.remove(); imageDlg = null; } });
    toolRow.appendChild(doneBtn);
    document.body.appendChild(dlg);
    imageDlg = dlg;
    syncTools();
    recalc();
  }

  // ---- 视频参数弹窗：双 range 选区 + 帧率/总帧 + 实时帧数计算 ----
  let videoDlg = null;
  function openVideoDialog(a) {
    if (videoDlg) { videoDlg.remove(); videoDlg = null; }
    const dur = a.duration || 0;
    const vp = { ...state.videoParams };
    const probe = async () => { // 打开时后台补 fps/时长（若前端还没有）
      if (!a.fps || !a.duration) {
        try {
          const d = await apiGet("/media/probe?name=" + encodeURIComponent(assetFileName(a)));
          if (d?.ok && d.fps > 0) { a.fps = Math.round(d.fps * 100) / 100; }
          if (d?.ok && !a.duration && d.duration > 0) { a.duration = d.duration; }
        } catch (e) { /* ignore */ }
      }
      if (a.duration > 0) { // 时长补全后同步滑杆量程
        sStart.max = String(a.duration);
        sEnd.max = String(a.duration);
      }
    };
    const dlg = h("div", { class: "media-overlay" });
    const box = h("div", { class: "media-dialog" });
    box.appendChild(h("div", { class: "media-dialog-hd" },
      [`🎬 ${a.label || a.name}`, h("span", { class: "media-dialog-sub" },
        [`${a.w ? a.w + "×" + a.h + " · " : ""}${dur ? fmtDur(dur) : "时长探测中"}${a.fps ? " · " + a.fps + "fps" : ""}`])]));

    const body = h("div", { class: "media-dialog-bd" });
    // 顶部：抽帧条预览（12 帧），选区滑杆叠加其上，拖动即看到裁剪区域
    const strip = h("div", { class: "media-frames" });
    const fill = h("div", { class: "media-range2-fill" });
    const sStart = h("input", { type: "range", min: "0", max: String(Math.max(dur, 0.1)), step: "0.05", value: String(vp.start) });
    const sEnd = h("input", { type: "range", min: "0", max: String(Math.max(dur, 0.1)), step: "0.05", value: String(vp.end || dur) });
    const track = h("div", { class: "media-range2 overlay" }, [fill, sStart, sEnd]);
    const frameWrap = h("div", { class: "media-wave media-frames-wrap" }, [strip, track]);
    const tLabel = h("div", { class: "media-wtime" }, []);
    const nStart = h("input", { class: "media-input", type: "text", inputmode: "decimal", value: String(vp.start) });
    const nEnd = h("input", { class: "media-input", type: "text", inputmode: "decimal", value: String(vp.end || "") });
    const nFps = h("input", { class: "media-input", type: "text", inputmode: "numeric", value: String(vp.fps || "") });
    const nMax = h("input", { class: "media-input", type: "text", inputmode: "numeric", value: String(vp.max_frames || "") });
    const calc = h("div", { class: "media-calc" }, [""]);

    function readNum(inp) { const v = parseFloat(inp.value); return isNaN(v) ? 0 : Math.max(0, v); }
    function syncFill() {
      const max = parseFloat(sStart.max) || 1;
      const a0 = (parseFloat(sStart.value) / max) * 100;
      const a1 = (parseFloat(sEnd.value) / max) * 100;
      fill.style.left = Math.min(a0, a1) + "%";
      fill.style.width = Math.abs(a1 - a0) + "%";
    }
    function refresh() {
      // v1.32：钳制上限只在「终点已填或时长已知」时生效——duration 未知且终点留空时
      // 保持用户输入（此前 `readNum(nEnd) || dur` 在两者皆 0 时会把非 0 起点静默打成 0）
      const endIn = readNum(nEnd);
      const cap = endIn > 0 ? endIn : dur;
      vp.start = cap > 0 ? Math.min(readNum(nStart), cap) : readNum(nStart);
      vp.end = endIn;
      if (vp.end > 0 && vp.end <= vp.start) vp.end = vp.start + 0.05;
      vp.fps = Math.min(999, readNum(nFps));
      vp.max_frames = Math.min(99999, Math.round(readNum(nMax)));
      const fps = vp.fps > 0 ? vp.fps : (a.fps || 0);
      const end = vp.end > 0 ? vp.end : dur;
      const est = end > vp.start && fps > 0 ? Math.round((end - vp.start) * fps) : 0;
      const shown = vp.max_frames > 0 && est > vp.max_frames ? vp.max_frames : est;
      calc.textContent = est
        ? `实际输出：选区 ${(end - vp.start).toFixed(2)}s × ${fps || "?"}fps = ${est} 帧${vp.max_frames > 0 && est > vp.max_frames ? " → 截断为 " + vp.max_frames + " 帧" : ""} · 帧率口 = ${vp.fps > 0 ? vp.fps : "原速"}`
        : "未指定帧率时按原速输出到结尾；终点留空 = 到结尾。";
      tLabel.innerHTML = "";
      tLabel.append(h("span", {}, ["入点 " + fmtSec(vp.start)]), h("span", {}, ["出点 " + (vp.end > 0 ? fmtSec(vp.end) : "结尾")]));
      sStart.value = String(vp.start);
      sEnd.value = String(vp.end > 0 ? vp.end : (parseFloat(sEnd.max) || 0));
      syncFill();
    }
    sStart.addEventListener("input", () => { nStart.value = sStart.value; refresh(); });
    sEnd.addEventListener("input", () => { nEnd.value = sEnd.value; refresh(); });
    [nStart, nEnd, nFps, nMax].forEach((el) => el.addEventListener("input", refresh));

    body.append(
      frameWrap, tLabel,
      h("div", { class: "media-row3" }, [
        h("div", {}, [h("label", {}, ["起点（秒）"]), nStart]),
        h("div", {}, [h("label", {}, ["终点（秒，空=结尾）"]), nEnd]),
        h("div", {}, [h("label", {}, ["目标帧率（空=原速）"]), nFps]),
      ]),
      h("div", { class: "media-row2" }, [
        h("div", {}, [h("label", {}, ["总帧数上限（空=不限）"]), nMax]),
        h("div", {}, [h("label", {}, ["缩放"]), h("div", { class: "media-input media-static" }, ["共用缩放设置（⚙ 图片卡）"])]),
      ]),
      calc,
    );
    const ok = h("button", { class: "media-btn pri", type: "button" }, ["保存"]);
    const cancel = h("button", { class: "media-btn", type: "button" }, ["取消"]);
    const exportBtn = h("button", { class: "media-btn", type: "button",
      title: "按当前选区/帧率/帧数/缩放导出 MP4 文件（长片段编码需数秒）" }, ["⬇ 导出 MP4"]);
    exportBtn.addEventListener("click", () => {
      refresh();
      const url = `${API}/media/export/video?name=${encodeURIComponent(assetFileName(a))}`
        + `&start=${vp.start}&end=${vp.end}&fps=${vp.fps}&max_frames=${vp.max_frames}`
        + `&scale_mode=${state.scale.mode}&scale_value=${state.scale.value}&scale_multiple=${state.scale.multiple}`;
      exportBtn.textContent = "⏳ 编码中…";
      exportBtn.disabled = true;
      const fr = document.createElement("iframe");
      fr.style.display = "none";
      fr.src = url;
      const restore = () => {
        if (fr.parentNode) fr.remove();
        exportBtn.textContent = "⬇ 导出 MP4";
        exportBtn.disabled = false;
      };
      fr.addEventListener("load", restore);
      document.body.appendChild(fr);
      setTimeout(restore, 120000); // 编码超时兜底：恢复按钮（下载通常已开始）
    });
    // 首帧/尾帧导出（按当前选区出入点抽帧，尾帧取终点前 50ms 的最后一帧）
    const frameUrl = (t) => `${API}/media/export/frame?name=${encodeURIComponent(assetFileName(a))}`
      + `&t=${t.toFixed(3)}&scale_mode=${state.scale.mode}&scale_value=${state.scale.value}&scale_multiple=${state.scale.multiple}`;
    const firstBtn = h("button", { class: "media-btn", type: "button", title: "导出选区第一帧为 PNG" }, ["⬇ 首帧"]);
    const lastBtn = h("button", { class: "media-btn", type: "button", title: "导出选区最后一帧为 PNG" }, ["⬇ 尾帧"]);
    firstBtn.addEventListener("click", () => { refresh(); window.open(frameUrl(vp.start), "_blank"); });
    lastBtn.addEventListener("click", () => {
      refresh();
      const end = vp.end > vp.start ? vp.end : (a.duration || 0);
      const t = end > 0.05 ? end - 0.05 : 0;
      window.open(frameUrl(t), "_blank");
    });
    box.append(body, h("div", { class: "media-dialog-ft" }, [cancel, firstBtn, lastBtn, exportBtn, ok]));
    dlg.appendChild(box);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) { dlg.remove(); videoDlg = null; } });
    ok.addEventListener("click", () => {
      state.videoParams = { ...vp };
      save(); render();
      dlg.remove(); videoDlg = null;
    });
    cancel.addEventListener("click", () => { dlg.remove(); videoDlg = null; });
    document.body.appendChild(dlg);
    videoDlg = dlg;
    refresh();
    // 抽帧条在 probe 后填充：时长已知则立即拿到正确采样点，未知则 probe 补全后再刷
    probe().then(() => { refresh(); fillFrames(); });
    // 抽帧条：12 帧铺满时长，量程未知时先用 t=0 单帧，probe 后补齐
    function fillFrames() {
      const d = a.duration > 0 ? a.duration : 0;
      const N = 12;
      strip.innerHTML = "";
      for (let i = 0; i < N; i++) {
        const t = d > 0 ? (i * d) / N : 0;
        const img = h("img", { class: "media-frame", loading: "lazy", alt: "" });
        img.src = `${API}/media/vthumb?name=${encodeURIComponent(assetFileName(a))}&w=140&t=${t.toFixed(2)}`;
        img.addEventListener("error", () => { img.style.visibility = "hidden"; });
        strip.appendChild(img);
      }
    }
  }

  // ---- 音频裁剪弹窗：波形峰值 + 双 range 选区 + 试听 ----
  let audioDlg = null;
  function openAudioDialog(a) {
    if (audioDlg) { audioDlg.remove(); audioDlg = null; }
    const ap = { ...state.audioParams };
    let duration = a.duration || 0;
    const dlg = h("div", { class: "media-overlay" });
    const box = h("div", { class: "media-dialog" });
    box.appendChild(h("div", { class: "media-dialog-hd" },
      [`🎵 ${a.label || a.name}`, h("span", { class: "media-dialog-sub" },
        [duration ? fmtDur(duration) : "时长探测中"])]));

    const body = h("div", { class: "media-dialog-bd" });
    const waveBox = h("div", { class: "media-wave" }, [h("div", { class: "media-wave-hint" }, ["波形加载中…"])]);
    const fill = h("div", { class: "media-range2-fill" });
    const sStart = h("input", { type: "range", min: "0", max: String(Math.max(duration, 0.1)), step: "0.05", value: String(ap.start) });
    const sEnd = h("input", { type: "range", min: "0", max: String(Math.max(duration, 0.1)), step: "0.05", value: String(ap.duration > 0 ? ap.start + ap.duration : duration) });
    // 选区滑杆直接叠在波形上，拖动即在波形上看到裁剪区域
    const track = h("div", { class: "media-range2 overlay" }, [fill, sStart, sEnd]);
    const tLabel = h("div", { class: "media-wtime" }, []);
    const nStart = h("input", { class: "media-input", type: "text", inputmode: "decimal", value: String(ap.start) });
    const nDur = h("input", { class: "media-input", type: "text", inputmode: "decimal", value: String(ap.duration || "") });
    const calc = h("div", { class: "media-calc" }, [""]);
    let audioEl = null;
    let playing = false;

    function readNum(inp) { const v = parseFloat(inp.value); return isNaN(v) ? 0 : Math.max(0, v); }
    function refresh() {
      ap.start = readNum(nStart);
      ap.duration = readNum(nDur);
      if (duration > 0) {
        ap.start = Math.min(ap.start, duration);
        if (ap.duration > 0) ap.duration = Math.min(ap.duration, Math.max(0, duration - ap.start));
      }
      const end = ap.duration > 0 ? ap.start + ap.duration : duration;
      const max = parseFloat(sStart.max) || 1;
      fill.style.left = (ap.start / max) * 100 + "%";
      fill.style.width = (Math.min(end, max) - ap.start) / max * 100 + "%";
      sStart.value = String(ap.start);
      sEnd.value = String(Math.min(end, max));
      tLabel.innerHTML = "";
      tLabel.append(
        h("span", {}, ["入点 " + fmtSec(ap.start)]),
        h("span", { style: "color:#a9c9ef" }, ["生效 " + (ap.duration > 0 ? fmtSec(ap.duration) : "至结尾")]),
        h("span", {}, ["出点 " + (ap.duration > 0 ? fmtSec(end) : "结尾")]),
      );
      const durTxt = ap.duration > 0 ? fmtSec(ap.duration) : (duration > 0 ? fmtSec(duration - ap.start) : "未知");
      calc.textContent = `裁剪片段：从 ${fmtSec(ap.start)} 起播 ${durTxt}——选中区域即裁剪生效片段。`;
    }
    sStart.addEventListener("input", () => { nStart.value = sStart.value; refresh(); });
    sEnd.addEventListener("input", () => {
      const end = parseFloat(sEnd.value) || 0;
      nStart.value = String(Math.min(readNum(nStart), end));
      nDur.value = String(Math.max(0, end - readNum(nStart)));
      refresh();
    });
    [nStart, nDur].forEach((el) => el.addEventListener("input", refresh));

    const playBtn = h("button", { class: "media-btn", type: "button" }, ["▶ 试听选区"]);
    const exportBtn = h("button", { class: "media-btn", type: "button",
      title: "按当前选区导出 WAV 音频文件" }, ["⬇ 导出 WAV"]);
    exportBtn.addEventListener("click", () => {
      const url = `${API}/media/export/audio?name=${encodeURIComponent(assetFileName(a))}`
        + `&start=${ap.start}&duration=${ap.duration}`;
      window.open(url, "_blank");
    });
    playBtn.addEventListener("click", () => {
      if (playing) { audioEl?.pause(); return; }
      const fname = assetFileName(a);
      audioEl = new Audio(`/view?filename=${encodeURIComponent(fname)}&subfolder=${MEDIA_DIR}&type=input`);
      audioEl.currentTime = ap.start;
      playing = true;
      playBtn.textContent = "■ 停止";
      audioEl.addEventListener("timeupdate", () => {
        const end = ap.duration > 0 ? ap.start + ap.duration : Infinity;
        if (audioEl.currentTime >= end) audioEl.pause();
      });
      audioEl.addEventListener("pause", () => {
        playing = false; playBtn.textContent = "▶ 试听选区";
      });
      audioEl.play().catch(() => { playing = false; playBtn.textContent = "▶ 试听选区"; });
    });
    const allBtn = h("button", { class: "media-btn", type: "button" }, ["全选"]);
    allBtn.addEventListener("click", () => { nStart.value = "0"; nDur.value = ""; refresh(); });

    body.append(
      waveBox, tLabel,
      h("div", { class: "media-row2" }, [
        h("div", {}, [h("label", {}, ["起点（秒）"]), nStart]),
        h("div", {}, [h("label", {}, ["时长（秒，空=到结尾）"]), nDur]),
      ]),
      calc,
      h("div", { class: "media-tbar" }, [playBtn, exportBtn, allBtn]),
    );
    const ok = h("button", { class: "media-btn pri", type: "button" }, ["保存"]);
    const cancel = h("button", { class: "media-btn", type: "button" }, ["取消"]);
    box.append(body, h("div", { class: "media-dialog-ft" }, [cancel, ok]));
    dlg.appendChild(box);
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) { audioEl?.pause(); dlg.remove(); audioDlg = null; }
    });
    ok.addEventListener("click", () => {
      audioEl?.pause();
      state.audioParams = { start: ap.start, duration: ap.duration };
      save(); render();
      dlg.remove(); audioDlg = null;
    });
    cancel.addEventListener("click", () => { audioEl?.pause(); dlg.remove(); audioDlg = null; });
    document.body.appendChild(dlg);
    audioDlg = dlg;
    refresh();

    // 拉波形峰值绘制 SVG
    (async () => {
      try {
        const d = await apiGet("/media/wave?name=" + encodeURIComponent(assetFileName(a)) + "&buckets=500");
        if (d?.ok && d.peaks?.length) {
          if (!duration && d.duration > 0) {
            duration = d.duration;
            sStart.max = String(duration); sEnd.max = String(duration);
            a.duration = duration;
          }
          const W = 640, H = 88, mid = H / 2;
          waveBox.innerHTML = "";
          const cv = document.createElement("canvas");
          cv.width = W * 2; cv.height = H * 2;
          cv.style.cssText = "width:100%;height:" + H + "px;display:block";
          const ctx = cv.getContext("2d");
          ctx.scale(2, 2);
          ctx.fillStyle = "#6b7690";
          const bw = W / d.peaks.length;
          d.peaks.forEach((v, i) => {
            const bh = Math.max(1.5, v * (mid - 2));
            ctx.fillRect(i * bw, mid - bh, Math.max(1, bw - 0.5), bh * 2);
          });
          waveBox.appendChild(cv);
          waveBox.appendChild(track); // 选区叠加在波形上
          refresh();
        } else {
          waveBox.querySelector(".media-wave-hint").textContent = "波形解码失败（不影响裁剪与执行）";
          waveBox.appendChild(track); // 波形缺失时滑杆仍可用
        }
      } catch (e) {
        const hint = waveBox.querySelector(".media-wave-hint");
        if (hint) hint.textContent = "波形加载失败（不影响裁剪与执行）";
        waveBox.appendChild(track);
      }
    })();
  }

  // ---- lightbox（图片大图预览）----
  let lightbox = null;
  function openLightbox(a) {
    if (lightbox) lightbox.remove();
    const name = a.name || (a.file || "").split("/").pop();
    const ov = h("div", { class: "media-overlay" });
    const src = `${API}/view?filename=${encodeURIComponent(name)}&subfolder=${MEDIA_DIR}&type=input`;
    let body;
    if (a.type === "video") {
      body = h("video", {
        class: "media-lightbox-media", controls: "", playsinline: "", preload: "auto",
        poster: `${API}/media/vthumb?name=${encodeURIComponent(name)}&w=640&t=0`,
        src,
      });
      // 原始编码解不了（HEVC 等）→ 自动降级服务端转码 H.264 预览流（v1.23 起转码含音轨）
      body.muted = false; body.volume = 1;
      body.addEventListener("error", () => {
        if (body.error && body.error.code === 1) return; // 主动中断（abort）不降级
        if (!body.dataset.fb) {
          body.dataset.fb = "1";
          note.textContent = "原始编码无法直接播放，正在转码预览…";
          body.removeAttribute("poster");
          body.src = `${API}/media/export/video?name=${encodeURIComponent(name)}`;
          body.addEventListener("loadedmetadata", () => { note.textContent = ""; }, { once: true });
          body.load();
          body.play().catch(() => {});
        } else {
          note.textContent = "无法加载：文件缺失或浏览器不支持该编码";
        }
      });
    } else if (a.type === "audio") {
      body = h("audio", { class: "media-lightbox-audio", controls: "", preload: "auto", src });
      body.muted = false; body.volume = 1;
      body.addEventListener("error", () => {
        if (body.error && body.error.code === 1) return; // 主动中断（abort）不降级
        if (!body.dataset.fb) {
          body.dataset.fb = "1";
          note.textContent = "原始编码无法直接播放，正在转码预览…";
          body.src = `${API}/media/export/audio?name=${encodeURIComponent(name)}`;
          body.addEventListener("loadedmetadata", () => { note.textContent = ""; }, { once: true });
          body.load();
          body.play().catch(() => {});
        } else {
          note.textContent = "无法加载：文件缺失或浏览器不支持该编码";
        }
      });
    } else {
      body = h("img", { class: "media-lightbox-img", alt: name });
      body.src = `${API}/media/thumb?name=${encodeURIComponent(name)}&w=1600`;
    }
    const meta = [a.w ? ` · ${a.w}×${a.h}` : "", a.duration ? ` · ${fmtDur(a.duration)}` : ""].join("");
    const hd = h("div", { class: "media-dialog-hd" }, [name + meta]);
    const note = h("div", { class: "media-lightbox-note" });
    const wrap = h("div", { class: "media-lightbox" }, [hd, body, note]);
    ov.appendChild(wrap);
    // 统一关闭路径：点遮罩与 ESC 都走 close()，确保 keydown 监听必然摘除（v1.26 修泄漏）
    const close = () => { ov.remove(); lightbox = null; document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    document.addEventListener("keydown", esc);
    document.body.appendChild(ov);
    lightbox = ov;
  }

  // ---- 入料三通道：拖入（文件/文件夹）/ 节点级拖放 / Ctrl+V ----
  // 拖入文件夹（v1.30）：webkitGetAsEntry 只能在事件回调里同步取，目录递归读取可异步；
  // readEntries 每次最多返回 100 条，必须循环读到空为止
  async function collectEntriesFiles(entries) {
    const files = [];
    async function walk(entry) {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { files.push(f); res(); }, () => res()));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res) => reader.readEntries((es) => res(es), () => res([])));
          if (!batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    }
    for (const e of entries) await walk(e);
    return files;
  }
  function entriesFromDrop(dataTransfer) {
    const items = dataTransfer?.items;
    if (!items?.length) return null;
    const entries = [];
    let hasFile = false;
    for (const it of items) {
      if (it.kind !== "file") continue;
      hasFile = true;
      const get = it.webkitGetAsEntry;
      if (typeof get === "function") {
        const entry = get.call(it);
        if (entry) entries.push(entry);
      }
    }
    return hasFile ? entries : null;
  }
  function handleDropFiles(dataTransfer) {
    // 文件夹拖放时 dataTransfer.files 里只有目录占位（type 为空），必须先走 entries 通道
    const entries = entriesFromDrop(dataTransfer);
    if (entries && entries.length) {
      collectEntriesFiles(entries).then((files) => { if (files.length) addFiles(files); });
      return true;
    }
    if (dataTransfer?.files?.length) { addFiles(dataTransfer.files); return true; }
    return false;
  }
  container.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); container.classList.add("media-dragover"); }
  });
  container.addEventListener("dragleave", () => container.classList.remove("media-dragover"));
  container.addEventListener("drop", (e) => {
    container.classList.remove("media-dragover");
    if (handleDropFiles(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); }
  });
  // 拖到节点非面板区域也能接住（LiteGraph 节点级）
  node.onDragOver = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes("Files"));
  node.onDragDrop = (e) => handleDropFiles(e.dataTransfer);
  // Ctrl+V：仅鼠标悬停面板时接管，避免与 ComfyUI 自身复制粘贴冲突
  container.addEventListener("mouseenter", () => { state.hover = true; });
  container.addEventListener("mouseleave", () => { state.hover = false; });
  const onPaste = (e) => {
    if (!state.hover) return;
    const items = [...(e.clipboardData?.items || [])];
    const files = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); e.stopPropagation(); addFiles(files); }
  };
  document.addEventListener("paste", onPaste);
  // 节点删除时摘掉 document 级监听（反复增删节点不再累积监听器，v3.58）
  const _origOnRemovedPanel = node.onRemoved;
  node.onRemoved = function () {
    _origOnRemovedPanel?.apply(this, arguments);
    document.removeEventListener("paste", onPaste);
    document.removeEventListener("pointerdown", onDocPointerClose, true);
  };

  // ---- DOM widget 与高度管理（bips 同款：缓存驱动，绝不现场测量）----
  const domWidget = node.addDOMWidget("media_ui", "MEDIA_UI", container, {
    getValue() { return ""; },
    setValue() {},
    resize: false,
  });
  installBypassSync(node, container);
  installExecutionLock(node, container);

  try { domWidget.computeSize = function () { return [0, -4]; }; } catch (e) { /* ignore */ }

  const MIN_DOM_H = 160;   // 空态最小高度（与批量选图节点一致，紧凑）
  const MAX_CHROME = 300;  // domWidget.y 异常钳制：正常 = 标题+输出槽（≤290 左右）；
                           // 被补建的隐藏 widget 撑大时按钳制值兜底，防止节点底部拉出长空白
  const FALLBACK_CHROME = 96;
  const BOTTOM_PAD = 18;   // 节点色底缝（与三个既有节点一致）
  const MIN_TOTAL_H = 260;
  let _cachedTotalH = MIN_TOTAL_H;
  let _lastGoodH = 520;

  function widgetChromeH() {
    const y = domWidget && typeof domWidget.y === "number" ? domWidget.y : 0;
    if (y <= 0) return FALLBACK_CHROME;
    return Math.min(y, MAX_CHROME);
  }
  // 内容高不做上限钳制（v1.27 教训）：容器视觉高度永远=自然内容高，
  // 节点高度若被算小（旧 MAX_DOM_H=880）内容必然溢出节点框；
  // 防测量跑飞靠下方可见性守卫 + rAF 合并，不靠钳制。
  function measureContentH() {
    const prevH = container.style.height;
    const prevMax = container.style.maxHeight;
    container.style.height = "auto";
    container.style.maxHeight = "none";
    void container.offsetHeight;
    const hh = container.scrollHeight || container.offsetHeight;
    container.style.height = prevH;
    container.style.maxHeight = prevMax;
    return Math.max(MIN_DOM_H, hh > 0 ? hh : MIN_DOM_H);
  }
  function realContentH() {
    if (!container.isConnected || container.getBoundingClientRect().height === 0) return _lastGoodH;
    const hh = measureContentH();
    if (hh > 0) _lastGoodH = hh;
    return hh;
  }
  try {
    node.computeSize = function (out) {
      out = out || [0, 0];
      out[0] = NODE_WIDTH;
      out[1] = _cachedTotalH;
      return out;
    };
  } catch (e) { /* ignore */ }

  let _recalcPending = false;
  let _fadePainted = false; // 渐隐取色要等容器进 DOM（挂载时读 computedStyle 拿不到类样式）
  function recalcHeight() {
    if (_recalcPending) return;
    _recalcPending = true;
    requestAnimationFrame(() => {
      _recalcPending = false;
      if (!container.isConnected || container.getBoundingClientRect().height === 0) return;
      if (!_fadePainted) {
        _fadePainted = true;
        try {
          const bg = getComputedStyle(container).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)") container.style.setProperty("--media-fade", bg);
        } catch (e) { /* ignore */ }
      }
      // 节点被拉宽/拉窄 → 列数变了就重排（renderGrid 末尾会再走一次 recalcHeight 收敛）
      if (els.grid.children.length && calcCols() !== _lastCols) { renderGrid(); return; }
      const contentH = realContentH();
      if (contentH <= 0) return;
      _cachedTotalH = Math.max(MIN_TOTAL_H, contentH + widgetChromeH() + BOTTOM_PAD);
      node._mediaTargetH = _cachedTotalH; // guard 对齐循环用：任何来源改大节点高度都会被掰回
      const w = node.size[0] && node.size[0] > 0 ? node.size[0] : NODE_WIDTH;
      node.setSize([w, _cachedTotalH]);
      updateGridFade();
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
      if (app.canvas && typeof app.canvas.setDirty === "function") app.canvas.setDirty(true);
    });
  }
  // ---- 槽位带交互（v1.21）：透明 DOM 层盖住卡片区 —— 点卡片=预览，✎ 钮=编辑弹窗 ----
  // 新前端不向节点派发 onMouseDown（实测探针确认），交互必须走 DOM 事件。
  // 层挂在容器内、负 top 顶到标题条下沿；几何随 node._heroRects 每帧同步（有变化才写样式）。
  const heroLayer = document.createElement("div");
  heroLayer.className = "media-hero-layer";
  container.appendChild(heroLayer);
  let heroLayerGeom = "";
  function heroSyncLayer() {
    const rects = node._heroRects;
    const domY = typeof domWidget?.y === "number" ? domWidget.y : 0;
    if (!rects || !domY) {
      if (heroLayerGeom !== "off") { heroLayerGeom = "off"; heroLayer.style.display = "none"; }
      return;
    }
    const topLocal = rects.y - domY;          // 容器局部坐标（容器顶 = domWidget.y）
    const geom = [topLocal, rects.h, rects.w * 3 + 16].join("|");
    if (geom !== heroLayerGeom) {
      heroLayerGeom = geom;
      heroLayer.style.display = "block";
      heroLayer.style.top = topLocal + "px";
      heroLayer.style.height = rects.h + "px";
      heroLayer.style.width = rects.w * 3 + 16 + "px";
    }
  }
  function heroLocal(e) {
    const rect = heroLayer.getBoundingClientRect();
    const zoom = rect.width / (heroLayerGeom === "off" ? 1 : parseFloat(heroLayer.style.width) || 1);
    return [(e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom];
  }
  function heroCardAt(nx, ny) {
    const rects = node._heroRects;
    if (!rects) return -1;
    return rects.cards.findIndex((c) => c.asset && nx >= c.x && nx <= c.x + rects.w);
  }
  function heroPillAt(nx, ny) {
    const rects = node._heroRects;
    if (!rects) return -1;
    return rects.cards.findIndex((c) => {
      if (!c.asset) return false;
      return Math.abs(nx - (c.x + rects.w - 14)) <= 13 && Math.abs(ny - (rects.y + 14)) <= 13;
    });
  }
  function heroGuarded() {
    return container.classList.contains("vpl-locked") || container.classList.contains("vpl-bypassed");
  }
  heroLayer.addEventListener("mousemove", (e) => {
    const [lx, ly] = heroLocal(e);
    const i = heroCardAt(lx + 20, ly);
    if (i !== heroHover) {
      heroHover = i;
      node.setDirtyCanvas?.(true, true);
    }
    heroLayer.style.cursor = i >= 0 ? "pointer" : "default";
  });
  heroLayer.addEventListener("mouseleave", () => {
    if (heroHover !== -1) {
      heroHover = -1;
      node.setDirtyCanvas?.(true, true);
    }
  });
  heroLayer.addEventListener("click", (e) => {
    if (heroGuarded()) return;
    const rects = node._heroRects;
    if (!rects) return;
    const [lx, ly] = heroLocal(e);
    const nx = lx + 20, ny = ly + rects.y; // 层内坐标 → 节点坐标（层顶 = rects.y）
    const i = heroCardAt(nx, ny);
    if (i < 0) return;
    const a = rects.cards[i].asset;
    if (heroPillAt(nx, ny) === i) {
      if (a.type === "image") openImageDialog(a);
      else if (a.type === "video") openVideoDialog(a);
      else openAudioDialog(a);
    } else {
      openLightbox(a);
    }
  });

  node._mediaRecalc = recalcHeight; // prune 清掉补建 widget 后立即回收节点高度

  // ---- 顶部槽位带三联预览卡：标题与面板之间的输出槽保留带不再留白 ----
  // 与 .media-panel 同族的圆角卡，内含 图片/视频/音频 三张等分卡（各显示该类型已选素材）：
  // 图片=已选第一张缩略图；视频=首帧抽帧+播放标+时长；音频=波形（/media/wave 同源缓存）+时长。
  // 未选的类型画虚线占位（该类型无素材显示「无 X」）。计数/已选信息 Tab 与 footer 已有，不重复。
  // 挂 onDrawBackground：画布层在 DOM 面板之下、槽位标签之下；右侧 HERO_PORT_ZONE 为
  // 输出口标签保留区，底板与卡片都只画到 nw-HERO_PORT_ZONE，标签列完全落在节点本色上。
  const heroImgCache = new Map(); // "t|名字"/"v|名字" → Image；onerror 进 failed 集合防死循环
  const heroFailed = new Set();
  const TITLE_H = 30;           // 新前端标题栏实测高（domWidget.y = 标题30 + 输出槽区）
  const HERO_PORT_ZONE = 90;    // 右侧接口标签保留区宽度：最长4字标签左缘约 nw-65，留 ~25px 安全距（用户定版）

  function heroImage(kind, a) {
    const name = assetFileName(a);
    const key = kind + "|" + name;
    if (heroFailed.has(key)) return null;
    let img = heroImgCache.get(key);
    if (!img) {
      img = new Image();
      img.onload = () => node.setDirtyCanvas?.(true, true);
      img.onerror = () => { heroFailed.add(key); heroImgCache.delete(key); };
      img.src = (kind === "v"
        ? `${API}/media/vthumb?name=${encodeURIComponent(name)}&w=320&t=0`
        : `${API}/media/thumb?name=${encodeURIComponent(name)}&w=320`);
      heroImgCache.set(key, img);
      if (heroImgCache.size > 40) heroImgCache.clear();
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }
  function heroRoundRect(ctx, x, y, w2, h2, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") { ctx.roundRect(x, y, w2, h2, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w2, y, x + w2, y + h2, r); ctx.arcTo(x + w2, y + h2, x, y + h2, r);
    ctx.arcTo(x, y + h2, x, y, r); ctx.arcTo(x, y, x + w2, y, r); ctx.closePath();
  }
  const HERO_FONT = "'Segoe UI', 'Microsoft YaHei', sans-serif";
  let heroHover = -1; // 悬停的卡片序号（0 图 1 视 2 音），-1 无；编辑钮仅悬停卡浮现
  function heroPill(ctx, xRight, yTop, on) {
    if (!on) return;
    const r = 9, cx2 = xRight - r - 5, cy2 = yTop + r + 5;
    ctx.beginPath(); ctx.arc(cx2, cy2, r, 0, 7);
    ctx.fillStyle = "rgba(0,0,0,.62)"; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.stroke();
    ctx.fillStyle = "#f1f5fb"; ctx.font = "10px " + HERO_FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("✎", cx2, cy2 + .5);
  }
  function heroChip(ctx, x, y, label) {
    ctx.font = "600 9px " + HERO_FONT;
    const w2 = ctx.measureText(label).width + 12, h2 = 15;
    heroRoundRect(ctx, x, y, w2, h2, 4);
    ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fill();
    ctx.fillStyle = "#eef1f8"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(label, x + 6, y + h2 / 2 + .5);
  }
  function heroDur(ctx, xRight, yBottom, secs) {
    if (!(secs > 0)) return;
    const label = fmtDur(secs);
    ctx.font = "8.5px " + HERO_FONT;
    const w2 = ctx.measureText(label).width + 10, h2 = 13;
    const x = xRight - w2 - 5, y = yBottom - h2 - 5;
    heroRoundRect(ctx, x, y, w2, h2, 3.5);
    ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fill();
    ctx.fillStyle = "#dfe4ee"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(label, x + 5, y + h2 / 2 + .5);
  }
  function heroCover(ctx, img, x, y, w2, h2) {
    ctx.save();
    heroRoundRect(ctx, x, y, w2, h2, 6); ctx.clip();
    const s = Math.max(w2 / img.naturalWidth, h2 / img.naturalHeight);
    const sw = w2 / s, sh = h2 / s;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w2, h2);
    ctx.restore();
  }
  function heroPlaceholder(ctx, x, y, w2, h2, label, cLine, cText) {
    heroRoundRect(ctx, x, y, w2, h2, 6);
    ctx.fillStyle = "rgba(0,0,0,.16)"; ctx.fill();
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = cLine; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = cText; ctx.font = "9px " + HERO_FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, x + w2 / 2, y + h2 / 2);
  }
  function heroWave(ctx, a, x, y, w2, h2, cBar) {
    const name = assetFileName(a);
    if (!waveCache.has(name)) { fetchWave(name, () => node.setDirtyCanvas?.(true, true)); return; }
    const peaks = waveCache.get(name)?.peaks || [];
    const maxV = peaks.length ? Math.max(...peaks) : 0;
    if (!peaks.length || maxV <= 0.0001) return;
    ctx.save();
    heroRoundRect(ctx, x + 5, y + 22, w2 - 10, h2 - 44, 4); ctx.clip();
    ctx.fillStyle = cBar;
    const bw = (w2 - 10) / peaks.length, mid = y + 22 + (h2 - 44) / 2;
    peaks.forEach((v, i) => {
      const bh = Math.max(1, v * ((h2 - 44) / 2) - 1.5);
      ctx.fillRect(x + 5 + i * bw, mid - bh, Math.max(1, bw - 0.3), bh * 2);
    });
    ctx.restore();
  }

  const _prevDrawBG = node.onDrawBackground;
  node.onDrawBackground = function (ctx) {
    const r = _prevDrawBG ? _prevDrawBG.apply(this, arguments) : undefined;
    try {
      if (node.flags && node.flags.collapsed) return r;
      const y2 = typeof domWidget?.y === "number" ? domWidget.y : 0;
      const nw = node.size[0] || NODE_WIDTH;
      const top = TITLE_H - 4, bot = y2 - 2, R = 12; // R=--vpl-r-lg；顶部贴标题条（v1.21 拉高），下缘贴 domWidget.y
      if (y2 > top + 40 && bot <= node.size[1] + 2) {
        const rgbS = getComputedStyle(container).backgroundColor || "";
        const m = rgbS.match(/\d+/g);
        const pr = m ? +m[0] : 33, pg = m ? +m[1] : 35, pb = m ? +m[2] : 44;
        const light = (pr * 299 + pg * 587 + pb * 114) / 1000 > 128;
        const cBorder = light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.085)";
        const cGlass = light ? "rgba(0,0,0,.025)" : "rgba(255,255,255,.035)";
        const cSubtle = light ? "#8a93a6" : "#6b7689";
        const cThumbBg = light ? "#e4e6ee" : "#141419";
        const off = node.mode === 2 || node.mode === 4; // 静音/旁路随面板一起变暗
        ctx.save();
        ctx.globalAlpha = off ? 0.55 : 1;
        // 底板右侧在接口标签保留区前停住（v1.17：整条铺满会让标签坐在预览区底色上）
        heroRoundRect(ctx, 10, top, nw - HERO_PORT_ZONE, bot - top, R);
        ctx.fillStyle = rgbS || (light ? "#f3f4f8" : "#21232c");
        ctx.fill();
        ctx.fillStyle = cGlass; ctx.fill();
        ctx.strokeStyle = cBorder; ctx.lineWidth = 1; ctx.stroke();
        const pad = 10, ix = 20, iy = top + pad, ib = bot - pad;
        const ih = ib - iy;
        if (!state.assets.length) {
          node._heroRects = null;
          heroSyncLayer();
          ctx.fillStyle = cSubtle; ctx.font = "11.5px 'Segoe UI', 'Microsoft YaHei', sans-serif";
          ctx.textBaseline = "middle"; ctx.textAlign = "left";
          ctx.fillText("「+ 添加」/ 拖入文件 / Ctrl+V 粘贴素材", ix, (top + bot) / 2);
          ctx.restore();
          return r;
        }
        // 三联卡：底板 10..nw-80，左右内边距各 10 对称（v1.20 修正右缝被扣两次的不对称）
        const zoneR = nw - HERO_PORT_ZONE; // 卡片区右界 = 底板右缘(nw-80) - 内边距10 = nw-90
        const cw = (zoneR - ix - 16) / 3; // 三卡等分，间隙 8
        const cLine = light ? "rgba(0,0,0,.16)" : "rgba(255,255,255,.14)";
        const cBar = light ? "rgba(99,102,241,.65)" : "#8b93f8";
        const selImg = state.selected.image[0] ? byId(state.selected.image[0]) : null;
        const selVid = state.selected.video ? byId(state.selected.video) : null;
        const selAud = state.selected.audio ? byId(state.selected.audio) : null;
        const phLabel = (type, name) => (assetsOf(type).length ? "未选" + name : "无" + name);
        { // 图片卡：已选第一张（输出批次首帧）
          const x = ix;
          if (selImg) {
            heroRoundRect(ctx, x, iy, cw, ih, 6);
            ctx.fillStyle = cThumbBg; ctx.fill();
            const img = heroImage("t", selImg);
            if (img) heroCover(ctx, img, x, iy, cw, ih);
            heroChip(ctx, x + 5, iy + 5, "图片");
            heroPill(ctx, x + cw, iy, heroHover === 0);
          } else heroPlaceholder(ctx, x, iy, cw, ih, phLabel("image", "图片"), cLine, cSubtle);
        }
        { // 视频卡：已选视频首帧 + 播放标 + 时长
          const x = ix + cw + 8;
          if (selVid) {
            heroRoundRect(ctx, x, iy, cw, ih, 6);
            ctx.fillStyle = cThumbBg; ctx.fill();
            const img = heroImage("v", selVid);
            if (img) heroCover(ctx, img, x, iy, cw, ih);
            const pcx = x + cw / 2, pcy = iy + ih / 2;
            ctx.beginPath(); ctx.arc(pcx, pcy, 13, 0, 7);
            ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fill();
            ctx.lineWidth = 1.25; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(pcx - 3.5, pcy - 5); ctx.lineTo(pcx + 5.5, pcy); ctx.lineTo(pcx - 3.5, pcy + 5);
            ctx.closePath();
            ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fill();
            heroChip(ctx, x + 5, iy + 5, "视频");
            heroDur(ctx, x + cw, iy + ih, selVid.duration);
            heroPill(ctx, x + cw, iy, heroHover === 1);
          } else heroPlaceholder(ctx, x, iy, cw, ih, phLabel("video", "视频"), cLine, cSubtle);
        }
        { // 音频卡：已选音频波形 + 时长（波形与面板音频卡共用 waveCache/fetchWave）
          const x = ix + (cw + 8) * 2;
          if (selAud) {
            heroRoundRect(ctx, x, iy, cw, ih, 6);
            ctx.fillStyle = cThumbBg; ctx.fill();
            heroWave(ctx, selAud, x, iy, cw, ih, cBar);
            heroChip(ctx, x + 5, iy + 5, "音频");
            heroDur(ctx, x + cw, iy + ih, selAud.duration);
            heroPill(ctx, x + cw, iy, heroHover === 2);
          } else heroPlaceholder(ctx, x, iy, cw, ih, phLabel("audio", "音频"), cLine, cSubtle);
        }
        node._heroRects = { // 槽位带交互命中区（v1.21 点击预览 / ✎ 编辑）
          y: iy, h: ih, w: cw,
          cards: [
            { x: ix, asset: selImg },
            { x: ix + cw + 8, asset: selVid },
            { x: ix + (cw + 8) * 2, asset: selAud },
          ],
        };
        heroSyncLayer();
        ctx.restore();
      }
    } catch (e) { /* 绘制失败静默，不影响主面板 */ }
    return r;
  };

  // 滚轮拦截：面板内滚动不被画布缩放抢占
  container.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

  // ---- 启动 ----
  loadFromSaved();
  syncSizeChip();
  // 执行参数注入函数挂载即存在（v1.25）：此前只在 save()（首次交互）里赋值，
  // 工作流加载后不碰面板直接点运行 → 钩子拿不到注入函数 → 校验缺「素材清单」报错。
  node._mediaInputs = function () { return { 素材清单: manifestText() }; };
  if (wManifest) wManifest.value = manifestText();
  render();

  [60, 250, 600].forEach((t) => setTimeout(recalcHeight, t));
  const ro = new ResizeObserver(() => recalcHeight());
  ro.observe(container);

  console.log(`%c[MediaAsset ${MEDIA_VERSION}] 面板已挂载`, "color:#27ae60");
}

// ---------------------------------------------------------------------------
// 节点注册
// ---------------------------------------------------------------------------
app.registerExtension({
  name: "AllBuy.MediaAssetLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    // 输出槽对齐：定义里删掉的输出，新前端只增不减，节点会残留旧槽（如多余的 音频/素材JSON）。
    // 按最新定义重建 node.outputs，同名槽位保留已有连线，被移除口的悬空连线从图上移除。
    function reconcileOutputs(node) {
      try {
        const defOut = nodeData.output || [];
        const defNames = nodeData.output_name || [];
        if (!defOut.length) return;
        const old = Array.isArray(node.outputs) ? node.outputs : [];
        const same = old.length === defOut.length &&
          defNames.every((n, i) => old[i] && old[i].name === n);
        if (same) return;
        const target = defOut.map((t, i) => ({ type: t, name: defNames[i] || String(t), links: [] }));
        const removedLinkIds = [];
        for (const o of old) {
          if (!o) continue;
          const ni = target.findIndex((t) => t.name === o.name);
          if (ni >= 0) target[ni].links = o.links || [];
          else if (o.links?.length) removedLinkIds.push(...o.links);
        }
        node.outputs = target;
        for (const lid of removedLinkIds) {
          try { app.graph?.removeLink?.(lid); } catch (e) { /* ignore */ }
        }
        node.setDirtyCanvas?.(true, true);
        console.log("[MediaAsset] 输出槽已对齐当前定义：" + defNames.join("/"));
      } catch (e) { console.warn("[MediaAsset] 输出槽对齐失败：", e); }
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;
      node.setSize([NODE_WIDTH, 560]);
      reconcileOutputs(node);

      const startWhenReady = () => {
        let tries = 0;
        const tick = () => {
          const wManifest = node.widgets?.find((w) => w.name === "素材清单");
          if (wManifest || tries >= 60) {
            // 存储 widget 处理照抄 VPL 完整配方（同版本前端验证可用）：
            // 全量隐藏标志（含 Vue 的 computeLayoutSize）+ 物理移除 + 多时点 prune。
            // 之前两次失败原因：只移除不隐藏 → widgets_values 失配被前端补建；
            // 只隐藏不移除 → Vue DOM 层照样把字符串画出来。
            const pruneStrays = () => {
              if (!node.widgets) return;
              const strays = node.widgets.filter((w) => w && w.name === "素材清单");
              if (strays.length) {
                strays.forEach(hideStorageWidget);
                node.widgets = node.widgets.filter((w) => !strays.includes(w));
                node._mediaRecalc?.();
              }
            };
            pruneStrays();
            const guardTick = () => {
              pruneStrays();
              reconcileOutputs(node); // 页面刷新恢复工作流时 configure 可能早于钩子安装，靠常驻补偿
            };
            [0, 200, 800, 1600, 3000, 6000, 12000].forEach((t) => setTimeout(guardTick, t));
            const guardTimer = setInterval(guardTick, 1500); // 兜底常驻
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
              origOnRemoved?.apply(this, arguments);
              clearInterval(guardTimer);
            };
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function () {
              const r2 = origOnConfigure?.apply(this, arguments);
              setTimeout(pruneStrays, 0); // 工作流恢复是复发高危时点
              setTimeout(() => reconcileOutputs(node), 0); // 同步对齐输出槽
              return r2;
            };
            const container = h("div", { class: "vpl-node media-node" });
            startMediaPanel(node, container, null);
          } else { tries++; requestAnimationFrame(tick); }
        };
        requestAnimationFrame(tick);
      };
      startWhenReady();
      return r;
    };
  },
});
