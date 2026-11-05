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
import { myRole } from './boards.js';
import { laneKeyOf, laneTitleOf } from '../../shared/swimlane.js';
import { capturePlaceholderState, restorePlaceholderState } from './dnd.js';
import {
  STATUSES,
  STATUS_LABELS,
  PRIORITY_LABELS,
  ISSUE_TYPE_LABELS,
  AI_ACTOR_PREFIX,
} from '../../shared/constants.js';

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
    state.selection.has(issue.id),
    issue.title,
    issue.type,
    issue.description,
    issue.priority,
    issue.assignee,
    issue.assigneeId,
    issue.dueDate,
    issue.status,
    issue.tags,
    issue.logs.length,
    issue.commentCount,
    state.expanded.has(issue.id),
    myRole(),
  ]);
}

function logItemHtml(log) {
  const fromLabel = log.fromStatus ? STATUS_LABELS[log.fromStatus] : '新建';
  const toLabel = STATUS_LABELS[log.toStatus] || log.toStatus;
  const reasonHtml = log.reason ? `<div class="log-reason">失败原因：${esc(log.reason)}</div>` : '';
  // 操作者：人（用户名）与 AI（客户端自报身份）都在时间线里留名
  const actorCls = (log.actor || '').startsWith(AI_ACTOR_PREFIX) ? ' log-actor-ai' : '';
  const actorHtml = log.actor ? `<span class="log-actor${actorCls}">${esc(log.actor)}</span>` : '';
  return `
    <div class="log-item" data-to="${esc(log.toStatus)}">
      <span class="log-bar"></span>
      <div>
        <div class="log-main">${esc(fromLabel)} → ${esc(toLabel)} ${actorHtml}</div>
        <div class="log-at">${esc(fmtDateTime(log.changedAt))}</div>
        ${reasonHtml}
      </div>
    </div>`;
}

