/**
 * 站内通知：顶栏铃铛 + 未读徽标 + 通知下拉。
 *
 * 数据流与看板一致：api → state → notify() → 渲染。
 * 未读数轮询挂在 checkHealth 的 30s 周期上（不新增定时器），
 * 写操作经 bumpRevision 触发本页 reload 后顺带刷新（跨标签页同理）。
 */
import { state } from './state.js';
import { api } from './api.js';
import { esc, fmtDateTime } from './utils.js';

const $ = (sel) => document.querySelector(sel);

const TYPE_ICONS = { status: '🔁', assignee: '🙋', comment: '💬' };
const TYPE_LABELS = { status: '流转', assignee: '指派', comment: '评论' };

/** 初始化：绑定铃铛与面板事件（main.js 调用一次） */
export function initNotifications() {
  const root = $('#notifRoot');
  const trigger = root.querySelector('.notif-trigger');
  const panel = $('#notifPanel');

  trigger.addEventListener('click', async (e) => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains('open');
    document.querySelectorAll('.dropdown').forEach((d) => {
      d.querySelector('.drop-trigger')?.setAttribute('aria-expanded', 'false');
      d.querySelector('.drop-panel')?.classList.remove('open');
    });
    if (willOpen) {
      panel.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      await renderPanel();
    }
  });

  panel.addEventListener('click', async (e) => {
    e.stopPropagation();

    // 全部已读
    if (e.target.closest('#notifReadAll')) {
      try {
        await api.readAllNotifications();
        await refreshUnread();
        await renderPanel();
      } catch {
        /* 失败静默：下次轮询会刷新 */
      }
      return;
    }

    // 单条：标记已读并跳转对应看板的 issue
    const item = e.target.closest('[data-notif-id]');
    if (!item) return;
    const { notifId, boardId, issueId } = item.dataset;
    try {
      await api.readNotification(Number(notifId));
      await refreshUnread();
    } catch {
      /* 已读失败不阻断跳转 */
    }
    panel.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    // 跨看板跳转：切到该通知所在看板再打开抽屉
    if (Number(boardId) !== state.currentBoardId) {
      const { switchBoard } = await import('./boards.js');
      if (state.boards.some((b) => b.id === Number(boardId))) await switchBoard(Number(boardId));
    }
    const { openDrawer } = await import('./drawer.js');
    openDrawer(Number(issueId));
  });
}

/** 未读徽标渲染 */
function renderBadge() {
  const badge = $('#notifBadge');
  const n = state.unreadCount ?? 0;
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
}

/** 通知列表面板渲染 */
async function renderPanel() {
  const list = $('#notifList');
  try {
    const data = await api.notifications({ limit: 10 });
    const items = data.notifications ?? [];
    state.unreadCount = data.unreadCount ?? 0;
    renderBadge();
    list.innerHTML = items.length
      ? items
          .map(
            (n) => `
        <button class="notif-item${n.read ? '' : ' unread'}" type="button"
                data-notif-id="${n.id}" data-board-id="${n.boardId}" data-issue-id="${n.issueId}">
          <span class="notif-icon">${TYPE_ICONS[n.type] || '🔔'}</span>
          <span class="notif-body">
            <span class="notif-title">${esc(n.title)}</span>
            <span class="notif-meta">${TYPE_LABELS[n.type] || '通知'} · ${esc(n.actor || '系统')} · ${esc(fmtDateTime(n.createdAt))}</span>
          </span>
          ${n.read ? '' : '<span class="notif-dot" aria-label="未读"></span>'}
        </button>`,
          )
          .join('')
      : '<div class="notif-empty">暂无通知</div>';
  } catch (err) {
    list.innerHTML = `<div class="notif-empty">通知加载失败：${esc(err.message)}</div>`;
  }
}

/** 拉未读数（登录后与轮询时调用）；未登录静默忽略 */
export async function refreshUnread() {
  if (!state.me) return;
  try {
    const data = await api.unreadCount();
    state.unreadCount = data.unreadCount ?? 0;
    renderBadge();
  } catch {
    /* 静默：链路恢复后下个周期会刷新 */
  }
}

/** 登录后显示铃铛；登出隐藏并清零 */
export function showNotifUI(show) {
  $('#notifRoot').hidden = !show;
  if (!show) {
    state.unreadCount = 0;
    renderBadge();
    $('#notifPanel').classList.remove('open');
  }
}

/** 写操作后立即刷新（load() 尾部调用；bumpRevision 已由 api 层触发跨标签页） */
export function refreshNotificationsSoon() {
  if (!state.me) return;
  refreshUnread();
}
