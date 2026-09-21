// AllBuy-A/B 图像对比画布
//   画布 custom widget：深底图区，A/B 按 contain 同区适配；
//   靛紫分割线 + 光晕，顶部 A｜B 胶囊随分割线移动；底部 A/B 尺寸徽标 + 批量页码(点击翻页)。
//   交互：鼠标在图上移动 → 分割线实时跟随（无需按住）；按住左键拖动；右键切换原生预览槽位 A/B。
//   空态文案「连接图片开始对比」。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "AllBuyABCompare";
const MIN_WIDTH = 320;
const MIN_HEIGHT = 320;
const EDGE_PAD = 10;
const FOOTER_HEIGHT = 34;
const BADGE_H = 22;
const BADGE_INSET = 8;
const BRAND = "#6366f1";
const EMPTY_IMAGE_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function isTargetNode(node) {
  return (node?.constructor?.comfyClass || node?.comfyClass || node?.type) === NODE_NAME;
}

function imageRefs(refs) {
  return Array.isArray(refs) ? refs.filter((ref) => ref?.filename) : [];
}

function imageRefsFromMessage(message, key) {
  if (!message || typeof message !== "object") return [];
  const direct = imageRefs(message[key]);
  if (direct.length) return direct;
  const uiRefs = imageRefs(message.ui?.[key]);
  if (uiRefs.length) return uiRefs;
  const outputRefs = imageRefs(message.output?.[key]);
  if (outputRefs.length) return outputRefs;
  for (const value of Object.values(message)) {
    if (value && typeof value === "object") {
      const nested = imageRefsFromMessage(value, key);
      if (nested.length) return nested;
    }
  }
  return [];
}

function imageKey(ref) {
  return `${ref?.type || ""}/${ref?.subfolder || ""}/${ref?.filename || ""}`;
}

function makeViewUrl(ref) {
  const params = new URLSearchParams(ref || {});
  return api.apiURL(`/view?${params.toString()}`);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fitRect(img, rect) {
  const w = img?.naturalWidth || img?.width;
  const h = img?.naturalHeight || img?.height;
  if (!w || !h) return null;
  const [, , boxW, boxH] = rect;
  const scale = Math.min(boxW / w, boxH / h);
  const fw = Math.max(1, w * scale);
  const fh = Math.max(1, h * scale);
  return [rect[0] + (boxW - fw) / 2, rect[1] + (boxH - fh) / 2, fw, fh];
}

function drawContained(ctx, img, rect) {
  const fit = fitRect(img, rect);
  if (!fit) return null;
  ctx.drawImage(img, fit[0], fit[1], fit[2], fit[3]);
  return fit;
}

function dimLabel(entry, side) {
  const w = Number(entry?.img?.naturalWidth) || 0;
  const h = Number(entry?.img?.naturalHeight) || 0;
  return w && h ? `${side} · ${w} × ${h}` : "";
}

function drawBadge(ctx, label, rect, align) {
  if (!label) return;
  ctx.font = "12px sans-serif";
  const bw = Math.min(ctx.measureText(label).width + 14, Math.max(1, rect[2] - BADGE_INSET * 2));
  const x = align === "right" ? rect[0] + rect[2] - bw - BADGE_INSET : rect[0] + BADGE_INSET;
  const y = rect[1] + (rect[3] - BADGE_H) / 2;
  ctx.fillStyle = "rgba(20,22,30,0.78)";
  ctx.beginPath();
  ctx.roundRect?.(x, y, bw, BADGE_H, 999);
  if (!ctx.roundRect) ctx.rect(x, y, bw, BADGE_H);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#eef1f8";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + bw / 2, y + BADGE_H / 2, Math.max(1, bw - 8));
}

function releaseDecoded(img) {
  if (!img) return;
  img.onload = null;
  img.onerror = null;
  try { img.src = EMPTY_IMAGE_SRC; } catch (_) {}
}

function releaseEntry(node, slot, entry) {
  if (!entry?.img) return;
  const images = node?._abImages || {};
  const usedElsewhere = Object.entries(images).some(([k, e]) => k !== slot && e?.img === entry.img);
  if (!usedElsewhere) releaseDecoded(entry.img);
}

function loadImage(node, slot, ref) {
  const key = ref?.filename ? imageKey(ref) : "";
  node._abImages = node._abImages || {};
  const old = node._abImages[slot];
  if (!key) {
    node._abImages[slot] = null;
    releaseEntry(node, slot, old);
    syncNative(node);
    return;
  }
  if (old?.key === key) return;
  const reusable = Object.entries(node._abImages)
    .find(([s, e]) => s !== slot && e?.key === key)?.[1];
  if (reusable) {
    node._abImages[slot] = reusable;
    releaseEntry(node, slot, old);
    syncNative(node);
    app.graph?.setDirtyCanvas?.(true, false);
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (node._abImages?.[slot]?.key === key) {
      syncNative(node);
      app.graph?.setDirtyCanvas?.(true, true);
    }
  };
  img.onerror = () => {
    if (node._abImages?.[slot]?.key === key) {
      node._abImages[slot] = null;
      syncNative(node);
    }
    app.graph?.setDirtyCanvas?.(true, true);
  };
  img.src = makeViewUrl(ref);
  node._abImages[slot] = { key, ref, img };
  releaseEntry(node, slot, old);
}

function suppressNativePreviewWidget(node) {
  if (!node) return;
  node.preview = undefined;
  const widgets = node.widgets || [];
  const idx = widgets.findIndex((w) => w?.name === "$$canvas-image-preview");
  if (idx >= 0) {
    widgets[idx].onRemove?.();
    widgets.splice(idx, 1);
  }
}

function syncNative(node) {
  if (!node) return;
  suppressNativePreviewWidget(node);
  const images = node._abImages || {};
  const order = node._abNativeSlot === "b" ? ["b", "a"] : ["a", "b"];
  const entries = order
    .map((s) => images[s])
    .filter((e) => e?.img?.naturalWidth);
  node.imgs = entries.map((e) => e.img);
  node.images = entries.map((e) => e.ref);
  node.imageIndex = 0;
  node.overIndex = 0;
}

function clearNative(node) {
  if (!node) return;
  suppressNativePreviewWidget(node);
  node.imgs = undefined;
  node.images = undefined;
  node.imageIndex = 0;
  node.overIndex = 0;
  node._abNativeSlot = null;
}

function persistRefs(node) {
  const images = node?._abImages || {};
  node.properties = node.properties || {};
  node.properties.ab_compare = {
    a: images.a?.ref ? { ...images.a.ref } : null,
    b: images.b?.ref ? { ...images.b.ref } : null,
  };
}

function listLength(node) {
  const lists = node?._abRefLists || {};
  return Math.max(lists.a?.length || 0, lists.b?.length || 0);
}

function refAt(list, index) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[clamp(index, 0, list.length - 1)];
}

