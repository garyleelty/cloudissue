/**
 * CloudIssue · 任务看板前端
 * ---------------------------------------------------------------
 * · 五列固定看板，卡片支持跨列拖拽
 * · 拖拽时目标列高亮 + 虚线占位提示
 * · 拖入「失败」列必须先填写失败原因，否则拒绝移动
 * · 数据全部经 REST API → MCP → MySQL，刷新不丢失
 */
import {
  STATUSES,
  STATUS_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  FAIL_STATUS,
} from '/shared/constants.js';

// ==================================================================
// DOM 引用
// ==================================================================
const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const colTabs = $('#colTabs');
const modalRoot = $('#modalRoot');
const modalForm = $('#modalForm');
const modalConfirm = $('#modalConfirm');
const modalReason = $('#modalReason');
const toastRoot = $('#toastRoot');
const issueForm = $('#issueForm');

const COL_ACCENT = {
  backlog: 'var(--c-backlog)',
  planning: 'var(--c-planning)',
  in_progress: 'var(--c-in_progress)',
  done: 'var(--c-done)',
  failed: 'var(--c-failed)',
};

// ==================================================================
// 全局状态
// ==================================================================
const state = {
  issues: [],
  loading: false,
  editingId: null,
  expanded: new Set(), // 展开状态变更记录的卡片
  filters: {
    keyword: '',
    priority: new Set(),
    tag: new Set(),
    assignee: new Set(),
  },
  drag: null, // { id, fromStatus }
};

const placeholder = document.createElement('div');
placeholder.className = 'placeholder';

// ==================================================================
// 工具函数
// ==================================================================
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const pad = (n) => String(n).padStart(2, '0');

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 距离今天的天数（忽略时分秒） */
function daysFromToday(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target - today) / 86400000);
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// ==================================================================
// Toast 提示
// ==================================================================
function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 3600 : 2200);
}

