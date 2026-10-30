/**
 * 入口：装配各层，建立「事件 → 状态 → 重绘」的单向数据流。
 */
import { state, onChange, notify, resetFilters } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import * as render from './render.js';
import { syncDropdowns, closeAllDropdowns } from './dropdowns.js';
import { initDnd } from './dnd.js';
import {
  initModals,
  openForm,
  closeModals,
  askDelete,
  cancelPendingReason,
  hasPendingReason,
} from './modals.js';
import { STATUSES } from '../../shared/constants.js';

const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const colTabs = $('#colTabs');

/** 拉取整块看板并广播刷新 */
async function load() {
  state.loading = true;
  try {
    const data = await api.list();
    state.issues = data.issues ?? [];
    render.syncAssigneeList();
    syncDropdowns();
    notify();
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
    await api.health();
    dot.className = 'health ok';
    text.textContent = 'MySQL 已连接（经 MCP）';
  } catch {
    dot.className = 'health err';
    text.textContent = '数据链路异常';
  }
}

function bindGlobalEvents() {
  $('#btnNew').addEventListener('click', () => openForm(null, 'backlog'));

  $('#btnClear').addEventListener('click', () => {
    resetFilters();
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
    const id = Number(btn.dataset.id);
    const issue = state.issues.find((i) => i.id === id);
    if (!issue) return;

    if (btn.dataset.act === 'logs') {
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
        render.renderTabs();
      }
    },
    { passive: true }
  );
}

async function init() {
  state.activeTab = STATUSES[0];

  render.buildSkeleton();
  initDnd({ onChanged: load });
  initModals({ onChanged: load });
  bindGlobalEvents();

  onChange(() => render.renderBoard());

  await checkHealth();
  await load();
}

init();
