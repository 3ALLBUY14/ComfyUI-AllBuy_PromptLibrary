// 卡片新建/编辑弹窗
// 用法：const res = await openEditor(group, { isNew, categories, palette });
// res 为 { group, meta }；取消时返回 null。
//   group：编辑后的卡片对象
//   meta ：可能扩展后的自定义调色板 { categories:[], colors:[], tags:[] }，由调用方落库

export function uid() {
  return "g-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export const COLOR_PRESETS = [
  "#4A90D9", "#9B59B6", "#E74C3C", "#E67E22",
  "#F1C40F", "#27AE60", "#1ABC9C", "#34495E",
  "#E91E63", "#795548", "#607D8B", "#00BCD4",
];

const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_PASTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>';
const ICON_DICE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" ry="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/></svg>';

// hsl → #rrggbb（标准公式）
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}
// 真随机取色：全色相随机，饱和/亮度限定在玻璃 UI 的舒适区间（避免脏色和看不清的深浅）
export function randomColor() {
  return hslToHex(
    Math.floor(Math.random() * 360),
    58 + Math.floor(Math.random() * 22),
    52 + Math.floor(Math.random() * 16),
  );
}

// 剪贴板：写优先 Clipboard API，失败（http 非安全源等）退回 execCommand；读没有可靠降级，失败返回 null
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}
async function readClipboard() {
  try { return await navigator.clipboard.readText(); } catch {}
  return null;
}

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  // form 内按钮若不显式设 type 会默认成 submit，点击即触发保存——这里统一默认为普通按钮
  if (tag === "button" && !(props && props.type)) el.type = "button";
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

