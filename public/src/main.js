/**
 * 入口：装配各层，建立「事件 → 状态 → 重绘」的单向数据流。
 */
import {
  state,
  onChange,
  notify,
  resetFilters,
  clearSelection,
  selectedIds,
  setSelected,
  toggleSelected,
} from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import * as render from './render.js';
import { syncDropdowns, closeAllDropdowns, bindDropdowns } from './dropdowns.js';
import { initDnd } from './dnd.js';
import { initCrossTabSync } from './sync.js';
import { filteredIssues } from './filters.js';
import {
  initModals,
  openForm,
  closeModals,
  populateAssigneeOptions,
  askDelete,
  askDeleteMany,
  askDeleteBoard,
  askFailureReason,
  cancelPendingReason,
  hasPendingReason,
} from './modals.js';
import {
  initBoards,
  loadBoards,
  switchBoard,
  hasBoard,
  syncBoardAfterDataChange,
  syncWriteUI,
} from './boards.js';
import {
  initDrawer,
  bindDrawer,
  openDrawer,
  closeDrawer,
  drawerIssueId,
  refresh as refreshDrawer,
} from './drawer.js';
import { initListView, renderList, resetListPage } from './listview.js';
import { downloadBlob } from './utils.js';
import { STATUSES, STATUS_LABELS, FAIL_STATUS, MOBILE_BREAKPOINT } from '../../shared/constants.js';
import { LANE_DIMS, LANE_DIM_LABELS } from '../../shared/swimlane.js';
import { initNotifications, refreshUnread, refreshNotificationsSoon, showNotifUI } from './notifications.js';

/** SSE 实时推送：服务端广播 changed → 合并去抖后重拉（替代 30s 轮询的主通道，轮询保留为兜底） */
let sseSource = null;
let sseDebounce = null;
function startEventStream() {
  if (sseSource || typeof EventSource !== 'function') return;
  sseSource = new EventSource('/api/events');
  sseSource.addEventListener('changed', () => {
    clearTimeout(sseDebounce);
    sseDebounce = setTimeout(() => {
      load();
      refreshUnread();
    }, 120);
  });
  sseSource.onerror = () => {
    // 连接断开：EventSource 会自动重连；期间 30s 轮询兜底
  };
}
function stopEventStream() {
  sseSource?.close();
  sseSource = null;
}

const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const colTabs = $('#colTabs');

/** 拉取当前看板并广播刷新 */
async function load() {
  try {
    // 未选定看板（登录后看板列表还没回来）时不发请求，等 loadBoards 后再拉
    if (!hasBoard()) return;
    const data = await api.list(state.currentBoardId);
    state.issues = data.issues ?? [];
    // 勾选里可能残留已被别处删掉的卡片，重新拉取后顺手清掉
    syncBoardAfterDataChange();
    syncDropdowns();
    notify();
    refreshDrawer();
    refreshNotificationsSoon();
  } catch (err) {
    // 401 已由 ci:unauthorized 统一切到登录视图，这里不重复打扰
    if (err.status !== 401) toast(`加载失败：${err.message}`, 'error');
  }
}

/** 登录后拉一次用户列表（负责人选择器 + 负责人筛选的骨架） */
async function loadUsers() {
  try {
    const data = await api.users();
    state.users = data.users ?? [];
    populateAssigneeOptions();
    syncDropdowns();
  } catch {
    /* 用户列表失败不致命：负责人退化为历史文本展示 */
  }
}

async function checkHealth() {
  const dot = $('#healthDot');
  const text = $('#healthText');
  try {
    await api.health();
    dot.className = 'health ok';
    text.textContent = 'MySQL 已连接（经 MCP）';
  } catch {
    dot.className = 'health err';
    text.textContent = '数据链路异常';
  }
}

/** 看板 / 列表视图切换（筛选状态两边共用） */
function switchView(view) {
  state.view = view;
  $('#board').hidden = view !== 'board';
  $('#listView').hidden = view !== 'list';
  $('#viewBoard').classList.toggle('active', view === 'board');
  $('#viewList').classList.toggle('active', view === 'list');
  $('#viewBoard').setAttribute('aria-selected', String(view === 'board'));
  $('#viewList').setAttribute('aria-selected', String(view === 'list'));
  notify();
}

