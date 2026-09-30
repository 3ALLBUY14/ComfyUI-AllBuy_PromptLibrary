// 面板守护：旁路(mute/bypass)视觉同步 + 执行期间锁定（v3.51）
//   - installBypassSync：节点被 Ctrl+M 静音 / 旁路时，DOM 面板同步变暗（画布只画框架，
//     DOM 层不参与 LiteGraph 的 mute 绘制，需要自己每帧同步 node.mode）。
//   - installExecutionLock：队列执行本节点期间面板只读，底部浮出状态条；
//     「解锁」按钮可强制本次执行期间恢复可编辑（下次执行重新上锁）。
import { api } from "../../scripts/api.js";

const MODE_NEVER = 2;   // LiteGraph 静音
const MODE_BYPASS = 4;  // ComfyUI 旁路

export function installBypassSync(node, container) {
  if (!node || !container) return;
  // 每帧绘制时同步（onDrawForeground 在节点每次重绘时调用，classList.toggle 幂等且廉价）
  const orig = node.onDrawForeground;
  node.onDrawForeground = function () {
    const r = orig ? orig.apply(this, arguments) : undefined;
    const off = this.mode === MODE_NEVER || this.mode === MODE_BYPASS;
    container.classList.toggle("vpl-bypassed", off);
    return r;
  };
  // 工作流加载时节点可能已是旁路态，先同步一次
  container.classList.toggle("vpl-bypassed", node.mode === MODE_NEVER || node.mode === MODE_BYPASS);
}

export function installExecutionLock(node, container) {
  if (!node || !container) return;

  const text = document.createElement("span");
  text.className = "vpl-exec-bar-text";
  const spin = document.createElement("span");
  spin.className = "vpl-exec-bar-spin";
  const unlockBtn = document.createElement("button");
  unlockBtn.type = "button";
  unlockBtn.className = "vpl-exec-bar-unlock";
  unlockBtn.textContent = "解锁编辑";
  unlockBtn.title = "本次执行期间恢复面板可编辑（改动对正在执行的一批不生效）";

  const bar = document.createElement("div");
  bar.className = "vpl-exec-bar";
  bar.appendChild(spin);
  bar.appendChild(text);
  bar.appendChild(unlockBtn);
  container.appendChild(bar);

  let forcedUnlock = false; // 用户手动解锁后，本次执行内不再自动上锁
  const lock = () => {
    if (forcedUnlock) return;
    text.textContent = "执行中 · 本次输出已固定";
    container.classList.add("vpl-locked");
  };
  const unlock = () => container.classList.remove("vpl-locked");
  const nodeMatches = (e) => {
    const d = e && e.detail;
    if (!d) return false;
    return String(d.node) === String(node.id) || String(d.node_id) === String(node.id);
  };

  const handlers = [];
  const on = (ev, fn) => {
    try {
      api.addEventListener(ev, fn);
      handlers.push([ev, fn]);
    } catch (e) { /* 事件接口不可用时静默降级：仅失去锁定能力 */ }
  };

  on("execution_start", (e) => { if (nodeMatches(e)) { forcedUnlock = false; lock(); } });
  on("executed", (e) => { if (nodeMatches(e)) unlock(); });
  on("execution_error", (e) => { if (!e || !e.detail || nodeMatches(e)) unlock(); });
  on("execution_interrupted", () => unlock());
  on("execution_success", () => unlock());

  // 节点删除时摘掉 api 事件监听：工作流重载后节点 id 复用时，残留监听会
  // 误命中新节点并把已删除节点的容器标记为锁定态（v3.58）
  const _origOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    _origOnRemoved?.apply(this, arguments);
    for (const [ev, fn] of handlers) {
      try { api.removeEventListener(ev, fn); } catch (e) { /* ignore */ }
    }
    handlers.length = 0;
  };

  unlockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    forcedUnlock = true;
    unlock();
  });
}

// ---------------------------------------------------------------------------
// 填充式高度（v3.109）：拖高节点 → 面板跟满；拖矮 → 钳到内容下限。
// 文本框/LoRA堆栈/批量选图/素材加载/主库/随机抽卡共用。几何链实测（前端 1.53.6）：
//   DOM 锚点顶 = domWidget.y + 10；目标元素顶 = 锚点顶 + 其 offsetTop
//   （offsetParent 是锚点或容器顶时成立，offsetTop 不受画布缩放 transform 影响）；
//   margin 取各节点自动模式既有的底缝（面板卡 18 / 容器 8），填充与自动外观一致。
// ---------------------------------------------------------------------------