export function openEditor(group, { isNew = false, categories = [], palette = {} } = {}) {
  return new Promise((resolve) => {
    const data = group
      ? JSON.parse(JSON.stringify(group))
      : {
          id: uid(),
          name: "",
          categories: [],
          positive: "",
          negative: "",
          note: "",
          // 新建即真随机取色（全色相），替代 v3.42 的预设循环配色
          color: randomColor(),
          weight: 1.0,
          prefix: "",
          suffix: "",
          tags: [],
          cover: "",
        };
    // 兼容旧数据：group.category 单字符串 → categories 数组
    if (typeof data.category === "string" && !Array.isArray(data.categories)) {
      data.categories = data.category ? [data.category] : [];
    }

    // 自定义调色板（随库持久化）；分类建议额外合并“库里已存在的分类”
    const pal = {
      categories: [...new Set([...(palette.categories || []), ...categories])],
      colors: [...(palette.colors || [])],
      tags: [...(palette.tags || [])],
      attributes: [...(palette.attributes || [])], // v3.35：属性标签（#名称#）建议
    };
    const uidSuffix = uid();

    const overlay = h("div", { class: "vpl-overlay" });
    const dialog = h("div", { class: "vpl-dialog vpl-editor" });

    // ---- 标题栏 ----
    const title = h("div", { class: "vpl-dialog-title" }, [
      h("span", {}, isNew ? "新建提示词组" : "编辑提示词组"),
      h("button", {
        class: "vpl-icon-btn", title: "关闭", onclick: () => close(null), html: ICON_CLOSE,
      }),
    ]);

    // ---- 表单 ----
    const nameInput = h("input", {
      type: "text", class: "vpl-input", placeholder: "提示词组名称（如：电影感慢推镜头）",
      value: data.name || "",
    });

    // 分类：多选 chip（与标签同构）—— 一组可属于多个分类
    const catListId = "vpl-cat-" + uidSuffix;
    const catInput = h("input", {
      type: "text", class: "vpl-input", list: catListId,
      placeholder: "分类（如：镜头运动 / 视觉风格，可多选）",
    });
    const catDatalist = h("datalist", { id: catListId },
      pal.categories.map((c) => h("option", { value: c })));
    let selCats = [...(data.categories || [])];
    const selCatChips = h("div", { class: "vpl-chip-list" });
    function renderSelCatChips() {
      selCatChips.innerHTML = "";
      selCats.forEach((c, i) => {
        selCatChips.appendChild(h("span", { class: "vpl-chip vpl-chip-removable" }, [
          c,
          h("span", {
            class: "vpl-chip-x", title: "移除该分类",
            onclick: () => { selCats.splice(i, 1); renderSelCatChips(); },
          }, "×"),
        ]));
      });
    }
    function addCatFromInput() {
      const v = catInput.value.trim();
      if (v && !selCats.includes(v)) {
        selCats.push(v);
        if (!pal.categories.includes(v)) {
          pal.categories.push(v);
          catDatalist.appendChild(h("option", { value: v }));
        }
        renderSelCatChips();
      }
      catInput.value = "";
    }
    catInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCatFromInput(); }
    });
    const addCatBtn = h("button", {
      class: "vpl-btn vpl-btn-sm vpl-chip-add", title: "把输入框里的分类加入此卡",
      html: ICON_PLUS,
      onclick: addCatFromInput,
    }, "加入");
    const clearCatBtn = h("button", {
      class: "vpl-btn vpl-btn-sm vpl-chip-clear", title: "清空本卡分类",
      onclick: () => { selCats = []; renderSelCatChips(); catInput.focus(); },
    }, "清空");
    renderSelCatChips();

    // 分类库（库级自定义建议）：点击加入此卡、× 从库删除
    const catPaletteChips = h("div", { class: "vpl-chip-list" });
    function renderCatPalette() {
      catPaletteChips.innerHTML = "";
      pal.categories.forEach((c) => {
        const chip = h("span", { class: "vpl-chip vpl-chip-click" }, [
          h("span", {
            title: "点击加入此卡",
            onclick: () => { if (!selCats.includes(c)) { selCats.push(c); renderSelCatChips(); } },
          }, c),
          h("span", {
            class: "vpl-chip-x", title: "从库删除该分类建议",
            onclick: (e) => {
              e.stopPropagation();
              const i = pal.categories.indexOf(c);
              if (i >= 0) pal.categories.splice(i, 1);
              [...catDatalist.children].forEach((o) => { if (o.value === c) o.remove(); });
              renderCatPalette();
            },
          }, "×"),
        ]);
        catPaletteChips.appendChild(chip);
      });
    }
    renderCatPalette();

    // 颜色：预设 + 取色器 + “＋ 加入自定义”
    const colorPicker = h("input", {
      type: "color", class: "vpl-color-picker",
      value: /^#[0-9a-fA-F]{6}$/.test(data.color || "") ? data.color : COLOR_PRESETS[0],
    });
    const colorItems = [];
    function highlightColor() {
      colorItems.forEach((i) => i.classList.toggle("active", i.dataset.color === data.color));
    }
    function renderColorRow() {
      const all = [...new Set([...COLOR_PRESETS, ...pal.colors])];
      colorRow.innerHTML = "";
      colorItems.length = 0;
      // 无颜色项：点击后 data.color = ""（节点不渲染色条）
      const noneItem = h("div", {
        class: "vpl-color-item vpl-color-none" + (data.color === "" ? " active" : ""),
        title: "无颜色（不标记）",
        onclick: () => { data.color = ""; highlightColor(); },
      });
      noneItem.dataset.color = "";
      colorItems.push(noneItem);
      colorRow.appendChild(noneItem);
      all.forEach((c) => {
        const isCustom = pal.colors.includes(c);
        const item = h("div", {
          class: "vpl-color-item" + (c === data.color ? " active" : ""),
          style: `background:${c}`, "data-color": c, title: c,
          onclick: () => { data.color = c; highlightColor(); colorPicker.value = c; },
        });
        if (isCustom) {
          item.appendChild(h("span", {
            class: "vpl-color-x", title: "从库删除该颜色",
            onclick: (e) => {
              e.stopPropagation();
              const i = pal.colors.indexOf(c);
              if (i >= 0) pal.colors.splice(i, 1);
              renderColorRow();
            },
          }, "×"));
        }
        colorItems.push(item);
        colorRow.appendChild(item);
      });
      colorRow.appendChild(colorPicker);
      colorRow.appendChild(h("button", {
        class: "vpl-btn vpl-btn-sm vpl-chip-add", title: "把当前取色器颜色加入自定义",
        html: ICON_PLUS,
        onclick: () => {
          const v = colorPicker.value;
          if (v && !pal.colors.includes(v)) { pal.colors.push(v); renderColorRow(); }
        },
      }, "加入"));
      colorRow.appendChild(h("button", {
        class: "vpl-btn vpl-btn-sm vpl-chip-add", title: "随机换一个颜色（全色相真随机）",
        html: ICON_DICE,
        onclick: () => {
          data.color = randomColor();
          highlightColor();
          colorPicker.value = data.color;
        },
      }, "随机"));
    }
    const colorRow = h("div", { class: "vpl-color-row" });
    colorPicker.addEventListener("input", () => { data.color = colorPicker.value; highlightColor(); });
    renderColorRow();

    const noteInput = h("input", {
      type: "text", class: "vpl-input", placeholder: "备注（可选，仅自己可见）",
      value: data.note || "",
    });

    const positiveInput = h("textarea", {
      class: "vpl-textarea vpl-textarea-lg",
      placeholder: "正向提示词（一大段视频提示词贴这里）",
    });
    positiveInput.value = data.positive || "";

    const negativeInput = h("textarea", {
      class: "vpl-textarea",
      placeholder: "负向提示词（可选，不需要就留空）",
    });
    negativeInput.value = data.negative || "";

    // 正向提示词标签行：复制/粘贴整段内容（按钮 hover 浮现；flash 反馈成败）
    function flash(btn, cls = "vpl-flash-ok") {
      btn.classList.add(cls);
      setTimeout(() => btn.classList.remove(cls), 900);
    }
    const copyPosBtn = h("button", {
      class: "vpl-icon-btn", title: "复制正向提示词", html: ICON_COPY,
      onclick: async () => {
        if (await copyToClipboard(positiveInput.value)) flash(copyPosBtn);
        else flash(copyPosBtn, "vpl-flash-fail"); // 写剪贴板失败（非安全源等）给红闪提示
      },
    });
    const pastePosBtn = h("button", {
      class: "vpl-icon-btn", title: "用剪贴板内容替换正向提示词", html: ICON_PASTE,
      onclick: async () => {
        const t = await readClipboard();
        if (t) { positiveInput.value = t; flash(pastePosBtn); }
        else positiveInput.focus(); // 浏览器不允许读剪贴板时退回手动 Ctrl+V
      },
    });

    // v3.35：属性标签（#名称#）——点击插入到正向提示词光标处；值在节点面板「变量」行填
    function insertAttrTag(name) {
      const tag = "#" + name + "#";
      const v = positiveInput.value;
      const s = positiveInput.selectionStart ?? v.length;
      const e = positiveInput.selectionEnd ?? s;
      positiveInput.value = v.slice(0, s) + tag + v.slice(e);
      positiveInput.focus();
      positiveInput.selectionStart = positiveInput.selectionEnd = s + tag.length;
    }
    const attrInput = h("input", {
      type: "text", class: "vpl-input vpl-input-sm", placeholder: "新属性名（如：性别）",
    });
    function addAttrFromInput() {
      const name = attrInput.value.trim().replace(/^#+|#+$/g, "");
      if (name && !pal.attributes.includes(name)) {
        pal.attributes.push(name);
        insertAttrTag(name);
        renderAttrPalette();
      }
      attrInput.value = "";
    }
    attrInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addAttrFromInput(); }
    });
    const attrPaletteChips = h("div", { class: "vpl-chip-list" });
    function renderAttrPalette() {
      attrPaletteChips.innerHTML = "";
      if (!pal.attributes.length) {
        attrPaletteChips.appendChild(h("span", { class: "vpl-palette-hint" },
          "还没有属性。输入名字回车即可插入 #名字# 并记住它。"));
        return;
      }
      pal.attributes.forEach((name) => {
        attrPaletteChips.appendChild(h("span", { class: "vpl-chip vpl-chip-click" }, [
          h("span", { title: "点击插入到正向提示词光标处", onclick: () => insertAttrTag(name) }, "#" + name + "#"),
          h("span", {
            class: "vpl-chip-x", title: "从建议删除（不影响已写进文本的标签）",
            onclick: (e) => {
              e.stopPropagation();
              const i = pal.attributes.indexOf(name);
              if (i >= 0) pal.attributes.splice(i, 1);
              renderAttrPalette();
            },
          }, "×"),
        ]));
      });
    }
    renderAttrPalette();

    const weightInput = h("input", {
      type: "number", class: "vpl-input vpl-input-sm",
      min: "0", max: "2", step: "0.1", value: String(data.weight ?? 1.0),
    });
    const prefixInput = h("input", {
      type: "text", class: "vpl-input", placeholder: "前缀（可选）", value: data.prefix || "",
    });
    const suffixInput = h("input", {
      type: "text", class: "vpl-input", placeholder: "后缀（可选）", value: data.suffix || "",
    });

    // 标签：chip 编辑器 + 自定义建议
    const tagListId = "vpl-tag-" + uidSuffix;
    const tagInput = h("input", {
      type: "text", class: "vpl-input", list: tagListId,
      placeholder: "输入标签后回车添加（可选）",
    });
    const tagDatalist = h("datalist", { id: tagListId },
      pal.tags.map((t) => h("option", { value: t })));
    const tagChips = h("div", { class: "vpl-chip-list" });
    let curTags = [...(data.tags || [])];
    function renderTagChips() {
      tagChips.innerHTML = "";
      curTags.forEach((t, i) => {
        tagChips.appendChild(h("span", { class: "vpl-chip vpl-chip-removable" }, [
          t,
          h("span", {
            class: "vpl-chip-x", title: "移除标签",
            onclick: () => { curTags.splice(i, 1); renderTagChips(); },
          }, "×"),
        ]));
      });
    }
    function addTagFromInput() {
      const v = tagInput.value.trim().replace(/,+$/, "").trim();
      if (v && !curTags.includes(v)) {
        curTags.push(v);
        if (!pal.tags.includes(v)) {
          pal.tags.push(v);
          tagDatalist.appendChild(h("option", { value: v }));
        }
        renderTagChips();
        renderTagPalette();
      }
      tagInput.value = "";
    }
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTagFromInput(); }
      else if (e.key === "Backspace" && !tagInput.value && curTags.length) {
        curTags.pop(); renderTagChips();
      }
    });
    renderTagChips();

    // 标签库（库级自定义建议）：点击加入此卡、× 从库删除
    const tagPaletteChips = h("div", { class: "vpl-chip-list" });
    function renderTagPalette() {
      tagPaletteChips.innerHTML = "";
      pal.tags.forEach((t) => {
        const chip = h("span", { class: "vpl-chip vpl-chip-click" }, [
          h("span", {
            title: "点击加入此卡",
            onclick: () => { if (!curTags.includes(t)) { curTags.push(t); renderTagChips(); } },
          }, t),
          h("span", {
            class: "vpl-chip-x", title: "从库删除该标签建议",
            onclick: (e) => {
              e.stopPropagation();
              const i = pal.tags.indexOf(t);
              if (i >= 0) pal.tags.splice(i, 1);
              [...tagDatalist.children].forEach((o) => { if (o.value === t) o.remove(); });
              renderTagPalette();
            },
          }, "×"),
        ]);
        tagPaletteChips.appendChild(chip);
      });
    }
    renderTagPalette();

    function field(label, input, hint) {
      return h("div", { class: "vpl-field" }, [
        h("label", { class: "vpl-label" }, [label, hint ? h("span", { class: "vpl-hint" }, hint) : null]),
        input,
      ]);
    }

    const form = h("form", { class: "vpl-form", id: "vpl-form-" + uidSuffix }, [
      field("名称", nameInput),
      h("div", { class: "vpl-field" }, [
        h("label", { class: "vpl-label" }, "分类（可多选）"),
        h("div", { class: "vpl-row vpl-row-tight" }, [catInput, clearCatBtn, addCatBtn]),
        catDatalist,
        selCatChips,
        h("div", { class: "vpl-palette-hint" }, "分类库（点击加入此卡 · × 删除建议）"),
        catPaletteChips,
      ]),
      field("颜色标记", colorRow),
      field("备注", noteInput),
      h("div", { class: "vpl-field" }, [
        h("label", { class: "vpl-label" }, [
          "属性标签",
          h("span", { class: "vpl-hint" }, "（#名字# 占位，值在节点面板「变量」行填；输出时自动替换）"),
        ]),
        h("div", { class: "vpl-row vpl-row-tight" }, [attrInput]),
        attrPaletteChips,
      ]),
      h("div", { class: "vpl-field" }, [
        h("label", { class: "vpl-label" }, [
          "正向提示词",
          h("span", { class: "vpl-hint" }, "（{a|b|c} 随机选一；#名字# / {名字:男|女} 在节点面板固定取值）"),
          h("span", { class: "vpl-label-actions" }, [copyPosBtn, pastePosBtn]),
        ]),
        positiveInput,
      ]),
      field("负向提示词", negativeInput),
      h("div", { class: "vpl-field-row" }, [
        h("div", { class: "vpl-field vpl-field-grow" }, [
          h("label", { class: "vpl-label" }, "权重"),
          weightInput,
        ]),
        h("div", { class: "vpl-field vpl-field-grow" }, [
          h("label", { class: "vpl-label" }, "前缀"),
          prefixInput,
        ]),
        h("div", { class: "vpl-field vpl-field-grow" }, [
          h("label", { class: "vpl-label" }, "后缀"),
          suffixInput,
        ]),
      ]),
      h("div", { class: "vpl-field" }, [
        h("label", { class: "vpl-label" }, "标签"),
        tagInput,
        tagDatalist,
        tagChips,
        h("div", { class: "vpl-palette-hint" }, "标签库（点击加入此卡 · × 删除建议）"),
        tagPaletteChips,
      ]),
    ]);

    // ---- 底部按钮 ----
    function saveEditor() {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        nameInput.classList.add("vpl-input-error");
        return;
      }
      data.name = name;
      data.categories = selCats;
      delete data.category;
      data.note = noteInput.value.trim();
      data.positive = positiveInput.value;
      data.negative = negativeInput.value;
      const w = parseFloat(weightInput.value);
      data.weight = isNaN(w) ? 1.0 : w; // 不能用 || 1.0：合法的 0 会被吞成 1
      data.prefix = prefixInput.value;
      data.suffix = suffixInput.value;
      data.tags = curTags;
      data.color = data.color || ""; // 允许空字符串（无颜色）
      close({ group: data, meta: pal });
    }
    // v3.7：键盘流——Enter 在单行 input 内提交；textarea 不触发；标签输入回车已拦截加 tag
    form.addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
    const saveBtn = h("button", {
      type: "submit", class: "vpl-btn vpl-btn-primary",
      form: "vpl-form-" + uidSuffix, // footer 在 form 外，靠 form 属性关联保持 Enter 提交
    }, "保存");
    const cancelBtn = h("button", { class: "vpl-btn", onclick: () => close(null) }, "取消");

    const footer = h("div", { class: "vpl-dialog-footer" }, [cancelBtn, saveBtn]);

    // v3.33：footer 挂 dialog 直属（body flex:1 滚动），固定悬浮在弹窗底部不随内容滚动
    dialog.appendChild(title);
    dialog.appendChild(h("div", { class: "vpl-dialog-body" }, [form]));
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);

    nameInput.addEventListener("input", () => nameInput.classList.remove("vpl-input-error"));
    setTimeout(() => nameInput.focus(), 50);

    function close(result) {
      overlay.remove();
      resolve(result);
    }
  });
}