// ==================================================================
// API
// ==================================================================
async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const api = {
  list: () => request('/api/issues'),
  create: (payload) => request('/api/issues', { method: 'POST', body: JSON.stringify(payload) }),
  update: (id, payload) => request(`/api/issues/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  move: (id, payload) => request(`/api/issues/${id}/move`, { method: 'POST', body: JSON.stringify(payload) }),
  remove: (id) => request(`/api/issues/${id}`, { method: 'DELETE' }),
};

// ==================================================================
// 筛选
// ==================================================================
function matchesFilters(issue, f) {
  if (f.keyword) {
    const kw = f.keyword.toLowerCase();
    const hay = `${issue.title} ${issue.description}`.toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  if (f.priority.size && !f.priority.has(issue.priority)) return false;
  if (f.assignee.size && !f.assignee.has(issue.assignee || '未指派')) return false;
  if (f.tag.size && !issue.tags.some((t) => f.tag.has(t))) return false;
  return true;
}

function filteredIssues() {
  return state.issues.filter((i) => matchesFilters(i, state.filters));
}

function hasActiveFilters() {
  const f = state.filters;
  return Boolean(f.keyword) || f.priority.size > 0 || f.tag.size > 0 || f.assignee.size > 0;
}

function clearFilters() {
  state.filters.keyword = '';
  state.filters.priority.clear();
  state.filters.tag.clear();
  state.filters.assignee.clear();
  $('#fKeyword').value = '';
  syncDropCounts();
  render();
}

// ==================================================================
// 渲染
// ==================================================================
function cardHtml(issue) {
  const isOpen = state.expanded.has(issue.id);
  const dueDays = issue.dueDate ? daysFromToday(issue.dueDate) : null;
  let dueClass = '';
  if (dueDays !== null && issue.status !== 'done') {
    if (dueDays < 0) dueClass = ' overdue';
    else if (dueDays <= 3) dueClass = ' soon';
  }
  const dueText = issue.dueDate
    ? dueDays < 0
      ? `逾期 ${Math.abs(dueDays)} 天`
      : dueDays === 0
        ? '今天到期'
        : `${issue.dueDate}`
    : '无期限';

  const tagsHtml = issue.tags
    .map((t) => `<span class="chip tag"># ${esc(t)}</span>`)
    .join('');

  const logs = [...issue.logs].reverse();
  const logsHtml = logs
    .map((log) => {
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
            ${reasonHtml}
          </div>
        </div>`;
    })
    .join('');

  return `
    <article class="card${state.drag?.id === issue.id ? ' dragging' : ''}"
             draggable="true"
             data-id="${issue.id}"
             data-priority="${esc(issue.priority)}">
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
      <div class="log-list${isOpen ? ' open' : ''}">${logsHtml || '<div class="log-from">暂无记录</div>'}</div>
    </article>`;
}

function render() {
  const filtered = filteredIssues();
  const active = hasActiveFilters();

  board.innerHTML = STATUSES.map((status) => {
    const all = state.issues.filter((i) => i.status === status);
    const shown = filtered.filter((i) => i.status === status);
    const countCls = active ? 'col-count filtered' : 'col-count';

    const body = shown.length
      ? shown.map(cardHtml).join('')
      : `<div class="col-empty">${all.length && !shown.length ? '无匹配任务' : '暂无任务'}</div>`;

    return `
      <section class="column${status === FAIL_STATUS ? ' is-fail' : ''}"
               data-status="${status}"
               style="--accent:${COL_ACCENT[status]}">
        <header class="col-head">
          <span class="col-dot"></span>
          <span class="col-title">${esc(STATUS_LABELS[status])}</span>
          <span class="${countCls}">${shown.length}/${all.length}</span>
        </header>
        <div class="col-body">${body}</div>
      </section>`;
  }).join('');

  renderTabs(filtered);
  bindColumnDragEvents();
}

function renderTabs(filtered = filteredIssues()) {
  colTabs.innerHTML = STATUSES.map((status) => {
    const all = state.issues.filter((i) => i.status === status);
    const shown = filtered.filter((i) => i.status === status);
    return `
      <button class="col-tab${status === state.activeTab ? ' active' : ''}" type="button" data-status="${status}">
        ${esc(STATUS_LABELS[status])}
        <span class="tab-count">${shown.length}/${all.length}</span>
      </button>`;
  }).join('');
}

function syncAssigneeList() {
  const names = [...new Set(state.issues.map((i) => i.assignee).filter(Boolean))].sort();
  $('#assigneeList').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

// ==================================================================
// 筛选下拉
// ==================================================================
function buildDropPanel(panel, kind) {
  let options = [];
  if (kind === 'priority') {
    options = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
  } else if (kind === 'tag') {
    options = [...new Set(state.issues.flatMap((i) => i.tags))].sort().map((t) => ({ value: t, label: `# ${t}` }));
  } else if (kind === 'assignee') {
    options = [...new Set(state.issues.map((i) => i.assignee || '未指派'))].sort().map((a) => ({ value: a, label: a }));
  }

  if (!options.length) {
    panel.innerHTML = '<div class="drop-empty">暂无可选项</div>';
    return;
  }

  panel.innerHTML = options
    .map((o) => {
      const checked = state.filters[kind].has(o.value);
      return `
        <button class="drop-opt" type="button" role="checkbox"
                aria-checked="${checked}" data-value="${esc(o.value)}">
          <span class="drop-check">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>
          </span>
          <span>${esc(o.label)}</span>
        </button>`;
    })
    .join('');
}

function syncDropdowns() {
  buildDropPanel($('#panelPriority'), 'priority');
  buildDropPanel($('#panelTag'), 'tag');
  buildDropPanel($('#panelAssignee'), 'assignee');
  syncDropCounts();
}

function syncDropCounts() {
  document.querySelectorAll('.drop-count').forEach((el) => {
    const kind = el.dataset.count;
    const n = state.filters[kind].size;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('show', n > 0);
  });
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown').forEach((d) => {
    d.querySelector('.drop-trigger').setAttribute('aria-expanded', 'false');
    d.querySelector('.drop-panel').classList.remove('open');
  });
}

// ==================================================================
// 弹窗控制
// ==================================================================
function openModal(which) {
  modalRoot.hidden = false;
  [modalForm, modalConfirm, modalReason].forEach((m) => {
    m.hidden = m !== which;
  });
}

function closeModals() {
  modalRoot.hidden = true;
  [modalForm, modalConfirm, modalReason].forEach((m) => {
    m.hidden = true;
  });
}