// 把 el 填到节点当前高度（vpl-fill 类供 CSS 放宽内部滚动区上限）
export function applyFillPanel(node, el, chromeY, margin) {
  if (!el?.isConnected || el.getBoundingClientRect().height === 0) return; // 远缩放/离屏被剔除时不动
  const top = (chromeY || 0) + 10 + (el.offsetTop || 0);
  el.style.height = Math.max(0, Math.round((node.size?.[1] || 0) - top - (margin ?? 18))) + "px";
  el.classList.add("vpl-fill");
}

export function clearFillPanel(el) {
  if (!el) return;
  el.style.height = "";
  el.classList.remove("vpl-fill");
}

// 拖高/拖矮跟随（v3.115 重构）：新前端有两条改尺寸的路径——
//   ① node.setSize()（程序化/工作流载入）：方法体自带 onResize 回调；
//   ② 画布拖拽（Canvas 来源）：直接写 size 数组元素 → 布局存储，【实测一次都不回调
//      onResize，也不触发 RO】——挂 onResize 的钳制/填充对真实拖拽全部失效，节点
//      变矮而面板保留旧填充高度冲出节点框（"拉小了底栏卡片叠没"的根因）。
// 解法：onResize 照挂（①路径零延迟），另挂 onDrawBackground 每帧轮询补②——
// 高度与上次应用值一致时只做一次数字比较（零 DOM 访问），有变化才走完整逻辑。
// 拖拽停稳后（180ms 无新变化）回调 opts.onSettled 做一次重校准：拖拽中用的下限
// 可能是旧内容量出来的，松手后按最新内容回弹。
export function installFillResize(node, opts) {
  const orig = node.onResize;
  const origDraw = node.onDrawBackground;
  let settleTimer = 0;
  let lastAppliedH = NaN;

  const apply = (n) => {
    const el = opts.el();
    if (!el?.isConnected || el.getBoundingClientRect().height === 0) return; // 远缩放/离屏被剔除时不动
    const floor = opts.floor ? opts.floor() : 0;
    if (!floor) return; // 内容下限未就绪（recalc 未跑过/rAF 冻结）：不做也不记 lastAppliedH，
                        // 否则轮询把这个高度当成"已处理"，缓存就绪后永远跳过（no-op 吞掉修复）
    if ((n.size?.[1] || 0) < floor) {
      n.setSize([n.size?.[0] || opts.minWidth || n.size?.[0], floor]);
    }
    const h = n.size?.[1] || 0;
    if (h > floor + 1) {
      applyFillPanel(n, el, opts.chrome(), opts.margin ?? 18);
    } else if (el.classList.contains("vpl-fill")) {
      clearFillPanel(el);
    }
    lastAppliedH = n.size?.[1] || 0;
    if (opts.onSettled) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { if (opts.el()?.isConnected) opts.onSettled(); }, 180);
    }
  };

  node.onResize = function () {
    orig?.apply(this, arguments);
    apply(this);
  };
  // 画布拖拽路径的补位轮询：绘制帧必达，只比较高度数字，一致即返回
  node.onDrawBackground = function () {
    origDraw?.apply(this, arguments);
    const h = this.size?.[1] || 0;
    if (h === lastAppliedH) return;
    apply(this);
  };
  // 初值：让首个绘制帧先跑一次 apply（填充/清除到当前真实高度）
  lastAppliedH = NaN;
}


// ---------------------------------------------------------------------------
// 右下角悬停浮出（v3.122）：光标进入 host 元素右下 170×46 热区→corner 加 .show，
// 离开/移出→隐藏。挂 document 级（host 容器常是 pointer-events:none 的穿透层，
// 自身收不到 mousemove）；host 被剔除（rect 0）或摘除 DOM 时自动跳过。
// 返回卸载函数（节点 onRemoved 时调用）。
// ---------------------------------------------------------------------------
export function installCornerHover(host, corner) {
  const onMove = (e) => {
    if (!host.isConnected) { corner.classList.remove("show"); return; }
    const r = host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { corner.classList.remove("show"); return; } // 远缩放/离屏剔除
    const near = e.clientX >= r.left && e.clientY >= r.top
      && (r.right - e.clientX) < 170 && (r.bottom - e.clientY) < 46;
    corner.classList.toggle("show", near || corner.matches(":hover"));
  };
  document.addEventListener("mousemove", onMove, { passive: true });
  return () => {
    document.removeEventListener("mousemove", onMove);
    corner.classList.remove("show");
  };
}
