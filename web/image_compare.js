// AllBuy-A/B 图像对比画布
//   画布 custom widget：深底图区，A/B 按 contain 同区适配；
//   靛紫分割线 + 光晕，顶部 A｜B 胶囊随分割线移动；底部 A/B 尺寸徽标 + 批量页码(点击翻页)。
//   开关（自动输出/悬停跟随）= 隐藏绘制的原生 toggle widget，主题外观画在其条带位置，
//   命中走 litegraph 原生分发（canvas 自绘命中在条带外不可靠，v3.94 事故）。
//   交互：悬停跟随开启时鼠标在图内移动分割线自动跟随；按住左键拖动；右键切换原生预览槽位 A/B。
//   空态文案「连接图片开始对比」/临时预览失效指引。
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
const SWITCH_W = 118;
const SWITCH_H = 22;
const EMPTY_IMAGE_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function isTargetNode(node) {
  return (node?.constructor?.comfyClass || node?.comfyClass || node?.type) === NODE_NAME;
}

// 输入槽位中文标签（litegraph 官方定制点：label 优先于 name 显示）。
// 不做 canvas 覆盖：原生槽位行永远画在前景层之后，任何钩子都盖不住它（v3.94 实测）
function themeInputLabels(node) {
  for (const inp of node.inputs || []) {
    if (inp.type !== "IMAGE") continue;
    if (inp.name === "image_a" && !inp._abLabeled) { inp.label = "图片 A"; inp._abLabeled = true; }
    if (inp.name === "image_b" && !inp._abLabeled) { inp.label = "图片 B"; inp._abLabeled = true; }
  }
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
      // 留 error 标记（非清空）：draw 层据此显示"加载失败"徽标而非"未连接"
      node._abImages[slot] = { key, ref, img: null, error: true };
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
  const aLen = lists.a?.length || 0;
  const bLen = lists.b?.length || 0;
  // 单侧批量：一页 = 当前帧 vs 前一帧，总页 = len-1（旧口径第 1 页自比较且
  // onlyA/onlyB 的时间方向相反——两侧都改为"批量侧显示后一帧、对照侧前一帧"）
  if (aLen && !bLen) return Math.max(1, aLen - 1);
  if (!aLen && bLen) return Math.max(1, bLen - 1);
  return Math.max(aLen, bLen);
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
  const i = node._abListIndex;
  const a = onlyB ? refAt(bList, i) : refAt(aList, i + (onlyA ? 1 : 0));
  const b = onlyA ? refAt(aList, i) : refAt(bList, i + (onlyB ? 1 : 0));
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
    const splitX = rect[0] + rect[2] * splitPctOf(node) / 100;
    node._abNativeSlot = pos[0] <= splitX ? "a" : "b";
  } else {
    node._abNativeSlot = hasA ? "a" : "b";
  }
  syncNative(node);
}

