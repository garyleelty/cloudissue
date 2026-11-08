/**
 * 列表视图：表格化呈现（商业化可用性的基线能力）。
 * 数据源走服务端检索（/api/issues/search）——筛选/排序/分页全部服务端化，
 * 大数据量下列表视图不再受客户端内存约束；看板视图仍用全量客户端数据
 * （拖拽排序语义依赖全量）。排序键与服务端 issue_search 同一约定。
 */
import { state, notify } from './state.js';
import { api } from './api.js';
import { esc, fmtDateTime, dueInfo } from './utils.js';
import { STATUS_LABELS, PRIORITY_LABELS, ISSUE_TYPE_LABELS, PRIORITIES } from '../../shared/constants.js';

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 20;
let listSeq = 0; // 渲染竞态序号：只接受最新一次检索的返回

const PRIORITY_ORDER = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));

/** 各列定义：key 对应 listSort.key，label 为列头，render 输出单元格 */
const COLUMNS = [
  { key: 'id', label: '#', sortable: true, render: (i) => `<span class="cell-no">#${i.id}</span>` },
  {
    key: 'type',
    label: '类型',
    sortable: true,
    render: (i) => {
      const t = ISSUE_TYPE_LABELS[i.type] || ISSUE_TYPE_LABELS.task;
      return `<span class="chip type type-${esc(i.type)}">${t.icon} ${esc(t.label)}</span>`;
    },
  },
  {
    key: 'title',
    label: '标题',
    sortable: true,
    render: (i) => {
      const tags = i.tags.map((t) => `<span class="chip tag"># ${esc(t)}</span>`).join('');
      return `<div class="cell-title"><button class="card-open" type="button" data-act="open" data-id="${i.id}"><span class="cell-no">#${i.id}</span> ${esc(i.title)}</button>${tags ? `<span class="cell-tags">${tags}</span>` : ''}</div>`;
    },
  },
  {
    key: 'status',
    label: '状态',
    sortable: true,
    render: (i) => `<span class="chip">${esc(STATUS_LABELS[i.status] || i.status)}</span>`,
  },
  {
    key: 'priority',
    label: '优先级',
    sortable: true,
    render: (i) => `<span class="chip prio-${esc(i.priority)}">${esc(PRIORITY_LABELS[i.priority])}</span>`,
  },
  { key: 'assignee', label: '负责人', sortable: true, render: (i) => esc(i.assignee || '未指派') },
  {
    key: 'dueDate',
    label: '截止',
    sortable: true,
    render: (i) => {
      const { text, cls } = dueInfo(i);
      return `<span class="chip due${cls}">${esc(text)}</span>`;
    },
  },
  {
    key: 'commentCount',
    label: '💬',
    sortable: false,
    render: (i) => (i.commentCount ? String(i.commentCount) : ''),
  },
  {
    key: 'updatedAt',
    label: '更新于',
    sortable: true,
    render: (i) => `<span class="cell-time">${esc(fmtDateTime(i.updatedAt))}</span>`,
  },
];

export function initListView() {
  const root = $('#listView');

  // 列头点击排序；同列再点反转方向
  root.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.listSort.key === key) {
      state.listSort.dir = state.listSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.listSort = { key, dir: key === 'updatedAt' || key === 'id' ? 'desc' : 'asc' };
    }
    state.listPage = 1;
    notify();
  });

  // 分页
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn) return;
    state.listPage = Number(btn.dataset.page);
    notify();
  });

  // 点标题打开详情抽屉（与看板同一套 data-act 委托入口在 board 上，列表单独接）
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="open"]');
    if (!btn) return;
    import('./main.js').then((m) => m.openIssueDrawer(Number(btn.dataset.id)));
  });
}

/** 服务端检索参数（与筛选/排序/分页状态一一对应） */
function searchParams() {
  const f = state.filters;
  const params = new URLSearchParams();
  params.set('boardId', String(state.currentBoardId ?? 1));
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String((state.listPage - 1) * PAGE_SIZE));
  params.set('sort', state.listSort.key);
  params.set('order', state.listSort.dir);
  if (f.keyword) params.set('q', f.keyword);
  if (f.priority.size) params.set('priority', [...f.priority].join(','));
  if (f.tag.size) params.set('tag', [...f.tag][0]);
  if (f.assignee.size) params.set('assignee', [...f.assignee].join(','));
  if (f.aiOnly) params.set('aiOnly', '1');
  return params;
}

/** 渲染列表视图；非列表视图时跳过。数据走服务端检索（异步），先绘骨架再填行 */
export function renderList() {
  const root = $('#listView');
  if (state.view !== 'list') return;

  // 骨架（列头 + 空 tbody）：行内容在服务端返回后填充
  const head = COLUMNS.map((c) => {
    if (!c.sortable) return `<th class="col-ic" title="${esc(c.label)}">${esc(c.label)}</th>`;
    const active = state.listSort.key === c.key;
    const arrow = active ? (state.listSort.dir === 'asc' ? '↑' : '↓') : '↕';
    return `<th data-sort="${c.key}" class="${active ? 'sorted' : ''}" title="按${esc(c.label)}排序">${esc(c.label)} <span class="sort-arrow">${arrow}</span></th>`;
  }).join('');
  root.innerHTML = `
    <div class="list-scroll">
      <table class="issue-table">
        <thead><tr>${head}</tr></thead>
        <tbody><tr><td class="list-loading" colspan="${COLUMNS.length}">加载中…</td></tr></tbody>
      </table>
    </div>`;

  // 服务端检索（取消上一次未完成请求的渲染竞态）
  const seq = ++listSeq;
  api
    .searchIssues(searchParams())
    .then((data) => {
      if (seq !== listSeq || state.view !== 'list') return;
      renderListRows(data);
    })
    .catch((err) => {
      if (seq !== listSeq) return;
      if (err.status === 401) return;
      root.innerHTML = `<div class="list-empty">列表加载失败：${esc(err.message)}</div>`;
    });
}

/** 服务端返回后填充行与分页 */
function renderListRows(data) {
  const root = $('#listView');
  const rows = data.issues ?? [];
  const total = data.total ?? rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.listPage > pages) state.listPage = pages;
  const page = state.listPage;

  const head = COLUMNS.map((c) => {
    if (!c.sortable) return `<th class="col-ic" title="${esc(c.label)}">${esc(c.label)}</th>`;
    const active = state.listSort.key === c.key;
    const arrow = active ? (state.listSort.dir === 'asc' ? '↑' : '↓') : '↕';
    return `<th data-sort="${c.key}" class="${active ? 'sorted' : ''}" title="按${esc(c.label)}排序">${esc(c.label)} <span class="sort-arrow">${arrow}</span></th>`;
  }).join('');

  const body = rows
    .map(
      (i) => `<tr data-id="${i.id}">
        ${COLUMNS.map((c) => `<td class="td-${c.key}">${c.render(i)}</td>`).join('')}
      </tr>`,
    )
    .join('');

  const empty = rows.length
    ? ''
    : '<div class="list-empty">没有匹配的任务——调整筛选条件，或新建一个 issue。</div>';

  const pager =
    pages <= 1
      ? ''
      : `<div class="pager">
          <button class="btn btn-ghost" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="pager-info">第 ${page} / ${pages} 页 · 共 ${total} 条</span>
          <button class="btn btn-ghost" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button>
        </div>`;

  root.innerHTML = `
    <div class="list-scroll">
      <table class="issue-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${empty}
    </div>
    ${pager}`;
}

/** 筛选/数据变化后回到第一页（保持当前页码会让人「找不到刚才的列表」） */
export function resetListPage() {
  state.listPage = 1;
}
