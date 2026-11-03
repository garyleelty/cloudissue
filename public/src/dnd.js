/**
 * 拖拽层：跨列移动与列内排序。
 *
 * 两套输入并存：
 *   · 鼠标 —— 走浏览器原生 HTML5 DnD（dragstart / drop）；
 *   · 触屏与触控笔 —— Pointer Events 长按激活（HTML5 DnD 在触屏上不被支持）。
 *   两条路径最终汇到同一个 performMove，不再各写一份落位逻辑。
 *
 * 依赖注入说明：initDnd 接收 onChanged 回调，而不是直接 import 视图模块，
 * 这样「拖拽 → 数据 → 重绘」是单向的，不会出现拖拽与渲染互相依赖的环。
 *
 * 落位后先乐观更新本地状态（即时反馈），再提交服务端；
 * 失败则用快照回滚，并由 onChanged 重新拉取服务端数据兜底。
 */
import { state, notify } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { askFailureReason } from './modals.js';
import { FAIL_STATUS, STATUS_LABELS, MSG_MOVE_CANCELLED_NO_REASON } from '../../shared/constants.js';

const board = document.querySelector('#board');

const placeholder = document.createElement('div');
placeholder.className = 'placeholder';

/** @type {() => Promise<void>} */
let onChanged = async () => {};

/** 清理所有拖拽痕迹（HTML5 与触屏两条路径共用） */
export function clearDragState() {
  board.querySelectorAll('.column').forEach((c) => {
    c.classList.remove('drag-over', 'drag-invalid');
  });
  placeholder.remove();
  board.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
  state.drag = null;
  resetTouch();
}

/** 根据指针纵坐标把占位块插到合适位置 */
function updatePlaceholder(colBody, y) {
  const cards = [...colBody.querySelectorAll('.card')].filter((c) => !c.classList.contains('dragging'));

  let ref = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      ref = c;
      break;
    }
  }

  if (ref) colBody.insertBefore(placeholder, ref);
  else colBody.appendChild(placeholder);

  const isFail = Boolean(colBody.closest('.column')?.classList.contains('is-fail'));
  placeholder.classList.toggle('is-fail', isFail);
}

/** 占位块前最近的卡片 id 即 afterId；没有则表示插到列首 */
function afterIdFromPlaceholder() {
  let prev = placeholder.previousElementSibling;
  while (prev && !prev.classList.contains('card')) prev = prev.previousElementSibling;
  return prev ? Number(prev.dataset.id) : null;
}

/**
 * 造一份回滚快照。
 * 只浅拷贝卡片本身即可：乐观更新只改 status 与数组顺序，
 * 不会动 logs / tags，所以不存在共享引用被写坏的问题。
 * @returns {any[]}
 */
function snapshotIssues() {
  return state.issues.map((i) => ({ ...i }));
}

/**
 * 乐观应用一次移动：立刻改本地状态并重绘，不等服务端往返。
 *
 * 排序语义与服务端保持一致：state.issues 的全局顺序只在「同一 status 分组内」
 * 有意义（render.js 逐列 filter），所以只要把卡片插到 afterId 之后即可；
 * afterId 为空则插到目标列之首。
 *
 * @param {number} id
 * @param {string} toStatus
 * @param {number | null} afterId
 * @returns {any[] | null} 回滚快照；卡片不存在时返回 null
 */
export function applyMoveOptimistic(id, toStatus, afterId) {
  const moving = state.issues.find((i) => i.id === id);
  if (!moving) return null;

  const snapshot = snapshotIssues();
  const rest = state.issues.filter((i) => i.id !== id);

  let at = -1;
  if (afterId == null) {
    at = rest.findIndex((i) => i.status === toStatus);
  } else {
    const afterIdx = rest.findIndex((i) => i.id === afterId);
    at = afterIdx >= 0 ? afterIdx + 1 : -1;
  }

  if (at < 0) rest.push({ ...moving, status: toStatus });
  else rest.splice(at, 0, { ...moving, status: toStatus });

  state.issues = rest;
  notify();
  return snapshot;
}