function splitPctOf(node) {
  // 读侧钳位 [0,100]。不能用 `Number(x) || 50`：split=0（左侧最边）是合法值，
  // 0 是 falsy 会被当成缺省弹回 50（"点左边缘弹回中间"事故）
  const v = Number(node?._abSplit);
  return clamp(Number.isFinite(v) ? v : 50, 0, 100);
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
    // 此高度只用于 LiteGraph 的"布局条带"（widget 事件分发区 + 节点高度计算）。
    // 千万不能跟随 node.size[1]：布局会在 widget 高度上再加标题栏等 chrome →
    // 节点长高 → computeSize 返回更大值 → 再加 chrome……反馈环把节点撑到无限高
    // （v3.89 事故）。条带之外的图区交互由节点级 onMouseDown/Move/Up 钩子兜底。
    return [Math.max(MIN_WIDTH, width), MIN_HEIGHT];
  }

  setSplitFromPos(pos) {
    const rect = this.imageRect || this.rect;
    if (!rect?.[2]) return false;
    this.node._abSplit = clamp(((pos[0] - rect[0]) / rect[2]) * 100, 0, 100);
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
      // 开关命中已移交 litegraph 原生 toggle 条带分发（本 widget 之后两行），此处只管翻页与拖拽
      const total = listLength(this.node);
      if (total > 1 && this.pageRect && pointInRect(pos, this.pageRect)) {
        applyListIndex(this.node, ((Number(this.node._abListIndex) || 0) + 1) % total);
        persistRefs(this.node);
        app.graph?.setDirtyCanvas?.(true, true);
        return true;
      }
      if (!hasImages(this.node)) {
        // 引用已在、图还在解码的空窗期也消费按下：否则穿透成节点拖拽把节点拖走
        const pending = Object.values(this.node._abImages || {}).some((e) => e && !e.img);
        return pending;
      }
      this.node._abDragging = true;
      this.dragging = true;
      this.setSplitFromPos(pos);
      return true;
    }
    if (type.includes("move")) {
      if (!hasImages(this.node)) return Boolean(this.dragging);
      // 悬停模式开启或拖拽中时跟随（move 事件仅在部分分发路径到达 widget；
      // 纯悬停的跟随由节点级 onMouseMove 钩子负责）
      if ((this.node._abHover || this.dragging) && pointInRect(pos, this.rect)) {
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
    // 绘制固定在本 widget 的命中条带内（computeSize 320）：槽位行/开关行的原生
    // 命中条带都在其外侧，画出去会盖住它们的交互区
    const rect = [
      EDGE_PAD,
      y + EDGE_PAD,
      Math.max(1, fullWidth - EDGE_PAD * 2),
      Math.max(1, MIN_HEIGHT - y - EDGE_PAD * 2 - 4),
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
      const hadError = Boolean(images.a?.error || images.b?.error);
      const isTemp = images.a?.ref?.type === "temp" || images.b?.ref?.type === "temp";
      ctx.fillText(
        hadError
          ? (isTemp
            ? "对比预览是临时文件，已随后端重启被清理"
            : "图片加载失败（文件缺失或路径失效）")
          : "连接图片开始对比",
        rect[0] + rect[2] / 2, rect[1] + rect[3] / 2 - (hadError ? 8 : 0));
      if (hadError) {
        ctx.font = "11px sans-serif";
        ctx.fillStyle = "#7d8798";
        ctx.fillText("重新运行工作流即可恢复对比预览", rect[0] + rect[2] / 2, rect[1] + rect[3] / 2 + 12);
      }
      ctx.restore();
      return;
    }

    const imageAreaH = Math.max(1, rect[3] - FOOTER_HEIGHT);
    const imageArea = [rect[0], rect[1], rect[2], imageAreaH];
    const footerRect = [rect[0], rect[1] + imageAreaH, rect[2], FOOTER_HEIGHT];
    const base = fitRect(a || b, imageArea) || imageArea;
    this.imageRect = base;
    const splitX = base[0] + base[2] * splitPctOf(node) / 100;

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

    // 底部分隔 + 徽标行。开关行走 litegraph 原生 toggle 命中条带（本 widget 之后
    // 两行 28px），主题外观在下方按行位置绘制
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(footerRect[0], footerRect[1] + 0.5);
    ctx.lineTo(footerRect[0] + footerRect[2], footerRect[1] + 0.5);
    ctx.stroke();

    const badgeRow = [footerRect[0], footerRect[1], footerRect[2], footerRect[3]];
    const total = listLength(node);
    // 双侧批量数量不等时短侧复用末帧：徽标显示各自序号（* = 末帧复用），
    // 统一 N/total 会让用户误以为两同序号帧是配对产出的
    const lists = node._abRefLists || {};
    const aLen = (lists.a || []).length;
    const bLen = (lists.b || []).length;
    const idx = Number(node._abListIndex) || 0;
    const pageLabel = total > 1
      ? (aLen && bLen
        ? `A·${Math.min(idx, aLen - 1) + 1}${idx >= aLen ? "*" : ""} B·${Math.min(idx, bLen - 1) + 1}${idx >= bLen ? "*" : ""}`
        : `${idx + 1}/${total}`)
      : "";
    const pageW = pageLabel ? ctx.measureText(pageLabel).width + 16 : 0;
    const centerReserve = pageW ? pageW + 12 : 6;
    const half = Math.max(1, (badgeRow[2] - BADGE_INSET * 2 - centerReserve) / 2);
    if (hasA) drawBadge(ctx, dimLabel(images.a, "A"), badgeRow, "left");
    if (hasB) drawBadge(ctx, dimLabel(images.b, "B"), badgeRow, "right");
    // 单侧加载失败：徽标位给出失败提示（此前该侧无声消失，用户以为没接图）
    if (!hasA && images.a?.error) drawBadge(ctx, "A 加载失败", badgeRow, "left");
    if (!hasB && images.b?.error) drawBadge(ctx, "B 加载失败", badgeRow, "right");
    if (total > 1) {
      const bw = pageW;
      const bx = badgeRow[0] + (badgeRow[2] - bw) / 2;
      const by = badgeRow[1] + (badgeRow[3] - BADGE_H) / 2;
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

    // 开关行主题外观：两只原生 toggle 的条带在本 widget 之后上下两行（自动输出 /
    // 悬停跟随），命中由 litegraph 原生分发——外观按行位置绘制，画与命中必然同位
    const drawSwitch = (x, y2, on, label) => {
      ctx.fillStyle = on ? "rgba(99,102,241,0.22)" : "rgba(20,22,30,0.72)";
      ctx.strokeStyle = on ? "rgba(129,140,248,0.95)" : "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect?.(x, y2, SWITCH_W, SWITCH_H, 999);
      if (!ctx.roundRect) ctx.rect(x, y2, SWITCH_W, SWITCH_H);
      ctx.fill();
      ctx.stroke();
      const tx = x + 5;
      const ty = y2 + (SWITCH_H - 14) / 2;
      ctx.fillStyle = on ? BRAND : "#3a3f52";
      ctx.beginPath();
      ctx.roundRect?.(tx, ty, 26, 14, 999);
      if (!ctx.roundRect) ctx.rect(tx, ty, 26, 14);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(tx + (on ? 19 : 7), ty + 7, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = on ? "#e6e9ff" : "#aab1c4";
      ctx.font = "600 11.5px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tx + 32, y2 + SWITCH_H / 2 + 0.5);
    };
    const sx = rect[0] + (rect[2] - SWITCH_W) / 2;
    drawSwitch(sx, y + MIN_HEIGHT + 3, !(Boolean((node.widgets || []).find((w) => w.name === "auto_output")?.value === false)), "自动输出");
    drawSwitch(sx, y + MIN_HEIGHT + 31, Boolean(node._abHover), "悬停跟随");

    ctx.restore();
  }
}

function installWidget(node) {
  if (typeof node.addCustomWidget !== "function") return;
  // 去重：多入口 activate 会重复进入本函数——compare 占位与多余开关行清掉，
  // 已有开关行保留复用（全删重建会在 early-return 路径上丢失开关，v3.95 实测）
  let wHover = null;
  node.widgets = (node.widgets || []).filter((w) => {
    if (w.name === "悬停跟随") {
      if (wHover) return false; // 只留第一只
      wHover = w;
      return true;
    }
    if (w.name === "ab_compare" && w !== node._abWidget) return false; // 占位/旧实例
    return true;
  });
  const wAuto0 = (node.widgets || []).find((w) => w.name === "auto_output");
  // 统一排序：三只移到 widgets 尾部按 [compare, auto, hover] 排列——litegraph 自上
  // 而下按数组顺序布局与分发，主题 pill 的绘制位置（compare 条带后两行）与之对齐
  const tidy = () => {
    const cmp = node._abWidget, au = wAuto0 || null, hv = wHover || null;
    if (!cmp) return;
    const rest = (node.widgets || []).filter((w) => w !== cmp && w !== au && w !== hv);
    node.widgets = [...rest, cmp, au, hv].filter(Boolean);
  };
  if (node._abWidget) {
    // compare 已装：确保开关在位与排序，不重复创建
    if (!wHover) {
      wHover = node.addWidget("toggle", "悬停跟随", node._abHover, (v) => {
        node._abHover = v;
        node.properties = node.properties || {};
        node.properties.ab_hover = v;
        app.graph?.setDirtyCanvas?.(true, true);
      }, { serialize: false });
      wHover.draw = () => {};
      wHover.computeSize = () => [0, 28];
    }
    node._abHoverWidget = wHover;
    node._abAutoWidget = wAuto0 || null;
    wHover.value = node._abHover;
    tidy();
    return;
  }
  node._abSplit = node._abSplit ?? 50;
  node._abHover = Boolean(node.properties?.ab_hover); // 悬停跟随模式（rgthree comparer 同款），随工作流持久化
  node.color = "#1d2030";
  node.bgcolor = "#14161d";
  // 两只开关 = 隐藏绘制的原生 toggle widget：命中交给 litegraph 条带分发
  //（100% 可靠），主题外观由 compare.draw 画在其条带位置。教训：canvas 底栏 +
  // 事件转发不可靠——底部在 widget 命中条带之外、原型钩子不可依赖（v3.94 事故）
  const wAuto = wAuto0;
  if (wAuto) {
    if (wAuto.value !== true && wAuto.value !== false) wAuto.value = true; // 存档空值归一
    wAuto.draw = () => {};
    wAuto.computeSize = () => [0, 28];
    const prevCb = wAuto.callback;
    wAuto.callback = (v) => { app.graph?.setDirtyCanvas?.(true, true); prevCb?.(v); };
  }
  if (!wHover) {
    wHover = node.addWidget("toggle", "悬停跟随", node._abHover, (v) => {
      node._abHover = v;
      node.properties = node.properties || {};
      node.properties.ab_hover = v;
      app.graph?.setDirtyCanvas?.(true, true);
    }, { serialize: false });
    wHover.draw = () => {};
    wHover.computeSize = () => [0, 28];
  }
  node._abHoverWidget = wHover;
  node._abAutoWidget = wAuto || null;
  node._abWidget = node.addCustomWidget(new ABCompareWidget(node));
  tidy();
  // 顺序 [compare, auto, hover]：compare 条带 320 之后紧跟两只 28px 开关行 = 节点底部
  const wi = node.widgets.indexOf(node._abWidget);
  if (wi >= 0) {
    if (wAuto) { node.widgets.splice(node.widgets.indexOf(wAuto), 1); node.widgets.splice(wi, 0, wAuto); }
    node.widgets.splice(node.widgets.indexOf(node._abWidget) + 1, 0, wHover);
  }
  node.size = node.size || [MIN_WIDTH, MIN_HEIGHT];
  node.size[0] = Math.max(node.size[0] || MIN_WIDTH, MIN_WIDTH);
  // v3.89 事故的持久化超大尺寸收治 + v3.95 起布局固定（条带 320 + 开关两行 56），
  // 拉高节点只会留空白——存量超大尺寸直接收治到内容高
  node.size[1] = Math.max(Math.min(node.size[1] || MIN_HEIGHT, MIN_HEIGHT + 96), MIN_HEIGHT);
}

function activate(node) {
  if (!isTargetNode(node)) return;
  // dispose 后挂起的 onConfigure setTimeout 不再复活：否则会对已删节点重装 widget
  // 并经 restoreRefs 发起无人回收的幽灵 /view 请求
  if (node._abDisposed) return;
  suppressNativePreviewWidget(node);
  installWidget(node);
  if (node._abHoverWidget) node._abHoverWidget.value = node._abHover; // 工作流恢复后同步开关显示
  restoreRefs(node);
  syncNative(node);
}

function dispose(node) {
  if (!node) return;
  node._abDisposed = true;
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
    const onAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      onAdded?.apply(this, arguments);
      // 撤销删除（Ctrl+Z）恢复节点：解除 dispose 标记并重装对比 widget
      if (this._abDisposed) { this._abDisposed = false; activate(this); }
    };
    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (event, pos) {
      if (isTargetNode(this) && event?.button === 2) selectNativeAt(this, pos);
      const r = onMouseDown?.apply(this, arguments);
      if (r) return r;
      // 命中分发与布局条带解耦：computeSize 条带（MIN_HEIGHT）之外的图区点击
      // 也转交 widget——否则拉高节点后只有顶部条带拖得动分割线。
      // 注意：本文件只允许一个 onMouseDown 包装（v3.92 曾重复声明致整个模块
      // 解析失败、扩展静默不加载，表现为对比节点整块空黑）
      const w = this._abWidget;
      if (w?.mouse && Array.isArray(pos)) {
        const rect = w.rect || w.imageRect;
        if (rect && pos[0] >= rect[0] && pos[0] <= rect[0] + rect[2]
          && pos[1] >= rect[1] && pos[1] <= rect[1] + rect[3]) {
          return w.mouse(event, pos);
        }
      }
      return r;
    };
    const onMouseMove = nodeType.prototype.onMouseMove;
    nodeType.prototype.onMouseMove = function (e, pos) {
      const r = onMouseMove?.apply(this, arguments);
      // 悬停跟随模式：鼠标在图区内移动时分割线自动跟随。widget.mouse 的 move
      // 事件仅在拖拽激活期可靠到达，纯悬停必须走节点级 onMouseMove
      try {
        const w = this._abWidget;
        if (this._abDragging && w) {
          // 节点钩子发起的拖拽：move 事件不经 widget 分发，这里驱动
          w.setSplitFromPos(pos);
        } else if (this._abHover && w) {
          const rect = w.imageRect || w.rect;
          if (rect?.[2] && pos[0] >= rect[0] && pos[0] <= rect[0] + rect[2]
            && pos[1] >= rect[1] && pos[1] <= rect[1] + rect[3]) {
            const pct = clamp(((pos[0] - rect[0]) / rect[2]) * 100, 0, 100);
            if (pct !== this._abSplit) {
              this._abSplit = pct;
              app.graph?.setDirtyCanvas?.(true, false);
            }
          }
        }
      } catch (_) { /* 悬停跟随异常不得影响画布其它交互 */ }
      return r;
    };
    const onMouseUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function (e, pos) {
      const r = onMouseUp?.apply(this, arguments);
      // 兜底清拖拽态（widget 分发路径的 up 由 LiteGraph 自行投递，重复调用无害）
      if (this._abDragging && this._abWidget?.mouse) this._abWidget.mouse(e, pos || [0, 0]);
      return r;
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
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground?.apply(this, arguments);
      if (isTargetNode(this)) themeInputLabels(this);
      return r;
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