function showFormError(msg) {
  const el = $('#formError');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ------------------------------------------------------------------
// 新建 / 编辑 表单
// ------------------------------------------------------------------
function openForm(issue = null, presetStatus = null) {
  state.editingId = issue?.id ?? null;
  $('#formTitle').textContent = issue ? '编辑任务' : '新建任务';
  showFormError('');

  const f = issueForm;
  f.title.value = issue?.title ?? '';
  f.description.value = issue?.description ?? '';
  f.priority.value = issue?.priority ?? 'medium';
  f.assignee.value = issue?.assignee ?? '';
  f.status.value = issue?.status ?? presetStatus ?? 'backlog';
  f.dueDate.value = issue?.dueDate ?? '';
  f.tags.value = (issue?.tags ?? []).join(', ');
  f.failReason.value = '';

  syncReasonVisibility();
  openModal(modalForm);
  setTimeout(() => f.title.focus(), 60);
}

/** 仅当「新建」或「状态变更到失败」时才要求填写失败原因 */
function syncReasonVisibility() {
  const editing = state.editingId
    ? state.issues.find((i) => i.id === state.editingId)
    : null;
  const isFailed = issueForm.status.value === FAIL_STATUS;
  const needReason = isFailed && (!editing || editing.status !== FAIL_STATUS);
  $('#reasonRow').hidden = !needReason;
  issueForm.failReason.required = needReason;
  return needReason;
}

async function submitForm(e) {
  e.preventDefault();
  const f = e.target;
  const title = f.title.value.trim();
  if (!title) {
    showFormError('请填写任务标题');
    f.title.focus();
    return;
  }

  const payload = {
    title,
    description: f.description.value.trim(),
    priority: f.priority.value,
    assignee: f.assignee.value.trim(),
    tags: f.tags.value,
    dueDate: f.dueDate.value || null,
    status: f.status.value,
  };

  const needReason = syncReasonVisibility();
  const reason = f.failReason.value.trim();
  if (needReason && !reason) {
    showFormError('状态为「失败」时必须填写失败原因，否则无法保存');
    f.failReason.focus();
    return;
  }
  payload.failReason = reason;

  try {
    if (state.editingId) {
      await api.update(state.editingId, payload);
      toast('任务已更新', 'success');
    } else {
      await api.create(payload);
      toast('任务已创建', 'success');
    }
    closeModals();
    await load();
  } catch (err) {
    showFormError(err.message);
  }
}

// ------------------------------------------------------------------
// 删除二次确认
// ------------------------------------------------------------------
let pendingDelete = null;

function askDelete(issue) {
  pendingDelete = issue;
  $('#confirmText').innerHTML =
    `确定要删除任务「<strong>${esc(issue.title)}</strong>」吗？<br>该操作不可撤销，任务的标签与状态变更记录将一并删除。`;
  openModal(modalConfirm);
  setTimeout(() => $('#confirmOk').focus(), 60);
}

// ------------------------------------------------------------------
// 失败原因（拖拽进入失败列）
// ------------------------------------------------------------------
let reasonResolver = null;

function askFailureReason(issue) {
  $('#reasonIssueName').textContent = issue.title;
  $('#reasonInput').value = '';
  $('#reasonError').hidden = true;
  openModal(modalReason);
  setTimeout(() => $('#reasonInput').focus(), 60);

  return new Promise((resolve) => {
    reasonResolver = resolve;
  });
}

function resolveReason(value) {
  const done = reasonResolver;
  reasonResolver = null;
  if (done) done(value);
}

// ==================================================================
// 拖拽
// ==================================================================
function clearDragState() {
  board.querySelectorAll('.column').forEach((c) => {
    c.classList.remove('drag-over', 'drag-invalid');
  });
  placeholder.remove();
  board.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
  state.drag = null;
}

/** 根据指针位置把占位块移动到合适位置 */
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
}

/** 占位块前一个兄弟卡片即为 afterId */
function afterIdFromPlaceholder() {
  let prev = placeholder.previousElementSibling;
  while (prev && !prev.classList.contains('card')) prev = prev.previousElementSibling;
  return prev ? Number(prev.dataset.id) : null;
}

function bindColumnDragEvents() {
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
      if (col.contains(e.relatedTarget)) return; // 仍在列内移动
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
}

async function performMove(drag, toStatus, afterId) {
  const issue = state.issues.find((i) => i.id === drag.id);
  if (!issue) return;

  // 未发生跨列变化且位置也没变 → 忽略
  const needsReason = toStatus === FAIL_STATUS && drag.fromStatus !== FAIL_STATUS;

  let failReason = '';
  if (needsReason) {
    const reason = await askFailureReason(issue);
    if (!reason) {
      toast('已取消移动：未填写失败原因，任务保留在原列', 'error');
      return;
    }
    failReason = reason;
  }

  try {
    await api.move(drag.id, { toStatus, afterId, failReason });
    toast(`已移动到「${STATUS_LABELS[toStatus]}」`, 'success');
    await load();
  } catch (err) {
    toast(err.message, 'error');
    await load();
  }
}

