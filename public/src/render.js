/**
 * 视图层：看板骨架只构建一次，之后按 id 复用卡片节点。
 *
 * 为什么不用 board.innerHTML 全量重建：
 *   每次重建都会销毁并重新创建全部卡片 DOM，卡片一多就会出现闪烁、
 *   滚动位置跳动、输入框失焦、展开状态需要额外恢复等问题。
 *   改为按 id 复用后，排序变化只做 DOM 移动，内容变化只重写那一张卡片。
 */
import { state } from './state.js';
import { filteredIssues, hasActiveFilters } from './filters.js';
import { esc, fmtDateTime, dueInfo } from './utils.js';
import { STATUSES, STATUS_LABELS, PRIORITY_LABELS } from '/shared/constants.js';

const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const colTabs = $('#colTabs');

const COL_ACCENT = {
  backlog: 'var(--c-backlog)',
  planning: 'var(--c-planning)',
  in_progress: 'var(--c-in_progress)',
  done: 'var(--c-done)',
  failed: 'var(--c-failed)',
};

/** @type {Map<number, HTMLElement>} id -> 卡片节点 */
const cardNodes = new Map();
/** @type {Map<number, string>} id -> 上次渲染时的数据签名 */
const cardSigs = new Map();

/** 数据签名：只有签名变化才重写卡片内部 HTML */
function cardSignature(issue) {
  return JSON.stringify([
    issue.title,
    issue.description,
    issue.priority,
    issue.assignee,
    issue.dueDate,
    issue.status,
    issue.tags,
    issue.logs.length,
    state.expanded.has(issue.id),
  ]);
}

function logItemHtml(log) {
  const fromLabel = log.fromStatus ? STATUS_LABELS[log.fromStatus] : '新建';
  const toLabel = STATUS_LABELS[log.toStatus] || log.toStatus;
  const reasonHtml = log.reason
    ? `<div class="log-reason">失败原因：${esc(log.reason)}</div>`
    : '';
  return `
    <div class="log-item" data-to="${esc(log.toStatus)}">
      <span class="log-bar"></span>
      <div>
        <div class="log-main">${esc(fromLabel)} → ${esc(toLabel)}</div>
        <div class="log-at">${esc(fmtDateTime(log.changedAt))}</div>
      </div>
    </div>`;
}

function cardInnerHtml(issue) {
  const isOpen = state.expanded.has(issue.id);
  const { text: dueText, cls: dueClass } = dueInfo(issue);

  const tagsHtml = issue.tags
    .map((t) => `<span class="chip tag"># ${esc(t)}</span>`)
    .join('');

  const logsHtml = [...issue.logs].reverse().map(logItemHtml).join('');

  return `
    <h3 class="card-title">${esc(issue.title)}</h3>
    ${issue.description ? `<p class="card-desc">${esc(issue.description)}</p>` : ''}
    <div class="card-meta">
      <span class="chip prio-${esc(issue.priority)}">${esc(PRIORITY_LABELS[issue.priority])}优先级</span>
      <span class="chip">${esc(issue.assignee || '未指派')}</span>
      <span class="chip due${dueClass}">${esc(dueText)}</span>
      ${tagsHtml}
    </div>
    <div class="card-foot">
      <span class="card-time">创建于 ${esc(fmtDateTime(issue.createdAt))}</span>
      <div class="card-actions">
        <button class="log-toggle${isOpen ? ' open' : ''}" type="button" data-act="logs" data-id="${issue.id}">
          变更 ${issue.logs.length}
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <button class="icon-btn" type="button" data-act="edit" data-id="${issue.id}" aria-label="编辑">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="icon-btn" type="button" data-act="delete" data-id="${issue.id}" aria-label="删除">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>
    </div>
    <div class="log-list${isOpen ? ' open' : ''}">${logsHtml || '<div class="log-from">暂无记录</div>'}</div>`;
}

/** 构建五列骨架，整个生命周期只执行一次 */
export function buildSkeleton() {
  if (board.dataset.ready === '1') return;

  board.innerHTML = STATUSES.map((status) => {
    const isFail = status === 'failed';
    return `
      <section class="column${isFail ? ' is-fail' : ''}"
               data-status="${status}"
               style="--accent:${COL_ACCENT[status]}">
        <header class="col-head">
          <span class="col-dot"></span>
          <span class="col-title">${esc(STATUS_LABELS[status])}</span>
          <span class="col-count">0/0</span>
        </header>
        <div class="col-body"></div>
      </section>`;
  }).join('');

  board.dataset.ready = '1';
}

/** 增量更新：只改动必要的 DOM */
export function renderBoard() {
  buildSkeleton();

  const filtered = filteredIssues();
  const active = hasActiveFilters();
  const visible = new Set(filtered.map((i) => i.id));

  // 1) 移除已不可见的卡片（被删除或被筛选掉）
  for (const [id, node] of cardNodes) {
    if (!visible.has(id)) {
      node.remove();
      cardNodes.delete(id);
      cardSigs.delete(id);
    }
  }

  // 2) 逐列定位与更新
  for (const status of STATUSES) {
    const col = board.querySelector(`.column[data-status="${status}"]`);
    const colBody = col.querySelector('.col-body');
    const all = state.issues.filter((i) => i.status === status);
    const shown = filtered.filter((i) => i.status === status);

    const countEl = col.querySelector('.col-count');
    countEl.textContent = `${shown.length}/${all.length}`;
    countEl.classList.toggle('filtered', active);

    let prev = null;
    for (const issue of shown) {
      let node = cardNodes.get(issue.id);
      if (!node) {
        node = document.createElement('article');
        node.className = 'card';
        node.draggable = true;
        node.dataset.id = String(issue.id);
        cardNodes.set(issue.id, node);
      }

      const sig = cardSignature(issue);
      if (cardSigs.get(issue.id) !== sig) {
        node.dataset.priority = issue.priority;
        node.innerHTML = cardInnerHtml(issue);
        cardSigs.set(issue.id, sig);
      }

      // 仅在位置不正确时移动节点，避免无谓重排
      const expected = prev ? prev.nextElementSibling : colBody.firstElementChild;
      if (expected !== node) colBody.insertBefore(node, expected);
      prev = node;
    }

    // 3) 空状态
    const emptyEl = colBody.querySelector('.col-empty');
    if (!shown.length) {
      const text = all.length ? '无匹配任务' : '暂无任务';
      if (emptyEl) emptyEl.textContent = text;
      else {
        const div = document.createElement('div');
        div.className = 'col-empty';
        div.textContent = text;
        colBody.appendChild(div);
      }
    } else if (emptyEl) {
      emptyEl.remove();
    }
  }

  renderTabs();
}

/** 移动端列切换标签 */
export function renderTabs() {
  const filtered = filteredIssues();
  colTabs.innerHTML = STATUSES.map((status) => {
    const all = state.issues.filter((i) => i.status === status);
    const shown = filtered.filter((i) => i.status === status);
    const active = status === state.activeTab ? ' active' : '';
    return `
      <button class="col-tab${active}" type="button" data-status="${status}">
        ${esc(STATUS_LABELS[status])}
        <span class="tab-count">${shown.length}/${all.length}</span>
      </button>`;
  }).join('');
}

/** 让「负责人」输入框复用已有负责人名单 */
export function syncAssigneeList() {
  const names = [...new Set(state.issues.map((i) => i.assignee).filter(Boolean))].sort();
  $('#assigneeList').innerHTML = names
    .map((n) => `<option value="${esc(n)}"></option>`)
    .join('');
}
