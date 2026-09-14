// 预览弹窗：单卡预览 + 合并结果预览
// 合并逻辑需与后端 merger.py 保持一致

const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const API = "/allbuy_promptlibrary";

// v3.64：单卡预览顶部的封面媒体区（视频优先，可拖进度/开声）；两者皆无返回 null
function buildPreviewMedia(group) {
  const videoName = group.coverVideo || "";
  const posterName = group.cover || "";
  if (!videoName && !posterName) return null;
  if (videoName) {
    const v = document.createElement("video");
    v.className = "vpl-pv-media";
    v.src = `${API}/cover/video?name=${encodeURIComponent(videoName)}`;
    v.controls = true;
    v.autoplay = true;
    v.muted = true; // 用 property 而非 attribute：自动播放静音口径以浏览器判定为准
    v.loop = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.addEventListener("error", () => v.remove()); // 封面视频丢失时不挡下面的文本预览
    if (posterName) v.poster = `${API}/cover/file?name=${encodeURIComponent(posterName)}&w=960`;
    return v;
  }
  const img = h("img", {
    class: "vpl-pv-media",
    src: `${API}/cover/file?name=${encodeURIComponent(posterName)}&w=1280`,
    alt: "",
  });
  img.addEventListener("error", () => img.remove()); // 封面丢失时不挡下面的文本预览
  return img;
}

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined) el.setAttribute(k, v);
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

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 回退方案
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "已复制";
    btn.classList.add("vpl-btn-success");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("vpl-btn-success"); }, 1200);
  }
}

/**
 * 前端版通配符展开，与 merger.py 的 expand_wildcards 对齐。
 * vars: 命名槽取值 {名称: 值}——{名称:选项1|选项2} 有值固定替换、无值随机；
 *       纯占位符 {名称} 无值原样保留（与后端一致）。
 * 注意：随机展开预览用 Math.random（仅示意），实际输出以后端为准。
 */
function splitNamed(content) {
  const ci = content.indexOf(":");
  if (ci > 0) {
    const head = content.slice(0, ci).trim();
    if (head && !head.includes("|") && !/^\d+$/.test(head) && head.length <= 24) {
      return [head, content.slice(ci + 1)];
    }
  }
  return null;
}
function isBarePlaceholder(content) {
  const bare = content.trim();
  if (!bare || bare.length > 24 || /^\d+$/.test(bare)) return false;
  return !/[|:{}]/.test(bare);
}
function expandWildcards(text, vars = {}) {
  if (!text) return text;
  text = text.replace(/＃/g, "#"); // 全角＃兼容
  if (text.includes("#")) {
    // v3.35：属性标签 #名称# —— 填了值替换，没填原样保留（与后端 _TAG_RE 对齐）
    text = text.replace(/#([^#\s{}:|]{1,24})#/g, (whole, name) => {
      return String(vars[name] ?? "").trim() || whole;
    });
  }
  if (!text.includes("{")) return text;
  let prev = null;
  while (text !== prev) {
    prev = text;
    text = text.replace(/\{([^{}]*)\}/g, (whole, content) => {
      const named = splitNamed(content);
      if (named) {
        const [name, rest] = named;
        const val = String(vars[name] ?? "").trim();
        if (val) return val;
        const opts = rest.split("|").map((o) => o.trim()).filter(Boolean);
        if (opts.length) return opts[Math.floor(Math.random() * opts.length)];
        return whole;
      }
      if (isBarePlaceholder(content)) {
        const val = String(vars[content.trim()] ?? "").trim();
        if (val) return val;
        return whole;
      }
      const options = content.split("|").map((o) => o.trim()).filter(Boolean);
      return options.length ? options[Math.floor(Math.random() * options.length)] : "";
    });
  }
  return text;
}

/**
 * 前端版合并逻辑，与 merger.py 对齐
 * groups: 全部卡片
 * selectedIds: 有序 id
 * 返回 { positive, negative, blocks: [{group, text, isNegative}] }
 */
export function mergeGroups(groups, selectedIds, separator = ", ", prepend = "", append = "", ignoreWeight = false, vars = {}) {
  const byId = {};
  (groups || []).forEach((g) => { if (g.id) byId[g.id] = g; });
  const ordered = (selectedIds || []).map((id) => byId[id]).filter(Boolean);

  const posBlocks = [];
  const negBlocks = [];
  const posParts = [];
  const negParts = [];

  for (const g of ordered) {
    const pos = (g.positive || "").trim();
    const neg = (g.negative || "").trim();
    const prefix = expandWildcards(g.prefix || "", vars);
    const suffix = expandWildcards(g.suffix || "", vars);
    const weight = parseFloat(g.weight);
    const w = isNaN(weight) ? 1.0 : weight;

    if (pos) {
      let text = prefix + expandWildcards(pos, vars) + suffix;
      // 与后端 merger.merge_groups 同口径：展开为空不包权重、不产生空碎片
      if (text && !ignoreWeight && w !== 1.0) text = `(${text}:${w})`;
      if (text) {
        posParts.push(text);
        posBlocks.push({ group: g, text });
      }
    }
    if (neg) {
      const t = expandWildcards(neg, vars);
      if (t) {
        negParts.push(t);
        negBlocks.push({ group: g, text: t });
      }
    }
  }

  const join = (parts) => {
    const pieces = [];
    if (prepend) pieces.push(expandWildcards(prepend, vars));
    if (parts.length) pieces.push(parts.join(separator));
    if (append) pieces.push(expandWildcards(append, vars));
    return separator === "\n" ? pieces.join("\n") : pieces.join(separator);
  };

  return {
    positive: join(posParts).trim(),
    negative: negParts.join(separator).trim(),
    posBlocks,
    negBlocks,
  };
}