function cardInnerHtml(issue) {
  const isOpen = state.expanded.has(issue.id);
  const { text: dueText, cls: dueClass } = dueInfo(issue);
  const typeInfo = ISSUE_TYPE_LABELS[issue.type] || ISSUE_TYPE_LABELS.task;
  // viewer（只读成员）收起勾选与编辑/删除入口；真正的护栏在服务端
  const canWrite = myRole() !== 'viewer';

  const tagsHtml = issue.tags.map((t) => `<span class="chip tag"># ${esc(t)}</span>`).join('');

  const logsHtml = [...issue.logs].reverse().map(logItemHtml).join('');

  const picked = state.selection.has(issue.id);

  return `
    <div class="card-top">
      ${
        canWrite
          ? `<input class="card-pick" type="checkbox" data-act="select" data-id="${issue.id}"
             aria-label="选择任务「${esc(issue.title)}」"${picked ? ' checked' : ''} />`
          : ''
      }
      <h3 class="card-title"><button class="card-open" type="button" data-act="open" data-id="${issue.id}" title="查看详情"><span class="card-no">#${issue.id}</span> ${esc(issue.title)}</button></h3>
    </div>
    ${issue.description ? `<p class="card-desc">${esc(issue.description)}</p>` : ''}
    <div class="card-meta">
      <span class="chip type type-${esc(issue.type)}">${typeInfo.icon} ${esc(typeInfo.label)}</span>
      <span class="chip prio-${esc(issue.priority)}">${esc(PRIORITY_LABELS[issue.priority])}优先级</span>
      <span class="chip">${esc(issue.assignee || '未指派')}</span>
      <span class="chip due${dueClass}">${esc(dueText)}</span>
      ${tagsHtml}
    </div>
    <div class="card-foot">
      <span class="card-time">创建于 ${esc(fmtDateTime(issue.createdAt))}</span>
      <div class="card-actions">
        <button class="log-toggle${isOpen ? ' open' : ''}" type="button" data-act="logs" data-id="${issue.id}">
          变更 ${issue.logs.length}${issue.commentCount ? ` · 评论 ${issue.commentCount}` : ''}
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        ${
          canWrite
            ? `<button class="icon-btn" type="button" data-act="edit" data-id="${issue.id}" aria-label="编辑">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="icon-btn" type="button" data-act="delete" data-id="${issue.id}" aria-label="删除">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>`
            : ''
        }
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
          <input class="col-pick" type="checkbox" data-act="select-col" data-status="${status}"
                 aria-label="全选「${esc(STATUS_LABELS[status])}」列" />
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
export /** 负责人 id → 展示名（泳道标题用；查无此人回退 null） */
function resolveUserName(userId) {
  const u = state.users.find((x) => x.id === userId);
  return u ? u.displayName || u.username : null;
}

/** 取（或建）卡片节点并按最新数据更新内容；泳道/平铺两条路径共用 */
function ensureCardNode(issue) {
  let node = cardNodes.get(issue.id);
  if (!node) {
    node = document.createElement('article');
    node.className = 'card';
    node.draggable = true;
    node.dataset.id = String(issue.id);
    cardNodes.set(issue.id, node);
  }

  node.classList.toggle('selected', state.selection.has(issue.id));

  const sig = cardSignature(issue);
  if (cardSigs.get(issue.id) !== sig) {
    node.dataset.priority = issue.priority;
    node.innerHTML = cardInnerHtml(issue);
    cardSigs.set(issue.id, sig);
  }
  return node;
}

/** 列内平铺渲染（泳道关闭时的原路径） */
function renderFlatColumn(colBody, shown) {
  // 从泳道切回平铺：清掉 lane 容器（卡片节点引用保留，下方逐个插回）
  if (colBody.querySelector('.lane')) colBody.innerHTML = '';
  let prev = null;
  for (const issue of shown) {
    const node = ensureCardNode(issue);
    const expected = prev ? prev.nextElementSibling : colBody.firstElementChild;
    if (expected !== node) colBody.insertBefore(node, expected);
    prev = node;
  }
}

/** 属性选择器值转义（不依赖 CSS.escape，jsdom 等环境可能缺失全局 CSS） */
function attrSel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 列内泳道渲染：按 laneKey 分区（组序 = 卡片首次出现顺序，拖拽兜底组排最后）。
 * lane 容器每帧重建，卡片节点复用（append 语义 = 移动），拖拽中的占位由调用方恢复。
 */
function renderLanedColumn(colBody, status, shown, laneDim) {
  // 拖拽期兜底：拖拽卡的组必须在每列都有 lane，否则跨列无处投放
  const dragIssue = state.drag ? state.issues.find((i) => i.id === state.drag.id) : null;
  const dragKey = dragIssue ? laneKeyOf(dragIssue, laneDim) : null;

  const groups = [];
  const byKey = new Map();
  for (const issue of shown) {
    const key = laneKeyOf(issue, laneDim);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      groups.push(key);
    }
    byKey.get(key).push(issue);
  }
  if (dragKey && !byKey.has(dragKey)) {
    byKey.set(dragKey, []);
    groups.push(dragKey);
  }

  colBody.innerHTML = groups
    .map(
      (key) => `
      <section class="lane${key === dragKey ? ' lane-drag' : ''}" data-lane-key="${esc(key)}">
        <div class="lane-head">${esc(laneTitleOf(key, resolveUserName))}</div>
        <div class="lane-body"></div>
      </section>`,
    )
    .join('');

  for (const key of groups) {
    const lane = colBody.querySelector(`.lane[data-lane-key="${attrSel(key)}"]`);
    const body = lane.querySelector('.lane-body');
    for (const issue of byKey.get(key)) body.appendChild(ensureCardNode(issue));
  }

  // 空状态：没有可见卡片且没有拖拽兜底组
  if (!groups.length) {
    const text = shown.length ? '' : '无匹配任务';
    if (text) {
      const div = document.createElement('div');
      div.className = 'col-empty';
      div.textContent = text;
      colBody.appendChild(div);
    }
  }
}

export function renderBoard() {
  if (state.view !== 'board') return;
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

  // 2) 逐列定位与更新（泳道开 / 关两条路径；拖拽期间占位先捕获后恢复）
  const lanesOn = state.laneDim !== 'none';
  const placeholderState = lanesOn ? capturePlaceholderState() : null;

  for (const status of STATUSES) {
    const col = board.querySelector(`.column[data-status="${status}"]`);
    const colBody = col.querySelector('.col-body');
    const all = state.issues.filter((i) => i.status === status);
    const shown = filtered.filter((i) => i.status === status);

    // viewer 收起列头全选框（没有可执行的选择操作）
    col.querySelector('.col-pick').hidden = myRole() === 'viewer';

    const countEl = col.querySelector('.col-count');
    countEl.textContent = `${shown.length}/${all.length}`;
    countEl.classList.toggle('filtered', active);

    // 列头全选框：全选勾上，部分勾选置为半选（indeterminate）
    const pickEl = col.querySelector('.col-pick');
    if (pickEl) {
      const shownIds = shown.map((i) => i.id);
      const pickedCount = shownIds.filter((id) => state.selection.has(id)).length;
      pickEl.disabled = shownIds.length === 0;
      pickEl.checked = shownIds.length > 0 && pickedCount === shownIds.length;
      pickEl.indeterminate = pickedCount > 0 && pickedCount < shownIds.length;
    }

    if (lanesOn) {
      renderLanedColumn(colBody, status, shown, state.laneDim);
      restorePlaceholderState(placeholderState, status);
    } else {
      renderFlatColumn(colBody, shown);

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
  }

  renderSelectionBar();
  renderTabs();
}

/** 底部批量操作条：有勾选才出现 */
export function renderSelectionBar() {
  const bar = $('#batchBar');
  if (!bar) return;

  const sel = $('#batchStatus');
  if (sel && !sel.options.length) {
    sel.innerHTML = STATUSES.map((s) => `<option value="${esc(s)}">${esc(STATUS_LABELS[s])}</option>`).join(
      '',
    );
  }

  const n = state.selection.size;
  $('#batchCount').textContent = `已选 ${n} 项`;
  bar.hidden = n === 0;
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