function applyListIndex(node, index) {
  const total = listLength(node);
  if (!total) return;
  node._abListIndex = clamp(index, 0, total - 1);
  const lists = node._abRefLists || {};
  const aList = lists.a || [];
  const bList = lists.b || [];
  const onlyA = aList.length > 1 && !bList.length;
  const onlyB = bList.length > 1 && !aList.length;
  const a = onlyB ? refAt(bList, node._abListIndex - 1) : refAt(aList, node._abListIndex);
  const b = onlyA ? refAt(aList, node._abListIndex - 1) : refAt(bList, node._abListIndex);
  loadImage(node, "a", a);
  loadImage(node, "b", b);
}

function restoreRefs(node) {
  const refs = node?.properties?.ab_compare;
  if (!refs) return;
  if (refs.a?.filename) loadImage(node, "a", refs.a);
  if (refs.b?.filename) loadImage(node, "b", refs.b);
}

function selectNativeAt(node, pos) {
  const widget = node?._abWidget;
  const images = node?._abImages || {};
  const hasA = Boolean(images.a?.img?.naturalWidth);
  const hasB = Boolean(images.b?.img?.naturalWidth);
  if (!widget || (!hasA && !hasB)) return;
  if (hasA && hasB) {
    const rect = widget.imageRect || widget.rect;
    const splitX = rect[0] + rect[2] * (node._abSplit ?? 50) / 100;
    node._abNativeSlot = pos[0] <= splitX ? "a" : "b";
  } else {
    node._abNativeSlot = hasA ? "a" : "b";
  }
  syncNative(node);
}

function isPointLike(v) {
  return v != null && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]));
}

function selectNativeUnderPointer(node, canvas) {
  const m = canvas?.graph_mouse || app.canvas?.graph_mouse;
  if (!isPointLike(m) || !isPointLike(node?.pos)) return;
  selectNativeAt(node, [m[0] - node.pos[0], m[1] - node.pos[1]]);
}

function receiveRefs(node, message) {
  if (!node || !message) return;
  const aRefs = imageRefsFromMessage(message, "a_images");
  const bRefs = imageRefsFromMessage(message, "b_images");
  const total = Math.max(aRefs.length, bRefs.length);

  if (total > 1) {
    node._abRefLists = {
      a: aRefs.map((r) => ({ ...r })),
      b: bRefs.map((r) => ({ ...r })),
    };
    applyListIndex(node, total - 1);
    persistRefs(node);
    app.graph?.setDirtyCanvas?.(true, true);
    return;
  }

  node._abRefLists = null;
  node._abListIndex = 0;
  const a = aRefs[0];
  const b = bRefs[0];
  if (a) loadImage(node, "a", a);
  else loadImage(node, "a", null);
  if (b) loadImage(node, "b", b);
  else loadImage(node, "b", null);
  persistRefs(node);
  app.graph?.setDirtyCanvas?.(true, true);
}