function openShell(title, body, width = 720) {
  const overlay = h("div", { class: "vpl-overlay" });
  const dialog = h("div", { class: "vpl-dialog", style: `max-width:min(${width}px, calc(100vw - 32px))` });
  const header = h("div", { class: "vpl-dialog-title" }, [
    h("span", {}, title),
    h("button", { class: "vpl-icon-btn", title: "关闭", onclick: () => overlay.remove(), html: ICON_CLOSE }),
  ]);
  const bodyWrap = h("div", { class: "vpl-dialog-body vpl-preview-body" }, [body]);
  dialog.appendChild(header);
  dialog.appendChild(bodyWrap);
  overlay.appendChild(dialog);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return { overlay, dialog, bodyWrap };
}

function textBlock(label, text, color) {
  if (!text) return null;
  const ta = h("div", { class: "vpl-preview-text" });
  ta.textContent = text;
  const copyBtn = h("button", { class: "vpl-btn vpl-btn-sm", onclick: (e) => copyText(text, e.currentTarget) }, "复制");
  return h("div", { class: "vpl-preview-block" }, [
    h("div", { class: "vpl-preview-block-head" }, [
      h("span", { class: "vpl-dot", style: `background:${color || "#888"}` }),
      h("span", { class: "vpl-preview-block-label" }, label),
      copyBtn,
    ]),
    ta,
  ]);
}

/** 单卡预览 */
export function previewGroup(group) {
  // 分类显示优先 categories 数组（v3.12 起主字段），旧单字符串 category 兜底
  const cats = (Array.isArray(group.categories) && group.categories.length)
    ? group.categories.join(" / ") : (group.category || "");
  const media = buildPreviewMedia(group);
  const body = h("div", {}, [
    media,
    h("div", { class: "vpl-preview-meta" }, [
      h("span", { class: "vpl-dot", style: `background:${group.color || "#888"}` }),
      h("strong", {}, group.name || "未命名"),
      cats ? h("span", { class: "vpl-tag" }, cats) : null,
    ]),
    group.note ? h("div", { class: "vpl-preview-note" }, group.note) : null,
    textBlock("正向提示词", group.positive, group.color),
    textBlock("负向提示词", group.negative, "#E74C3C"),
  ]);
  openShell("预览：" + (group.name || "未命名"), body, media ? 860 : 720);
}

/** 合并结果预览：按卡片分块着色 + 最终文本 */
export function previewMerged({ groups, selectedIds, separator = ", ", prepend = "", append = "", ignoreWeight = false, vars = {} }) {
  const { positive, negative, posBlocks, negBlocks } = mergeGroups(
    groups, selectedIds, separator, prepend, append, ignoreWeight, vars
  );

  const blockView = h("div", { class: "vpl-merge-blocks" },
    posBlocks.length
      ? posBlocks.map((b, i) =>
          h("div", { class: "vpl-merge-item" }, [
            h("div", { class: "vpl-merge-item-head" }, [
              h("span", { class: "vpl-dot", style: `background:${b.group.color || "#888"}` }),
              h("span", {}, `${i + 1}. ${b.group.name || "未命名"}`),
              b.group.category ? h("span", { class: "vpl-tag" }, b.group.category) : null,
            ]),
            h("div", { class: "vpl-merge-item-text" }, b.text),
          ])
        )
      : h("div", { class: "vpl-empty" }, "未勾选任何提示词组")
  );

  const finalPositive = h("div", { class: "vpl-preview-text vpl-preview-text-final" });
  finalPositive.textContent = positive || "（空）";
  const finalNegative = h("div", { class: "vpl-preview-text vpl-preview-text-final" });
  finalNegative.textContent = negative || "（空）";

  const copyPosBtn = h("button", {
    class: "vpl-btn vpl-btn-sm vpl-btn-primary",
    onclick: (e) => copyText(positive, e.currentTarget),
  }, "复制正向");
  const copyNegBtn = h("button", {
    class: "vpl-btn vpl-btn-sm",
    onclick: (e) => copyText(negative, e.currentTarget),
  }, "复制负向");

  const hasWildcard = [...posBlocks, ...negBlocks].some((b) => b.text.includes("{"))
    || prepend.includes("{") || append.includes("{");

  const body = h("div", {}, [
    h("div", { class: "vpl-section-title" }, `已选 ${posBlocks.length} 组（按勾选顺序合并）`),
    blockView,
    hasWildcard ? h("div", { class: "vpl-hint" },
      "含 {a|b} 通配符：预览中为随机展开，实际输出以后端执行时的抽取为准；"
      + "{名称:选项} 命名槽已套用面板取值，未填的保留原样") : null,
    h("div", { class: "vpl-section-title" }, [
      "最终正向提示词",
      h("span", { class: "vpl-hint" }, `${positive.length} 字符`),
      copyPosBtn,
    ]),
    finalPositive,
    negative ? h("div", { class: "vpl-section-title" }, [
      "最终负向提示词",
      h("span", { class: "vpl-hint" }, `${negative.length} 字符`),
      copyNegBtn,
    ]) : null,
    negative ? finalNegative : null,
  ]);

  openShell("合并结果预览", body, 780);
}
