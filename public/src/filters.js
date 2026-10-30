/**
 * 筛选逻辑：纯函数，只依赖传入的 issue 与筛选条件。
 * 组合规则：同一维度内 OR，不同维度之间 AND。
 */
import { state } from './state.js';

/** @param {any} issue @param {BoardState['filters']} f @returns {boolean} */
export function matchesFilters(issue, f) {
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

/** @returns {any[]} */
export function filteredIssues() {
  return state.issues.filter((i) => matchesFilters(i, state.filters));
}

/** @returns {boolean} */
export function hasActiveFilters() {
  const f = state.filters;
  return Boolean(f.keyword) || f.priority.size > 0 || f.tag.size > 0 || f.assignee.size > 0;
}