function hasImages(node) {
  const images = node?._abImages || {};
  return Boolean(images.a?.img?.naturalWidth || images.b?.img?.naturalWidth);
}

function pointInRect(pos, rect) {
  if (!rect) return false;
  if (pos[0] < rect[0] || pos[0] > rect[0] + rect[2]) return false;
  if (pos[1] < rect[1] || pos[1] > rect[1] + rect[3]) return false;
  return true;
}

class ABCompareWidget {
  constructor(node) {
    this.type = "custom";
    this.name = "ab_compare";
    this.options = {};
    this.value = "";
    this.node = node;
    this.dragging = false;
    this.rect = [0, 0, MIN_WIDTH, MIN_HEIGHT];
    this.imageRect = null;
    this.pageRect = null;
  }

  computeSize(width) {
    return [Math.max(MIN_WIDTH, width), MIN_HEIGHT];
  }

  setSplitFromPos(pos) {
    const rect = this.imageRect || this.rect;
    if (!rect?.[2]) return false;
    this.node._abSplit = ((pos[0] - rect[0]) / rect[2]) * 100;
    app.graph?.setDirtyCanvas?.(true, false);
    return true;
  }

  mouse(event, pos) {
    const type = String(event?.type || "");
    const isSecondary = type.includes("contextmenu") || event?.button === 2;
    if (isSecondary) {
      selectNativeAt(this.node, pos);
      return false;
    }
    if (type.includes("down") && event.button === 0 && pointInRect(pos, this.rect)) {
      const total = listLength(this.node);
      if (total > 1 && this.pageRect && pointInRect(pos, this.pageRect)) {
        applyListIndex(this.node, ((Number(this.node._abListIndex) || 0) + 1) % total);
        persistRefs(this.node);
        app.graph?.setDirtyCanvas?.(true, true);
        return true;
      }
      if (!hasImages(this.node)) return false;
      this.node._abDragging = true;
      this.dragging = true;
      this.setSplitFromPos(pos);
      return true;
    }
    if (type.includes("move")) {
      if (!hasImages(this.node)) return Boolean(this.dragging);
      // 鼠标在图上移动即实时跟随（无需按住）
      if (pointInRect(pos, this.rect)) {
        this.setSplitFromPos(pos);
        return true;
      }
      return Boolean(this.dragging);
    }
    if (type.includes("up") || type.includes("cancel")) {
      const was = this.dragging;
      this.node._abDragging = false;
      this.dragging = false;
      return was;
    }
    return Boolean(this.dragging);
  }

  draw(ctx, node, width, y) {
    const fullWidth = node.size?.[0] || width;
    const fullHeight = node.size?.[1] || MIN_HEIGHT;
    const rect = [
      EDGE_PAD,
      y + EDGE_PAD,
      Math.max(1, fullWidth - EDGE_PAD * 2),
      Math.max(1, fullHeight - y - EDGE_PAD * 2),
    ];
    this.rect = rect;
    this.imageRect = null;
    this.pageRect = null;

    ctx.save();
    ctx.fillStyle = "#101014";
    ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);

    const images = node._abImages || {};
    const a = images.a?.img;
    const b = images.b?.img;
    const hasA = Boolean(a?.naturalWidth);
    const hasB = Boolean(b?.naturalWidth);

    if (!hasA && !hasB) {
      ctx.fillStyle = "#9aa4b6";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("连接图片开始对比", rect[0] + rect[2] / 2, rect[1] + rect[3] / 2);
      ctx.restore();
      return;
    }

    const imageAreaH = Math.max(1, rect[3] - FOOTER_HEIGHT);
    const imageArea = [rect[0], rect[1], rect[2], imageAreaH];
    const footerRect = [rect[0], rect[1] + imageAreaH, rect[2], FOOTER_HEIGHT];
    const base = fitRect(a || b, imageArea) || imageArea;
    this.imageRect = base;
    const splitX = base[0] + base[2] * (node._abSplit ?? 50) / 100;

    // B（右）整幅
    if (hasB) drawContained(ctx, b, base);
    // A（左）裁到分割线
    if (hasA && splitX > base[0]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(base[0], base[1], splitX - base[0], base[3]);
      ctx.clip();
      drawContained(ctx, a, base);
      ctx.restore();
    }

