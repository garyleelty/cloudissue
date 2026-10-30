/**
 * 全局状态与极简发布订阅。
 * 视图只订阅 onChange，不直接互相调用，避免渲染与交互逻辑互相纠缠。
 */
import { STATUSES } from '/shared/constants.js';

/**
 * @typedef {Object} BoardState
 * @property {any[]} issues
 * @property {boolean} loading
 * @property {number | null} editingId
 * @property {Set<number>} expanded   展开变更记录的卡片
 * @property {{ keyword: string, priority: Set<string>, tag: Set<string>, assignee: Set<string> }} filters
 * @property {{ id: number, fromStatus: string } | null} drag
 * @property {string} activeTab
 */

/** @type {BoardState} */
export const state = {
  issues: [],
  loading: false,
  editingId: null,
  expanded: new Set(),
  filters: {
    keyword: '',
    priority: new Set(),
    tag: new Set(),
    assignee: new Set(),
  },
  drag: null,
  activeTab: STATUSES[0],
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
}