async function performMove(drag, toStatus, afterId) {
  const issue = state.issues.find((i) => i.id === drag.id);
  if (!issue) return;

  let failReason = '';
  const needsReason = toStatus === FAIL_STATUS && drag.fromStatus !== FAIL_STATUS;

  // 原因闸门在乐观更新之前：拿不到原因就不该产生任何本地变化
  if (needsReason) {
    const reason = await askFailureReason(issue);
    if (!reason) {
      toast(MSG_MOVE_CANCELLED_NO_REASON, 'error');
      return;
    }
    failReason = reason;
  }

  const snapshot = applyMoveOptimistic(drag.id, toStatus, afterId);

  try {
    await api.move(drag.id, {
      toStatus,
      afterId,
      failReason,
      // 乐观锁：带上手上这份版本号，被别人先动过则由服务端拒绝
      expectedVersion: issue.version,
    });
    toast(`已移动到「${STATUS_LABELS[toStatus]}」`, 'success');
  } catch (err) {
    // 先用快照即时回滚，再靠 finally 拉一次服务端数据兜底，
    // 避免并发移动时把别人已提交的改动一起回滚掉
    if (snapshot) {
      state.issues = snapshot;
      notify();
    }
    toast(err.message, 'error');
  } finally {
    await onChanged();
  }
}

// ------------------------------------------------------------------
// 触屏 / 触控笔拖拽（Pointer Events）
//
// HTML5 DnD 在触屏浏览器上完全不可用，所以这里另开一条路径：
// 长按 220ms 激活拖拽（短按与滑动仍然是滚动，互不干扰），
// 之后手指移动时移动占位块，靠近左右边缘自动横向滚动以便跨列。
// 落位后交给与鼠标同一套 performMove，保证行为一致。
// ------------------------------------------------------------------
const TOUCH_HOLD_MS = 220; // 长按激活阈值
const TOUCH_SLOP = 8; // 激活前的移动容差，超出即判定为页面滚动
const EDGE_ZONE = 64; // 触发自动滚动的边缘宽度
const EDGE_STEP = 18; // 每次自动滚动的像素

/** @type {{ card: HTMLElement, id: number, fromStatus: string, startX: number, startY: number, x: number, y: number, active: boolean, timer: any } | null} */
let touchSession = null;
let edgeDir = 0;
let autoScrollRaf = 0;

// 浏览器里用 rAF；Node / jsdom 下退回定时器，保持同一套动画节奏
const raf = (fn) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16);
const caf = (handle) => {
  if (!handle) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
};

/** 是否正处于触屏拖拽中（供测试与状态判断使用） */
export function isTouchDragging() {
  return Boolean(touchSession?.active);
}

/** 拖拽期间吞掉原生滚动，否则手指一动页面就跟着滑走 */
function blockScroll(e) {
  if (e.cancelable) e.preventDefault();
}

function resetTouch() {
  if (!touchSession) return;
  clearTimeout(touchSession.timer);
  document.removeEventListener('touchmove', blockScroll);
  board.classList.remove('touch-dragging');
  touchSession = null;
  edgeDir = 0;
  if (autoScrollRaf) {
    caf(autoScrollRaf);
    autoScrollRaf = 0;
  }
}

/**
 * 命中手指下的列。优先用 elementFromPoint（能正确处理覆盖层与卡片），
 * 缺失时退化为按列矩形判定，保证在测试环境里也可用。
 */
function columnFromPoint(x, y) {
  if (typeof document.elementFromPoint === 'function') {
    try {
      const hit = document.elementFromPoint(x, y);
      const col = hit && hit.closest ? hit.closest('.column') : null;
      if (col) return col;
    } catch {
      /* 某些环境未实现该方法，走下面的几何兜底 */
    }
  }
  for (const col of board.querySelectorAll('.column')) {
    const r = col.getBoundingClientRect();
    if (x >= r.left && x <= r.right) return col;
  }
  return null;
}

/** 手指靠近左右边缘时推动看板横向滚动，便于在单列可视的移动端跨列投放 */
function updateEdgeScroll(x) {
  const r = board.getBoundingClientRect();
  edgeDir = 0;
  if (x < r.left + EDGE_ZONE) edgeDir = -1;
  else if (x > r.right - EDGE_ZONE) edgeDir = 1;
  if (edgeDir && !autoScrollRaf) autoScrollRaf = raf(stepEdgeScroll);
}

function stepEdgeScroll() {
  autoScrollRaf = 0;
  if (!touchSession || !touchSession.active || !edgeDir) return;

  const dx = edgeDir * EDGE_STEP;
  try {
    if (typeof board.scrollBy === 'function') board.scrollBy({ left: dx });
    else board.scrollLeft += dx;
  } catch {
    board.scrollLeft += dx;
  }

  // 滚动后各列位置已改变，用最后已知坐标重新定位占位块
  updateTouchDrag(touchSession.x, touchSession.y);
  if (!autoScrollRaf) autoScrollRaf = raf(stepEdgeScroll);
}

