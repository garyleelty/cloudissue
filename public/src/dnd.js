/**
 * 拖拽层：跨列移动与列内排序。
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
import { FAIL_STATUS, STATUS_LABELS } from '../../shared/constants.js';

const board = document.querySelector('#board');

const placeholder = document.createElement('div');
placeholder.className = 'placeholder';

/** @type {() => Promise<void>} */
let onChanged = async () => {};

/** 清理所有拖拽痕迹 */
export function clearDragState() {
  board.querySelectorAll('.column').forEach((c) => {
    c.classList.remove('drag-over', 'drag-invalid');
  });
  placeholder.remove();
  board.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
  state.drag = null;
}

/** 根据指针纵坐标把占位块插到合适位置 */
function updatePlaceholder(colBody, y) {
  const cards = [...colBody.querySelectorAll('.card')].filter(
    (c) => !c.classList.contains('dragging')
  );

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
      toast('已取消移动：未填写失败原因，任务保留在原列', 'error');
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
}
