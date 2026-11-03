/**
 * 入口：装配各层，建立「事件 → 状态 → 重绘」的单向数据流。
 */
import {
  state,
  onChange,
  notify,
  resetFilters,
  clearSelection,
  pruneSelection,
  selectedIds,
  setSelected,
  toggleSelected,
} from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import * as render from './render.js';
import { syncDropdowns, closeAllDropdowns } from './dropdowns.js';
import { initDnd } from './dnd.js';
import { initCrossTabSync } from './sync.js';
import { filteredIssues } from './filters.js';
import {
  initModals,
  openForm,
  closeModals,
  askDelete,
  askDeleteMany,
  askFailureReason,
  cancelPendingReason,
  hasPendingReason,
} from './modals.js';
import { STATUSES, STATUS_LABELS, FAIL_STATUS, MOBILE_BREAKPOINT } from '../../shared/constants.js';

const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const colTabs = $('#colTabs');

/** 拉取整块看板并广播刷新 */
async function load() {
  try {
    const data = await api.list();
    state.issues = data.issues ?? [];
    // 勾选里可能残留已被别处删掉的卡片，重新拉取后顺手清掉
    pruneSelection(new Set(state.issues.map((i) => i.id)));
    render.syncAssigneeList();
    syncDropdowns();
    notify();
  } catch (err) {
    // 401 已由 ci:unauthorized 统一切到登录视图，这里不重复打扰
    if (err.status !== 401) toast(`加载失败：${err.message}`, 'error');
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

// ------------------------------------------------------------------
// 认证视图：登录 / 注册 / 登出
// ------------------------------------------------------------------
const authView = $('#authView');
let authMode = 'login';

function showAuth() {
  authView.hidden = false;
  $('#userChip').hidden = true;
  $('#btnLogout').hidden = true;
  $('#authError').hidden = true;
  authView.querySelector('[name="username"]')?.focus();
}

function showBoard(user) {
  authView.hidden = true;
  const chip = $('#userChip');
  chip.textContent = user.displayName || user.username;
  chip.title = `@${user.username}`;
  chip.hidden = false;
  $('#btnLogout').hidden = false;
  load();
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
    $('#fKeyword').value = '';
    notify();
  });

  // 输入防抖，避免每次按键都重排整块看板
  let searchTimer = null;
  $('#fKeyword').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.filters.keyword = v.trim();
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
  initModals({ onChanged: load });
  initCrossTabSync(load);
  bindGlobalEvents();
  bindBatchBar();
  bindAuthView();

  // 任意请求 401（会话过期/被吊销）→ 统一切回登录视图
  window.addEventListener('ci:unauthorized', showAuth);

  onChange(() => render.renderBoard());

  // 健康状态周期性刷新，链路断了状态灯能自己翻红
  await checkHealth();
  setInterval(checkHealth, 30_000);

  // 先探测登录态：未登录只亮登录视图，不带出看板数据的 401 报错
  const me = await api
    .me()
    .then((r) => r.user)
    .catch(() => null);
  if (me) showBoard(me);
  else showAuth();
}

init();