// ==================================================================
// 事件绑定
// ==================================================================
function bindEvents() {
  $('#btnNew').addEventListener('click', () => openForm(null, 'backlog'));

  $('#btnClear').addEventListener('click', clearFilters);

  let searchTimer = null;
  $('#fKeyword').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.filters.keyword = v.trim();
      render();
    }, 160);
  });

  // 下拉多选
  document.querySelectorAll('.dropdown').forEach((dd) => {
    const trigger = dd.querySelector('.drop-trigger');
    const panel = dd.querySelector('.drop-panel');
    const kind = dd.dataset.filter;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !panel.classList.contains('open');
      closeAllDropdowns();
      if (willOpen) {
        buildDropPanel(panel, kind);
        panel.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });

    panel.addEventListener('click', (e) => {
      e.stopPropagation();
      const opt = e.target.closest('.drop-opt');
      if (!opt) return;
      const value = opt.dataset.value;
      const set = state.filters[kind];
      if (set.has(value)) set.delete(value);
      else set.add(value);
      opt.setAttribute('aria-checked', String(set.has(value)));
      syncDropCounts();
      render();
    });
  });

  document.addEventListener('click', closeAllDropdowns);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (reasonResolver) {
        resolveReason(null);
        closeModals();
        return;
      }
      if (!modalRoot.hidden) closeModals();
      else closeAllDropdowns();
    }
  });

  // 卡片区事件委托
  board.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const issue = state.issues.find((i) => i.id === id);
    if (!issue) return;

    if (btn.dataset.act === 'logs') {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      render();
    } else if (btn.dataset.act === 'edit') {
      openForm(issue);
    } else if (btn.dataset.act === 'delete') {
      askDelete(issue);
    }
  });

  // 拖拽开始 / 结束
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    state.drag = { id: Number(card.dataset.id), fromStatus: card.closest('.column').dataset.status };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(state.drag.id));
    // 让拖拽镜像在下一帧生成后再附加拖拽样式
    setTimeout(() => card.classList.add('dragging'), 0);
  });

  board.addEventListener('dragend', () => clearDragState());

  issueForm.addEventListener('submit', submitForm);
  issueForm.status.addEventListener('change', () => {
    syncReasonVisibility();
    showFormError('');
  });
  issueForm.failReason.addEventListener('input', () => {
    $('#reasonError').hidden = true;
  });

  // 弹窗关闭（含背景点击）
  modalRoot.addEventListener('click', (e) => {
    if (e.target.dataset.close) {
      if (reasonResolver) {
        resolveReason(null);
        toast('已取消移动：未填写失败原因，任务保留在原列', 'error');
      }
      closeModals();
    }
  });

  // 确认删除
  $('#confirmOk').addEventListener('click', async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    pendingDelete = null;
    closeModals();
    try {
      await api.remove(target.id);
      toast('任务已删除', 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // 确认失败原因
  const confirmReason = () => {
    const value = $('#reasonInput').value.trim();
    if (!value) {
      const err = $('#reasonError');
      err.textContent = '请填写失败原因，未填写将无法移动到「失败」列';
      err.hidden = false;
      $('#reasonInput').focus();
      return;
    }
    resolveReason(value);
    closeModals();
  };

  $('#reasonOk').addEventListener('click', confirmReason);
  $('#reasonInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirmReason();
  });

  // 移动端：列切换 + 滚动联动
  colTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.col-tab');
    if (!tab) return;
    const col = board.querySelector(`.column[data-status="${tab.dataset.status}"]`);
    if (!col) return;
    board.scrollTo({ left: col.offsetLeft - 8, behavior: 'smooth' });
    state.activeTab = tab.dataset.status;
    renderTabs();
  });

  board.addEventListener(
    'scroll',
    () => {
      if (window.innerWidth > 860) return;
      const center = board.scrollLeft + board.clientWidth / 2;
      let best = null;
      let bestDist = Infinity;
      board.querySelectorAll('.column').forEach((col) => {
        const c = col.offsetLeft + col.offsetWidth / 2;
        const d = Math.abs(c - center);
        if (d < bestDist) {
          bestDist = d;
          best = col.dataset.status;
        }
      });
      if (best && best !== state.activeTab) {
        state.activeTab = best;
        renderTabs();
      }
    },
    { passive: true }
  );
}

// ==================================================================
// 数据加载
// ==================================================================
async function load() {
  state.loading = true;
  try {
    const data = await api.list();
    state.issues = data.issues ?? [];
    syncAssigneeList();
    syncDropdowns();
    render();
  } catch (err) {
    toast(`加载失败：${err.message}`, 'error');
  } finally {
    state.loading = false;
  }
}

async function checkHealth() {
  const dot = $('#healthDot');
  const text = $('#healthText');
  try {
    await request('/api/health');
    dot.className = 'health ok';
    text.textContent = 'MySQL 已连接（经 MCP）';
  } catch (err) {
    dot.className = 'health err';
    text.textContent = '数据链路异常';
  }
}

// ==================================================================
// 启动
// ==================================================================
function init() {
  state.activeTab = STATUSES[0];
  bindEvents();
  checkHealth();
  load();
}

init();
