/**
 * 全局状态与极简发布订阅。
 * 视图只订阅 onChange，不直接互相调用，避免渲染与交互逻辑互相纠缠。
 */
import { STATUSES } from '../../shared/constants.js';

/**
 * @typedef {Object} BoardState
 * @property {any[]} issues
 * @property {{ id: number, name: string, description: string, issueCount: number }[]} boards  全部看板（多看板切换）
 * @property {number | null} currentBoardId  当前看板；null 表示尚未初始化（登录后取首个）
 * @property {{ id: number, username: string, displayName: string }[]} users  全部用户（负责人选择/筛选用）
 * @property {{ id: number, username: string, displayName: string } | null} me  当前登录用户
 * @property {number | null} editingId
 * @property {Set<number>} expanded   展开变更记录的卡片
 * @property {{ keyword: string, priority: Set<string>, tag: Set<string>, assignee: Set<string>, aiOnly: boolean }} filters
 * @property {{ id: number, fromStatus: string } | null} drag
 * @property {string} activeTab
 * @property {'board' | 'list'} view   当前视图
 * @property {{ key: string, dir: 'asc' | 'desc' }} listSort  列表排序
 * @property {'none' | 'tag' | 'assignee'} laneDim  泳道分组维度（看板视图）
 * @property {number} listPage        列表当前页（从 1 起）
 * @property {Set<number>} selection   批量操作勾选中的卡片
 */

/** @type {BoardState} */
export const state = {
  issues: [],
  boards: [],
  currentBoardId: null,
  users: [],
  me: null,
  editingId: null,
  expanded: new Set(),
  filters: {
    keyword: '',
    priority: new Set(),
    tag: new Set(),
    assignee: new Set(),
    aiOnly: false,
  },
  drag: null,
  activeTab: STATUSES[0],
  view: 'board',
  listSort: { key: 'updatedAt', dir: 'desc' },
  listPage: 1,
  laneDim: 'none',
  selection: new Set(),
};

/** @type {Set<(s: BoardState) => void>} */
const listeners = new Set();

/** @param {(s: BoardState) => void} fn @returns {() => void} 取消订阅 */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 状态变更后统一广播，触发视图重绘 */
export function notify() {
  for (const fn of listeners) fn(state);
}

/** 清空筛选条件（只动状态，DOM 同步交给调用方） */
export function resetFilters() {
  state.filters.keyword = '';
  state.filters.priority.clear();
  state.filters.tag.clear();
  state.filters.assignee.clear();
  state.filters.aiOnly = false;
}

// ------------------------------------------------------------------
// 批量选择
// ------------------------------------------------------------------

/** @param {number} id @param {boolean} on */
export function setSelected(id, on) {
  if (on) state.selection.add(id);
  else state.selection.delete(id);
}

/** @param {number} id */
export function toggleSelected(id) {
  setSelected(id, !state.selection.has(id));
}

export function clearSelection() {
  state.selection.clear();
}

/** @returns {number[]} 选中 id，按看板现有顺序输出，保证批量移动的顺序稳定 */
export function selectedIds() {
  return state.issues.filter((i) => state.selection.has(i.id)).map((i) => i.id);
}

/**
 * 丢弃已经不存在的勾选项（卡片被删除，或被其他标签页改没了）。
 * @param {Set<number> | number[]} existing
 */
export function pruneSelection(existing) {
  const valid = existing instanceof Set ? existing : new Set(existing);
  for (const id of [...state.selection]) {
    if (!valid.has(id)) state.selection.delete(id);
  }
}