/** 列表视图点击标题 → 打开与看板相同的详情抽屉 */
export function openIssueDrawer(id) {
  openDrawer(id);
}

// ------------------------------------------------------------------
// 认证视图：登录 / 注册 / 登出
// ------------------------------------------------------------------
const authView = $('#authView');
let authMode = 'login';

function showAuth() {
  state.me = null;
  state.users = [];
  state.issues = [];
  state.currentBoardId = null;
  closeDrawer();
  $('#boardSwitch').hidden = true;
  showNotifUI(false);
  stopEventStream();
  syncWriteUI();
  authView.hidden = false;
  $('#userChip').hidden = true;
  $('#btnLogout').hidden = true;
  $('#authError').hidden = true;
  $('#btnMine').setAttribute('aria-pressed', 'false');
  authView.querySelector('[name="username"]')?.focus();
}

async function showBoard(user) {
  state.me = user;
  authView.hidden = true;
  const chip = $('#userChip');
  chip.textContent = user.displayName || user.username;
  chip.title = `@${user.username}`;
  chip.hidden = false;
  $('#btnLogout').hidden = false;
  // 先看板列表、后任务：load 依赖 currentBoardId，顺序不能反
  showNotifUI(true);
  startEventStream();
  await refreshUnread();
  loadBoards().then((ok) => {
    syncWriteUI();
    if (ok) load();
    else notify(); // 没有任何看板：渲染空看板
  });
  loadUsers();
}