    // 分割线 + 光晕 + 把手
    if (splitX >= base[0] && splitX <= base[0] + base[2]) {
      ctx.save();
      ctx.shadowColor = BRAND;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = BRAND;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(splitX, base[1]);
      ctx.lineTo(splitX, base[1] + base[3]);
      ctx.stroke();
      const knobY = base[1] + base[3] / 2;
      ctx.shadowBlur = 6;
      ctx.fillStyle = BRAND;
      ctx.beginPath();
      ctx.arc(splitX, knobY, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      // 顶部 A｜B 胶囊随分割线移动
      const flag = "A ｜ B";
      ctx.font = "600 11px sans-serif";
      const fw = ctx.measureText(flag).width + 18;
      const fx = clamp(splitX - fw / 2, base[0] + 2, base[0] + base[2] - fw - 2);
      const fy = base[1] + 8;
      ctx.fillStyle = "rgba(20,22,30,0.84)";
      ctx.beginPath();
      ctx.roundRect?.(fx, fy, fw, 20, 999);
      if (!ctx.roundRect) ctx.rect(fx, fy, fw, 20);
      ctx.fill();
      ctx.strokeStyle = "rgba(99,102,241,0.75)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(flag, fx + fw / 2, fy + 10);
    }

    // 底部分隔 + 徽标
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(footerRect[0], footerRect[1] + 0.5);
    ctx.lineTo(footerRect[0] + footerRect[2], footerRect[1] + 0.5);
    ctx.stroke();

    const total = listLength(node);
    const pageLabel = total > 1 ? `${(Number(node._abListIndex) || 0) + 1}/${total}` : "";
    const pageW = pageLabel ? ctx.measureText(pageLabel).width + 16 : 0;
    const centerReserve = pageW ? pageW + 12 : 6;
    const half = Math.max(1, (footerRect[2] - BADGE_INSET * 2 - centerReserve) / 2);
    if (hasA) drawBadge(ctx, dimLabel(images.a, "A"), footerRect, "left");
    if (hasB) drawBadge(ctx, dimLabel(images.b, "B"), footerRect, "right");
    if (total > 1) {
      const bw = pageW;
      const bx = footerRect[0] + (footerRect[2] - bw) / 2;
      const by = footerRect[1] + (footerRect[3] - BADGE_H) / 2;
      this.pageRect = [bx, by, bw, BADGE_H];
      ctx.fillStyle = "rgba(20,22,30,0.8)";
      ctx.beginPath();
      ctx.roundRect?.(bx, by, bw, BADGE_H, 999);
      if (!ctx.roundRect) ctx.rect(bx, by, bw, BADGE_H);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(pageLabel, bx + bw / 2, by + BADGE_H / 2);
    }

    ctx.restore();
  }
}

function installWidget(node) {
  if (node._abWidget || typeof node.addCustomWidget !== "function") return;
  node._abSplit = node._abSplit ?? 50;
  node._abWidget = node.addCustomWidget(new ABCompareWidget(node));
  node.size = node.size || [MIN_WIDTH, MIN_HEIGHT];
  node.size[0] = Math.max(node.size[0] || MIN_WIDTH, MIN_WIDTH);
  node.size[1] = Math.max(node.size[1] || MIN_HEIGHT, MIN_HEIGHT);
}

function activate(node) {
  if (!isTargetNode(node)) return;
  suppressNativePreviewWidget(node);
  installWidget(node);
  restoreRefs(node);
  syncNative(node);
}

function dispose(node) {
  if (!node) return;
  const images = node._abImages || {};
  for (const entry of new Set([images.a, images.b].filter(Boolean))) {
    if (entry.img) releaseDecoded(entry.img);
  }
  clearNative(node);
  node._abImages = {};
  node._abRefLists = {};
  node._abDragging = false;
  node._abWidget = null;
}

app.registerExtension({
  name: "AllBuy.ABCompare",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      activate(this);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      setTimeout(() => activate(this), 0);
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      dispose(this);
      onRemoved?.apply(this, arguments);
    };
    const onDrawBackground = nodeType.prototype.onDrawBackground;
    nodeType.prototype.onDrawBackground = function () {
      const imgs = this.imgs;
      const images = this.images;
      this.imgs = undefined;
      this.images = undefined;
      try {
        return onDrawBackground?.apply(this, arguments);
      } finally {
        this.imgs = imgs;
        this.images = images;
      }
    };
    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (event, pos) {
      if (isTargetNode(this) && event?.button === 2) selectNativeAt(this, pos);
      return onMouseDown?.apply(this, arguments);
    };
    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      if (isTargetNode(this)) selectNativeUnderPointer(this, canvas);
      return getExtraMenuOptions?.apply(this, arguments);
    };
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      if (isTargetNode(this)) {
        activate(this);
        receiveRefs(this, message);
      }
      return onExecuted?.apply(this, arguments);
    };
  },
  async nodeCreated(node) {
    if (isTargetNode(node)) activate(node);
  },
});
