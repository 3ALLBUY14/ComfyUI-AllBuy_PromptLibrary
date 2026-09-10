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