function bindAuthView() {
  const form = $('#authForm');
  const err = $('#authError');
  const submit = $('#authSubmit');

  const setMode = (mode) => {
    authMode = mode;
    $('#tabLogin').classList.toggle('active', mode === 'login');
    $('#tabRegister').classList.toggle('active', mode === 'register');
    $('#tabLogin').setAttribute('aria-selected', String(mode === 'login'));
    $('#tabRegister').setAttribute('aria-selected', String(mode === 'register'));
    submit.textContent = mode === 'login' ? '登录' : '注册';
    form.password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    err.hidden = true;
  };
  $('#tabLogin').addEventListener('click', () => setMode('login'));
  $('#tabRegister').addEventListener('click', () => setMode('register'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) {
      err.textContent = '请输入用户名和密码';
      err.hidden = false;
      return;
    }

    submit.disabled = true;
    try {
      const payload = { username, password };
      const res = authMode === 'login' ? await api.login(payload) : await api.register(payload);
      toast(authMode === 'login' ? '欢迎回来' : '注册成功', 'success');
      showBoard(res.user);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

function bindGlobalEvents() {
  $('#btnNew').addEventListener('click', () => openForm(null, 'backlog'));

  $('#btnLogout').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch {
      /* 会话可能已失效，本地照常登出 */
    }
    clearSelection();
    resetFilters();
    $('#fKeyword').value = '';
    showAuth();
    toast('已退出登录');
  });

  $('#btnClear').addEventListener('click', () => {
    resetFilters();
    clearSelection();
    resetListPage();
    $('#fKeyword').value = '';
    $('#btnMine').setAttribute('aria-pressed', 'false');
    $('#btnAI').setAttribute('aria-pressed', 'false');
    notify();
  });

  // 泳道分组维度：视图层分组（卡片归属由数据决定，拖拽不改组）
  const laneSelect = $('#laneSelect');
  laneSelect.innerHTML = LANE_DIMS.map((d) => `<option value="${d}">${LANE_DIM_LABELS[d]}</option>`).join('');
  try {
    const saved = window.localStorage.getItem('issue-board:laneDim');
    if (LANE_DIMS.includes(saved)) state.laneDim = saved;
  } catch {
    /* 隐私模式下降级为默认 */
  }
  laneSelect.value = state.laneDim;
  laneSelect.addEventListener('change', () => {
    state.laneDim = laneSelect.value;
    try {
      window.localStorage.setItem('issue-board:laneDim', state.laneDim);
    } catch {
      /* 持久化失败仅影响下次默认值 */
    }
    notify();
  });

  // 导出 CSV：把当前筛选原样交给服务端，与看板同一份过滤口径（shared/issue-filters.js）
  $('#btnExport').addEventListener('click', async () => {
    const btn = $('#btnExport');
    const f = state.filters;
    btn.disabled = true;
    try {
      const { blob, count, filename } = await api.exportCsv({
        boardId: state.currentBoardId,
        q: f.keyword || undefined,
        priority: f.priority.size ? [...f.priority].join(',') : undefined,
        tag: f.tag.size ? [...f.tag].join(',') : undefined,
        assignee: f.assignee.size ? [...f.assignee].join(',') : undefined,
        aiOnly: f.aiOnly || undefined,
      });
      downloadBlob(blob, filename);
      toast(count ? `已导出 ${count} 个任务：${filename}` : '没有匹配的任务可导出', count ? 'success' : '');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = !hasBoard();
    }
  });

  // 「AI 动态」：只看被 AI 操作过的 issue（actor 以 ai: 开头）
  $('#btnAI').addEventListener('click', () => {
    state.filters.aiOnly = !state.filters.aiOnly;
    $('#btnAI').setAttribute('aria-pressed', String(state.filters.aiOnly));
    resetListPage();
    notify();
  });

  // 视图切换：看板 / 列表
  $('#viewBoard').addEventListener('click', () => switchView('board'));
  $('#viewList').addEventListener('click', () => switchView('list'));

  // 「我的」：一键只看指派给自己的 issue（再点一次取消）
  $('#btnMine').addEventListener('click', () => {
    const pressed = $('#btnMine').getAttribute('aria-pressed') === 'true';
    if (pressed) {
      state.filters.assignee.delete(String(state.me?.id));
      $('#btnMine').setAttribute('aria-pressed', 'false');
    } else {
      if (state.me?.id) state.filters.assignee.add(String(state.me.id));
      $('#btnMine').setAttribute('aria-pressed', 'true');
    }
    resetListPage();
    notify();
  });

  // 输入防抖，避免每次按键都重排整块看板
  let searchTimer = null;
  $('#fKeyword').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.filters.keyword = v.trim();
      resetListPage();
      notify();
    }, 160);
  });

  document.addEventListener('click', closeAllDropdowns);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 拖拽原因弹窗必须走取消流程，否则 Promise 悬挂
    if (hasPendingReason()) {
      cancelPendingReason();
      return;
    }
    if (drawerIssueId()) {
      closeDrawer();
      return;
    }
    if (!$('#modalRoot').hidden) closeModals();
    else closeAllDropdowns();
  });

  // 卡片区事件委托：列与卡片节点会被复用，绑定到 board 最稳
  board.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;

    // 列头全选：只勾选当前筛选后可见的卡片，避免误伤被筛掉的卡片
    if (btn.dataset.act === 'select-col') {
      const ids = filteredIssues()
        .filter((i) => i.status === btn.dataset.status)
        .map((i) => i.id);
      const allPicked = ids.length > 0 && ids.every((id) => state.selection.has(id));
      for (const id of ids) setSelected(id, !allPicked);
      notify();
      return;
    }

    const id = Number(btn.dataset.id);
    const issue = state.issues.find((i) => i.id === id);
    if (!issue) return;

    if (btn.dataset.act === 'select') {
      toggleSelected(id);
      notify();
    } else if (btn.dataset.act === 'open') {
      openDrawer(id);
    } else if (btn.dataset.act === 'logs') {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      notify();
    } else if (btn.dataset.act === 'edit') {
      openForm(issue);
    } else if (btn.dataset.act === 'delete') {
      askDelete(issue);
    }
  });

  // 移动端：点击标签滚动到对应列
  colTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.col-tab');
    if (!tab) return;
    const col = board.querySelector(`.column[data-status="${tab.dataset.status}"]`);
    if (!col) return;
    board.scrollTo({ left: col.offsetLeft - 8, behavior: 'smooth' });
    state.activeTab = tab.dataset.status;
    render.renderBoard();
  });

  // 移动端：横向滚动时同步高亮当前列标签
  board.addEventListener(
    'scroll',
    () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) return;
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
        render.renderTabs();
      }
    },
    { passive: true },
  );
}