function updateTouchDrag(x, y) {
  const col = columnFromPoint(x, y);
  if (!col) return;
  board.querySelectorAll('.column').forEach((c) => c.classList.toggle('drag-over', c === col));
  updatePlaceholder(col.querySelector('.col-body'), y);
  updateEdgeScroll(x);
}

function beginTouchDrag() {
  if (!touchSession || touchSession.active) return;
  const { card, id, fromStatus } = touchSession;

  touchSession.active = true;
  state.drag = { id, fromStatus };
  card.classList.add('dragging');
  // 移动端看板横向 scroll-snap 会与自动滚动打架，拖拽期间先关掉
  board.classList.add('touch-dragging');
  document.addEventListener('touchmove', blockScroll, { passive: false });
  updateTouchDrag(touchSession.x, touchSession.y);
}

function finishTouchDrop() {
  const col = placeholder.closest('.column');
  const toStatus = col?.dataset.status ?? touchSession.fromStatus;
  const afterId = afterIdFromPlaceholder();
  const drag = state.drag;
  clearDragState();
  if (drag) performMove(drag, toStatus, afterId);
}

/** 触屏拖拽的三个入口挂在 document 上，手指滑出看板也能继续跟踪 */
function bindTouchDnd() {
  board.addEventListener('pointerdown', (e) => {
    // 鼠标交给原生 HTML5 DnD；交互控件（按钮/输入框）不劫持
    if (e.pointerType === 'mouse') return;
    if (e.target.closest('button, a, input, textarea, select')) return;

    const card = e.target.closest('.card');
    if (!card) return;

    touchSession = {
      card,
      id: Number(card.dataset.id),
      fromStatus: card.closest('.column')?.dataset.status,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
      timer: setTimeout(beginTouchDrag, TOUCH_HOLD_MS),
    };
  });

  document.addEventListener('pointermove', (e) => {
    if (!touchSession) return;
    touchSession.x = e.clientX;
    touchSession.y = e.clientY;

    if (!touchSession.active) {
      // 长按未成形就移动 —— 用户想滚动，不当作拖拽
      const moved = Math.hypot(e.clientX - touchSession.startX, e.clientY - touchSession.startY);
      if (moved > TOUCH_SLOP) resetTouch();
      return;
    }

    if (e.cancelable) e.preventDefault();
    updateTouchDrag(e.clientX, e.clientY);
  });

  document.addEventListener('pointerup', () => {
    if (!touchSession) return;
    if (touchSession.active) finishTouchDrop();
    else resetTouch();
  });

  // 系统接管手势（如侧滑返回）时直接放弃本次拖拽
  document.addEventListener('pointercancel', () => {
    if (touchSession) resetTouch();
  });
}

export function initDnd(callbacks = {}) {
  if (callbacks.onChanged) onChanged = callbacks.onChanged;

  // 列级：高亮 / 占位 / 落位
  board.querySelectorAll('.column').forEach((col) => {
    const colBody = col.querySelector('.col-body');

    col.addEventListener('dragenter', (e) => {
      if (!state.drag) return;
      e.preventDefault();
      col.classList.add('drag-over');
      col.classList.remove('drag-invalid');
      updatePlaceholder(colBody, e.clientY);
    });

    col.addEventListener('dragover', (e) => {
      if (!state.drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
      updatePlaceholder(colBody, e.clientY);
    });

    col.addEventListener('dragleave', (e) => {
      if (!state.drag) return;
      if (col.contains(e.relatedTarget)) return; // 指针仍在列内
      col.classList.remove('drag-over', 'drag-invalid');
    });

    col.addEventListener('drop', (e) => {
      if (!state.drag) return;
      e.preventDefault();
      const toStatus = col.dataset.status;
      const afterId = afterIdFromPlaceholder();
      const drag = state.drag;
      clearDragState();
      performMove(drag, toStatus, afterId);
    });
  });

  // 卡片级：拖拽开始 / 结束
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    state.drag = {
      id: Number(card.dataset.id),
      fromStatus: card.closest('.column').dataset.status,
    };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(state.drag.id));
    // 延后一帧再置灰，避免拖拽镜像也被一起变淡
    setTimeout(() => card.classList.add('dragging'), 0);
  });

  board.addEventListener('dragend', () => clearDragState());

  bindTouchDnd();
}