/**
 * 批量操作条：移动 / 删除 / 取消选择。
 * 移动落库同样走失败原因闸门（在勾选态清除之前），删除走二次确认。
 */
function bindBatchBar() {
  $('#batchCancel').addEventListener('click', () => {
    clearSelection();
    notify();
  });

  $('#batchDelete').addEventListener('click', () => {
    const ids = selectedIds();
    if (!ids.length) return;
    askDeleteMany(ids);
  });

  $('#batchMove').addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) return;

    const toStatus = $('#batchStatus').value;
    let failReason = '';

    // 与单卡拖拽同一条规则：进「失败」列必须先拿到原因
    if (toStatus === FAIL_STATUS) {
      const reason = await askFailureReason({ id: ids[0], title: `选中的 ${ids.length} 个任务` });
      if (!reason) {
        toast('已取消批量移动：未填写失败原因', 'error');
        return;
      }
      failReason = reason;
    }

    try {
      // 逐卡携带乐观锁版本号：并发下冲突的卡片单独汇总，不被静默覆盖
      const items = ids.map((id) => {
        const issue = state.issues.find((i) => i.id === id);
        return { id, expectedVersion: issue?.version };
      });
      const res = await api.batchMove(items, { toStatus, failReason });
      const skipped = res?.failed?.length ?? 0;
      const moved = res?.moved ?? ids.length;
      toast(
        skipped
          ? `已移动 ${moved} 个任务，${skipped} 个失败`
          : `已移动 ${moved} 个任务到「${STATUS_LABELS[toStatus]}」`,
        skipped ? 'error' : 'success',
      );
      clearSelection();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      await load();
    }
  });
}

async function init() {
  state.activeTab = STATUSES[0];

  render.buildSkeleton();
  initDnd({ onChanged: load });
  initModals({ onChanged: load, onBoardDeleted: reloadBoardsAfterDelete });
  initCrossTabSync(load, followCrossTabBoard);
  initDrawer();
  bindDrawer({ onEdit: (issue) => openForm(issue) });
  initListView();
  initBoards({
    onBoardChanged: load,
    askDeleteBoard,
    closeDrawer,
    resetListPage: resetListPage,
  });
  initNotifications();
  bindDropdowns();
  bindGlobalEvents();
  bindBatchBar();
  bindAuthView();

  // 任意请求 401（会话过期/被吊销）→ 统一切回登录视图
  window.addEventListener('ci:unauthorized', showAuth);

  onChange(() => {
    render.renderBoard();
    renderList();
  });

  // 健康状态周期性刷新，链路断了状态灯能自己翻红；顺带轮询未读通知数（省一套定时器）
  await checkHealth();
  await refreshUnread();
  setInterval(() => {
    checkHealth();
    refreshUnread();
  }, 30_000);

  // 先探测登录态：未登录只亮登录视图，不带出看板数据的 401 报错
  const me = await api
    .me()
    .then((r) => r.user)
    .catch(() => null);
  if (me) showBoard(me);
  else showAuth();
}

/** 删除看板后的收尾：重载看板列表（loadBoards 会自动落到下一个可用看板）并拉任务 */
async function reloadBoardsAfterDelete() {
  const ok = await loadBoards();
  if (ok) await load();
  else {
    state.issues = [];
    notify();
  }
}

/** 其他标签页切换了看板：本页跟随（switchBoard 内部会去重并重新拉取） */
function followCrossTabBoard(id) {
  if (!state.me) return; // 未登录时忽略
  if (id == null) return;
  if (!state.boards.some((b) => b.id === id)) return; // 未知看板：等下次 loadBoards 校正
  switchBoard(id);
}

init();
